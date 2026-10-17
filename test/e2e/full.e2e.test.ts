/**
 * End to end, the whole product at once: TLS, API keys and JWTs, a pool of two real upstream instances with active
 * health checks, a cached route, WebSockets, and a real Redis reached through a proxy the test can cut. Everything
 * runs as separate processes and is driven over the network, so what is checked is what an operator would see.
 *
 * Needs a Redis (REDIS_URL), like the other integration tests.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { keyDigest } from '../../src/ratelimit/identity.js';
import { fixture, httpsRequest, sleep } from '../helpers.js';
import { signJwt, testKeys } from '../jwtHelpers.js';
import { openWs, startWsUpstream, type WsSession, type WsUpstream } from '../wsHelpers.js';
import {
  cleanupAll,
  type DemoUpstream,
  type GatewayProc,
  type Loose,
  metric,
  onCleanup,
  startDemoUpstream,
  startGatewayProc,
  startTcpProxy,
  type TcpProxy,
  until,
} from './stack.js';

afterEach(cleanupAll);

const redisUrl = process.env['REDIS_URL'];
const ca = readFileSync(fixture('tls/localhost-cert.pem'));
const keys = testKeys();
const ORIGIN = 'https://app.example.com';
const ADMIN_TOKEN = 'e2e-admin-token-0123456789';
const CLIENTS = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank'];

interface Stack {
  a: DemoUpstream;
  b: DemoUpstream;
  ws: WsUpstream;
  redis: TcpProxy;
  gw: GatewayProc;
  config: Record<string, unknown>;
  /** One HTTPS request through the gateway. */
  call(path: string, headers?: Record<string, string>, gw?: GatewayProc): ReturnType<typeof httpsRequest>;
  /** Open a wss:// connection through the gateway. */
  socket(headers?: Record<string, string>, path?: string): ReturnType<typeof openWs>;
}

const json = (body: string): Loose => JSON.parse(body) as Loose;

async function boot(options: { workers?: number } = {}): Promise<Stack> {
  const a = await startDemoUpstream();
  const b = await startDemoUpstream();
  const ws = await startWsUpstream();
  onCleanup(ws.close);
  const target = new URL(redisUrl as string);
  const redis = await startTcpProxy({ host: target.hostname, port: Number(target.port || 6379) });

  const config: Record<string, unknown> = {
    tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem') },
    admin: { port: 0, token: ADMIN_TOKEN },
    ...(options.workers ? { cluster: { workers: options.workers } } : {}),
    // The default 100 ms command timeout is for production; these tests share a busy machine with the gateway.
    redis: {
      url: `redis://127.0.0.1:${redis.port}`,
      commandTimeoutMs: 300,
      keyPrefix: `e2e-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}:`,
    },
    rateLimit: {
      failureMode: 'local',
      apiKeys: CLIENTS.map((name) => ({ name, sha256: keyDigest(`${name}-key`) })),
      default: { algorithm: 'sliding-window', limit: 20, windowMs: 60_000 },
    },
    auth: {
      forwardCredentials: false,
      jwt: { issuers: [{ name: 'partner', alg: 'HS256', secret: keys.hmacSecret, audience: 'gateway' }] },
    },
    upstreams: {
      pool: {
        urls: [a.url, b.url],
        timeoutMs: 1_500,
        retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 50 },
        healthCheck: { path: '/health', intervalMs: 300, timeoutMs: 200, unhealthyThreshold: 2, healthyThreshold: 2 },
      },
      chat: { url: ws.url },
    },
    routes: [
      { id: 'api', path: '/api', upstream: 'pool', auth: { methods: ['api-key', 'jwt'] } },
      { id: 'open', path: '/open', upstream: 'pool', rateLimit: false },
      { id: 'public', path: '/public', upstream: 'pool', rateLimit: false, cache: { ttlMs: 60_000 } },
      {
        id: 'chat',
        path: '/chat',
        upstream: 'chat',
        stripPrefix: false,
        auth: { methods: ['api-key', 'jwt'] },
        websocket: { allowedOrigins: [ORIGIN], idleTimeoutMs: 30_000 },
      },
    ],
  };
  const gw = await startGatewayProc(config);
  return {
    a,
    b,
    ws,
    redis,
    gw,
    config,
    call: (path, headers = {}, to = gw) => httpsRequest(to.base, { path, ca, headers }),
    socket: (headers = {}, path = '/chat') =>
      openWs(gw.base, { path, tlsCa: ca, headers: { Origin: ORIGIN, ...headers } }),
  };
}

