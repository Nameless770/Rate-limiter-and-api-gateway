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

// ---------------------------------------------------------------------------------------------------------------------
// Sliding window counter (approximate)
//
// Keeps one counter for the current fixed window and one for the previous, and estimates the trailing-window
// count as `previous * (share of the previous window still inside the trailing window) + current`. It assumes
// the previous window's requests were spread evenly, which makes it an approximation: it can briefly admit a
// little more or less than an exact log would, but it uses O(1) memory per key however large `limit` is, where
// the log needs one entry per admitted request.
//
// All arithmetic is scaled by `windowMs` and kept in integers, so the Redis Lua script can reproduce every
// decision exactly instead of agreeing only up to floating-point drift.
// ---------------------------------------------------------------------------------------------------------------------

export interface WindowCounterState {
  /** Index of the fixed window `current` belongs to: floor(timestamp / windowMs). */
  window: number;
  current: number;
  previous: number;
}

export function slidingWindowCounterStep(
  state: WindowCounterState | undefined,
  now: number,
  params: SlidingWindowParams,
  cost: number,
): { state: WindowCounterState; decision: RateLimitDecision } {
  const { limit, windowMs } = params;

  // A clock stepping backwards must not move us into a window earlier than the one we have state for.
  const at = state ? Math.max(now, state.window * windowMs) : now;
  const window = Math.floor(at / windowMs);
  const elapsed = at - window * windowMs;

  let current = 0;
  let previous = 0;
  if (state) {
    if (state.window === window) {
      current = state.current;
      previous = state.previous;
    } else if (state.window === window - 1) {
      previous = state.current;
    } // older than that: both windows have aged out completely
  }

  const capacity = limit * windowMs;
  let used = previous * (windowMs - elapsed) + current * windowMs; // estimated count, scaled by windowMs

  if (used + cost * windowMs <= capacity) {
    current += cost;
    used += cost * windowMs;
    return {
      state: { window, current, previous },
      decision: {
        allowed: true,
        limit,
        remaining: Math.max(0, Math.floor((capacity - used) / windowMs)),
        retryAfterMs: 0,
        resetAfterMs: windowMs - elapsed + windowMs, // `current` decays to nothing by the end of the next window
      },
    };
  }

  // Denied: find the first instant the estimate drops far enough to fit `cost`.
  const headroom = limit - current - cost;
  let retryAfterMs: number;
  if (headroom >= 0 && previous > 0) {
    // Same window: previous * (windowMs - e) <= headroom * windowMs, so e >= windowMs - floor(headroom*windowMs/previous).
    const needed = windowMs - Math.floor((headroom * windowMs) / previous);
    retryAfterMs = Math.max(1, needed - elapsed);
  } else {
    // `current` alone fills the window, so wait for it to roll over and decay as `previous`.
    const spare = limit - cost; // >= 0 because cost <= limit; current > 0 here
    const needed = Math.max(0, windowMs - Math.floor((spare * windowMs) / current));
    retryAfterMs = windowMs - elapsed + needed;
  }

  return {
    // Denials never write, in either implementation, so the stored state is left exactly as it was.
    state: state ?? { window, current, previous },
    decision: {
      allowed: false,
      limit,
      remaining: 0,
      retryAfterMs,
      resetAfterMs: current > 0 ? windowMs - elapsed + windowMs : windowMs - elapsed,
    },
  };
}

/** Once both windows have aged out the state is indistinguishable from none and can be dropped. */
export function slidingWindowCounterIsExpired(
  state: WindowCounterState,
  now: number,
  params: SlidingWindowParams,
): boolean {
  return state.window < Math.floor(now / params.windowMs) - 1;
}
