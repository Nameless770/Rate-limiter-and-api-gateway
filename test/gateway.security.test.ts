/**
 * Behaviour an attacker would probe: rotating credentials to dodge limits, reaching internals, poisoning the
 * cache with headers an upstream reflects, spoofing where a request came from, and exhausting resources.
 */
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { keyDigest } from '../src/ratelimit/identity.js';
import {
  closedPort,
  type FakeUpstream,
  json,
  type RunningGateway,
  rawRequest,
  rawTcp,
  sleep,
  startGateway,
  startUpstream,
  type UpstreamHandler,
  type UpstreamOptions,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function upstream(handler: UpstreamHandler, options?: UpstreamOptions): Promise<FakeUpstream> {
  const u = await startUpstream(handler, options);
  cleanups.push(u.close);
  return u;
}

async function gateway(
  raw: Record<string, unknown>,
  deps?: Parameters<typeof startGateway>[1],
): Promise<RunningGateway> {
  const g = await startGateway(raw, deps);
  cleanups.push(g.close);
  return g;
}

const echo: UpstreamHandler = (_req, res, hit) =>
  json(res, 200, { method: hit.method, url: hit.url, body: hit.body, headers: hit.headers });

const sw = (limit: number, windowMs = 10_000) => ({ algorithm: 'sliding-window', limit, windowMs });
const get = (g: RunningGateway, path: string, headers: Record<string, string> = {}) =>
  rawRequest(g.base, { path, headers });
const code = (body: string): string => (JSON.parse(body) as { error: { code: string } }).error.code;

describe('rotating API key values to dodge rate limits', () => {
  it('open mode: the per-address ceiling bounds a client that mints a new key every request', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      rateLimit: { default: sw(5), ip: sw(8) },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await get(g, '/x', { 'x-api-key': `fresh-key-${i}` })).status);

    // Each fresh key has its own route budget, so only the address ceiling can stop this.
    expect(statuses).toEqual([...Array(8).fill(200), ...Array(4).fill(429)]);
    expect(up.hits).toHaveLength(8);
  });

  it('registry mode: unregistered keys share the budget of their address, so rotation gains nothing', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      rateLimit: { default: sw(3), apiKeys: [{ name: 'alice', sha256: keyDigest('alice-secret') }] },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const guesses: number[] = [];
    for (let i = 0; i < 6; i++) guesses.push((await get(g, '/x', { 'x-api-key': `guess-${i}` })).status);
    expect(guesses).toEqual([200, 200, 200, 429, 429, 429]);

    // A registered key is not affected by what happened to the anonymous budget.
    expect((await get(g, '/x', { 'x-api-key': 'alice-secret' })).status).toBe(200);
  });

  it('requireKey: turns away callers without a registered key before touching the upstream', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      rateLimit: {
        default: sw(100),
        requireKey: true,
        apiKeys: [{ name: 'alice', sha256: keyDigest('alice-secret') }],
      },
      routes: [{ path: '/', upstream: 'u' }],
    });

    const missing = await get(g, '/x');
    const wrong = await get(g, '/x', { 'x-api-key': 'not-registered' });
    const ok = await get(g, '/x', { 'x-api-key': 'alice-secret' });

    expect([missing.status, wrong.status, ok.status]).toEqual([401, 401, 200]);
    expect(code(missing.body)).toBe('unauthorized');
    expect(missing.headers['www-authenticate']).toBe('ApiKey');
    expect(up.hits).toHaveLength(1);
  });
});

