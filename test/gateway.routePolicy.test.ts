import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { configNotes } from '../src/security.js';
import { json, rawRequest, sleep, startGateway, startUpstream } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** One upstream: /slow?ms=N answers after N ms, /flaky always answers 503, anything else echoes the body size. */
async function setup() {
  const up = await startUpstream(async (_req, res, hit) => {
    const url = new URL(hit.url, 'http://x');
    if (url.pathname.endsWith('/slow')) {
      await sleep(Number(url.searchParams.get('ms') ?? 0));
      return json(res, 200, { slow: true });
    }
    if (url.pathname.endsWith('/flaky')) return json(res, 503, { flaky: true });
    return json(res, 200, { bytes: Buffer.byteLength(hit.body) });
  });
  cleanups.push(up.close);
  const g = await startGateway({
    maxBodyBytes: 1_024,
    upstreams: {
      // Upstream-wide: 200 ms per attempt, 3 attempts, no overall deadline.
      u: { url: up.url, timeoutMs: 200, retry: { maxAttempts: 3, baseDelayMs: 10 } },
    },
    routes: [
      { id: 'default', path: '/default', upstream: 'u', stripPrefix: false },
      { id: 'report', path: '/report', upstream: 'u', stripPrefix: false, timeoutMs: 1_500 },
      { id: 'once', path: '/once', upstream: 'u', stripPrefix: false, retry: { maxAttempts: 1 } },
      { id: 'writes', path: '/writes', upstream: 'u', stripPrefix: false, retry: { retryNonIdempotent: true } },
      { id: 'deadline', path: '/deadline', upstream: 'u', stripPrefix: false, totalTimeoutMs: 300 },
      { id: 'upload', path: '/upload', upstream: 'u', stripPrefix: false, maxBodyBytes: 4_096 },
    ],
  });
  cleanups.push(g.close);
  const hits = (path: string) => up.hits.filter((h) => h.url.startsWith(path)).length;
  return { up, g, hits };
}

describe('per-route policies', () => {
  it("give a slow route the time it needs while its upstream's other routes keep their tight timeout", async () => {
    const { g } = await setup();
    expect((await rawRequest(g.base, { path: '/report/slow?ms=500' })).status).toBe(200);
    const tight = await rawRequest(g.base, { path: '/default/slow?ms=500' });
    expect(tight.status).toBe(504);
  });

  it('turn retries off for one route only', async () => {
    const { g, hits } = await setup();
    expect((await rawRequest(g.base, { path: '/once/flaky' })).status).toBe(503);
    expect(hits('/once')).toBe(1);
    expect(g.delays).toEqual([]);

    expect((await rawRequest(g.base, { path: '/default/flaky' })).status).toBe(503);
    expect(hits('/default')).toBe(3); // the upstream's own setting still applies elsewhere
  });

  it('change one retry setting and inherit the rest', async () => {
    const { g, hits } = await setup();
    // POST is not retried by default; this route opts in, and keeps the upstream's 3 attempts and retryable statuses.
    expect((await rawRequest(g.base, { method: 'POST', path: '/writes/flaky', chunks: ['x'] })).status).toBe(503);
    expect(hits('/writes')).toBe(3);
    expect((await rawRequest(g.base, { method: 'POST', path: '/default/flaky', chunks: ['x'] })).status).toBe(503);
    expect(hits('/default')).toBe(1);
  });

  it('bound a route with an overall deadline its upstream does not have', async () => {
    const { g } = await setup();
    const started = Date.now();
    const res = await rawRequest(g.base, { path: '/deadline/slow?ms=1000' });
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(550); // 300 ms in all, not 3 attempts of 200 ms
  });

  it('accept bigger bodies on one route without raising the limit everywhere', async () => {
    const { g } = await setup();
    const body = 'x'.repeat(3_000);
    const upload = await rawRequest(g.base, { method: 'POST', path: '/upload/files', chunks: [body] });
    expect(upload.status).toBe(200);
    expect(JSON.parse(upload.body).bytes).toBe(3_000);
    const elsewhere = await rawRequest(g.base, { method: 'POST', path: '/default/x', chunks: [body] });
    expect(elsewhere.status).toBe(413);
  });
});

describe('per-route policy config', () => {
  const base = {
    upstreams: { u: { url: 'http://localhost:9000' } },
    routes: [{ path: '/', upstream: 'u' }],
  };
  const problem = (extra: Record<string, unknown>, route: Record<string, unknown> = {}) => {
    try {
      parseConfig({ ...base, ...extra, routes: [{ path: '/', upstream: 'u', ...route }] });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return expect.unreachable('config was accepted');
  };

  it('leaves everything to the upstream unless a route says otherwise', () => {
    const route = parseConfig(base).routes[0];
    expect(route?.timeoutMs).toBeUndefined();
    expect(route?.retry).toBeUndefined();
    expect(route?.maxBodyBytes).toBeUndefined();
  });

  it('refuses retry settings that make no sense, and unknown ones', () => {
    expect(problem({}, { retry: { maxAttempts: 0 } })).toMatch(/retry\.maxAttempts/);
    expect(problem({}, { retry: { attempts: 2 } })).toMatch(/retry/);
    expect(problem({}, { timeoutMs: 0 })).toMatch(/timeoutMs/);
  });

  it('warns, at start-up, about a body limit the buffer budget could never hold', () => {
    const notes = (extra: Record<string, unknown>, route: Record<string, unknown> = {}) =>
      configNotes(parseConfig({ ...base, ...extra, routes: [{ id: 'up', path: '/', upstream: 'u', ...route }] }));
    expect(notes({ limits: { maxBufferedBytes: 1_000_000 } }, { maxBodyBytes: 2_000_000 }).join()).toMatch(
      /route "up" maxBodyBytes \(2000000 bytes\) is larger than limits\.maxBufferedBytes \(1000000\)/,
    );
    expect(notes({ maxBodyBytes: 2_000_000, limits: { maxBufferedBytes: 1_000_000 } }).join()).toMatch(
      /^maxBodyBytes \(2000000 bytes\) is larger than/,
    );
    expect(notes({}, { maxBodyBytes: 4_096 })).toEqual([]);
  });
});
