/**
 * In-process rate limiters built on the pure algorithms. They are exact for a single gateway instance and are
 * also the degraded-mode fallback when Redis is unreachable (see resilient.ts).
 */
import {
  slidingWindowIsExpired,
  slidingWindowStep,
  tokenBucketIsExpired,
  tokenBucketStep,
  type SlidingWindowParams,
  type TokenBucketParams,
  type TokenBucketState,
} from './algorithms.js';
import type { Clock, RateLimitDecision, RateLimiter } from './types.js';

export interface MemoryLimiterOptions {
  clock?: Clock;
  /**
   * Hard cap on tracked keys. Identities are attacker-controlled (API keys, IPs), so an unbounded map is a
   * memory-exhaustion vector. When full, expired keys are swept first, then the oldest key is evicted
   * (which resets that one client's allowance).
   */
  maxKeys?: number;
  /** How often idle keys are swept. 0 disables the background timer (lazy cleanup on insert still applies). */
  sweepIntervalMs?: number;
}

interface Algorithm<S> {
  limit: number;
  /** Largest cost that can ever be admitted. */
  maxCost: number;
  step(state: S | undefined, now: number, cost: number): { state: S; decision: RateLimitDecision };
  isExpired(state: S, now: number): boolean;
}

class MemoryRateLimiter<S> implements RateLimiter {
  private readonly states = new Map<string, S>();
  private readonly clock: Clock;
  private readonly maxKeys: number;
  private readonly timer?: NodeJS.Timeout;

  constructor(
    private readonly algorithm: Algorithm<S>,
    options: MemoryLimiterOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.maxKeys = options.maxKeys ?? 100_000;
    const interval = options.sweepIntervalMs ?? 30_000;
    if (interval > 0) {
      this.timer = setInterval(() => this.sweep(), interval);
      this.timer.unref();
    }
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    if (!Number.isInteger(cost) || cost < 1 || cost > this.algorithm.maxCost) {
      throw new RangeError(`cost must be an integer in [1, ${this.algorithm.maxCost}], got ${cost}`);
    }
    const now = this.clock();
    const current = this.states.get(key);
    if (current === undefined && this.states.size >= this.maxKeys) this.makeRoom();

    const { state, decision } = this.algorithm.step(current, now, cost);
    // Re-insert so the Map's insertion order doubles as an LRU-ish order for eviction.
    this.states.delete(key);
    this.states.set(key, state);
    return decision;
  }

  /** Number of keys currently tracked (exposed for tests and metrics). */
  get size(): number {
    return this.states.size;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.states.clear();
  }

  private sweep(): number {
    const now = this.clock();
    let removed = 0;
    for (const [key, state] of this.states) {
      if (this.algorithm.isExpired(state, now)) {
        this.states.delete(key);
        removed++;
      }
    }
    return removed;
  }

  private makeRoom(): void {
    if (this.sweep() > 0 && this.states.size < this.maxKeys) return;
    const oldest = this.states.keys().next();
    if (!oldest.done) this.states.delete(oldest.value);
  }
}

export function memoryTokenBucket(params: TokenBucketParams, options?: MemoryLimiterOptions): MemoryRateLimiter<TokenBucketState> {
  return new MemoryRateLimiter<TokenBucketState>(
    {
      limit: params.capacity,
      maxCost: params.capacity,
      step: (state, now, cost) => tokenBucketStep(state, now, params, cost),
      isExpired: (state, now) => tokenBucketIsExpired(state, now, params),
    },
    options,
  );
}

export function memorySlidingWindow(params: SlidingWindowParams, options?: MemoryLimiterOptions): MemoryRateLimiter<number[]> {
  return new MemoryRateLimiter<number[]>(
    {
      limit: params.limit,
      maxCost: params.limit,
      step: (state, now, cost) => {
        const { timestamps, decision } = slidingWindowStep(state ?? [], now, params, cost);
        return { state: timestamps, decision };
      },
      isExpired: (state, now) => slidingWindowIsExpired(state, now, params),
    },
    options,
  );
}