describe('plans, per-key overrides and the anonymous multiplier', () => {
  const alice = { name: 'alice', sha256: keyDigest('alice-secret'), plan: 'pro' };
  const bob = { name: 'bob', sha256: keyDigest('bob-secret') };
  const carol = {
    name: 'carol',
    sha256: keyDigest('carol-secret'),
    overrides: { open: false, tight: sw(1), loose: sw(50) },
  };

  async function setup() {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      rateLimit: {
        default: sw(2),
        plans: { pro: { multiplier: 3 } },
        apiKeys: [alice, bob, carol],
        anonymousMultiplier: 0.5,
      },
      routes: [
        { path: '/api', id: 'api', upstream: 'u' },
        { path: '/open', id: 'open', upstream: 'u' },
        { path: '/tight', id: 'tight', upstream: 'u' },
        { path: '/loose', id: 'loose', upstream: 'u' },
      ],
    });
    return { up, g };
  }
  const burst = async (g: RunningGateway, path: string, key: string | undefined, n: number) => {
    const statuses: number[] = [];
    for (let i = 0; i < n; i++) {
      statuses.push((await get(g, path, key ? { 'x-api-key': key } : {})).status);
    }
    return statuses.filter((s) => s === 200).length;
  };

  it('a plan multiplies the route rule for the keys on it', async () => {
    const { g } = await setup();
    expect(await burst(g, '/api/a', 'alice-secret', 10)).toBe(6); // 2 x 3
    expect(await burst(g, '/api/a', 'bob-secret', 10)).toBe(2); // the plain default
  });

  it('an override replaces the rule on that route, in either direction, or lifts it entirely', async () => {
    const { g } = await setup();
    expect(await burst(g, '/tight/a', 'carol-secret', 5)).toBe(1); // stricter than the default of 2
    expect(await burst(g, '/loose/a', 'carol-secret', 60)).toBe(50); // looser
    expect(await burst(g, '/open/a', 'carol-secret', 30)).toBe(30); // unlimited
    expect(await burst(g, '/api/a', 'carol-secret', 10)).toBe(2); // no override here: default applies
  });

  it('callers without a registered key get the scaled-down anonymous allowance', async () => {
    const { g } = await setup();
    expect(await burst(g, '/api/a', undefined, 10)).toBe(1); // 2 x 0.5
  });

  it('overrides on one key never leak to another', async () => {
    const { g } = await setup();
    expect(await burst(g, '/open/a', 'bob-secret', 10)).toBe(2);
  });
});

describe('the admin listener', () => {
  it('is never reachable through the proxy port, even with a catch-all route', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });

    for (const path of [
      '/_gateway/health',
      '/_gateway/metrics',
      '/_gateway/live',
      '/_gateway',
      '/_gateway/../_gateway/health',
    ]) {
      const res = await get(g, path);
      expect(res.status, path).toBe(404);
    }
    expect(up.hits).toHaveLength(0); // not forwarded either
  });

  it('keeps liveness open and gates health and metrics behind the bearer token', async () => {
    const up = await upstream(echo);
    const token = 'correct-horse-battery-staple';
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      admin: { token },
    });
    const at = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
      rawRequest(g.adminBase, { path, method, headers });

    expect((await at('/_gateway/live')).status).toBe(200);
    expect(JSON.parse((await at('/_gateway/live')).body)).toEqual({ status: 'ok' }); // says nothing about internals

    expect((await at('/_gateway/health')).status).toBe(401);
    expect((await at('/_gateway/metrics')).status).toBe(401);
    expect((await at('/_gateway/health')).headers['www-authenticate']).toBe('Bearer');
    expect((await at('/_gateway/health', { authorization: 'Bearer wrong-token-of-same-length!' })).status).toBe(401);
    expect((await at('/_gateway/health', { authorization: token })).status).toBe(401); // scheme required
    expect((await at('/_gateway/health', { authorization: `Bearer ${token}` })).status).toBe(200);
    expect((await at('/_gateway/metrics', { authorization: `Bearer ${token}` })).status).toBe(200);

    expect((await at('/_gateway/health', { authorization: `Bearer ${token}` }, 'POST')).status).toBe(405);
    expect((await at('/_gateway/nope', { authorization: `Bearer ${token}` })).status).toBe(404);
  });

  it('exposes process and connection metrics alongside the request metrics', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    await get(g, '/x');
    const text = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    for (const name of [
      'process_resident_memory_bytes',
      'nodejs_heap_used_bytes',
      'nodejs_eventloop_delay_seconds',
      'process_cpu_seconds_total',
      'gateway_connections',
      'gateway_inflight_requests',
      'gateway_requests_total',
    ]) {
      expect(text, name).toContain(`# TYPE ${name}`);
    }
    expect(text).toMatch(/^process_resident_memory_bytes \d+/m);
  });

  it('can be switched off', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      admin: { enabled: false },
    });
    expect(g.gateway.adminAddress).toBeUndefined();
  });
});

