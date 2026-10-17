/**
 * End to end, from the outside: the gateway as a user first meets it. The shipped `gateway.config.json`, the demo
 * upstream, both started as real processes, and a client that only speaks HTTP. Each test follows a step the README
 * tells a new user to try, and checks the whole behaviour that step promises, not one function of it.
 *
 * Needs no Redis (limits are per process in this setup).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rawRequest, sleep } from '../helpers.js';
import {
  cleanupAll,
  type DemoUpstream,
  type GatewayProc,
  type Loose,
  metric,
  projectRoot,
  startDemoUpstream,
  startGatewayProc,
  until,
} from './stack.js';

afterEach(cleanupAll);

async function boot(): Promise<{ demo: DemoUpstream; gw: GatewayProc }> {
  const demo = await startDemoUpstream();
  const shipped = JSON.parse(readFileSync(join(projectRoot, 'gateway.config.json'), 'utf8')) as {
    admin: { port: number };
  };
  shipped.admin.port = 0; // only so a test run does not need :9090 to be free
  const gw = await startGatewayProc(shipped as unknown as Record<string, unknown>, {
    PORT: '0',
    UPSTREAM_URL: demo.url,
  });
  return { demo, gw };
}

const get = (gw: GatewayProc, path: string, headers: Record<string, string> = {}) =>
  rawRequest(gw.base, { path, headers });
const json = (body: string): Loose => JSON.parse(body) as Loose;

describe('the shipped config, as the README drives it', { timeout: 60_000 }, () => {
  it('serves a cached route: a MISS, then HITs that are the very same response', async () => {
    const { gw } = await boot();
    const first = await get(gw, '/time');
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await get(gw, '/time');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body).toBe(first.body); // same instant, same upstream call counter
    expect(second.headers['age']).toBeDefined();
    expect(metric(await gw.metrics(), 'gateway_cache_requests_total', { result: 'HIT' })).toBe(1);
  });

  it('tells the upstream who is calling, keeps the request id end to end, and keeps its own internals off the proxy port', async () => {
    const { gw } = await boot();
    const res = await get(gw, '/echo?x=1', { 'x-request-id': 'trace-me-123', 'x-forwarded-for': '6.6.6.6' });
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('trace-me-123');
    const seen = json(res.body);
    expect(seen['query']).toBe('?x=1');
    expect(seen['headers']['x-request-id']).toBe('trace-me-123');
    expect(seen['headers']['x-forwarded-for']).toBe('127.0.0.1'); // the forged one is not believed
    expect(seen['headers']['host']).toMatch(/^127\.0\.0\.1:\d+$/); // rewritten to the upstream's own

    // The operator's endpoints are not reachable through the front door, whatever route would catch them.
    for (const path of ['/_gateway/metrics', '/_gateway/health', '/_gateway/live']) {
      expect((await get(gw, path)).status, path).toBe(404);
    }
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('limits per key with a token bucket: a burst, then 429s with honest headers, then a refill', async () => {
    const { gw } = await boot();
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof get>> | undefined;
    for (let i = 0; i < 15; i++) {
      const res = await get(gw, '/echo', { 'x-api-key': 'alice' });
      statuses.push(res.status);
      if (res.status === 429) limited ??= res;
    }
    const ok = statuses.filter((s) => s === 200).length;
    expect(ok).toBeGreaterThanOrEqual(10); // the burst (capacity 10, plus whatever refilled meanwhile)
    expect(ok).toBeLessThanOrEqual(11);
    expect(statuses.filter((s) => s === 429).length).toBe(15 - ok);

    expect(limited?.headers['retry-after']).toBeDefined();
    expect(Number(limited?.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(limited?.headers['ratelimit-remaining']).toBe('0');
    expect(json(limited?.body ?? '{}')['error']['code']).toBe('rate_limited');

    // Someone else is unaffected; the same key is back once tokens have refilled (2 per second).
    expect((await get(gw, '/echo', { 'x-api-key': 'bob' })).status).toBe(200);
    await sleep(1_200);
    expect((await get(gw, '/echo', { 'x-api-key': 'alice' })).status).toBe(200);
    expect(metric(await gw.metrics(), 'gateway_rate_limited_total', { route: 'echo' })).toBe(15 - ok);
  });

  it('gives up on a slow upstream inside its overall deadline, with an error that says nothing about the upstream', async () => {
    const { gw, demo } = await boot();
    const started = Date.now();
    const res = await get(gw, '/slow?ms=1500'); // each attempt times out at 1000 ms; the whole call is capped at 2500 ms
    const took = Date.now() - started;
    expect(res.status).toBe(504);
    expect(took).toBeGreaterThanOrEqual(1_800);
    expect(took).toBeLessThan(3_300);
    expect(json(res.body)['error']['code']).toBe('upstream_timeout');
    expect(res.body).not.toContain(String(demo.port));
    expect(res.body).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it('opens the breaker on a failing upstream, fails fast while it is open, and closes it again once the upstream heals', async () => {
    const { gw, demo } = await boot();
    await demo.fail(1);

    const statuses: number[] = [];
    const retryAfter: Array<string | undefined> = [];
    for (let i = 0; i < 20; i++) {
      const res = await get(gw, '/slow');
      statuses.push(res.status);
      if (res.status === 503) retryAfter.push(res.headers['retry-after']);
    }
    // "500s, then 503s": the failures are passed through until the breaker has seen enough, then it answers itself.
    const firstOpen = statuses.indexOf(503);
    expect(firstOpen).toBeGreaterThanOrEqual(6);
    expect(firstOpen).toBeLessThanOrEqual(8);
    expect(statuses.slice(0, firstOpen).every((s) => s === 500)).toBe(true);
    expect(statuses.slice(firstOpen).every((s) => s === 503)).toBe(true);
    expect(retryAfter.every((v) => Number(v) >= 1)).toBe(true);

    const open = await gw.health();
    expect(open['upstreams']['demo']['state']).toBe('open');
    expect(metric(await gw.metrics(), 'gateway_circuit_state', { upstream: 'demo' })).toBe(2);
    expect(metric(await gw.metrics(), 'gateway_circuit_transitions_total', { to: 'open' })).toBe(1);

    await demo.fail(0);
    const healedAt = Date.now();
    // Each poll uses its own key: the shipped limit is 60 a minute per key, which a tight poll would exhaust.
    let poll = 0;
    const probe = () => get(gw, '/slow?ms=0', { 'x-api-key': `poll-${poll++}` });
    expect((await probe()).status).toBe(503); // healed, but the breaker has not tried yet

    // After the open duration (8 s) it lets probes through; two successes close it.
    let recovered: number | undefined;
    await until(
      async () => {
        const res = await probe();
        if (res.status === 200) recovered = Date.now() - healedAt;
        return recovered !== undefined;
      },
      15_000,
      'the breaker to let a request through',
    );
    expect(recovered).toBeGreaterThanOrEqual(5_000); // it did not simply flip back
    for (let i = 0; i < 5; i++) expect((await probe()).status).toBe(200);
    expect((await gw.health())['upstreams']['demo']['state']).toBe('closed');
    const text = await gw.metrics();
    expect(metric(text, 'gateway_circuit_transitions_total', { to: 'half-open' })).toBeGreaterThanOrEqual(1);
    expect(metric(text, 'gateway_circuit_transitions_total', { to: 'closed' })).toBeGreaterThanOrEqual(1);
  });

  it('survives its upstream crashing outright, answers with a generic 502, and picks it up again when it returns', async () => {
    const { gw, demo } = await boot();
    expect((await get(gw, '/echo', { 'x-api-key': 'carol' })).status).toBe(200);
    await demo.crash();

    const started = Date.now();
    const down = await get(gw, '/echo', { 'x-api-key': 'carol' });
    expect(down.status).toBe(502);
    expect(Date.now() - started).toBeLessThan(2_000); // connection refused is quick; it is retried, not hung on
    expect(json(down.body)['error']['code']).toBe('bad_gateway');
    expect(down.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/live' })).status).toBe(200); // the gateway itself is fine

    // Bring it back on the same address; once the breaker (8 s) and token bucket allow it, traffic flows again.
    await startDemoUpstream(demo.port);
    let n = 0;
    await until(
      async () => (await get(gw, '/slow?ms=0', { 'x-api-key': `again-${n++}` })).status === 200,
      20_000,
      'traffic to resume',
    );
  });
});
