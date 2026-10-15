/**
 * Pure rate-limiting algorithms. State and the current time go in, a decision and the next state come out.
 * No I/O, no clocks: the in-memory limiter, the unit tests and the Redis Lua scripts (see redis.ts) all
 * implement exactly this behaviour, and the Redis integration test checks that they agree.
 */
import type { RateLimitDecision } from './types.js';

/** Tolerance for floating-point drift when comparing fractional token counts. Mirrored in the Lua script. */
const EPSILON = 1e-9;

// ---------------------------------------------------------------------------------------------------------------------
// Token bucket
//
// A bucket holds up to `capacity` tokens and refills continuously at `refillPerSecond`. Each request spends
// `cost` tokens. Allows bursts up to `capacity` while enforcing a long-run average of `refillPerSecond`.
// O(1) time and O(1) memory per key.
// ---------------------------------------------------------------------------------------------------------------------

export interface TokenBucketParams {
  capacity: number;
  refillPerSecond: number;
}

export interface TokenBucketState {
  /** Fractional tokens available as of `updatedAt`. */
  tokens: number;
  updatedAt: number;
}

export function tokenBucketStep(
  state: TokenBucketState | undefined,
  now: number,
  params: TokenBucketParams,
  cost: number,
): { state: TokenBucketState; decision: RateLimitDecision } {
  const { capacity, refillPerSecond } = params;
  const refillPerMs = refillPerSecond / 1000;

  // A key we have never seen (or one that expired, which only happens once it has refilled) is a full bucket.
  let tokens = capacity;
  let updatedAt = now;
  if (state) {
    const elapsed = Math.max(0, now - state.updatedAt); // tolerate the clock stepping backwards
    tokens = Math.min(capacity, state.tokens + elapsed * refillPerMs);
    updatedAt = Math.max(state.updatedAt, now);
  }

  const allowed = tokens + EPSILON >= cost;
  if (allowed) tokens -= cost;

  return {
    state: { tokens, updatedAt },
    decision: {
      allowed,
      limit: capacity,
      remaining: Math.max(0, Math.floor(tokens + EPSILON)),
      retryAfterMs: allowed ? 0 : Math.ceil((cost - tokens) / refillPerMs),
      resetAfterMs: Math.ceil((capacity - tokens) / refillPerMs),
    },
  };
}

/** A bucket that has refilled completely is indistinguishable from a missing one and can be dropped. */
export function tokenBucketIsExpired(state: TokenBucketState, now: number, params: TokenBucketParams): boolean {
  const elapsed = Math.max(0, now - state.updatedAt);
  return state.tokens + (elapsed * params.refillPerSecond) / 1000 + EPSILON >= params.capacity;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sliding window log
//
// Remembers the timestamp of every admitted request and admits a new one only if fewer than `limit` fall inside
// the trailing `windowMs`. Exact (no boundary burst like a fixed window) at the price of O(limit) memory per key.
// A request at time t counts against the window (t - windowMs, t].
// ---------------------------------------------------------------------------------------------------------------------

export interface SlidingWindowParams {
  limit: number;
  windowMs: number;
}

/**
 * `timestamps` must be sorted ascending. It is mutated in place and returned, to avoid copying up to `limit`
 * entries on every request.
 */
export function slidingWindowStep(
  timestamps: number[],
  now: number,
  params: SlidingWindowParams,
  cost: number,
): { timestamps: number[]; decision: RateLimitDecision } {
  const { limit, windowMs } = params;

  // Never let a backwards clock step break the sort order.
  const last = timestamps[timestamps.length - 1];
  if (last !== undefined && now < last) now = last;

  // Evict everything that has aged out: ts <= now - windowMs.
  const cutoff = now - windowMs;
  let expired = 0;
  while (expired < timestamps.length && (timestamps[expired] as number) <= cutoff) expired++;
  if (expired > 0) timestamps.splice(0, expired);

  const count = timestamps.length;
  if (count + cost <= limit) {
    for (let i = 0; i < cost; i++) timestamps.push(now);
    return {
      timestamps,
      decision: {
        allowed: true,
        limit,
        remaining: limit - count - cost,
        retryAfterMs: 0,
        resetAfterMs: windowMs, // the entry we just added is the newest, so the window empties in windowMs
      },
    };
  }

  // Denied. To fit `cost` more, the oldest `need` entries must age out; the need-th oldest is the last of them.
  const need = count + cost - limit;
  const blocking = timestamps[need - 1] as number;
  const newest = timestamps[count - 1] as number;
  return {
    timestamps,
    decision: {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterMs: blocking + windowMs - now,
      resetAfterMs: newest + windowMs - now,
    },
  };
}

export function slidingWindowIsExpired(timestamps: number[], now: number, params: SlidingWindowParams): boolean {
  const newest = timestamps[timestamps.length - 1];
  return newest === undefined || newest + params.windowMs <= now;
}
