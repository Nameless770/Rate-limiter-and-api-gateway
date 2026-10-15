/**
 * Retries with exponential backoff and full jitter.
 *
 * Delay before retry n (1-based) is uniform in [0, min(maxDelay, base * 2^(n-1))]. Full jitter spreads
 * retries from many clients evenly over the interval, which avoids the synchronized "retry storms" that
 * plain exponential backoff produces when a shared upstream blips.
 */

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

export function backoffDelayMs(retryNumber: number, policy: BackoffPolicy, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retryNumber - 1));
  return Math.floor(random() * (ceiling + 1));
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface RetryOptions<T> {
  /** Total number of tries including the first. */
  maxAttempts: number;
  backoff: BackoffPolicy;
  /** Decide whether an outcome (a value or a thrown error) deserves another try. */
  shouldRetry(outcome: Outcome<T>, attempt: number): boolean;
  /**
   * Server-supplied hint for how long to wait (e.g. `Retry-After`). The retry waits at least this long; a hint
   * longer than `backoff.maxDelayMs` means "not soon", so the current outcome is returned instead of retried.
   */
  retryAfterMs?(outcome: Outcome<T>): number | undefined;
  /** Release resources held by a value that is being thrown away in favour of another attempt. */
  discard?(value: T): void;
  onRetry?(info: { attempt: number; delayMs: number; outcome: Outcome<T> }): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  random?(): number;
  signal?: AbortSignal;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Run `fn` until it produces an outcome that is not retryable or attempts run out. The final outcome is
 * returned (or its error rethrown) unchanged, so an upstream's last 503 reaches the client as a 503.
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions<T>): Promise<T> {
  const sleep = opts.sleep ?? abortableSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 1; ; attempt++) {
    let outcome: Outcome<T>;
    try {
      outcome = { ok: true, value: await fn(attempt) };
    } catch (error) {
      outcome = { ok: false, error };
    }

    let delayMs = 0;
    let again = attempt < opts.maxAttempts && !opts.signal?.aborted && opts.shouldRetry(outcome, attempt);
    if (again) {
      const hint = opts.retryAfterMs?.(outcome) ?? 0;
      if (hint > opts.backoff.maxDelayMs) {
        again = false;
      } else {
        delayMs = Math.max(backoffDelayMs(attempt, opts.backoff, random), hint);
      }
    }

    if (!again) {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    }

    if (outcome.ok) opts.discard?.(outcome.value);
    opts.onRetry?.({ attempt, delayMs, outcome });
    await sleep(delayMs, opts.signal);
  }
}
