/** Milliseconds since the epoch. Injected so tests can control time. */
export type Clock = () => number;

export interface RateLimitDecision {
  allowed: boolean;
  /** Bucket capacity (token bucket) or max requests per window (sliding window). */
  limit: number;
  /** Whole requests still available after this call. */
  remaining: number;
  /** When denied: ms until a request of the same cost would be admitted. 0 when allowed. */
  retryAfterMs: number;
  /** ms until the limiter is back to its full allowance. */
  resetAfterMs: number;
  /** True when the decision came from a fallback path because the primary store was unavailable. */
  degraded?: boolean;
}

export interface RateLimiter {
  /**
   * Atomically check and, if allowed, consume `cost` units for `key`.
   * Denied calls never consume anything.
   */
  consume(key: string, cost?: number): Promise<RateLimitDecision>;
  close?(): Promise<void> | void;
}

export type RateLimitRule =
  | { algorithm: 'token-bucket'; capacity: number; refillPerSecond: number }
  | { algorithm: 'sliding-window'; limit: number; windowMs: number };

/** Stable identifier for the algorithm, used to namespace keys so two algorithms never share a Redis key. */
export function algorithmTag(rule: RateLimitRule): 'tb' | 'sw' {
  return rule.algorithm === 'token-bucket' ? 'tb' : 'sw';
}

/** Raised when the limiter's backing store is down and the configured failure mode is "closed". */
export class RateLimiterUnavailableError extends Error {
  constructor(message = 'rate limiter unavailable', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RateLimiterUnavailableError';
  }
}
