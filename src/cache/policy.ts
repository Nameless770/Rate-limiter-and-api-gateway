/**
 * What may a shared cache store, and for how long? Pure functions over header maps so they're easy to test.
 *
 * The gateway is a *shared* cache sitting between many clients and one upstream, so the rules are the
 * conservative ones from RFC 9111: when in doubt, don't store.
 */
import type { IncomingHttpHeaders } from 'node:http';

export type CacheDirectives = Map<string, string | true>;

export function parseCacheControl(value: string | string[] | undefined): CacheDirectives {
  const out: CacheDirectives = new Map();
  if (value === undefined) return out;
  const raw = Array.isArray(value) ? value.join(',') : value;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      out.set(trimmed.toLowerCase(), true);
    } else {
      out.set(trimmed.slice(0, eq).trim().toLowerCase(), trimmed.slice(eq + 1).trim().replace(/^"|"$/g, ''));
    }
  }
  return out;
}

function seconds(directives: CacheDirectives, name: string): number | undefined {
  const raw = directives.get(name);
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

export interface RequestCacheInfo {
  /** The client asked us not to use or store anything (Cache-Control: no-store). */
  noStore: boolean;
  /** The client wants a fresh copy (Cache-Control: no-cache / Pragma: no-cache): skip lookup, may still store. */
  noCache: boolean;
}

export function requestCacheInfo(headers: IncomingHttpHeaders): RequestCacheInfo {
  const cc = parseCacheControl(headers['cache-control']);
  return {
    noStore: cc.has('no-store'),
    noCache: cc.has('no-cache') || headers['pragma'] === 'no-cache',
  };
}

/**
 * Requests whose response depends on credentials we are not keying on must never be served from a shared
 * entry, or one user's data could be handed to another.
 */
export function requestIsCacheSafe(headers: IncomingHttpHeaders, varyHeaders: readonly string[]): boolean {
  for (const credential of ['authorization', 'cookie']) {
    if (headers[credential] !== undefined && !varyHeaders.includes(credential)) return false;
  }
  return true;
}

export interface StoreDecision {
  /** Freshness lifetime in ms. */
  ttlMs: number;
  /** Request header names the upstream said the response varies on. */
  vary: string[];
}

/**
 * Decide whether a response may be stored. Returns undefined to mean "do not store".
 * `defaultTtlMs` applies only when the upstream expressed no opinion about freshness.
 */
export function storeDecision(
  status: number,
  headers: IncomingHttpHeaders,
  defaultTtlMs: number,
): StoreDecision | undefined {
  if (status !== 200) return undefined;

  const cc = parseCacheControl(headers['cache-control']);
  if (cc.has('no-store') || cc.has('no-cache') || cc.has('private')) return undefined;
  if (headers['set-cookie'] !== undefined) return undefined; // never hand one client's session to another

  const varyRaw = headers['vary'];
  const vary = (Array.isArray(varyRaw) ? varyRaw.join(',') : (varyRaw ?? ''))
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (vary.includes('*')) return undefined;

  // s-maxage targets shared caches and wins over max-age.
  const explicit = seconds(cc, 's-maxage') ?? seconds(cc, 'max-age');
  let ttlMs = explicit !== undefined ? explicit * 1000 : defaultTtlMs;

  // If another cache already held it for a while, that time counts against its freshness.
  const ageHeader = headers['age'];
  const age = typeof ageHeader === 'string' ? Number(ageHeader) : 0;
  if (Number.isFinite(age) && age > 0) ttlMs -= age * 1000;

  if (ttlMs <= 0) return undefined;
  return { ttlMs, vary };
}