describe('cache poisoning through headers the upstream reflects', () => {
  /** An upstream that, like many frameworks, builds absolute links and echoes headers into the body. */
  const reflecting: UpstreamHandler = (_req, res, hit) =>
    json(res, 200, {
      link: `https://${hit.headers['x-forwarded-host'] ?? 'default.example'}/page`,
      originalUrl: hit.headers['x-original-url'] ?? null,
      lang: hit.headers['accept-language'] ?? null,
      userAgent: hit.headers['user-agent'] ?? null,
    });
  const cached = { path: '/', upstream: 'u', cache: { ttlMs: 60_000 } };

  it('ignores hostile forwarding and rewrite headers, so they cannot reach a response other clients receive', async () => {
    const up = await upstream(reflecting);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cached] });

    const attack = await get(g, '/page', {
      'x-forwarded-host': 'evil.example',
      'x-original-url': '/admin',
      'x-host': 'evil.example',
      forwarded: 'host=evil.example',
      'user-agent': '<script>alert(1)</script>',
    });
    expect(attack.status).toBe(200);
    expect(JSON.parse(attack.body)).toMatchObject({
      link: 'https://default.example/page',
      originalUrl: null,
      userAgent: null,
    });

    // The same cache entry is what the next client gets.
    const victim = await get(g, '/page');
    expect(victim.headers['x-cache']).toBe('HIT');
    expect(victim.body).not.toContain('evil.example');
    expect(victim.body).not.toContain('<script>');
    expect(up.hits).toHaveLength(1);
    expect(up.hits[0]?.headers['x-forwarded-host']).toBeUndefined();
    expect(up.hits[0]?.headers['x-original-url']).toBeUndefined();
  });

  it('keys the headers it does forward, so a hostile value only reaches requests that send that same value', async () => {
    const up = await upstream(reflecting);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cached] });

    const poisoned = await get(g, '/page', { 'accept-language': '<img src=x onerror=alert(1)>' });
    expect(JSON.parse(poisoned.body).lang).toBe('<img src=x onerror=alert(1)>'); // the attacker sees their own reflection

    const victim = await get(g, '/page', { 'accept-language': 'en-US' });
    expect(victim.headers['x-cache']).toBe('MISS'); // a different key: never served the poisoned entry
    expect(JSON.parse(victim.body).lang).toBe('en-US');

    const another = await get(g, '/page', { 'accept-language': 'en-US' });
    expect(another.headers['x-cache']).toBe('HIT');
    expect(another.body).not.toContain('onerror');
  });

  it('withholds the same headers from a cacheable fetch even when only some are on the allowlist', async () => {
    const up = await upstream(reflecting);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ ...cached, cache: { ttlMs: 60_000, forwardHeaders: ['accept-language', 'user-agent'] } }],
    });
    await get(g, '/page', { 'user-agent': 'custom-agent/1.0', 'x-forwarded-host': 'evil.example' });
    expect(up.hits[0]?.headers['user-agent']).toBe('custom-agent/1.0'); // opted in
    expect(up.hits[0]?.headers['x-forwarded-host']).toBeUndefined(); // never on the list
  });

  it('does not strip headers on routes that are not cached', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    await get(g, '/x', { 'user-agent': 'my-client/2', 'x-custom': 'kept', 'accept-language': 'fr' });
    expect(up.hits[0]?.headers).toMatchObject({
      'user-agent': 'my-client/2',
      'x-custom': 'kept',
      'accept-language': 'fr',
    });
  });
});

