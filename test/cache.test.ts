import { describe, expect, it } from 'vitest';
import { parseCacheControl, requestCacheInfo, requestIsCacheSafe, storeDecision } from '../src/cache/policy.js';
import { type CachedResponse, ResponseCache } from '../src/cache/responseCache.js';

describe('parseCacheControl', () => {
  it('parses flags and valued directives case-insensitively', () => {
    const cc = parseCacheControl('Public, MAX-AGE=60, s-maxage="30"');
    expect(cc.get('public')).toBe(true);
    expect(cc.get('max-age')).toBe('60');
    expect(cc.get('s-maxage')).toBe('30');
  });

  it('copes with absent and empty values', () => {
    expect(parseCacheControl(undefined).size).toBe(0);
    expect(parseCacheControl(' , ,').size).toBe(0);
  });
});

describe('storeDecision', () => {
  it('uses the route default when the upstream expresses no opinion', () => {
    expect(storeDecision(200, {}, 5000)).toEqual({
      ttlMs: 5000,
      vary: [],
      staleWhileRevalidateMs: 0,
      staleIfErrorMs: 0,
    });
  });

  it('prefers s-maxage over max-age over the default', () => {
    expect(storeDecision(200, { 'cache-control': 'max-age=60' }, 5000)?.ttlMs).toBe(60_000);
    expect(storeDecision(200, { 'cache-control': 'max-age=60, s-maxage=10' }, 5000)?.ttlMs).toBe(10_000);
  });

  it.each([
    ['no-store', { 'cache-control': 'no-store' }],
    ['no-cache', { 'cache-control': 'no-cache' }],
    ['private', { 'cache-control': 'private, max-age=60' }],
    ['Set-Cookie', { 'set-cookie': ['sid=1'] }],
    ['Vary: *', { vary: '*' }],
    ['max-age=0', { 'cache-control': 'max-age=0' }],
  ])('refuses to store a response with %s', (_name, headers) => {
    expect(storeDecision(200, headers, 5000)).toBeUndefined();
  });

  it('only stores 200s', () => {
    expect(storeDecision(404, {}, 5000)).toBeUndefined();
    expect(storeDecision(500, {}, 5000)).toBeUndefined();
  });

  it('subtracts time the response already spent in another cache', () => {
    expect(storeDecision(200, { 'cache-control': 'max-age=60', age: '45' }, 5000)?.ttlMs).toBe(15_000);
    expect(storeDecision(200, { 'cache-control': 'max-age=60', age: '60' }, 5000)).toBeUndefined();
  });

  it('records which request headers the response varies on', () => {
    expect(storeDecision(200, { vary: 'Accept-Language, Accept' }, 5000)?.vary).toEqual(['accept-language', 'accept']);
  });
});

describe('request-side rules', () => {
  it('detects no-store / no-cache', () => {
    expect(requestCacheInfo({ 'cache-control': 'no-store' })).toEqual({ noStore: true, noCache: false });
    expect(requestCacheInfo({ 'cache-control': 'no-cache' })).toEqual({ noStore: false, noCache: true });
    expect(requestCacheInfo({ pragma: 'no-cache' }).noCache).toBe(true);
  });

  it('refuses to share entries for credentialed requests unless the credential is part of the key', () => {
    expect(requestIsCacheSafe({ authorization: 'Bearer x' }, [])).toBe(false);
    expect(requestIsCacheSafe({ authorization: 'Bearer x' }, ['authorization'])).toBe(true);
    expect(requestIsCacheSafe({ cookie: 'a=b' }, ['x-api-key'])).toBe(false);
    expect(requestIsCacheSafe({}, [])).toBe(true);
  });
});

