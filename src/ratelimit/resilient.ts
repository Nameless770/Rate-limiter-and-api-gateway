/**
 * Wraps a networked limiter (Redis) so the gateway stays up when the store doesn't.
 *
 * A rate limiter sits on the hot path of every request, which makes "what if Redis is down?" a design
 * decision rather than an error case:
 *
 *   open    let traffic through unlimited. Availability over protection.
 *   closed  reject with 503. Protection over availability.
 *   local   keep limiting with a per-instance in-memory limiter. With N instances the effective global limit
 *           degrades to roughly N x limit, but abuse is still bounded. (default)
 *
 * A circuit breaker around the store means that once Redis is clearly unhealthy we stop paying its timeout
 * on every request and go straight to the fallback until it recovers.
 */
import { CircuitBreaker, CircuitOpenError, type CircuitBreakerOptions } from '../resilience/circuitBreaker.js';
import type { RateLimitDecision, RateLimiter } from './types.js';
import { RateLimiterUnavailableError } from './types.js';

export type FailureMode = 'open' | 'closed' | 'local';

export interface ResilientLimiterOptions {
  mode: FailureMode;
  /** Required when mode is "local". */
  fallback?: RateLimiter;
  /** Used to synthesize a decision in "open" mode. */
  limit: number;
  breaker?: CircuitBreaker;
  breakerOptions?: Partial<CircuitBreakerOptions>;
  onError?: (error: unknown) => void;
}

export class ResilientRateLimiter implements RateLimiter {
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly primary: RateLimiter,
    private readonly opts: ResilientLimiterOptions,
  ) {
    if (opts.mode === 'local' && !opts.fallback) throw new Error('mode "local" requires a fallback limiter');
    this.breaker =
      opts.breaker ??
      new CircuitBreaker({
        failureRateThreshold: 0.5,
        minimumRequests: 5,
        windowMs: 5_000,
        openDurationMs: 3_000,
        halfOpenMaxCalls: 1,
        halfOpenSuccesses: 1,
        ...opts.breakerOptions,
      });
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    try {
      return await this.breaker.execute(() => this.primary.consume(key, cost), isStoreFailure);
    } catch (error) {
      if (isCallerError(error)) throw error;
      if (!(error instanceof CircuitOpenError)) this.opts.onError?.(error);
      return this.degrade(key, cost, error);
    }
  }

  async close(): Promise<void> {
    await this.primary.close?.();
    await this.opts.fallback?.close?.();
  }

  private async degrade(key: string, cost: number, cause: unknown): Promise<RateLimitDecision> {
    switch (this.opts.mode) {
      case 'local':
        return { ...(await (this.opts.fallback as RateLimiter).consume(key, cost)), degraded: true };
      case 'open':
        return {
          allowed: true,
          limit: this.opts.limit,
          remaining: this.opts.limit,
          retryAfterMs: 0,
          resetAfterMs: 0,
          degraded: true,
        };
      case 'closed':
        throw new RateLimiterUnavailableError('rate limiter store unavailable', { cause });
    }
  }
}

/** A bad `cost` is a bug in the caller, not a sign the store is unhealthy. */
function isCallerError(error: unknown): boolean {
  return error instanceof RangeError;
}

function isStoreFailure(error: unknown): boolean {
  return !isCallerError(error);
}
