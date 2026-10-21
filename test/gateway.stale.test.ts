import { afterEach, describe, expect, it } from 'vitest';
import { json, rawRequest, sleep, startGateway, startUpstream } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Behaviour {
  /** What every response says about caching. */
  cacheControl?: string;
  /** Answer with this status instead of 200. */
  status?: number;
  /** Wait this long before answering. */
  delayMs?: number;
}

/**
 * An upstream whose every answer is a new version ({"version": n}), and whose behaviour the test changes as it goes.
 * /fail always answers 500 (for tripping the breaker).
 */
async function setup(options: { route?: Record<string, unknown>; upstream?: Record<string, unknown> } = {}) {
  const behaviour: Behaviour = { cacheControl: 'max-age=1, stale-while-revalidate=60, stale-if-error=600' };
  let version = 0;
  const up = await startUpstream(async (_req, res, hit) => {
    if (hit.url.startsWith('/fail')) return json(res, 500, { failed: true });
    if (behaviour.delayMs) await sleep(behaviour.delayMs);
    version++;
    const headers: Record<string, string> = behaviour.cacheControl ? { 'cache-control': behaviour.cacheControl } : {};
    json(res, behaviour.status ?? 200, { version }, headers);
  });
  cleanups.push(up.close);
  const g = await startGateway({
    upstreams: { u: { url: up.url, timeoutMs: 300, retry: { maxAttempts: 1 }, ...options.upstream } },
    routes: [
      {
        id: 'cached',
        path: '/',
        upstream: 'u',
        cache: { ttlMs: 1_000, varyHeaders: [], ...options.route },
      },
    ],
  });
  cleanups.push(g.close);

  const get = async (path = '/item', headers: Record<string, string> = {}) => {
    const res = await rawRequest(g.base, { path, headers });
    let body: { version?: number; error?: { code: string } } = {};
    try {
      body = JSON.parse(res.body);
    } catch {
      // not JSON
    }
    return { status: res.status, cache: res.headers['x-cache'], age: Number(res.headers['age']), ...body };
  };
  const metrics = async () => (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
  const versionsFetched = () => up.hits.filter((h) => !h.url.startsWith('/fail')).length;
  return { up, g, behaviour, get, metrics, versionsFetched };
}

async function until(check: () => boolean | Promise<boolean>, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

describe('stale-while-revalidate', () => {
  it('answers a stale request at once with the stale copy, and refreshes it behind the scenes', async () => {
    const t = await setup();
    expect(await t.get()).toMatchObject({ status: 200, cache: 'MISS', version: 1 });
    t.g.clock.advance(2_000); // stale now, well inside the 60 s window

    const stale = await t.get();
    expect(stale).toMatchObject({ status: 200, cache: 'STALE', version: 1 });
    expect(stale.age).toBeGreaterThanOrEqual(2);

    await until(() => t.versionsFetched() === 2); // the refresh happened...
    await until(async () => /gateway_cache_refreshes_total\{[^}]*result="stored"[^}]*\} 1/.test(await t.metrics()));
    expect(await t.get()).toMatchObject({ cache: 'HIT', version: 2 }); // ...and its result is what is served now
    expect(await t.metrics()).toMatch(/gateway_cache_stale_served_total\{[^}]*reason="revalidating"[^}]*\} 1/);
  });

  it('refreshes once, however many requests arrive while the copy is stale', async () => {
    const t = await setup();
    await t.get();
    t.g.clock.advance(2_000);
    t.behaviour.delayMs = 200; // the refresh takes a while: everyone below arrives during it
    const answers = await Promise.all(Array.from({ length: 10 }, () => t.get()));
    expect(answers.every((a) => a.cache === 'STALE' && a.version === 1)).toBe(true);
    await until(() => t.versionsFetched() === 2);
    await sleep(300);
    expect(t.versionsFetched()).toBe(2); // one refresh, not ten
  });

  it('fetches synchronously once the copy is past its window', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1, stale-while-revalidate=1';
    await t.get();
    t.g.clock.advance(3_000);
    expect(await t.get()).toMatchObject({ cache: 'MISS', version: 2 });
  });

  it('keeps serving the stale copy when the refresh fails, and says so in the metrics', async () => {
    const t = await setup();
    await t.get();
    t.g.clock.advance(2_000);
    t.behaviour.status = 503;
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 });
    await until(async () => /gateway_cache_refreshes_total\{[^}]*result="not_stored"[^}]*\} 1/.test(await t.metrics()));
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 }); // nothing replaced it
  });

  it("keeps the route's windows on the refreshed copy, so it too is revalidated in the background when it goes stale", async () => {
    const t = await setup({ route: { staleWhileRevalidateMs: 60_000 } });
    t.behaviour.cacheControl = undefined; // the upstream says nothing: the route's windows apply
    await t.get();
    t.g.clock.advance(2_000);
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 });
    await until(async () => /gateway_cache_refreshes_total\{[^}]*result="stored"[^}]*\} 1/.test(await t.metrics()));
    t.g.clock.advance(2_000); // the refreshed copy has gone stale in turn
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 2 });
  });

  it('stores and serves a response that is never fresh but may always be revalidated in the background', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=0, stale-while-revalidate=30';
    expect(await t.get()).toMatchObject({ cache: 'MISS', version: 1 });
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 });
    await until(() => t.versionsFetched() === 2);
  });
});