describe('ResponseCache', () => {
  const entry = (body: string, overrides: Partial<CachedResponse> = {}): CachedResponse => ({
    status: 200,
    headers: {},
    body: Buffer.from(body),
    storedAt: 0,
    expiresAt: 10_000,
    vary: {},
    ...overrides,
  });

  it('returns stored entries until they expire', () => {
    let now = 0;
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => now });
    cache.set('k', entry('hello', { expiresAt: 5000 }));
    expect(cache.get('k', {})?.body.toString()).toBe('hello');
    now = 4999;
    expect(cache.get('k', {})).toBeDefined();
    now = 5000;
    expect(cache.get('k', {})).toBeUndefined();
    expect(cache.stats().entries).toBe(0); // expired entries are reclaimed, not just hidden
  });

  it('evicts the least recently used entry when over the entry limit', () => {
    const cache = new ResponseCache({ maxEntries: 2, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => 0 });
    cache.set('a', entry('1'));
    cache.set('b', entry('2'));
    cache.get('a', {}); // a is now the most recently used
    cache.set('c', entry('3'));
    expect(cache.get('b', {})).toBeUndefined();
    expect(cache.get('a', {})).toBeDefined();
    expect(cache.get('c', {})).toBeDefined();
    expect(cache.stats().evictions).toBe(1);
  });

  it('enforces the byte budget and refuses oversized entries', () => {
    const cache = new ResponseCache({ maxEntries: 100, maxBytes: 1500, maxEntryBytes: 600, clock: () => 0 });
    expect(cache.set('big', entry('x'.repeat(601)))).toBe(false);
    cache.set('a', entry('x'.repeat(500)));
    cache.set('b', entry('x'.repeat(500)));
    cache.set('c', entry('x'.repeat(500))); // ~756 per entry incl. overhead: only two fit
    expect(cache.stats().bytes).toBeLessThanOrEqual(1500);
    expect(cache.get('a', {})).toBeUndefined();
    expect(cache.get('c', {})).toBeDefined();
  });

  it('serves a stored variant only to requests matching its Vary values', () => {
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => 0 });
    cache.set('k', entry('bonjour', { vary: { 'accept-language': 'fr' } }));
    expect(cache.get('k', { 'accept-language': 'fr' })).toBeDefined();
    expect(cache.get('k', { 'accept-language': 'en' })).toBeUndefined();
    expect(cache.get('k', {})).toBeUndefined();
  });

  it('replacing a key keeps byte accounting correct', () => {
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => 0 });
    cache.set('k', entry('x'.repeat(100)));
    const before = cache.stats().bytes;
    cache.set('k', entry('x'.repeat(100)));
    expect(cache.stats().bytes).toBe(before);
    expect(cache.stats().entries).toBe(1);
  });

  it('coalesces concurrent fetches for one key into a single call', async () => {
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => 0 });
    let fetches = 0;
    const slow = async (): Promise<CachedResponse> => {
      fetches++;
      await new Promise((r) => setTimeout(r, 20));
      return entry('shared');
    };
    const results = await Promise.all(Array.from({ length: 10 }, () => cache.singleFlight('k', slow)));
    expect(fetches).toBe(1);
    expect(results.filter((r) => r.coalesced)).toHaveLength(9);
    expect(results.every((r) => r.value.body.toString() === 'shared')).toBe(true);
  });

  it("shares the leader's failure with waiters instead of letting each retry", async () => {
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 10_000, maxEntryBytes: 1000, clock: () => 0 });
    let followerFetches = 0;
    const leader = cache.singleFlight('k', async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('upstream down');
    });
    const follower = cache.singleFlight('k', async () => {
      followerFetches++;
      return entry('unused');
    });
    await expect(leader).rejects.toThrow('upstream down');
    await expect(follower).rejects.toThrow('upstream down');
    expect(followerFetches).toBe(0);
    // And the key is free again afterwards.
    const next = await cache.singleFlight('k', async () => entry('fresh'));
    expect(next.coalesced).toBe(false);
  });
});

describe('ResponseCache byte accounting', () => {
  const entry = (body: string): CachedResponse => ({
    status: 200,
    headers: {},
    body: Buffer.from(body),
    storedAt: 0,
    expiresAt: 10_000,
    vary: {},
  });

  it('charges the key against the budget, so long client-chosen URLs cannot inflate the cache', () => {
    const cache = new ResponseCache({ maxEntries: 1_000_000, maxBytes: 100_000, maxEntryBytes: 1000, clock: () => 0 });
    const longKey = (i: number) => `u\u0000/${'a'.repeat(8000)}${i}`;
    for (let i = 0; i < 50; i++) cache.set(longKey(i), entry('x')); // a one-byte body behind a 16 KB key

    expect(cache.stats().bytes).toBeLessThanOrEqual(100_000);
    expect(cache.stats().entries).toBeLessThan(10); // about 6 fit; the rest were evicted
    expect(cache.stats().evictions).toBeGreaterThan(40);
  });

  it('releases exactly what it charged', () => {
    const cache = new ResponseCache({ maxEntries: 10, maxBytes: 100_000, maxEntryBytes: 1000, clock: () => 0 });
    cache.set('a'.repeat(500), entry('body'));
    cache.set('b'.repeat(300), entry('body'));
    cache.delete('a'.repeat(500));
    cache.delete('b'.repeat(300));
    expect(cache.stats().bytes).toBe(0);
  });
});