describe('spoofed forwarding headers', () => {
  const route = { path: '/', upstream: 'u' };

  it('as the edge, discards what the client claims and reports only what the socket showed', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [route] });
    await get(g, '/x', {
      'x-forwarded-for': '6.6.6.6, 7.7.7.7',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
      'x-real-ip': '8.8.8.8',
      forwarded: 'for=9.9.9.9;proto=https;host=evil.example',
      'x-http-method-override': 'DELETE',
      'x-method-override': 'DELETE',
      'x-original-url': '/admin',
      'x-rewrite-url': '/admin',
    });
    const seen = up.hits[0]?.headers ?? {};
    expect(seen['x-forwarded-for']).toMatch(/^(127\.0\.0\.1|::1)$/);
    expect(seen['x-forwarded-proto']).toBe('http');
    for (const header of [
      'x-forwarded-host',
      'x-real-ip',
      'forwarded',
      'x-http-method-override',
      'x-method-override',
      'x-original-url',
      'x-rewrite-url',
    ]) {
      expect(seen[header], header).toBeUndefined();
    }
  });

  it('sets X-Forwarded-Host from configuration, never from the client Host header', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [route],
      forwardedHost: 'api.example.com',
    });
    await get(g, '/x', { host: 'attacker.example', 'x-forwarded-host': 'evil.example' });
    expect(up.hits[0]?.headers['x-forwarded-host']).toBe('api.example.com');
  });

  it('behind trusted proxies, keeps their chain and the headers they set', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [route],
      rateLimit: { trustedProxyHops: 1 },
    });
    await get(g, '/x', {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'shop.example.com',
      'x-http-method-override': 'DELETE',
    });
    const seen = up.hits[0]?.headers ?? {};
    expect(seen['x-forwarded-for']).toMatch(/^203\.0\.113\.9, (127\.0\.0\.1|::1)$/);
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['x-forwarded-host']).toBe('shop.example.com');
    expect(seen['x-http-method-override']).toBeUndefined(); // dropped regardless of who sent it
  });

  it('strips headers named in Connection, so a client cannot smuggle a header past the hop-by-hop rule', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [route] });
    await get(g, '/x', { connection: 'close, x-internal-auth', 'x-internal-auth': 'forged' });
    expect(up.hits[0]?.headers['x-internal-auth']).toBeUndefined();
  });
});

describe('identifying clients behind a proxy', () => {
  const limited = { upstreams: { u: { url: '' } }, routes: [{ path: '/', upstream: 'u' }] };

  async function proxied(limit: number) {
    const up = await upstream(echo);
    const g = await gateway({
      ...limited,
      upstreams: { u: { url: up.url } },
      rateLimit: { trustedProxyHops: 1, default: sw(limit) },
    });
    return { up, g, call: (xff: string) => get(g, '/x', { 'x-forwarded-for': xff }) };
  }

  it('shares one budget across an IPv6 /64, so a subscriber cannot mint addresses', async () => {
    const { call } = await proxied(2);
    const results = [
      (await call('2001:db8:aaaa:1:1::1')).status,
      (await call('2001:db8:aaaa:1:2:3:4:5')).status,
      (await call('2001:db8:aaaa:1:ffff::9')).status, // a third address in the same /64
    ];
    expect(results).toEqual([200, 200, 429]);
    expect((await call('2001:db8:aaaa:2::1')).status).toBe(200); // a different /64 is a different client
  });

  it('keeps IPv4 clients separate and unifies IPv4-mapped IPv6 with plain IPv4', async () => {
    const { call } = await proxied(1);
    expect((await call('198.51.100.1')).status).toBe(200);
    expect((await call('198.51.100.1')).status).toBe(429);
    expect((await call('198.51.100.2')).status).toBe(200);
    expect((await call('::ffff:198.51.100.1')).status).toBe(429); // the same client, written differently
  });

  it('never uses attacker-chosen text as a key: unparseable addresses collapse onto the socket address', async () => {
    const { call } = await proxied(2);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await call(`not-an-address-${i}-${'x'.repeat(200)}`)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  it('uses the entry the nearest trusted proxy appended, not the client-supplied left side', async () => {
    const { call } = await proxied(1);
    // The client prepends whatever it likes; only the right-most entry (added by our proxy) counts.
    expect((await call('6.6.6.6, 203.0.113.50')).status).toBe(200);
    expect((await call('7.7.7.7, 203.0.113.50')).status).toBe(429);
    expect((await call('7.7.7.7, 203.0.113.51')).status).toBe(200);
  });
});

describe('methods', () => {
  it('refuses methods outside the allowlist with 405 and an Allow header, without contacting the upstream', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });

    const trace = await rawRequest(g.base, { method: 'TRACE', path: '/x' });
    expect(trace.status).toBe(405);
    expect(trace.headers['allow']).toBe('GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');
    expect(code(trace.body)).toBe('method_not_allowed');
    expect(up.hits).toHaveLength(0);
  });

  it('is configurable', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      allowedMethods: ['get', 'head'],
    });
    expect((await rawRequest(g.base, { method: 'POST', path: '/x', chunks: ['a'] })).status).toBe(405);
    expect((await rawRequest(g.base, { method: 'GET', path: '/x' })).status).toBe(200);
  });
});

