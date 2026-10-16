import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import {
  type FakeUpstream,
  json,
  type RunningGateway,
  rawRequest,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const ok: UpstreamHandler = (_r, res) => json(res, 200, { ok: true });
const sw = (limit: number) => ({ algorithm: 'sliding-window', limit, windowMs: 60_000 });

async function setup(raw: Record<string, unknown>): Promise<{ g: RunningGateway; up: FakeUpstream }> {
  const up = await startUpstream(ok);
  cleanups.push(up.close);
  const g = await startGateway({ upstreams: { u: { url: up.url } }, ...raw });
  cleanups.push(g.close);
  return { g, up };
}

const hit = (g: RunningGateway, path: string, headers: Record<string, string> = {}) =>
  rawRequest(g.base, { path, headers: { 'x-api-key': 'k', ...headers } });

describe('request cost', () => {
  it('lets an expensive route spend several units of the same budget per request', async () => {
    const { g } = await setup({
      rateLimit: { default: sw(10) },
      routes: [
        { id: 'cheap', path: '/cheap', upstream: 'u', stripPrefix: false },
        { id: 'export', path: '/export', upstream: 'u', stripPrefix: false, cost: 4 },
      ],
    });
    const first = await hit(g, '/export');
    const second = await hit(g, '/export');
    const third = await hit(g, '/export'); // 12 would exceed 10
    expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
    expect(first.headers['ratelimit-remaining']).toBe('6');
    expect(second.headers['ratelimit-remaining']).toBe('2');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('works with the token bucket, and refills proportionally', async () => {
    const { g } = await setup({
      rateLimit: { default: { algorithm: 'token-bucket', capacity: 10, refillPerSecond: 5 } },
      routes: [{ id: 'report', path: '/report', upstream: 'u', stripPrefix: false, cost: 5 }],
    });
    expect([(await hit(g, '/report')).status, (await hit(g, '/report')).status]).toEqual([200, 200]);
    expect((await hit(g, '/report')).status).toBe(429);
    g.clock.advance(1000); // 5 tokens back: exactly one more request
    expect((await hit(g, '/report')).status).toBe(200);
    expect((await hit(g, '/report')).status).toBe(429);
  });

  it("keeps each route's budget separate, so cost only matters within a route", async () => {
    const { g } = await setup({
      rateLimit: { default: sw(5) },
      routes: [
        { id: 'a', path: '/a', upstream: 'u', stripPrefix: false, cost: 5 },
        { id: 'b', path: '/b', upstream: 'u', stripPrefix: false },
      ],
    });
    expect((await hit(g, '/a')).status).toBe(200);
    expect((await hit(g, '/a')).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await hit(g, '/b')).status).toBe(200);
  });

  it('charges a request even when the response comes from the cache', async () => {
    const { g, up } = await setup({
      rateLimit: { default: sw(9) },
      routes: [{ id: 'c', path: '/c', upstream: 'u', stripPrefix: false, cost: 3, cache: { ttlMs: 60_000 } }],
    });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await hit(g, '/c')).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(up.hits).toHaveLength(1); // three were served from cache, and each still cost 3
  });

  it("is capped at the caller's whole allowance, so a scaled-down caller can still make one request per refill", async () => {
    // Anonymous callers get a tenth of the quota: an allowance of 1, against a route that costs 10. Without the cap
    // no request could ever be admitted and the route would be permanently closed to them.
    const { g } = await setup({
      rateLimit: {
        default: sw(10),
        apiKeys: [{ name: 'known', sha256: keyDigest('known-key') }],
        anonymousMultiplier: 0.1,
      },
      routes: [{ id: 'r', path: '/r', upstream: 'u', stripPrefix: false, cost: 10 }],
    });
    const anonymous = () => rawRequest(g.base, { path: '/r' });
    expect([(await anonymous()).status, (await anonymous()).status]).toEqual([200, 429]);
    g.clock.advance(60_000);
    expect((await anonymous()).status).toBe(200);
  });

  it("is charged against the caller's own allowance: a plan raises how many requests fit, not what each costs", async () => {
    const { g } = await setup({
      rateLimit: {
        default: sw(10),
        plans: { pro: { multiplier: 3 } },
        apiKeys: [{ name: 'pro-key', sha256: keyDigest('pro-key'), plan: 'pro' }],
      },
      routes: [{ id: 'x', path: '/x', upstream: 'u', stripPrefix: false, cost: 10 }],
    });
    const statuses = async (headers: Record<string, string>) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i++) out.push((await rawRequest(g.base, { path: '/x', headers })).status);
      return out;
    };
    expect(await statuses({ 'x-api-key': 'pro-key' })).toEqual([200, 200, 200, 429]); // allowance 30, cost 10
    expect(await statuses({})).toEqual([200, 429, 429, 429]); // allowance 10, cost 10
  });
});

describe('cost configuration', () => {
  const base = {
    upstreams: { u: { url: 'http://localhost:9000' } },
    rateLimit: { default: sw(10) },
  };
  const route = (extra: Record<string, unknown>) => ({ ...base, routes: [{ path: '/', upstream: 'u', ...extra }] });

  it('defaults to 1', () => {
    expect(parseConfig(route({})).routes[0]?.cost).toBe(1);
  });

  it('accepts a cost up to the whole allowance and no more', () => {
    expect(parseConfig(route({ cost: 10 })).routes[0]?.cost).toBe(10);
    expect(() => parseConfig(route({ cost: 11 }))).toThrow(/exceeds the route's whole allowance of 10/);
  });

  it("checks against the route's own rule when it has one", () => {
    const tb = { algorithm: 'token-bucket', capacity: 3, refillPerSecond: 1 };
    expect(() => parseConfig(route({ cost: 4, rateLimit: tb }))).toThrow(/allowance of 3/);
    expect(parseConfig(route({ cost: 3, rateLimit: tb })).routes[0]?.cost).toBe(3);
  });

  it('does not constrain a route that is not rate limited', () => {
    expect(parseConfig(route({ cost: 500, rateLimit: false })).routes[0]?.cost).toBe(500);
    const unlimited = parseConfig({ upstreams: base.upstreams, routes: [{ path: '/', upstream: 'u', cost: 500 }] });
    expect(unlimited.routes[0]?.cost).toBe(500);
  });

  it('rejects zero, negative and fractional costs', () => {
    for (const cost of [0, -1, 1.5, '2']) expect(() => parseConfig(route({ cost })), String(cost)).toThrow();
  });
});
