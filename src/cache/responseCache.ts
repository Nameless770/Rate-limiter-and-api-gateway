/**
 * In-memory response cache: LRU eviction, a byte budget, per-entry TTL, and single-flight coalescing so a
 * thundering herd of identical cache misses produces one upstream request instead of N.
 */
import type { Clock } from '../ratelimit/types.js';

export interface CachedResponse {
  status: number;
  /** Already filtered of hop-by-hop headers. */
  headers: Record<string, string | string[]>;
  body: Buffer;
  storedAt: number;
  expiresAt: number;
  /** Request header values this variant was stored under, for the upstream's `Vary` list. */
  vary: Record<string, string | undefined>;
}

export interface ResponseCacheOptions {
  maxEntries: number;
  maxBytes: number;
  /** Responses larger than this are never stored. */
  maxEntryBytes: number;
  clock?: Clock;
}

export interface CacheStats {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
  coalesced: number;
}

const ENTRY_OVERHEAD_BYTES = 256; // rough per-entry bookkeeping so tiny bodies still count against the budget

/**
 * What an entry costs against the byte budget. The key counts: it is built from the request path and query, which
 * the client controls (up to the header size limit), so charging only the body would let long URLs with tiny
 * responses grow the cache well past its budget. Two bytes per character covers V8's UTF-16 worst case.
 */
function entrySize(key: string, entry: CachedResponse): number {
  return entry.body.length + key.length * 2 + ENTRY_OVERHEAD_BYTES;
}

export class ResponseCache {
  private readonly entries = new Map<string, CachedResponse>(); // insertion order == recency order
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly clock: Clock;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private coalesced = 0;

  constructor(private readonly opts: ResponseCacheOptions) {
    this.clock = opts.clock ?? Date.now;
  }

  get maxEntryBytes(): number {
    return this.opts.maxEntryBytes;
  }

  /** Fresh entry for `key` whose stored `Vary` values match this request's headers, if any. */
  get(key: string, requestHeaders: Record<string, string | string[] | undefined>): CachedResponse | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expiresAt <= this.clock()) {
      this.remove(key, entry);
      this.misses++;
      return undefined;
    }
    for (const [name, stored] of Object.entries(entry.vary)) {
      const current = requestHeaders[name];
      const normalized = Array.isArray(current) ? current.join(', ') : current;
      if (normalized !== stored) {
        this.misses++;
        return undefined;
      }
    }
    // Mark as most recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  set(key: string, entry: CachedResponse): boolean {
    const size = entrySize(key, entry);
    if (entry.body.length > this.opts.maxEntryBytes || size > this.opts.maxBytes) return false;

    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);

    this.entries.set(key, entry);
    this.bytes += size;

    while (this.entries.size > this.opts.maxEntries || this.bytes > this.opts.maxBytes) {
      const oldest = this.entries.entries().next();
      if (oldest.done) break;
      this.remove(oldest.value[0], oldest.value[1]);
      this.evictions++;
    }
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /**
   * Single-flight: if a fetch for `key` is already running, wait for it instead of starting another.
   * Everyone gets the leader's outcome, including a rejection, so a failing upstream sees one request rather
   * than one per waiter. What the value means (and whether waiters may use it) is up to the caller.
   */
  async singleFlight<T>(key: string, fetch: () => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
    const running = this.inflight.get(key) as Promise<T> | undefined;
    if (running) {
      this.coalesced++;
      return { value: await running, coalesced: true };
    }
    const promise = fetch();
    this.inflight.set(key, promise);
    try {
      return { value: await promise, coalesced: false };
    } finally {
      this.inflight.delete(key);
    }
  }

  stats(): CacheStats {
    return {
      entries: this.entries.size,
      bytes: this.bytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      coalesced: this.coalesced,
    };
  }

  private remove(key: string, entry: CachedResponse): void {
    this.entries.delete(key);
    this.bytes -= entrySize(key, entry);
  }
}