describe('errors carry no internals', () => {
  it('a refused connection says nothing about the upstream address or the system error', async () => {
    const port = await closedPort();
    const g = await gateway({
      upstreams: { dead: { url: `http://127.0.0.1:${port}`, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'dead' }],
    });
    const res = await get(g, '/x');
    expect(res.status).toBe(502);
    expect(res.body).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|localhost/);
    expect(res.body).not.toContain(String(port));
    expect(JSON.parse(res.body).error).toEqual({
      code: 'bad_gateway',
      message: 'the upstream request failed',
      requestId: res.headers['x-request-id'],
    });
  });

  it('a timeout does not reveal the configured limit', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(400);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: { u: { url: up.url, timeoutMs: 100, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await get(g, '/x');
    expect(res.status).toBe(504);
    expect(res.body).not.toMatch(/\d+\s*ms/);
  });

  it('a 404 does not echo the requested path or method back', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/known', upstream: 'u' }] });
    const res = await get(g, '/secret-internal-path?token=abc123');
    expect(res.status).toBe(404);
    expect(res.body).not.toContain('secret-internal-path');
    expect(res.body).not.toContain('abc123');
  });

  it('marks its own errors as non-cacheable and non-sniffable', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', rateLimit: sw(1) }],
    });
    await get(g, '/x');
    const limited = await get(g, '/x');
    expect(limited.status).toBe(429);
    expect(limited.headers['x-content-type-options']).toBe('nosniff');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(limited.headers['content-type']).toContain('application/json');
  });

  it('logs the detail it withholds from the client, against the same request id', async () => {
    const port = await closedPort();
    const lines: Array<Record<string, unknown>> = [];
    const { createLogger } = await import('../src/observability/logger.js');
    const logger = createLogger('debug', (l) => void lines.push(JSON.parse(l)));
    const g = await gateway(
      {
        upstreams: { dead: { url: `http://127.0.0.1:${port}`, retry: { maxAttempts: 1 } } },
        routes: [{ path: '/', upstream: 'dead' }],
      },
      { logger },
    );
    const res = await get(g, '/x');
    const entry = lines.find((l) => l['msg'] === 'upstream error');
    expect(entry).toMatchObject({ requestId: res.headers['x-request-id'], kind: 'connect', upstream: 'dead' });
    expect(String(entry?.['detail'])).toContain('ECONNREFUSED');
  });
});