const key = (name: string): Record<string, string> => ({ 'x-api-key': `${name}-key` });
const token = (sub: string, extra: Record<string, unknown> = {}): string =>
  signJwt({
    alg: 'HS256',
    key: keys.hmacSecret,
    payload: { sub, aud: 'gateway', exp: Math.floor(Date.now() / 1000) + 600, ...extra },
  });

describe.skipIf(!redisUrl)('the whole product, end to end', { timeout: 90_000 }, () => {
  it('authenticates callers and tells the upstream who they are, over TLS, without trusting what they claim', async () => {
    const s = await boot();

    const byKey = await s.call('/api/echo', {
      ...key('alice'),
      'x-authenticated-client': 'root',
      'x-forwarded-proto': 'http',
    });
    expect(byKey.status).toBe(200);
    const seen = json(byKey.body)['headers'];
    expect(seen['x-authenticated-client']).toBe('alice'); // the forged claim is replaced by the verified one
    expect(seen['x-authenticated-method']).toBe('api-key');
    expect(seen['x-api-key']).toBeUndefined(); // consumed here, not handed on
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(byKey.headers['x-request-id']).toBeTruthy();
    expect(byKey.headers['ratelimit-limit']).toBe('20');

    const byJwt = await s.call('/api/echo', { authorization: `Bearer ${token('zoe')}` });
    expect(byJwt.status).toBe(200);
    expect(json(byJwt.body)['headers']['x-authenticated-client']).toBe('zoe');
    expect(json(byJwt.body)['headers']['x-authenticated-issuer']).toBe('partner');
    expect(json(byJwt.body)['headers']['authorization']).toBeUndefined();

    for (const bad of [
      {},
      key('mallory'),
      { authorization: 'Bearer nonsense' },
      { authorization: `Bearer ${token('zoe', { exp: Math.floor(Date.now() / 1000) - 3_600 })}` },
      { authorization: `Bearer ${token('zoe', { aud: 'someone-else' })}` },
    ]) {
      const res = await s.call('/api/echo', bad);
      expect(res.status, JSON.stringify(bad)).toBe(401);
      expect(res.headers['www-authenticate']).toBeDefined();
      expect(res.body).not.toMatch(/expired|signature|audience/i); // why is for the log, not for the caller
    }
    // The operator's view of the same traffic.
    const text = await s.gw.metrics();
    expect(metric(text, 'gateway_auth_total', { route: 'api', result: 'ok' })).toBe(2);
    expect(metric(text, 'gateway_auth_total', { route: 'api', result: 'fail' })).toBe(5);
  });

  it('shares one rate-limit budget across two gateway processes, as the docker-compose setup promises', async () => {
    const s = await boot();
    const second = await startGatewayProc(s.config); // same config, same Redis keys, its own process and port
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await s.call('/api/echo', key('carol'), s.gw)).status);
      statuses.push((await s.call('/api/echo', key('carol'), second)).status);
    }
    expect(statuses.filter((v) => v === 200)).toHaveLength(20); // not 20 each
    expect(statuses.filter((v) => v === 429)).toHaveLength(4);
    // And the budget really is per caller: bob has all of his.
    expect((await s.call('/api/echo', key('bob'), second)).status).toBe(200);
  });

  it('keeps serving, with no errors for clients, while an upstream instance dies and comes back', async () => {
    const s = await boot();
    const served = { a: 0, b: 0 };
    const bad: Array<number | string> = [];
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        try {
          const res = await s.call('/open/echo');
          if (res.status !== 200) bad.push(res.status);
          else {
            const host = json(res.body)['headers']['host'] as string;
            if (host.endsWith(`:${s.a.port}`)) served.a++;
            else if (host.endsWith(`:${s.b.port}`)) served.b++;
          }
        } catch (error) {
          bad.push((error as Error).message);
        }
      }
    };
    const workers = Array.from({ length: 6 }, worker);
    const hostLoad = async (ms: number): Promise<{ a: number; b: number }> => {
      const before = { ...served };
      await sleep(ms);
      return { a: served.a - before.a, b: served.b - before.b };
    };

    const healthy = async (d: DemoUpstream): Promise<number> =>
      metric(await s.gw.metrics(), 'gateway_target_healthy', { target: `127.0.0.1:${d.port}` });

    const beforeCrash = await hostLoad(700);
    expect(beforeCrash.a).toBeGreaterThan(0); // both instances share the load
    expect(beforeCrash.b).toBeGreaterThan(0);

    await s.a.crash();
    await until(async () => (await healthy(s.a)) === 0, 8_000, 'the health check to eject the dead instance');
    const afterEject = await hostLoad(800);
    expect(afterEject.a).toBe(0); // no more traffic is sent into the hole
    expect(afterEject.b).toBeGreaterThan(0);

    await startDemoUpstream(s.a.port); // the instance returns on the same address
    await until(async () => (await healthy(s.a)) === 1, 8_000, 'the instance to be readmitted');
    await until(
      async () => {
        const slice = await hostLoad(500);
        return slice.a > 0;
      },
      8_000,
      'traffic to reach the returned instance',
    );

    stop = true;
    await Promise.all(workers);
    expect(bad).toEqual([]); // not one client saw the instance die
    const text = await s.gw.metrics();
    expect(metric(text, 'gateway_health_transitions_total')).toBeGreaterThanOrEqual(2); // out, then back in
  });

  it('collapses a burst of identical requests for a cached route into one upstream fetch', async () => {
    const s = await boot();
    const before = metric(await s.gw.metrics(), 'gateway_upstream_attempts_total');
    const burst = await Promise.all(Array.from({ length: 40 }, () => s.call('/public/slow?ms=400')));
    expect(burst.every((r) => r.status === 200)).toBe(true);
    expect(new Set(burst.map((r) => r.body)).size).toBe(1); // everyone got the same response
    expect(metric(await s.gw.metrics(), 'gateway_upstream_attempts_total') - before).toBe(1);

    const later = await s.call('/public/slow?ms=400');
    expect(later.headers['x-cache']).toBe('HIT');
    expect(later.body).toBe(burst[0]?.body);
  });

  it('proxies WebSockets over TLS, with the same authentication, origin and limits as everything else', async () => {
    const s = await boot();

    const refusals: Array<[string, Record<string, string>, number]> = [
      ['no credential', {}, 401],
      ['an unknown key', key('mallory'), 401],
      ['a page on another site', { ...key('dave'), Origin: 'https://evil.example' }, 403],
    ];
    for (const [what, headers, status] of refusals) {
      expect((await s.socket(headers)).status, what).toBe(status);
    }
    expect(s.ws.hits).toEqual([]); // none of them reached the upstream

    const ok = await s.socket(key('dave'));
    expect(ok.status).toBe(101);
    const socket = ok.ws as WsSession;
    onCleanup(() => socket.destroy());
    expect(s.ws.hits[0]?.headers['x-authenticated-client']).toBe('dave');
    expect(s.ws.hits[0]?.headers['x-forwarded-proto']).toBe('https');

    // HTTP traffic is unaffected by the open socket, and the socket by the HTTP traffic.
    for (let i = 0; i < 3; i++) expect((await s.call('/api/echo', key('dave'))).status).toBe(200);
    socket.send('hello through two hops');
    expect(await socket.nextText()).toBe('hello through two hops');
    expect(metric(await s.gw.metrics(), 'gateway_websocket_connections', { route: 'chat' })).toBe(1);

    // A JWT works for sockets too.
    const viaJwt = await s.socket({ authorization: `Bearer ${token('zoe')}` });
    expect(viaJwt.status).toBe(101);
    viaJwt.ws?.destroy();

    socket.destroy();
    await until(
      async () => metric(await s.gw.metrics(), 'gateway_websocket_connections', { route: 'chat' }) === 0,
      5_000,
      'the closed socket to be forgotten',
    );
  });

  describe('when Redis goes away while the gateway is running', () => {
    const remaining = (res: { headers: Record<string, string | string[] | undefined> }): string | undefined =>
      res.headers['ratelimit-remaining'] as string | undefined;

    it('stays up and keeps limiting locally when Redis hangs, then returns to shared limits when it comes back', async () => {
      const s = await boot();
      const first = await s.call('/api/echo', key('erin'));
      expect(first.status).toBe(200);
      expect(remaining(first)).toBe('19'); // an exact, shared count

      s.redis.setMode('blackhole'); // accepts connections, answers nothing
      const outcome: Array<{ status: number; ms: number; limited: boolean }> = [];
      for (let i = 0; i < 26; i++) {
        const started = Date.now();
        const res = await s.call('/api/echo', key('erin'));
        outcome.push({ status: res.status, ms: Date.now() - started, limited: remaining(res) === undefined });
      }
      // Nobody gets a 5xx for Redis's sake; the per-process fallback keeps the budget (20) rather than dropping it.
      expect(outcome.every((o) => o.status === 200 || o.status === 429)).toBe(true);
      expect(outcome.filter((o) => o.status === 200).length).toBeLessThanOrEqual(20);
      expect(outcome.filter((o) => o.status === 429).length).toBeGreaterThanOrEqual(6);
      // The first few requests wait out the 300 ms command timeout; then the breaker around Redis stops paying it.
      const late = outcome.slice(10).map((o) => o.ms);
      expect(Math.max(...late)).toBeLessThan(250);
      expect(metric(await s.gw.metrics(), 'gateway_ratelimit_degraded_total')).toBeGreaterThan(0);

      s.redis.setMode('open');
      let shared = false;
      await until(
        async () => {
          const res = await s.call('/api/echo', key('frank'));
          shared = res.status === 200 && remaining(res) !== undefined; // headers return only when the answer is exact
          return shared;
        },
        15_000,
        'limits to be shared again',
      );
      expect(shared).toBe(true);
      const settled = metric(await s.gw.metrics(), 'gateway_ratelimit_degraded_total');
      await s.call('/api/echo', key('frank'));
      expect(metric(await s.gw.metrics(), 'gateway_ratelimit_degraded_total')).toBe(settled); // no longer degrading
    });

    it('treats a refused connection the same way, and never blocks a request on it', async () => {
      const s = await boot();
      s.redis.setMode('refuse');
      const times: number[] = [];
      for (let i = 0; i < 8; i++) {
        const started = Date.now();
        expect((await s.call('/api/echo', key('bob'))).status).toBe(200);
        times.push(Date.now() - started);
      }
      expect(Math.max(...times)).toBeLessThan(500);
      expect((await s.gw.health())['redis']).not.toBe('ready');
      s.redis.setMode('open');
      await until(async () => (await s.gw.health())['redis'] === 'ready', 15_000, 'Redis to be reconnected');
    });
  });

  describe('as a cluster', () => {
    it('serves the same product from several workers: TLS, auth, a shared budget, WebSockets, one set of metrics', async () => {
      const s = await boot({ workers: 2 });
      const health = await s.gw.health();
      expect(health['cluster']).toMatchObject({ workers: 2, ready: 2 });

      const statuses: number[] = [];
      for (let i = 0; i < 24; i++) statuses.push((await s.call('/api/echo', key('alice'))).status);
      expect(statuses.filter((v) => v === 200)).toHaveLength(20); // one budget, however the connections were spread
      expect((await s.call('/api/echo')).status).toBe(401);

      const ws = await s.socket(key('bob'));
      expect(ws.status).toBe(101);
      ws.ws?.send('cluster');
      expect(await ws.ws?.nextText()).toBe('cluster');
      ws.ws?.destroy();

      const text = await s.gw.metrics();
      expect(metric(text, 'gateway_requests_total', { route: 'api', status: '200' })).toBe(20);
      expect(metric(text, 'gateway_rate_limited_total', { route: 'api' })).toBe(4);
      expect(text).toMatch(/worker="0"/);
      expect(text).toMatch(/worker="1"/);
    });
  });

  describe.skipIf(process.platform === 'win32')('shutting down (POSIX signals)', () => {
    it('finishes the request in flight, closes open sockets, refuses new work, and exits 0', async () => {
      const s = await boot();
      const socket = (await s.socket(key('alice'))).ws as WsSession;
      await s.a.latency(700);
      await s.b.latency(700);
      const slow = s.call('/open/echo');
      await sleep(200);

      const exit = s.gw.proc.stop('SIGTERM');
      expect((await slow).status).toBe(200); // not cut off
      expect(await socket.closesWithin(3_000)).toBe(true); // the socket is ended, not left dangling
      expect(await exit).toBe(0);
      await expect(s.call('/open/echo')).rejects.toThrow(); // nobody is listening any more
      expect(s.gw.proc.logs.some((l) => l['msg'] === 'shutting down')).toBe(true);
    });
  });
});
