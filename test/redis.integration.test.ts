/**
 * Runs the Lua scripts against a real Redis. Skipped unless REDIS_URL is set:
 *
 *   docker run --rm -p 6379:6379 redis:7-alpine
 *   REDIS_URL=redis://localhost:6379 npm test
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisSlidingWindow, RedisTokenBucket } from '../src/ratelimit/redis.js';
import { memorySlidingWindow, memoryTokenBucket } from '../src/ratelimit/memory.js';
import type { RateLimitDecision } from '../src/ratelimit/types.js';

const url = process.env['REDIS_URL'];

/** Small deterministic PRNG so a parity failure is reproducible from its seed. */
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

describe.skipIf(!url)('redis limiters (integration)', () => {
  const connections: Redis[] = [];
  const prefix = `gwtest:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}:`;
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

  describe('parity with the in-memory implementation', () => {
    // Refill rates that are exact binary fractions per ms (0.125/ms), so doubles never drift and the
    // comparison can demand exact equality instead of an epsilon.
    it.each([1, 2, 3])('token bucket agrees on every decision (seed %i)', async (seed) => {
      const rand = mulberry32(seed);
      let t = 1_700_000_000_000;
      const clock = () => t;
      const params = { capacity: 10, refillPerSecond: 125 };
      const memory = memoryTokenBucket(params, { clock, sweepIntervalMs: 0 });
      const remote = new RedisTokenBucket(redis, params, { keyPrefix: prefix, clock });
      const key = `tb-parity-${seed}`;

      for (let i = 0; i < 400; i++) {
        t += Math.floor(rand() * 90); // 0..89ms between calls: a mix of bursts and refills
        const cost = 1 + Math.floor(rand() * 3);
        const expected = await memory.consume(key, cost);
        const actual = await remote.consume(key, cost);
        expect(comparable(actual), `step ${i} (seed ${seed})`).toEqual(comparable(expected));
      }
      memory.close();
    });

    it.each([1, 2, 3])('sliding window agrees on every decision (seed %i)', async (seed) => {
      const rand = mulberry32(seed * 101);
      let t = 1_700_000_000_000;
      const clock = () => t;
      const params = { limit: 7, windowMs: 1000 };
      const memory = memorySlidingWindow(params, { clock, sweepIntervalMs: 0 });
      const remote = new RedisSlidingWindow(redis, params, { keyPrefix: prefix, clock });
      const key = `sw-parity-${seed}`;

      for (let i = 0; i < 400; i++) {
        t += Math.floor(rand() * 250);
        const cost = 1 + Math.floor(rand() * 3);
        const expected = await memory.consume(key, cost);
        const actual = await remote.consume(key, cost);
        expect(comparable(actual), `step ${i} (seed ${seed})`).toEqual(comparable(expected));
      }
      memory.close();
    });
  });

  describe('atomicity across independent clients', () => {
    it('sliding window admits exactly `limit` out of a concurrent flood from several instances', async () => {
      const limit = 50;
      const instances = Array.from({ length: 4 }, () =>
        new RedisSlidingWindow(connect(), { limit, windowMs: 60_000 }, { keyPrefix: prefix }),
      );
      const results = await Promise.all(
        Array.from({ length: 400 }, (_, i) => (instances[i % instances.length] as RedisSlidingWindow).consume('flood-sw')),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(limit);
    });

    it('token bucket admits exactly `capacity` out of a concurrent flood from several instances', async () => {
      const capacity = 30;
      const instances = Array.from({ length: 4 }, () =>
        // Refill so slow that no token can appear during the test.
        new RedisTokenBucket(connect(), { capacity, refillPerSecond: 0.0001 }, { keyPrefix: prefix }),
      );
      const results = await Promise.all(
        Array.from({ length: 300 }, (_, i) => (instances[i % instances.length] as RedisTokenBucket).consume('flood-tb')),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(capacity);
    });
  });

  describe('against the real Redis clock', () => {
    it('admits again after the advertised Retry-After and not meaningfully before', async () => {
      const limiter = new RedisSlidingWindow(redis, { limit: 2, windowMs: 400 }, { keyPrefix: prefix });
      await limiter.consume('retry-sw');
      await limiter.consume('retry-sw');
      const denied = await limiter.consume('retry-sw');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(400);

      await new Promise((r) => setTimeout(r, denied.retryAfterMs + 30));
      expect((await limiter.consume('retry-sw')).allowed).toBe(true);
    });

    it('token bucket refills in real time', async () => {
      const limiter = new RedisTokenBucket(redis, { capacity: 1, refillPerSecond: 10 }, { keyPrefix: prefix });
      expect((await limiter.consume('refill-tb')).allowed).toBe(true);
      const denied = await limiter.consume('refill-tb');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterMs).toBeLessThanOrEqual(100);
      await new Promise((r) => setTimeout(r, denied.retryAfterMs + 30));
      expect((await limiter.consume('refill-tb')).allowed).toBe(true);
    });
  });

  describe('key hygiene', () => {
    it('always sets a TTL so idle keys disappear', async () => {
      const sw = new RedisSlidingWindow(redis, { limit: 5, windowMs: 5000 }, { keyPrefix: prefix });
      const tb = new RedisTokenBucket(redis, { capacity: 5, refillPerSecond: 1 }, { keyPrefix: prefix });
      await sw.consume('ttl-sw');
      await tb.consume('ttl-tb');
      const swTtl = await redis.pttl(`${prefix}ttl-sw`);
      const tbTtl = await redis.pttl(`${prefix}ttl-tb`);
      expect(swTtl).toBeGreaterThan(0);
      expect(swTtl).toBeLessThanOrEqual(5000);
      expect(tbTtl).toBeGreaterThan(0);
    });

    it('does not write on denied requests, so a flood of rejections costs no storage', async () => {
      const sw = new RedisSlidingWindow(redis, { limit: 3, windowMs: 60_000 }, { keyPrefix: prefix });
      for (let i = 0; i < 3; i++) await sw.consume('nowrite-sw');
      for (let i = 0; i < 100; i++) expect((await sw.consume('nowrite-sw')).allowed).toBe(false);
      expect(await redis.zcard(`${prefix}nowrite-sw`)).toBe(3);
    });

    it('keeps distinct keys independent', async () => {
      const sw = new RedisSlidingWindow(redis, { limit: 1, windowMs: 60_000 }, { keyPrefix: prefix });
      expect((await sw.consume('indep-a')).allowed).toBe(true);
      expect((await sw.consume('indep-a')).allowed).toBe(false);
      expect((await sw.consume('indep-b')).allowed).toBe(true);
    });
  });
});