describe('resource limits', () => {
  it('sheds load with 503 once too many requests are in flight, and recovers when they finish', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(300);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      limits: { maxInFlight: 2 },
    });

    const results = await Promise.all([0, 1, 2, 3].map((i) => sleep(i * 20).then(() => get(g, '/slow'))));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 503, 503]);
    const shed = results.find((r) => r.status === 503);
    expect(code(shed?.body ?? '')).toBe('overloaded');
    expect(shed?.headers['retry-after']).toBe('1');

    expect((await get(g, '/slow')).status).toBe(200); // capacity is back
  });

  it('caps connections per client address', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      limits: { maxConnectionsPerIp: 3 },
    });
    const { hostname, port } = new URL(g.base);
    const sockets: import('node:net').Socket[] = [];
    const net = await import('node:net');
    const closedFlags: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const s = net.connect({ host: hostname, port: Number(port) });
      closedFlags.push(false);
      s.on('close', () => {
        closedFlags[i] = true;
      });
      s.on('error', () => {});
      sockets.push(s);
      await sleep(30);
    }
    await sleep(100);
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
    });

    expect(closedFlags.slice(0, 3)).toEqual([false, false, false]);
    expect(closedFlags.slice(3)).toEqual([true, true]); // the 4th and 5th were refused
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).toMatch(/gateway_connections_rejected_total\{reason="per_ip"\} 2/);

    // Freeing a slot lets a new connection in.
    sockets[0]?.destroy();
    await sleep(60);
    expect((await get(g, '/x')).status).toBe(200);
  });

  it('refuses request bodies once the in-memory buffer budget is spent', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      maxBodyBytes: 100_000,
      limits: { maxBufferedBytes: 1_000 },
    });
    const declared = await rawRequest(g.base, {
      method: 'POST',
      path: '/up',
      chunks: ['x'.repeat(5_000)],
      headers: { 'content-length': '5000' },
    });
    expect(declared.status).toBe(503);
    expect(code(declared.body)).toBe('overloaded');

    const chunked = await rawRequest(g.base, {
      method: 'POST',
      path: '/up',
      chunks: ['x'.repeat(600), 'x'.repeat(600), 'x'.repeat(600)],
      chunkDelayMs: 15,
    });
    expect(chunked.status).toBe(503);
    expect(up.hits).toHaveLength(0);

    // A request within budget still works, and the budget is released afterwards.
    expect((await rawRequest(g.base, { method: 'POST', path: '/up', chunks: ['y'.repeat(500)] })).status).toBe(200);
    expect((await rawRequest(g.base, { method: 'POST', path: '/up', chunks: ['y'.repeat(500)] })).status).toBe(200);
  });

  it('accepts requests whose headers fit and refuses ones that do not, with 431', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      limits: { maxHeaderBytes: 1024 },
    });
    expect((await get(g, '/x', { 'x-pad': 'a'.repeat(300) })).status).toBe(200);
    const big = await get(g, '/x', { 'x-pad': 'a'.repeat(2000) });
    expect(big.status).toBe(431);
    expect(up.hits.map((h) => h.url)).toEqual(['/x']);
  });

  it('disconnects a client that never finishes sending its headers (slowloris)', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
      limits: { headersTimeoutMs: 300 },
    });
    const result = await rawTcp(g.base, 'GET /x HTTP/1.1\r\nHost: a\r\nX-Slow: ', { waitMs: 4_000 });
    expect(result.closed).toBe(true);
    expect(result.openedForMs).toBeLessThan(3_000); // nowhere near forever
    expect(up.hits).toHaveLength(0);
  });

  it('returns the gateway to a normal state after all of the above', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    await Promise.all(Array.from({ length: 20 }, () => get(g, '/x')));
    await sleep(30);
    const health = JSON.parse((await rawRequest(g.adminBase, { path: '/_gateway/health' })).body);
    expect(health.inFlight).toBe(0);
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).toMatch(/^gateway_buffered_request_bytes 0$/m);
  });
});

// A reference so the unused-import guard stays honest if a helper is dropped from a future edit.
void http;

describe('access logs', () => {
  it('bound the request path, so a long URL cannot amplify into a long log line', async () => {
    const up = await upstream(echo);
    const lines: Array<Record<string, unknown>> = [];
    const { createLogger } = await import('../src/observability/logger.js');
    const logger = createLogger('info', (l) => void lines.push(JSON.parse(l)));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] }, { logger });

    await get(g, `/${'p'.repeat(6000)}`);
    await sleep(20);
    const entry = lines.find((l) => l['msg'] === 'request');
    const logged = String(entry?.['path']);
    expect(logged.length).toBeLessThanOrEqual(513);
    expect(logged.endsWith('…')).toBe(true);
    expect(JSON.stringify(entry).length).toBeLessThan(1500);
  });
});
