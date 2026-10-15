import { describe, expect, it } from 'vitest';
import { slidingWindowStep, type TokenBucketState, tokenBucketStep } from '../src/ratelimit/algorithms.js';
import { memorySlidingWindow, memoryTokenBucket } from '../src/ratelimit/memory.js';

/** Drive the pure token bucket through a list of (time, cost) calls. */
function runBucket(params: { capacity: number; refillPerSecond: number }, calls: Array<[number, number?]>) {
  let state: TokenBucketState | undefined;
  return calls.map(([now, cost = 1]) => {
    const step = tokenBucketStep(state, now, params, cost);
    state = step.state;
    return step.decision;
  });
}

describe('token bucket', () => {
  const params = { capacity: 5, refillPerSecond: 10 }; // 1 token per 100ms

  it('starts full and allows a burst up to capacity, then denies', () => {
    const decisions = runBucket(
      params,
      Array.from({ length: 7 }, () => [0] as [number]),
    );
    expect(decisions.map((d) => d.allowed)).toEqual([true, true, true, true, true, false, false]);
    expect(decisions.map((d) => d.remaining)).toEqual([4, 3, 2, 1, 0, 0, 0]);
  });

  it('tells a denied caller exactly when a token will be available', () => {
    const [, , , , , denied] = runBucket(params, [[0], [0], [0], [0], [0], [0]]);
    expect(denied?.allowed).toBe(false);
    expect(denied?.retryAfterMs).toBe(100);
  });

  it('refills continuously, not in steps', () => {
    const d = runBucket(params, [[0], [0], [0], [0], [0], [99], [100]]);
    expect(d[5]?.allowed).toBe(false); // 0.99 tokens
    expect(d[6]?.allowed).toBe(true); // 1.0 tokens
  });

  it('never accumulates beyond capacity however long it idles', () => {
    const d = runBucket(params, [[0], [3_600_000], ...Array.from({ length: 5 }, () => [3_600_000] as [number])]);
    // After an hour idle there are exactly `capacity` tokens: the first call plus four more succeed, the rest fail.
    expect(d.slice(1).map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it('supports weighted requests', () => {
    const d = runBucket(params, [
      [0, 3],
      [0, 3],
      [0, 2],
    ]);
    expect(d.map((x) => x.allowed)).toEqual([true, false, true]);
    expect(d[1]?.retryAfterMs).toBe(100); // has 2, needs 3
  });

  it('bounds total admissions to burst + rate * elapsed under sustained overload', () => {
    // Hammer every millisecond for 10 seconds.
    const calls: Array<[number]> = Array.from({ length: 10_001 }, (_, t) => [t]);
    const admitted = runBucket(params, calls).filter((d) => d.allowed).length;
    expect(admitted).toBe(5 + 10 * 10); // capacity + refill over 10s
  });

  it('reports time until fully refilled', () => {
    const d = runBucket(params, [[0, 5]]);
    expect(d[0]?.resetAfterMs).toBe(500);
  });

  it('survives the clock stepping backwards', () => {
    const d = runBucket(params, [[1000, 5], [500], [1000]]);
    expect(d[1]?.allowed).toBe(false); // no refill is granted for negative elapsed time
    expect(d[2]?.allowed).toBe(false);
  });
});

describe('sliding window log', () => {
  const params = { limit: 3, windowMs: 1000 };

  function run(calls: Array<[number, number?]>) {
    const log: number[] = [];
    return calls.map(([now, cost = 1]) => slidingWindowStep(log, now, params, cost).decision);
  }

  it('admits up to the limit within a window and denies the rest', () => {
    const d = run([[0], [10], [20], [30]]);
    expect(d.map((x) => x.allowed)).toEqual([true, true, true, false]);
    expect(d.map((x) => x.remaining)).toEqual([2, 1, 0, 0]);
  });

  it('retryAfter is when the oldest blocking entry leaves the window', () => {
    const d = run([[0], [100], [200], [300]]);
    expect(d[3]?.retryAfterMs).toBe(700); // entry at t=0 expires at t=1000
  });

  it('admits again at exactly the moment the oldest entry expires', () => {
    const d = run([[0], [100], [200], [999], [1000]]);
    expect(d[3]?.allowed).toBe(false);
    expect(d[4]?.allowed).toBe(true);
  });

  it('has no fixed-window boundary burst', () => {
    // A fixed window of 1000ms would reset at t=1000 and allow 3 more right after 3 at t=900.
    const d = run([[900], [900], [900], [1000], [1100], [1899], [1900]]);
    expect(d.map((x) => x.allowed)).toEqual([true, true, true, false, false, false, true]);
  });

  it('does not record denied requests', () => {
    const d = run([[0], [1], [2], [3], [4], [5], [1000]]);
    // If denials were recorded the window would still be full at t=1000; it must have exactly one free slot.
    expect(d[6]?.allowed).toBe(true);
    expect(d[6]?.remaining).toBe(0); // t=1 and t=2 are still in the window, plus the one just admitted
  });

  it('handles cost > 1 and computes the retry time for the needed number of expiries', () => {
    const d = run([[0], [100], [200], [300, 2]]);
    // Window holds 3 (t=0,100,200). Need 2 slots, so the 2nd oldest (t=100) must expire: at t=1100.
    expect(d[3]?.allowed).toBe(false);
    expect(d[3]?.retryAfterMs).toBe(1100 - 300);
  });

  it('reports time until the window is completely clear', () => {
    const d = run([[0], [100], [200], [300]]);
    expect(d[2]?.resetAfterMs).toBe(1000); // just admitted, so it takes a full window to empty
    expect(d[3]?.allowed).toBe(false);
    expect(d[3]?.resetAfterMs).toBe(200 + 1000 - 300); // the newest admitted entry (t=200) leaves last
  });
});

describe('in-memory limiters', () => {
  it('keeps keys independent', async () => {
    let now = 0;
    const limiter = memorySlidingWindow({ limit: 1, windowMs: 1000 }, { clock: () => now, sweepIntervalMs: 0 });
    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
    expect((await limiter.consume('b')).allowed).toBe(true);
    now += 1000;
    expect((await limiter.consume('a')).allowed).toBe(true);
    limiter.close();
  });

  it('rejects impossible costs instead of silently denying forever', async () => {
    const limiter = memoryTokenBucket({ capacity: 2, refillPerSecond: 1 }, { sweepIntervalMs: 0 });
    await expect(limiter.consume('k', 3)).rejects.toBeInstanceOf(RangeError);
    await expect(limiter.consume('k', 0)).rejects.toBeInstanceOf(RangeError);
    await expect(limiter.consume('k', 1.5)).rejects.toBeInstanceOf(RangeError);
    limiter.close();
  });

  it('caps tracked keys so unbounded identities cannot exhaust memory', async () => {
    const limiter = memoryTokenBucket({ capacity: 5, refillPerSecond: 1 }, { maxKeys: 100, sweepIntervalMs: 0 });
    for (let i = 0; i < 1000; i++) await limiter.consume(`client-${i}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
    limiter.close();
  });

  it('sweeps keys whose state is indistinguishable from a fresh one', async () => {
    let now = 0;
    const limiter = memoryTokenBucket(
      { capacity: 2, refillPerSecond: 1 },
      { clock: () => now, maxKeys: 3, sweepIntervalMs: 0 },
    );
    await limiter.consume('a');
    await limiter.consume('b');
    await limiter.consume('c');
    now += 60_000; // all three have long since refilled
    await limiter.consume('d'); // at capacity: triggers a sweep rather than evicting a live client
    expect(limiter.size).toBe(1);
    limiter.close();
  });
});
