/**
 * The approximate sliding-window counter's Lua script against a real Redis. Skipped unless REDIS_URL is set:
 *
 *   docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memorySlidingWindowCounter } from '../src/ratelimit/memory.js';
import { RedisSlidingWindowCounter } from '../src/ratelimit/redis.js';
import type { RateLimitDecision } from '../src/ratelimit/types.js';

const url = process.env['REDIS_URL'];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const comparable = (d: RateLimitDecision) => ({
  allowed: d.allowed,
  limit: d.limit,
  remaining: d.remaining,
  retryAfterMs: d.retryAfterMs,
  resetAfterMs: d.resetAfterMs,
});

describe.skipIf(!url)('redis sliding window counter (integration)', () => {
  const connections: Redis[] = [];
  const prefix = `gwtest:sc:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}:`;
  let redis: Redis;

  const connect = (): Redis => {
    const c = new Redis(url as string, { maxRetriesPerRequest: 1 });
    connections.push(c);
    return c;
  };

  beforeAll(() => {
    redis = connect();
  });

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    await Promise.all(connections.map((c) => c.quit().catch(() => undefined)));
  });

  it.each([1, 2, 3, 4, 5])('agrees with the in-memory implementation on every decision (seed %i)', async (seed) => {
    const rand = mulberry32(seed * 7919);
    let t = 1_700_000_000_000;
    const clock = () => t;
    const params = { limit: 9, windowMs: 1000 };
    const memory = memorySlidingWindowCounter(params, { clock, sweepIntervalMs: 0 });
    const remote = new RedisSlidingWindowCounter(redis, params, { keyPrefix: prefix, clock });
    const key = `parity-${seed}`;

    for (let i = 0; i < 500; i++) {
      // Mostly short gaps (bursts across window boundaries), occasionally a long idle gap.
      t += rand() < 0.04 ? Math.floor(rand() * 4000) : Math.floor(rand() * 300);
      const cost = 1 + Math.floor(rand() * 3);
      const expected = await memory.consume(key, cost);
      const actual = await remote.consume(key, cost);
      expect(comparable(actual), `step ${i} (seed ${seed})`).toEqual(comparable(expected));
    }
    memory.close();
  });

  it('admits exactly `limit` out of a concurrent flood from several independent clients', async () => {
    const limit = 40;
    const instances = Array.from(
      { length: 4 },
      () => new RedisSlidingWindowCounter(connect(), { limit, windowMs: 60_000 }, { keyPrefix: prefix }),
    );
    const results = await Promise.all(
      Array.from({ length: 400 }, (_, i) =>
        (instances[i % instances.length] as RedisSlidingWindowCounter).consume('flood'),
      ),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(limit);
  });

  it('admits again after the advertised Retry-After against the real Redis clock', async () => {
    const limiter = new RedisSlidingWindowCounter(redis, { limit: 2, windowMs: 400 }, { keyPrefix: prefix });
    await limiter.consume('retry');
    await limiter.consume('retry');
    const denied = await limiter.consume('retry');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(800);

    await new Promise((r) => setTimeout(r, denied.retryAfterMs + 40));
    expect((await limiter.consume('retry')).allowed).toBe(true);
  });

  it('keeps O(1) state per key: one small hash, however many requests', async () => {
    const limiter = new RedisSlidingWindowCounter(redis, { limit: 100_000, windowMs: 60_000 }, { keyPrefix: prefix });
    for (let i = 0; i < 300; i++) await limiter.consume('small');
    expect(await redis.type(`${prefix}small`)).toBe('hash');
    expect(await redis.hlen(`${prefix}small`)).toBe(3);
  });

  it('sets a TTL covering two windows, and does not write on a denial', async () => {
    const limiter = new RedisSlidingWindowCounter(redis, { limit: 1, windowMs: 5000 }, { keyPrefix: prefix });
    expect((await limiter.consume('ttl')).allowed).toBe(true);
    const ttl = await redis.pttl(`${prefix}ttl`);
    expect(ttl).toBeGreaterThan(5000);
    expect(ttl).toBeLessThanOrEqual(10_000);

    const before = await redis.hgetall(`${prefix}ttl`);
    for (let i = 0; i < 20; i++) expect((await limiter.consume('ttl')).allowed).toBe(false);
    expect(await redis.hgetall(`${prefix}ttl`)).toEqual(before);
  });

  it('does not write on a denial even when the denial falls in a later window than the stored state', async () => {
    // A denial that arrives after a window boundary has to *compute* the shifted counters, but it must not
    // persist them: that would be a write per rejected request, which is what flooding attackers want.
    let t = 1_700_000_000_000;
    const limiter = new RedisSlidingWindowCounter(
      redis,
      { limit: 3, windowMs: 1000 },
      { keyPrefix: prefix, clock: () => t },
    );
    expect((await limiter.consume('shift', 3)).allowed).toBe(true);
    const stored = await redis.hgetall(`${prefix}shift`);

    t += 1000; // next window: all of the previous window still counts, so this is denied
    for (let i = 0; i < 5; i++) expect((await limiter.consume('shift')).allowed).toBe(false);

    expect(await redis.hgetall(`${prefix}shift`)).toEqual(stored);
  });

  it('keeps distinct keys independent', async () => {
    const limiter = new RedisSlidingWindowCounter(redis, { limit: 1, windowMs: 60_000 }, { keyPrefix: prefix });
    expect((await limiter.consume('indep-a')).allowed).toBe(true);
    expect((await limiter.consume('indep-a')).allowed).toBe(false);
    expect((await limiter.consume('indep-b')).allowed).toBe(true);
  });
});
