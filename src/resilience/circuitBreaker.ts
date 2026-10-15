/**
 * Circuit breaker.
 *
 *            failure rate >= threshold                 openDurationMs elapsed
 *   CLOSED ───────────────────────────▶ OPEN ─────────────────────────────▶ HALF-OPEN
 *      ▲                                  ▲                                     │
 *      │      enough probe successes      │          any probe failure          │
 *      └──────────────────────────────────┴─────────────────────────────────────┘
 *
 * CLOSED    calls flow; outcomes are counted over a rolling window.
 * OPEN      calls are rejected immediately (fail fast) so a struggling upstream gets room to recover.
 * HALF-OPEN a few probe calls are let through; their outcome decides whether to close or re-open.
 *
 * Callers take a {@link Permit} before each call and report the outcome on it. Outcomes that arrive from a
 * previous "era" (the call started before the breaker last changed state) are ignored, so a slow request that
 * began while CLOSED can't masquerade as a half-open probe result.
 */
import type { Clock } from '../ratelimit/types.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Open when failures / total >= this (0..1) ... */
  failureRateThreshold: number;
  /** ... and at least this many calls were seen in the window (avoids tripping on 1 failure out of 1). */
  minimumRequests: number;
  /** Rolling window over which outcomes are counted. */
  windowMs: number;
  /** How long to stay OPEN before allowing probes. */
  openDurationMs: number;
  /** Max concurrent probe calls while HALF-OPEN. */
  halfOpenMaxCalls: number;
  /** Probe successes needed to close again. */
  halfOpenSuccesses: number;
  clock?: Clock;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export const DEFAULT_BREAKER_OPTIONS: Omit<CircuitBreakerOptions, 'clock' | 'onStateChange'> = {
  failureRateThreshold: 0.5,
  minimumRequests: 10,
  windowMs: 10_000,
  openDurationMs: 10_000,
  halfOpenMaxCalls: 1,
  halfOpenSuccesses: 2,
};

export class CircuitOpenError extends Error {
  constructor(
    readonly retryAfterMs: number,
    message = 'circuit breaker is open',
  ) {
    super(message);
    this.name = 'CircuitOpenError';
  }
}

/** Handle for one admitted call. Only the first of success/failure/release has any effect. */
export interface Permit {
  success(): void;
  failure(): void;
  /** The call was abandoned for a reason that says nothing about upstream health (e.g. the client hung up). */
  release(): void;
}

export interface CircuitBreakerSnapshot {
  state: CircuitState;
  failures: number;
  total: number;
  failureRate: number;
  /** While OPEN: ms until probes are allowed. */
  retryAfterMs: number;
}

interface Bucket {
  start: number;
  ok: number;
  fail: number;
}

const BUCKETS_PER_WINDOW = 10;

export class CircuitBreaker {
  private readonly opts: Required<Omit<CircuitBreakerOptions, 'onStateChange'>> & Pick<CircuitBreakerOptions, 'onStateChange'>;
  private readonly bucketMs: number;
  private buckets: Bucket[] = [];

  private current: CircuitState = 'closed';
  private era = 0;
  private openedAt = 0;
  private probesInFlight = 0;
  private probeSuccesses = 0;

  constructor(options: Partial<CircuitBreakerOptions> = {}) {
    this.opts = { ...DEFAULT_BREAKER_OPTIONS, clock: Date.now, ...stripUndefined(options) };
    this.bucketMs = Math.max(1, Math.floor(this.opts.windowMs / BUCKETS_PER_WINDOW));
  }

  get state(): CircuitState {
    this.refresh(this.opts.clock());
    return this.current;
  }

  /** Ask to make a call. Returns undefined when the call must be rejected. */
  tryAcquire(): Permit | undefined {
    const now = this.opts.clock();
    this.refresh(now);

    if (this.current === 'open') return undefined;
    if (this.current === 'half-open') {
      if (this.probesInFlight >= this.opts.halfOpenMaxCalls) return undefined;
      this.probesInFlight++;
    }
    return this.makePermit(this.era, this.current === 'half-open');
  }

