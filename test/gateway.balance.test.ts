import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeUpstream,
  json,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function upstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const u = await startUpstream(handler);
  cleanups.push(u.close);
  return u;
}

async function gateway(raw: Record<string, unknown>): Promise<RunningGateway> {
  const g = await startGateway(raw);
  cleanups.push(g.close);
  return g;
}

const ok: UpstreamHandler = (_r, res, hit) => json(res, 200, { url: hit.url });
const failing: UpstreamHandler = (_r, res) => json(res, 503, { broken: true });
const get = (g: RunningGateway, path = '/x') => rawRequest(g.base, { path });

const breaker = { failureRateThreshold: 0.5, minimumRequests: 4, windowMs: 10_000, openDurationMs: 5_000 };

describe('spreading load across several targets', () => {
  it('round-robin gives each target an equal share', async () => {
    const [a, b, c] = await Promise.all([upstream(ok), upstream(ok), upstream(ok)]);
    const g = await gateway({
      upstreams: { pool: { urls: [(a as FakeUpstream).url, (b as FakeUpstream).url, (c as FakeUpstream).url] } },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    for (let i = 0; i < 30; i++) expect((await get(g)).status).toBe(200);
    expect([a, b, c].map((u) => u?.hits.length)).toEqual([10, 10, 10]);
  });

  it('least-pending steers new work away from a slow target', async () => {
    const slow = await upstream(async (_r, res) => {
      await sleep(250);
      json(res, 200, { from: 'slow' });
    });
    const fast = await upstream((_r, res) => json(res, 200, { from: 'fast' }));
    const g = await gateway({
      upstreams: { pool: { urls: [slow.url, fast.url], balance: 'least-pending' } },
      routes: [{ path: '/', upstream: 'pool' }],
    });

    // A steady trickle: each request is sent before the slow one has answered the previous.
    const pending: Array<ReturnType<typeof get>> = [];
    for (let i = 0; i < 24; i++) {
      pending.push(get(g));
      await sleep(15);
    }
    await Promise.all(pending);

    expect(fast.hits.length + slow.hits.length).toBe(24);
    expect(fast.hits.length).toBeGreaterThanOrEqual(18); // plain round-robin would be 12 each
    expect(slow.hits.length).toBeGreaterThanOrEqual(1); // but it is not starved of probes
  });

  it('applies each target base path independently', async () => {
    const a = await upstream(ok);
    const b = await upstream(ok);
    const g = await gateway({
      upstreams: { pool: { urls: [`${a.url}/v1`, `${b.url}/v2`] } },
      routes: [{ path: '/api', upstream: 'pool' }],
    });
    await get(g, '/api/things');
    await get(g, '/api/things');
    expect(a.hits[0]?.url).toBe('/v1/things');
    expect(b.hits[0]?.url).toBe('/v2/things');
  });
});

describe('a failing target', () => {
  it('is tried at most once per request: the retry moves to a different target', async () => {
    const bad = await upstream(failing);
    const good = await upstream(ok);
    const g = await gateway({
      upstreams: { pool: { urls: [bad.url, good.url], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 } } },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    const res = await get(g); // round-robin starts at the bad target
    expect(res.status).toBe(200);
    expect(bad.hits).toHaveLength(1);
    expect(good.hits).toHaveLength(1);
  });

  it('is avoided by the retry even when other traffic has rotated the cursor back onto it', async () => {
    // R1 goes to `slowBad` and is still waiting on it when R2 arrives. R2 takes the next turn (`good`), so by the
    // time R1 has failed and retries, plain rotation points straight back at `slowBad`. Only the preference for
    // an untried target sends the retry to `good`.
    const slowBad = await upstream(async (_r, res) => {
      await sleep(120);
      json(res, 503, { broken: true });
    });
    const good = await upstream(ok);
    const g = await gateway({
      upstreams: {
        pool: { urls: [slowBad.url, good.url], retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 } },
      },
      routes: [{ path: '/', upstream: 'pool' }],
    });

    const first = get(g, '/r1');
    await sleep(30);
    const second = get(g, '/r2');
    const [r1, r2] = await Promise.all([first, second]);

    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(slowBad.hits.map((h) => h.url)).toEqual(['/r1']); // tried once, not again for the retry
    expect(good.hits.map((h) => h.url).sort()).toEqual(['/r1', '/r2']);
  });

  it('is ejected by its own breaker while the healthy target keeps serving, and the client never sees an error', async () => {
    const bad = await upstream(failing);
    const good = await upstream(ok);
    const g = await gateway({
      upstreams: {
        pool: { urls: [bad.url, good.url], breaker, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 } },
      },
      routes: [{ path: '/', upstream: 'pool' }],
    });

    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await get(g)).status);

    expect(statuses.every((s) => s === 200)).toBe(true);
    const circuits = g.gateway.circuits('pool');
    const [badId, goodId] = [new URL(bad.url).host, new URL(good.url).host];
    expect(circuits[badId]?.state).toBe('open');
    expect(circuits[goodId]?.state).toBe('closed');
    // Once ejected the bad target is left alone: it saw only about the breaker's minimum volume.
    expect(bad.hits.length).toBeLessThanOrEqual(6);
    expect(good.hits.length).toBe(40);
  });

  it('is probed again after the cool-down and rejoins the pool once it recovers', async () => {
    let healthy = false;
    const flaky = await upstream((_r, res) => (healthy ? json(res, 200, { ok: true }) : json(res, 503, {})));
    const good = await upstream(ok);
    const g = await gateway({
      upstreams: {
        pool: {
          urls: [flaky.url, good.url],
          breaker: { ...breaker, halfOpenSuccesses: 1 },
          retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 },
        },
      },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    for (let i = 0; i < 12; i++) await get(g);
    const flakyId = new URL(flaky.url).host;
    expect(g.gateway.circuits('pool')[flakyId]?.state).toBe('open');

    healthy = true;
    g.clock.advance(5_000);
    const before = flaky.hits.length;
    for (let i = 0; i < 10; i++) await get(g);
    expect(g.gateway.circuits('pool')[flakyId]?.state).toBe('closed');
    expect(flaky.hits.length).toBeGreaterThan(before + 3); // sharing the load again
  });

  it('answers 503 with a retry hint only when every target is open', async () => {
    const a = await upstream(failing);
    const b = await upstream(failing);
    const g = await gateway({
      upstreams: { pool: { urls: [a.url, b.url], breaker, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    for (let i = 0; i < 12; i++) await get(g);
    const states = Object.values(g.gateway.circuits('pool')).map((c) => c.state);
    expect(states).toEqual(['open', 'open']);

    const res = await get(g);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).error.code).toBe('upstream_unavailable');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    const hitsBefore = a.hits.length + b.hits.length;
    await get(g);
    expect(a.hits.length + b.hits.length).toBe(hitsBefore); // fail fast: no load on either
  });
});

describe('visibility', () => {
  it('reports health and metrics per target', async () => {
    const bad = await upstream(failing);
    const good = await upstream(ok);
    const g = await gateway({
      upstreams: {
        pool: { urls: [bad.url, good.url], breaker, retry: { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 1 } },
      },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    for (let i = 0; i < 20; i++) await get(g);

    const health = JSON.parse((await rawRequest(g.adminBase, { path: '/_gateway/health' })).body);
    const pool = health.upstreams.pool;
    expect(pool.state).toBe('closed'); // it can still serve: one target is healthy
    expect(pool.targets).toHaveLength(2);
    const byId = Object.fromEntries(pool.targets.map((t: { id: string; state: string }) => [t.id, t.state]));
    expect(byId[new URL(bad.url).host]).toBe('open');
    expect(byId[new URL(good.url).host]).toBe('closed');

    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    const badHost = new URL(bad.url).host.replace('.', '\\.');
    expect(metrics).toMatch(new RegExp(`gateway_circuit_state\\{target="${badHost}",upstream="pool"\\} 2`));
    expect(metrics).toMatch(
      /gateway_upstream_attempts_total\{outcome="status_5xx",target="127\.0\.0\.1:\d+",upstream="pool"\}/,
    );
  });

  it('reports the upstream as open only when no target can serve', async () => {
    const a = await upstream(failing);
    const g = await gateway({
      upstreams: { pool: { urls: [a.url], breaker, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'pool' }],
    });
    for (let i = 0; i < 8; i++) await get(g);
    const health = JSON.parse((await rawRequest(g.adminBase, { path: '/_gateway/health' })).body);
    expect(health.upstreams.pool.state).toBe('open');
  });
});

describe('upstream connection reuse', () => {
  it('keeps idle connections for reuse under concurrent load instead of closing and reopening them', async () => {
    // A pool opens a new connection only when every existing one is busy, so the number of connections it has
    // ever opened can never exceed the peak concurrency the upstream observed. A free-socket cap below the
    // concurrency level breaks that: each wave destroys the surplus and re-opens it, which at load exhausts
    // ephemeral ports (TIME_WAIT) and wastes CPU on handshakes.
    let concurrent = 0;
    let peak = 0;
    const up = await upstream(async (_r, res) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await sleep(25);
      concurrent--;
      json(res, 200, { ok: true });
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const wave = () => Promise.all(Array.from({ length: 60 }, () => get(g)));

    for (let i = 0; i < 5; i++) {
      const statuses = (await wave()).map((r) => r.status);
      expect(statuses.every((s) => s === 200)).toBe(true);
    }

    expect(peak).toBeGreaterThan(40); // concurrency really did exceed the old free-socket cap of 32
    expect(up.connections()).toBeLessThanOrEqual(peak + 2); // never re-opened: the old cap opened ~28 more per wave
  });

  it('caps connections per target and queues the excess rather than refusing it', async () => {
    let concurrent = 0;
    let peak = 0;
    const up = await upstream(async (_r, res) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await sleep(40);
      concurrent--;
      json(res, 200, { ok: true });
    });
    const g = await gateway({
      upstreams: { u: { url: up.url, maxConnections: 3 } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const results = await Promise.all(Array.from({ length: 12 }, () => get(g)));

    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(up.hits).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(3);
    expect(up.connections()).toBeLessThanOrEqual(3);
  });
});
