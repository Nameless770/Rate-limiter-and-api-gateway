import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { type GatewayConfig, parseConfig } from '../src/config.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import {
  capturingLogger,
  fixture,
  httpsRequest,
  json,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
  startUpstream,
} from './helpers.js';
import { openWs, startWsUpstream, type WsSession } from './wsHelpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** What startGateway adds to a raw config, so a reloaded config differs only where the test means it to. */
const full = (raw: Record<string, unknown>): GatewayConfig =>
  parseConfig({
    host: '127.0.0.1',
    port: 0,
    shutdownGraceMs: 500,
    ...raw,
    admin: { port: 0, ...((raw['admin'] as object | undefined) ?? {}) },
  });

/** An upstream that names itself, can be slow on /slow, and reports how many connections it has open. */
async function named(name: string) {
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith('/slow')) await sleep(400);
    json(res, 200, { from: name, path: req.url });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const hits: string[] = [];
  server.on('request', (req) => hits.push(req.url ?? ''));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    open: () => new Promise<number>((resolve) => server.getConnections((_e, n) => resolve(n))),
  };
}

async function boot(raw: Record<string, unknown>, deps: Parameters<typeof startGateway>[1] = {}) {
  const { logger, lines } = capturingLogger();
  const g = await startGateway(raw, { logger, ...deps });
  cleanups.push(g.close);
  return { g, lines };
}

const from = async (g: RunningGateway, path: string, headers: Record<string, string> = {}) => {
  const res = await rawRequest(g.base, { path, headers });
  return { status: res.status, ...(res.status === 200 ? (JSON.parse(res.body) as { from: string }) : {}) };
};