describe('stale windows (RFC 5861)', () => {
  const route = { whileRevalidateMs: 30_000, ifErrorMs: 60_000 };

  it("takes the upstream's own stale-while-revalidate and stale-if-error", () => {
    expect(
      storeDecision(200, { 'cache-control': 'max-age=10, stale-while-revalidate=20, stale-if-error=300' }, 5000),
    ).toMatchObject({ ttlMs: 10_000, staleWhileRevalidateMs: 20_000, staleIfErrorMs: 300_000 });
  });

  it("falls back to the route's windows when the upstream gives none", () => {
    expect(storeDecision(200, { 'cache-control': 'max-age=10' }, 5000, route)).toMatchObject({
      staleWhileRevalidateMs: 30_000,
      staleIfErrorMs: 60_000,
    });
    // An explicit directive wins over the route default, in either direction.
    expect(storeDecision(200, { 'cache-control': 'max-age=10, stale-if-error=0' }, 5000, route)).toMatchObject({
      staleWhileRevalidateMs: 30_000,
      staleIfErrorMs: 0,
    });
  });

  it.each([
    ['must-revalidate', 'max-age=10, must-revalidate, stale-while-revalidate=20, stale-if-error=20'],
    ['proxy-revalidate', 'max-age=10, proxy-revalidate, stale-while-revalidate=20, stale-if-error=20'],
  ])('never allows stale under %s, whatever else is said', (_name, cc) => {
    expect(storeDecision(200, { 'cache-control': cc }, 5000, route)).toMatchObject({
      staleWhileRevalidateMs: 0,
      staleIfErrorMs: 0,
    });
  });

  it("does not apply the route's defaults over s-maxage, but honours the upstream's explicit permission", () => {
    expect(storeDecision(200, { 'cache-control': 's-maxage=10' }, 5000, route)).toMatchObject({
      staleWhileRevalidateMs: 0,
      staleIfErrorMs: 0,
    });
    expect(storeDecision(200, { 'cache-control': 's-maxage=10, stale-if-error=40' }, 5000, route)).toMatchObject({
      staleWhileRevalidateMs: 0,
      staleIfErrorMs: 40_000,
    });
  });

  it('keeps a response that is fresh for no time at all if it may be served stale', () => {
    expect(storeDecision(200, { 'cache-control': 'max-age=0, stale-while-revalidate=30' }, 5000)).toMatchObject({
      ttlMs: 0,
      staleWhileRevalidateMs: 30_000,
    });
    expect(storeDecision(200, { 'cache-control': 'max-age=0' }, 5000, NO_ROUTE_STALE)).toBeUndefined();
  });

  it('charges time the response already spent stale elsewhere against its windows', () => {
    // max-age 10, but it is 25 s old: 15 s into its 20 s stale-while-revalidate window already.
    expect(
      storeDecision(200, { 'cache-control': 'max-age=10, stale-while-revalidate=20', age: '25' }, 5000),
    ).toMatchObject({ ttlMs: 0, staleWhileRevalidateMs: 5_000 });
    expect(
      storeDecision(200, { 'cache-control': 'max-age=10, stale-while-revalidate=20', age: '31' }, 5000),
    ).toBeUndefined();
  });

  describe('in the store', () => {
    let now = 0;
    const cache = () =>
      new ResponseCache({ maxEntries: 10, maxBytes: 100_000, maxEntryBytes: 10_000, clock: () => now });
    const stored = (overrides: Partial<CachedResponse>): CachedResponse => ({
      status: 200,
      headers: {},
      body: Buffer.from('v1'),
      storedAt: 0,
      expiresAt: 1_000,
      vary: {},
      ...overrides,
    });

    it('returns a stale entry while one of its windows is open, and reports it as stale', () => {
      now = 0;
      const c = cache();
      c.set('k', stored({ staleWhileRevalidateUntil: 2_000, staleIfErrorUntil: 5_000 }));
      expect(c.lookup('k', {})).toMatchObject({ fresh: true });
      now = 1_500;
      expect(c.lookup('k', {})).toMatchObject({ fresh: false });
      expect(c.get('k', {})).toBeUndefined(); // get() only ever hands out fresh entries
      now = 4_999;
      expect(c.lookup('k', {})?.fresh).toBe(false);
      expect(c.stats()).toMatchObject({ hits: 1, stale: 3 });
    });

    it('drops it once every window has closed', () => {
      now = 0;
      const c = cache();
      c.set('k', stored({ staleWhileRevalidateUntil: 2_000, staleIfErrorUntil: 3_000 }));
      now = 3_000;
      expect(c.lookup('k', {})).toBeUndefined();
      expect(c.stats().entries).toBe(0);
    });

    it('keeps an entry with no stale windows no longer than before', () => {
      now = 0;
      const c = cache();
      c.set('k', stored({}));
      now = 1_000;
      expect(c.lookup('k', {})).toBeUndefined();
      expect(c.stats()).toMatchObject({ entries: 0, misses: 1, stale: 0 });
    });

    it('still applies Vary to a stale entry', () => {
      now = 0;
      const c = cache();
      c.set('k', stored({ staleIfErrorUntil: 5_000, vary: { 'accept-language': 'en' } }));
      now = 2_000;
      expect(c.lookup('k', { 'accept-language': 'fr' })).toBeUndefined();
      expect(c.lookup('k', { 'accept-language': 'en' })?.fresh).toBe(false);
    });

    it('knows when a fetch is under way for a key', async () => {
      const c = cache();
      let release: () => void = () => {};
      const flight = c.singleFlight('k', () => new Promise<void>((resolve) => (release = resolve)));
      expect(c.isInFlight('k')).toBe(true);
      expect(c.isInFlight('other')).toBe(false);
      release();
      await flight;
      expect(c.isInFlight('k')).toBe(false);
    });
  });
});

const NO_ROUTE_STALE = { whileRevalidateMs: 0, ifErrorMs: 0 };