  /** Like {@link tryAcquire} but throws {@link CircuitOpenError} with a retry hint. */
  acquire(): Permit {
    const permit = this.tryAcquire();
    if (!permit) throw new CircuitOpenError(this.snapshot().retryAfterMs);
    return permit;
  }

  /** Run `fn` under the breaker. Any thrown error counts as a failure unless `isFailure` says otherwise. */
  async execute<T>(fn: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true): Promise<T> {
    const permit = this.acquire();
    try {
      const value = await fn();
      permit.success();
      return value;
    } catch (error) {
      if (isFailure(error)) permit.failure();
      else permit.release();
      throw error;
    }
  }

  snapshot(): CircuitBreakerSnapshot {
    const now = this.opts.clock();
    this.refresh(now);
    const { ok, fail } = this.totals(now);
    const total = ok + fail;
    return {
      state: this.current,
      failures: fail,
      total,
      failureRate: total === 0 ? 0 : fail / total,
      retryAfterMs: this.current === 'open' ? Math.max(0, this.openedAt + this.opts.openDurationMs - now) : 0,
    };
  }

  /** Force the breaker back to CLOSED with a clean slate (admin/testing). */
  reset(): void {
    this.transition('closed');
    this.buckets = [];
  }

  // ------------------------------------------------------------------------------------------------------------------

  private makePermit(era: number, isProbe: boolean): Permit {
    let settled = false;
    const settle = (kind: 'success' | 'failure' | 'release'): void => {
      if (settled) return;
      settled = true;
      if (era !== this.era) return; // stale: the breaker has moved on since this call was admitted
      if (isProbe) this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      if (kind === 'release') return;
      this.record(kind === 'success');
    };
    return {
      success: () => settle('success'),
      failure: () => settle('failure'),
      release: () => settle('release'),
    };
  }

  private record(ok: boolean): void {
    const now = this.opts.clock();

    if (this.current === 'half-open') {
      if (!ok) {
        this.trip(now);
      } else if (++this.probeSuccesses >= this.opts.halfOpenSuccesses) {
        this.transition('closed');
        this.buckets = [];
      }
      return;
    }

    if (this.current !== 'closed') return; // OPEN: nothing in flight is allowed to influence the decision

    const bucket = this.bucketFor(now);
    if (ok) bucket.ok++;
    else bucket.fail++;

    if (!ok) {
      const { ok: okCount, fail } = this.totals(now);
      const total = okCount + fail;
      if (total >= this.opts.minimumRequests && fail / total >= this.opts.failureRateThreshold) this.trip(now);
    }
  }

  private trip(now: number): void {
    this.openedAt = now;
    this.transition('open');
  }

  /** Lazily promote OPEN -> HALF-OPEN once the cool-down has elapsed. */
  private refresh(now: number): void {
    if (this.current === 'open' && now - this.openedAt >= this.opts.openDurationMs) {
      this.transition('half-open');
    }
  }

  private transition(to: CircuitState): void {
    if (to === this.current) return;
    const from = this.current;
    this.current = to;
    this.era++;
    this.probesInFlight = 0;
    this.probeSuccesses = 0;
    this.opts.onStateChange?.(from, to);
  }

  private bucketFor(now: number): Bucket {
    const start = now - (now % this.bucketMs);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.start === start) return last;
    const bucket: Bucket = { start, ok: 0, fail: 0 };
    this.buckets.push(bucket);
    return bucket;
  }

  private totals(now: number): { ok: number; fail: number } {
    const oldestKept = now - this.opts.windowMs;
    let drop = 0;
    while (drop < this.buckets.length && (this.buckets[drop] as Bucket).start + this.bucketMs <= oldestKept) drop++;
    if (drop > 0) this.buckets.splice(0, drop);

    let ok = 0;
    let fail = 0;
    for (const b of this.buckets) {
      ok += b.ok;
      fail += b.fail;
    }
    return { ok, fail };
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