describe('reloading the configuration', () => {
  it('adds and removes routes, and counts the configurations it has applied', async () => {
    const a = await named('a');
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ id: 'one', path: '/one', upstream: 'u' }] };
    const { g } = await boot(raw);
    expect((await from(g, '/two')).status).toBe(404);

    const result = g.gateway.reload(full({ ...raw, routes: [{ id: 'two', path: '/two', upstream: 'u' }] }));
    expect(result).toMatchObject({ ok: true, generation: 2, changed: ['routes'], restartRequired: [] });
    expect((await from(g, '/two')).status).toBe(200);
    expect((await from(g, '/one')).status).toBe(404);
    expect((await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body).toMatch(
      /gateway_config_reloads_total\{result="ok"\} 1/,
    );
    expect(JSON.parse((await rawRequest(g.adminBase, { path: '/_gateway/health' })).body).configGeneration).toBe(2);
  });

  it('moves an upstream to new targets, lets the request in flight finish on the old one, then closes it', async () => {
    const [a, b] = [await named('a'), await named('b')];
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ path: '/', upstream: 'u' }] };
    const { g } = await boot(raw);
    expect((await from(g, '/x')).from).toBe('a');

    const inFlight = from(g, '/slow');
    await sleep(100);
    expect(g.gateway.reload(full({ ...raw, upstreams: { u: { url: b.url } } })).ok).toBe(true);
    expect((await from(g, '/x')).from).toBe('b'); // new requests go to the new target at once...
    expect(await inFlight).toMatchObject({ status: 200, from: 'a' }); // ...the one under way is not cut off

    // and once it is done, the old target's connections are closed rather than left idle for ever.
    const deadline = Date.now() + 2_000;
    while ((await a.open()) > 0 && Date.now() < deadline) await sleep(20);
    expect(await a.open()).toBe(0);
  });

  it('keeps everything about an upstream the reload did not change: its connections and its circuit state', async () => {
    const up = await startUpstream((_r, res) => json(res, 500, {}));
    cleanups.push(up.close);
    const raw = {
      upstreams: {
        u: { url: up.url, retry: { maxAttempts: 1 }, breaker: { minimumRequests: 2, openDurationMs: 60_000 } },
      },
      routes: [{ id: 'one', path: '/one', upstream: 'u' }],
    };
    const { g } = await boot(raw);
    for (let i = 0; i < 3; i++) await rawRequest(g.base, { path: '/one' });
    const breaker = g.gateway.circuit('u');
    expect(breaker?.state).toBe('open');

    g.gateway.reload(full({ ...raw, routes: [...raw.routes, { id: 'two', path: '/two', upstream: 'u' }] }));
    expect(g.gateway.circuit('u')).toBe(breaker); // the very same breaker, still open
    expect(g.gateway.circuit('u')?.state).toBe('open');
  });

  it('rotates API keys: the removed key stops working and the new one starts', async () => {
    const a = await named('a');
    const raw = (keys: string[]) => ({
      upstreams: { u: { url: a.url } },
      rateLimit: { apiKeys: keys.map((name) => ({ name, sha256: keyDigest(`${name}-key`) })) },
      routes: [{ path: '/', upstream: 'u', auth: { methods: ['api-key'] } }],
    });
    const { g } = await boot(raw(['alice']));
    expect((await from(g, '/x', { 'x-api-key': 'alice-key' })).status).toBe(200);
    expect((await from(g, '/x', { 'x-api-key': 'bob-key' })).status).toBe(401);

    g.gateway.reload(full(raw(['bob'])));
    expect((await from(g, '/x', { 'x-api-key': 'alice-key' })).status).toBe(401);
    expect((await from(g, '/x', { 'x-api-key': 'bob-key' })).status).toBe(200);
  });

  it('keeps the counts of a rate limit it did not change, and starts a changed one afresh', async () => {
    const a = await named('a');
    const sw = (limit: number) => ({ algorithm: 'sliding-window', limit, windowMs: 60_000 });
    const raw = (twoLimit: number, oneLimit = 3) => ({
      upstreams: { u: { url: a.url } },
      routes: [
        { id: 'one', path: '/one', upstream: 'u', rateLimit: sw(oneLimit) },
        { id: 'two', path: '/two', upstream: 'u', rateLimit: sw(twoLimit) },
      ],
    });
    const { g } = await boot(raw(3));
    for (let i = 0; i < 2; i++) expect((await from(g, '/one')).status).toBe(200);

    g.gateway.reload(full(raw(10))); // only route two's rule changed
    expect((await from(g, '/one')).status).toBe(200); // the third of three...
    expect((await from(g, '/one')).status).toBe(429); // ...and no more: route one's count survived the reload

    g.gateway.reload(full(raw(10, 5))); // now route one's rule changes too
    for (let i = 0; i < 5; i++) expect((await from(g, '/one')).status).toBe(200);
    expect((await from(g, '/one')).status).toBe(429);
  });

  it('closes limiters that no route can reach any more', async () => {
    const a = await named('a');
    const sw = { algorithm: 'sliding-window', limit: 10, windowMs: 60_000 };
    const raw = {
      upstreams: { u: { url: a.url } },
      routes: [
        { id: 'one', path: '/one', upstream: 'u', rateLimit: sw },
        { id: 'two', path: '/two', upstream: 'u', rateLimit: sw },
      ],
    };
    const { g } = await boot(raw);
    await from(g, '/one');
    await from(g, '/two');
    const limiters = (g.gateway as unknown as { limiterCache: Map<string, unknown> }).limiterCache;
    expect(limiters.size).toBe(2);
    g.gateway.reload(full({ ...raw, routes: [raw.routes[0]] }));
    expect(limiters.size).toBe(1);
  });

  it('changes nothing if the new configuration cannot work, and says why', async () => {
    const a = await named('a');
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ id: 'one', path: '/one', upstream: 'u' }] };
    const { g, lines } = await boot(raw);
    const broken = full({
      ...raw,
      routes: [{ id: 'two', path: '/two', upstream: 'u', auth: { methods: ['jwt'] } }],
      auth: { jwt: { issuers: [{ name: 'idp', alg: 'RS256', publicKeyFile: fixture('tls/nope.pem') }] } },
    });
    const result = g.gateway.reload(broken);
    expect(result).toMatchObject({ ok: false });
    expect(result.ok ? '' : result.error).toMatch(/nope\.pem/);
    expect((await from(g, '/one')).status).toBe(200); // the old configuration is still the one in force
    expect((await from(g, '/two')).status).toBe(404);
    expect(g.gateway.config.routes.map((r) => r.id)).toEqual(['one']);
    expect(
      lines.some((l) => l['msg'] === 'configuration reload failed; still running the previous configuration'),
    ).toBe(true);
    expect((await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body).toMatch(
      /gateway_config_reloads_total\{result="error"\} 1/,
    );
  });

  it('keeps settings a running process cannot change, applies the rest, and lists what needs a restart', async () => {
    const a = await named('a');
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ id: 'one', path: '/one', upstream: 'u' }] };
    const { g } = await boot(raw);
    const result = g.gateway.reload(
      full({
        ...raw,
        port: 9999,
        host: '0.0.0.0',
        redis: { url: 'redis://example.invalid:6379' },
        cluster: { workers: 2 },
        tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem') },
        admin: { port: 0, host: '0.0.0.0', token: 'a-sufficiently-long-token' },
        limits: { maxHeaderBytes: 32 * 1024, headersTimeoutMs: 4_000 },
        routes: [{ id: 'two', path: '/two', upstream: 'u' }],
      }),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && [...result.restartRequired].sort()).toEqual(
      ['admin', 'cluster', 'host', 'limits.maxHeaderBytes', 'port', 'redis', 'tls'].sort(),
    );
    const now = g.gateway.config;
    expect(now.port).toBe(0);
    expect(now.host).toBe('127.0.0.1');
    expect(now.redis).toBeUndefined();
    expect(now.cluster.workers).toBe(1);
    expect(now.tls).toBeUndefined(); // still plain HTTP: a listener cannot start speaking TLS
    expect(now.admin.host).toBe('127.0.0.1');
    expect(now.admin.token).toBe('a-sufficiently-long-token'); // the token is not fixed...
    expect(now.limits.headersTimeoutMs).toBe(4_000); // ...nor are the other limits
    expect(g.gateway.server.headersTimeout).toBe(4_000);
    expect((await from(g, '/two')).status).toBe(200);
  });

  it('puts a new admin token into force at once', async () => {
    const a = await named('a');
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ path: '/', upstream: 'u' }] };
    const { g } = await boot(raw);
    expect((await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).status).toBe(200);
    g.gateway.reload(full({ ...raw, admin: { token: 'a-sufficiently-long-token' } }));
    expect((await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).status).toBe(401);
    const authorized = { authorization: 'Bearer a-sufficiently-long-token' };
    expect((await rawRequest(g.adminBase, { path: '/_gateway/metrics', headers: authorized })).status).toBe(200);
  });

  it('drops cached responses from an upstream it replaced, and keeps the rest', async () => {
    const [a1, a2, b] = [await named('a1'), await named('a2'), await named('b')];
    const cache = { ttlMs: 60_000, varyHeaders: [] };
    const raw = (aUrl: string) => ({
      upstreams: { a: { url: aUrl }, b: { url: b.url } },
      routes: [
        { path: '/a', upstream: 'a', cache },
        { path: '/b', upstream: 'b', cache },
      ],
    });
    const { g } = await boot(raw(a1.url));
    await from(g, '/a/x');
    await from(g, '/b/x');
    g.gateway.reload(full(raw(a2.url)));
    const fromA = await rawRequest(g.base, { path: '/a/x' });
    expect(fromA.headers['x-cache']).toBe('MISS');
    expect(JSON.parse(fromA.body).from).toBe('a2');
    expect((await rawRequest(g.base, { path: '/b/x' })).headers['x-cache']).toBe('HIT');
  });

  it('starts a new cache when its size limits change', async () => {
    const a = await named('a');
    const raw = (maxEntries: number) => ({
      cache: { maxEntries },
      upstreams: { u: { url: a.url } },
      routes: [{ path: '/', upstream: 'u', cache: { ttlMs: 60_000, varyHeaders: [] } }],
    });
    const { g } = await boot(raw(100));
    await from(g, '/x');
    expect((await rawRequest(g.base, { path: '/x' })).headers['x-cache']).toBe('HIT');
    g.gateway.reload(full(raw(5)));
    expect(g.gateway.cache.stats().entries).toBe(0);
    expect((await rawRequest(g.base, { path: '/x' })).headers['x-cache']).toBe('MISS');
  });

  it('stops probing an upstream it replaced and starts probing the new one', async () => {
    const [a, b] = [await named('a'), await named('b')];
    const hc = { path: '/health', intervalMs: 100, timeoutMs: 50 };
    const raw = (url: string) => ({
      upstreams: { u: { url, healthCheck: hc } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const { g } = await boot(raw(a.url), { manualHealthChecks: false });
    await sleep(250);
    expect(a.hits.filter((h) => h === '/health').length).toBeGreaterThan(0);

    g.gateway.reload(full(raw(b.url)));
    const before = a.hits.length;
    await sleep(400);
    expect(a.hits.length).toBe(before); // nothing more for the old one
    expect(b.hits.filter((h) => h === '/health').length).toBeGreaterThan(1);
  });

  it('leaves open WebSockets alone, even when their upstream is replaced', async () => {
    const ws = await startWsUpstream();
    cleanups.push(ws.close);
    const raw = {
      upstreams: { chat: { url: ws.url } },
      routes: [
        { id: 'chat', path: '/chat', upstream: 'chat', stripPrefix: false, websocket: { allowAnyOrigin: true } },
      ],
    };
    const { g } = await boot(raw);
    const socket = (await openWs(g.base, { path: '/chat' })).ws as WsSession;
    cleanups.push(async () => socket.destroy());
    const result = g.gateway.reload(
      full({
        upstreams: { chat: { url: ws.url, timeoutMs: 1_234 } }, // a changed upstream: the old one is retired
        routes: [...raw.routes, { id: 'more', path: '/more', upstream: 'chat' }],
      }),
    );
    expect(result).toMatchObject({ ok: true, changed: expect.arrayContaining(['upstreams', 'routes']) });
    await sleep(50); // time for the retired upstream to close what it holds
    socket.send('still here');
    expect(await socket.nextText()).toBe('still here');
  });

  it('applies TLS changes to new connections: the certificate and the minimum version', async () => {
    const a = await named('a');
    const ca1 = readFileSync(fixture('tls/localhost-cert.pem'));
    const ca2 = readFileSync(fixture('tls/localhost2-cert.pem'));
    const tls = (n: '' | '2', minVersion = 'TLSv1.2') => ({
      certFile: fixture(`tls/localhost${n}-cert.pem`),
      keyFile: fixture(`tls/localhost${n}-key.pem`),
      minVersion,
    });
    const raw = (t: Record<string, unknown>) => ({
      tls: t,
      upstreams: { u: { url: a.url } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const { g } = await boot(raw(tls('')));
    const base = g.base.replace('http://', 'https://');
    expect((await httpsRequest(base, { path: '/x', ca: ca1, maxVersion: 'TLSv1.2' })).status).toBe(200);

    expect(g.gateway.reload(full(raw(tls('2', 'TLSv1.3')))).ok).toBe(true);
    expect((await httpsRequest(base, { path: '/x', ca: ca2 })).status).toBe(200); // the new certificate
    await expect(httpsRequest(base, { path: '/x', ca: ca2, maxVersion: 'TLSv1.2' })).rejects.toThrow(); // and 1.3 only
  });

  it('refuses to reload while shutting down', async () => {
    const a = await named('a');
    const raw = { upstreams: { u: { url: a.url } }, routes: [{ path: '/', upstream: 'u' }] };
    const { g } = await boot(raw);
    const closing = g.gateway.close(500);
    expect(g.gateway.reload(full(raw))).toMatchObject({ ok: false, error: 'the gateway is shutting down' });
    await closing;
  });
});

describe('the reload endpoint (POST /_gateway/reload)', () => {
  async function withSource(adminExtra: Record<string, unknown> = {}) {
    const a = await named('a');
    let raw: Record<string, unknown> = {
      admin: adminExtra,
      upstreams: { u: { url: a.url } },
      routes: [{ id: 'one', path: '/one', upstream: 'u' }],
    };
    const { g } = await boot(raw, { loadConfig: () => full(raw) });
    const edit = (next: Record<string, unknown>): void => {
      raw = { ...raw, ...next };
    };
    return { g, edit };
  }
  const post = (g: RunningGateway, headers: Record<string, string> = {}) =>
    rawRequest(g.adminBase, { method: 'POST', path: '/_gateway/reload', headers });

  it('re-reads the configuration and applies it', async () => {
    const { g, edit } = await withSource();
    edit({ routes: [{ id: 'two', path: '/two', upstream: 'u' }] });
    const res = await post(g);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, generation: 2, changed: ['routes'] });
    expect((await from(g, '/two')).status).toBe(200);
  });

  it('answers 422 with the reason when the new configuration is refused', async () => {
    const { g, edit } = await withSource();
    edit({ routes: [{ id: 'two', path: '/two', upstream: 'nowhere' }] });
    // The source itself throws (as loadConfig does for a file that fails the schema).
    const res = await post(g);
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).error).toMatch(/unknown upstream "nowhere"/);
    expect((await from(g, '/one')).status).toBe(200);
  });

  it('takes POST only, refuses browsers, and asks for the token when there is one', async () => {
    const { g } = await withSource({ token: 'a-sufficiently-long-token' });
    expect((await rawRequest(g.adminBase, { path: '/_gateway/reload' })).status).toBe(405);
    expect((await post(g)).status).toBe(401);
    const authorized = { authorization: 'Bearer a-sufficiently-long-token' };
    expect((await post(g, { ...authorized, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(g, { ...authorized, 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await post(g, authorized)).status).toBe(200);
  });

  it('does not exist for a gateway with nothing to reload from', async () => {
    const a = await named('a');
    const { g } = await boot({ upstreams: { u: { url: a.url } }, routes: [{ path: '/', upstream: 'u' }] });
    expect((await post(g)).status).toBe(404);
  });
});