describe('stale-if-error', () => {
  const failing = async (status = 500) => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1, stale-if-error=600';
    expect(await t.get()).toMatchObject({ cache: 'MISS', version: 1 });
    t.g.clock.advance(2_000);
    t.behaviour.status = status;
    return t;
  };

  it('stands in for an upstream that answers with an error', async () => {
    const t = await failing(500);
    expect(await t.get()).toMatchObject({ status: 200, cache: 'STALE', version: 1 });
    expect(await t.metrics()).toMatch(/gateway_cache_stale_served_total\{[^}]*reason="upstream_error"[^}]*\} 1/);
    expect(await t.metrics()).toMatch(/gateway_cache_requests_total\{[^}]*result="STALE"[^}]*\} 1/);

    // Once the upstream is back, the next request gets a fresh copy, not the stale one.
    t.behaviour.status = undefined;
    expect(await t.get()).toMatchObject({ cache: 'MISS', version: 3 });
  });

  it('only after the retries the route allows have been spent', async () => {
    const t = await setup({ upstream: { retry: { maxAttempts: 3 } } });
    t.behaviour.cacheControl = 'max-age=1, stale-if-error=600';
    await t.get();
    t.g.clock.advance(2_000);
    t.behaviour.status = 503;
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 });
    expect(t.versionsFetched()).toBe(4); // the first fetch, then three attempts
  });

  it('stands in for an upstream that is down, slow, or behind an open circuit', async () => {
    // Timeout: the upstream takes longer than the route's 300 ms.
    const slow = await failing(200);
    slow.behaviour.delayMs = 600;
    expect(await slow.get()).toMatchObject({ cache: 'STALE', version: 1 });

    // Open circuit: tripped by failures on another path of the same upstream.
    const t = await setup({ upstream: { breaker: { minimumRequests: 2, openDurationMs: 600_000 } } });
    t.behaviour.cacheControl = 'max-age=1, stale-if-error=600';
    await t.get();
    t.g.clock.advance(2_000);
    for (let i = 0; i < 3; i++) await t.get('/fail');
    expect(t.g.gateway.circuit('u')?.state).toBe('open');
    expect(await t.get()).toMatchObject({ status: 200, cache: 'STALE', version: 1 });

    // Down: nothing listening any more.
    const down = await failing(200);
    await down.up.close();
    expect(await down.get()).toMatchObject({ status: 200, cache: 'STALE', version: 1 });
  });

  it('gives every request waiting on the failed fetch the same stale copy', async () => {
    const t = await failing(500);
    t.behaviour.delayMs = 150;
    const answers = await Promise.all(Array.from({ length: 6 }, () => t.get()));
    expect(answers.every((a) => a.status === 200 && a.cache === 'STALE' && a.version === 1)).toBe(true);
    expect(t.versionsFetched()).toBe(2); // one failed fetch for all six
  });

  it('covers a request that waits on a background refresh which then fails', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1, stale-while-revalidate=1, stale-if-error=600';
    await t.get();
    t.g.clock.advance(1_500); // inside the revalidate window: this request starts a background refresh
    t.behaviour.delayMs = 600; // which will time out (the route allows 300 ms)
    expect(await t.get()).toMatchObject({ cache: 'STALE', version: 1 });
    t.g.clock.advance(1_000); // past the revalidate window, still inside stale-if-error
    // This request finds the refresh still running and waits on it; when it fails, stale-if-error covers it.
    expect(await t.get()).toMatchObject({ status: 200, cache: 'STALE', version: 1 });
    expect(t.versionsFetched()).toBe(2);
  });

  it('lets the error through once the window has passed', async () => {
    const t = await failing(500);
    t.g.clock.advance(600_000);
    expect(await t.get()).toMatchObject({ status: 500 });
  });
});

describe('what stale serving respects', () => {
  it('never serves stale against must-revalidate', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1, must-revalidate, stale-while-revalidate=60, stale-if-error=600';
    await t.get();
    t.g.clock.advance(2_000);
    expect(await t.get()).toMatchObject({ cache: 'MISS', version: 2 }); // not served stale while revalidating
    t.g.clock.advance(2_000);
    t.behaviour.status = 500;
    expect(await t.get()).toMatchObject({ status: 500 }); // nor in place of an error
  });

  it("applies the route's windows when the upstream gives none, but not over s-maxage", async () => {
    const t = await setup({ route: { staleIfErrorMs: 600_000 } });
    t.behaviour.cacheControl = undefined;
    await t.get(); // fresh for the route's 1 s
    t.g.clock.advance(2_000);
    t.behaviour.status = 500;
    expect(await t.get()).toMatchObject({ status: 200, cache: 'STALE', version: 1 });

    const strict = await setup({ route: { staleIfErrorMs: 600_000 } });
    strict.behaviour.cacheControl = 's-maxage=1';
    await strict.get();
    strict.g.clock.advance(2_000);
    strict.behaviour.status = 500;
    expect(await strict.get()).toMatchObject({ status: 500 });
  });

  it('gives a client that asked for a fresh copy the fresh copy or the error, never a stale stand-in', async () => {
    const t = await setup();
    await t.get();
    t.g.clock.advance(2_000);
    t.behaviour.status = 500;
    expect(await t.get('/item', { 'cache-control': 'no-cache' })).toMatchObject({ status: 500 });
  });

  it('does not serve stale by default: without directives or route windows an expired entry is simply gone', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1';
    await t.get();
    t.g.clock.advance(2_000);
    t.behaviour.status = 500;
    expect(await t.get()).toMatchObject({ status: 500 });
  });
});
