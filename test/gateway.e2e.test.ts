import { afterEach, describe, expect, it } from 'vitest';
import {
  closedPort,
  type FakeUpstream,
  fakeRedis,
  json,
  type RunningGateway,
  rawGet,
  sleep,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function upstream(handler: Parameters<typeof startUpstream>[0]): Promise<FakeUpstream> {
  const u = await startUpstream(handler);
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

describe('proxying', () => {
  it('forwards method, path, query, headers and body, stripping the route prefix', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { users: { url: `${up.url}/api/v1` } },
      routes: [{ path: '/users', upstream: 'users' }],
    });

    const res = await fetch(`${g.base}/users/42?expand=true`, {
      method: 'POST',
      headers: { 'x-custom': 'yes', 'x-request-id': 'req-abc-123' },
      body: 'hello gateway',
    });
    const seen = (await res.json()) as { method: string; url: string; body: string; headers: Record<string, string> };

    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/v1/42?expand=true'); // base path + stripped route
    expect(seen.body).toBe('hello gateway');
    expect(seen.headers['x-custom']).toBe('yes');
    expect(seen.headers['host']).toBe(new URL(up.url).host); // rewritten to the upstream
    expect(seen.headers['x-forwarded-for']).toContain('127.0.0.1');
    expect(seen.headers['x-request-id']).toBe('req-abc-123');
    expect(res.headers.get('x-request-id')).toBe('req-abc-123');
  });

  it('replaces a client request id that is not safe to log or forward', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const res = await fetch(`${g.base}/x`, { headers: { 'x-request-id': 'has spaces; and "quotes"' } });
    const id = res.headers.get('x-request-id');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(up.hits[0]?.headers['x-request-id']).toBe(id);
  });

  it('returns 404 for unrouted paths without touching any upstream', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/known', upstream: 'u' }] });
    const res = await fetch(`${g.base}/unknown`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('route_not_found');
    expect(up.hits).toHaveLength(0);
  });

  it('normalizes dot-segments before routing, so a path cannot borrow another route’s rules', async () => {
    const internal = await upstream((_r, res) => json(res, 200, { internal: true }));
    const open = await upstream((_r, res) => json(res, 200, { open: true }));
    const g = await gateway({
      upstreams: { open: { url: open.url }, internal: { url: internal.url } },
      routes: [
        { path: '/public', upstream: 'open' },
        { path: '/internal', upstream: 'internal' },
      ],
    });

    // Sent verbatim (fetch would clean these up client-side). Both resolve to /internal/data.
    const dots = await rawGet(g.base, '/public/../internal/data');
    const encoded = await rawGet(g.base, '/public/%2e%2e/internal/data');

    expect(dots.status).toBe(200);
    expect(encoded.status).toBe(200);
    expect(internal.hits.map((h) => h.url)).toEqual(['/data', '/data']);
    expect(open.hits).toHaveLength(0); // never reached the route whose prefix was used as a decoy
  });

  it('ignores the origin in an absolute-form request target', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    // A client cannot steer the gateway at a different host this way: only the path is ever used.
    const res = await rawGet(g.base, 'http://169.254.169.254/latest/meta-data');
    expect(res.status).toBe(200);
    expect(up.hits[0]?.url).toBe('/latest/meta-data');
    expect(up.hits[0]?.headers['host']).toBe(new URL(up.url).host);
  });

  it('passes upstream error statuses and bodies through unchanged', async () => {
    const up = await upstream((_r, res) => json(res, 418, { teapot: true }, { 'x-from': 'upstream' }));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const res = await fetch(`${g.base}/brew`);
    expect(res.status).toBe(418);
    expect(res.headers.get('x-from')).toBe('upstream');
    expect(await res.json()).toEqual({ teapot: true });
  });

  it('rejects oversized request bodies with 413', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      maxBodyBytes: 10,
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/upload`, { method: 'POST', body: 'x'.repeat(100) });
    expect(res.status).toBe(413);
    expect(up.hits).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  const sliding = { algorithm: 'sliding-window', limit: 3, windowMs: 10_000 };

  it('limits per API key, with accurate headers and a Retry-After on rejection', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', rateLimit: sliding }],
    });
    const call = (key: string) => fetch(`${g.base}/x`, { headers: { 'x-api-key': key } });

    const remaining: Array<string | null> = [];
    for (let i = 0; i < 3; i++) {
      const res = await call('alice');
      expect(res.status).toBe(200);
      expect(res.headers.get('ratelimit-limit')).toBe('3');
      remaining.push(res.headers.get('ratelimit-remaining'));
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const blocked = await call('alice');
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe('rate_limited');

    // Another key is unaffected, and the blocked call never reached the upstream.
    expect((await call('bob')).status).toBe(200);
    expect(up.hits).toHaveLength(4);
  });

  it('admits traffic again once the window has slid past', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', rateLimit: sliding }],
    });
    const call = () => fetch(`${g.base}/x`, { headers: { 'x-api-key': 'k' } });
    for (let i = 0; i < 3; i++) await call();
    expect((await call()).status).toBe(429);
    g.clock.advance(10_000);
    expect((await call()).status).toBe(200);
  });

  it('falls back to the client address when there is no API key', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', rateLimit: sliding }],
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await fetch(`${g.base}/x`)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it('supports the token bucket: burst, then sustained refill', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', rateLimit: { algorithm: 'token-bucket', capacity: 2, refillPerSecond: 1 } }],
    });
    const call = () => fetch(`${g.base}/x`, { headers: { 'x-api-key': 'k' } });
    expect([(await call()).status, (await call()).status, (await call()).status]).toEqual([200, 200, 429]);
    g.clock.advance(1000);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(429);
  });

  it('keeps limits separate per route and honours `rateLimit: false`', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      rateLimit: { default: { algorithm: 'sliding-window', limit: 1, windowMs: 10_000 } },
      upstreams: { u: { url: up.url } },
      routes: [
        { path: '/a', upstream: 'u' },
        { path: '/b', upstream: 'u' },
        { path: '/open', upstream: 'u', rateLimit: false },
      ],
    });
    const call = (p: string) => fetch(`${g.base}${p}`, { headers: { 'x-api-key': 'k' } });
    expect((await call('/a')).status).toBe(200);
    expect((await call('/a')).status).toBe(429);
    expect((await call('/b')).status).toBe(200); // separate budget
    for (let i = 0; i < 5; i++) expect((await call('/open')).status).toBe(200);
  });
});

describe('redis-backed limiting and failure modes', () => {
  const route = {
    path: '/api',
    id: 'api',
    upstream: 'u',
    rateLimit: { algorithm: 'sliding-window', limit: 2, windowMs: 10_000 },
  };

  async function withRedis(failureMode: 'open' | 'closed' | 'local') {
    const up = await upstream(echo);
    const redis = fakeRedis();
    const g = await gateway(
      {
        redis: { url: 'redis://unused', keyPrefix: 'test:' },
        rateLimit: { failureMode },
        upstreams: { u: { url: up.url } },
        routes: [route],
      },
      { redis: redis.client },
    );
    return { up, g, redis };
  }

  it('namespaces keys by algorithm and route, and hashes credentials rather than storing them', async () => {
    const { g, redis } = await withRedis('local');
    const res = await fetch(`${g.base}/api/x`, { headers: { 'x-api-key': 'super-secret-key' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('ratelimit-remaining')).toBe('2'); // taken from the store's answer
    const [key] = redis.state.calls;
    expect(key).toMatch(/^test:rl:sw:api:k:[0-9a-f]{32}$/);
    expect(key).not.toContain('super-secret-key');
  });

  it('local mode: keeps enforcing limits per instance while Redis is down', async () => {
    const { g, redis } = await withRedis('local');
    redis.state.failing = true;
    const call = () => fetch(`${g.base}/api/x`, { headers: { 'x-api-key': 'k' } });
    expect([(await call()).status, (await call()).status, (await call()).status]).toEqual([200, 200, 429]);
    // Degraded decisions don't claim an authoritative remaining-count.
    expect((await call()).headers.get('ratelimit-remaining')).toBeNull();
  });

  it('open mode: lets traffic through unlimited while Redis is down', async () => {
    const { g, redis } = await withRedis('open');
    redis.state.failing = true;
    for (let i = 0; i < 6; i++) expect((await fetch(`${g.base}/api/x`)).status).toBe(200);
  });

  it('closed mode: refuses traffic with 503 while Redis is down', async () => {
    const { g, up, redis } = await withRedis('closed');
    redis.state.failing = true;
    const res = await fetch(`${g.base}/api/x`);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limiter_unavailable');
    expect(up.hits).toHaveLength(0);
  });

  it('stops calling a failing store, then resumes once it has recovered', async () => {
    const { g, redis } = await withRedis('local');
    redis.state.failing = true;
    for (let i = 0; i < 12; i++) await fetch(`${g.base}/api/x`, { headers: { 'x-api-key': `k${i}` } });
    // The store's breaker tripped after 5 failures; the other 7 requests never touched Redis.
    expect(redis.state.calls).toHaveLength(5);

    redis.state.failing = false;
    g.clock.advance(3_000);
    const res = await fetch(`${g.base}/api/x`, { headers: { 'x-api-key': 'fresh' } });
    expect(res.headers.get('ratelimit-remaining')).toBe('2'); // authoritative answers again
    expect(redis.state.calls).toHaveLength(6);
  });
});

describe('caching', () => {
  const cacheRoute = { path: '/', upstream: 'u', cache: { ttlMs: 30_000 } };

  it('serves repeat GETs from cache until the TTL expires', async () => {
    const up = await upstream((_r, res, _h, n) => json(res, 200, { n }));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });

    const first = await fetch(`${g.base}/thing`);
    expect(first.headers.get('x-cache')).toBe('MISS');
    expect(await first.json()).toEqual({ n: 1 });

    g.clock.advance(5000);
    const second = await fetch(`${g.base}/thing`);
    expect(second.headers.get('x-cache')).toBe('HIT');
    expect(second.headers.get('age')).toBe('5');
    expect(await second.json()).toEqual({ n: 1 });
    expect(up.hits).toHaveLength(1);

    g.clock.advance(25_000);
    const third = await fetch(`${g.base}/thing`);
    expect(third.headers.get('x-cache')).toBe('MISS');
    expect(await third.json()).toEqual({ n: 2 });
  });

  it('uses the upstream Cache-Control max-age over the route default', async () => {
    const up = await upstream((_r, res, _h, n) => json(res, 200, { n }, { 'cache-control': 'max-age=2' }));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });
    await fetch(`${g.base}/x`);
    g.clock.advance(1999);
    expect((await fetch(`${g.base}/x`)).headers.get('x-cache')).toBe('HIT');
    g.clock.advance(1);
    expect((await fetch(`${g.base}/x`)).headers.get('x-cache')).toBe('MISS');
  });

  it('treats different query strings as different resources', async () => {
    const up = await upstream((_r, res, hit) => json(res, 200, { url: hit.url }));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });
    await fetch(`${g.base}/list?page=1`);
    const other = await fetch(`${g.base}/list?page=2`);
    expect(other.headers.get('x-cache')).toBe('MISS');
    expect(await other.json()).toEqual({ url: '/list?page=2' });
  });

  it.each([
    ['Cache-Control: no-store', { 'cache-control': 'no-store' }],
    ['Cache-Control: private', { 'cache-control': 'private' }],
    ['Set-Cookie', { 'set-cookie': 'session=abc; HttpOnly' }],
  ])('never stores a response with %s', async (_name, headers) => {
    const up = await upstream((_r, res, _h, n) => json(res, 200, { n }, headers));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });
    await fetch(`${g.base}/x`);
    const second = await fetch(`${g.base}/x`);
    expect(second.headers.get('x-cache')).toBe('MISS');
    expect(up.hits).toHaveLength(2);
  });

  it('does not cache non-GET requests or failures', async () => {
    let status = 500;
    const up = await upstream((_r, res) => json(res, status, {}));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: { maxAttempts: 1 } } },
      routes: [cacheRoute],
    });
    await fetch(`${g.base}/x`);
    await fetch(`${g.base}/x`);
    expect(up.hits).toHaveLength(2); // 500s are not stored
    status = 200;
    await fetch(`${g.base}/y`, { method: 'POST', body: 'a' });
    await fetch(`${g.base}/y`, { method: 'POST', body: 'a' });
    expect(up.hits).toHaveLength(4);
  });

  it("isolates cached responses per API key so one client's data is never served to another", async () => {
    const up = await upstream((_r, res, hit) => json(res, 200, { forKey: hit.headers['x-api-key'] }));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });

    const alice1 = await fetch(`${g.base}/me`, { headers: { 'x-api-key': 'alice' } });
    const bob = await fetch(`${g.base}/me`, { headers: { 'x-api-key': 'bob' } });
    const alice2 = await fetch(`${g.base}/me`, { headers: { 'x-api-key': 'alice' } });

    expect(await alice1.json()).toEqual({ forKey: 'alice' });
    expect(await bob.json()).toEqual({ forKey: 'bob' });
    expect(bob.headers.get('x-cache')).toBe('MISS');
    expect(alice2.headers.get('x-cache')).toBe('HIT');
    expect(await alice2.json()).toEqual({ forKey: 'alice' });
  });

  it('bypasses the cache for credentials it is not keyed on', async () => {
    const up = await upstream((_r, res, _h, n) => json(res, 200, { n }));
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', cache: { ttlMs: 30_000, varyHeaders: [] } }],
    });
    const call = () => fetch(`${g.base}/x`, { headers: { authorization: 'Bearer token' } });
    expect((await call()).headers.get('x-cache')).toBe('BYPASS');
    expect((await call()).headers.get('x-cache')).toBe('BYPASS');
    expect(up.hits).toHaveLength(2);
  });

  it('honours Vary from the upstream', async () => {
    const up = await upstream((_r, res, hit) =>
      json(res, 200, { lang: hit.headers['accept-language'] }, { vary: 'Accept-Language' }),
    );
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });
    const get = (lang: string) => fetch(`${g.base}/greeting`, { headers: { 'accept-language': lang } });
    await get('fr');
    expect((await get('fr')).headers.get('x-cache')).toBe('HIT');
    const en = await get('en');
    expect(en.headers.get('x-cache')).toBe('MISS');
    expect(await en.json()).toEqual({ lang: 'en' });
  });

  it('coalesces a burst of identical cache misses into one upstream request', async () => {
    const up = await upstream(async (_r, res, _h, n) => {
      await sleep(100);
      json(res, 200, { n });
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });

    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`${g.base}/hot`)));
    const bodies = await Promise.all(responses.map((r) => r.json()));

    expect(up.hits).toHaveLength(1);
    expect(bodies.every((b) => (b as { n: number }).n === 1)).toBe(true);
  });

  it('does not share an uncacheable response between coalesced requests', async () => {
    const up = await upstream(async (_r, res, _h, n) => {
      await sleep(50);
      json(res, 200, { n }, { 'cache-control': 'private' });
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cacheRoute] });
    const bodies = await Promise.all(
      Array.from({ length: 3 }, async () => (await (await fetch(`${g.base}/me`)).json()) as { n: number }),
    );
    expect(new Set(bodies.map((b) => b.n)).size).toBe(3); // each got its own upstream response
  });
});

describe('retries', () => {
  const fastRetry = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 };

  it('retries 5xx on idempotent methods with exponential backoff and returns the eventual success', async () => {
    const up = await upstream((_r, res, _h, n) => (n < 3 ? json(res, 503, { n }) : json(res, 200, { ok: true, n })));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: fastRetry } },
      routes: [{ path: '/', upstream: 'u' }],
    });

    const res = await fetch(`${g.base}/flaky`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, n: 3 });
    expect(up.hits).toHaveLength(3);
    expect(g.delays).toEqual([100, 200]); // full jitter pinned to its ceiling by the test's random()
  });

  it('hands back the last upstream response when retries are exhausted', async () => {
    const up = await upstream((_r, res, _h, n) => json(res, 503, { attempt: n }));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: fastRetry } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/down`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ attempt: 3 });
    expect(up.hits).toHaveLength(3);
  });

  it('does not retry POST on a 5xx, since it may already have taken effect', async () => {
    const up = await upstream((_r, res) => json(res, 503, {}));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: fastRetry } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/orders`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(503);
    expect(up.hits).toHaveLength(1);
  });

  it('retries POST when explicitly allowed', async () => {
    const up = await upstream((_r, res, _h, n) => (n < 2 ? json(res, 503, {}) : json(res, 201, { created: true })));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: { ...fastRetry, retryNonIdempotent: true } } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/orders`, { method: 'POST', body: 'payload' });
    expect(res.status).toBe(201);
    expect(up.hits.map((h) => h.body)).toEqual(['payload', 'payload']); // the body is replayed intact
  });

  it('retries connection failures even for POST, since nothing was sent', async () => {
    const port = await closedPort();
    const g = await gateway({
      upstreams: { dead: { url: `http://127.0.0.1:${port}`, retry: fastRetry } },
      routes: [{ path: '/', upstream: 'dead' }],
    });
    const res = await fetch(`${g.base}/x`, { method: 'POST', body: 'a' });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('bad_gateway');
    expect(g.delays).toHaveLength(2); // 3 attempts -> 2 backoffs
  });

  it('honours a short Retry-After from the upstream', async () => {
    const up = await upstream((_r, res, _h, n) =>
      n < 2 ? json(res, 503, {}, { 'retry-after': '1' }) : json(res, 200, { ok: true }),
    );
    const g = await gateway(
      { upstreams: { u: { url: up.url, retry: fastRetry } }, routes: [{ path: '/', upstream: 'u' }] },
      { random: () => 0 }, // jitter alone would wait 0ms
    );
    await fetch(`${g.base}/x`);
    expect(g.delays).toEqual([1000]);
  });
});

describe('timeouts', () => {
  it('answers 504 when the upstream is too slow', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(400);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: { u: { url: up.url, timeoutMs: 100, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/slow`);
    expect(res.status).toBe(504);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('upstream_timeout');
  });

  it('stops retrying once the overall deadline is spent, instead of attempts x timeout', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(2000);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: {
        u: {
          url: up.url,
          timeoutMs: 200,
          totalTimeoutMs: 500,
          retry: { maxAttempts: 10, baseDelayMs: 0, maxDelayMs: 1 },
        },
      },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const started = Date.now();
    const res = await fetch(`${g.base}/slow`);
    const elapsed = Date.now() - started;

    expect(res.status).toBe(504);
    expect(elapsed).toBeLessThan(1000); // ten 200ms attempts would have taken two seconds
    expect(up.hits.length).toBeGreaterThanOrEqual(2);
    expect(up.hits.length).toBeLessThanOrEqual(4);
  });

  it('does not count a client hanging up as an upstream failure', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(300);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const controller = new AbortController();
    const pending = fetch(`${g.base}/slow`, { signal: controller.signal }).catch(() => undefined);
    await sleep(50);
    controller.abort();
    await pending;
    await sleep(400);

    expect(g.gateway.circuit('u')?.snapshot().failures).toBe(0);
    expect((await fetch(`${g.base}/slow`)).status).toBe(200); // and the gateway is perfectly healthy
  });
});

describe('circuit breaker', () => {
  const breaker = {
    failureRateThreshold: 0.5,
    minimumRequests: 4,
    windowMs: 10_000,
    openDurationMs: 5_000,
    halfOpenSuccesses: 2,
  };

  it('opens after repeated failures, fails fast, then probes and recovers', async () => {
    let healthy = false;
    const up = await upstream((_r, res) => (healthy ? json(res, 200, { ok: true }) : json(res, 500, { boom: true })));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: { maxAttempts: 1 }, breaker } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const call = () => fetch(`${g.base}/x`);

    // Four failures trip it; upstream errors are passed through as-is until then.
    for (let i = 0; i < 4; i++) expect((await call()).status).toBe(500);
    expect(g.gateway.circuit('u')?.state).toBe('open');

    // While open, the gateway answers by itself: 503 with a retry hint and zero load on the upstream.
    const rejected = await call();
    expect(rejected.status).toBe(503);
    expect(((await rejected.json()) as { error: { code: string } }).error.code).toBe('upstream_unavailable');
    expect(Number(rejected.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(up.hits).toHaveLength(4);

    // After the cool-down it lets probes through; two successes close it again.
    healthy = true;
    g.clock.advance(5_000);
    expect(g.gateway.circuit('u')?.state).toBe('half-open');
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(g.gateway.circuit('u')?.state).toBe('closed');
    expect(up.hits).toHaveLength(6);
  });

  it('goes straight back to open if the probe fails', async () => {
    const up = await upstream((_r, res) => json(res, 502, {}));
    const g = await gateway({
      upstreams: { u: { url: up.url, retry: { maxAttempts: 1 }, breaker } },
      routes: [{ path: '/', upstream: 'u' }],
    });
    for (let i = 0; i < 4; i++) await fetch(`${g.base}/x`);
    g.clock.advance(5_000);
    expect((await fetch(`${g.base}/x`)).status).toBe(502); // the probe reached the upstream and failed
    expect(g.gateway.circuit('u')?.state).toBe('open');
    expect((await fetch(`${g.base}/x`)).status).toBe(503);
  });

  it('stops retrying as soon as the breaker opens mid-request', async () => {
    const up = await upstream((_r, res) => json(res, 503, {}));
    const g = await gateway({
      upstreams: {
        u: {
          url: up.url,
          retry: { maxAttempts: 10, baseDelayMs: 1, maxDelayMs: 1 },
          breaker: { ...breaker, minimumRequests: 3 },
        },
      },
      routes: [{ path: '/', upstream: 'u' }],
    });
    const res = await fetch(`${g.base}/x`);
    expect(res.status).toBe(503);
    expect(up.hits).toHaveLength(3); // tripped on the third failure; the remaining 7 attempts never happened
  });

  it('isolates failures per upstream', async () => {
    const bad = await upstream((_r, res) => json(res, 500, {}));
    const good = await upstream((_r, res) => json(res, 200, { ok: true }));
    const g = await gateway({
      upstreams: {
        bad: { url: bad.url, retry: { maxAttempts: 1 }, breaker },
        good: { url: good.url, retry: { maxAttempts: 1 }, breaker },
      },
      routes: [
        { path: '/bad', upstream: 'bad' },
        { path: '/good', upstream: 'good' },
      ],
    });
    for (let i = 0; i < 5; i++) await fetch(`${g.base}/bad/x`);
    expect(g.gateway.circuit('bad')?.state).toBe('open');
    expect((await fetch(`${g.base}/good/x`)).status).toBe(200);
  });
});

describe('observability and admin', () => {
  it('reports health with circuit states', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const res = await fetch(`${g.adminBase}/_gateway/health`);
    const body = (await res.json()) as { status: string; upstreams: { u: { state: string } }; redis: string };
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.upstreams.u.state).toBe('closed');
    expect(body.redis).toBe('disabled');
  });

  it('exposes Prometheus metrics for requests, rate limiting and caching', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [
        {
          path: '/api',
          upstream: 'u',
          id: 'api',
          rateLimit: { algorithm: 'sliding-window', limit: 1, windowMs: 10_000 },
          cache: { ttlMs: 10_000 },
        },
      ],
    });
    await fetch(`${g.base}/api/a`, { headers: { 'x-api-key': 'k' } });
    await fetch(`${g.base}/api/a`, { headers: { 'x-api-key': 'k' } }); // 429

    const text = await (await fetch(`${g.adminBase}/_gateway/metrics`)).text();
    expect(text).toContain('# TYPE gateway_requests_total counter');
    expect(text).toMatch(/gateway_requests_total\{route="api",status="200"\} 1/);
    expect(text).toMatch(/gateway_requests_total\{route="api",status="429"\} 1/);
    expect(text).toMatch(/gateway_rate_limited_total\{route="api"\} 1/);
    expect(text).toMatch(/gateway_cache_requests_total\{result="MISS",route="api"\} 1/);
    expect(text).toMatch(/gateway_circuit_state\{target="127\.0\.0\.1:\d+",upstream="u"\} 0/);
    expect(text).toContain('gateway_request_duration_seconds_bucket');
  });
});
