import { describe, expect, it } from 'vitest';
import { slidingWindowCounterStep, slidingWindowStep, type WindowCounterState } from '../src/ratelimit/algorithms.js';
import { memorySlidingWindowCounter } from '../src/ratelimit/memory.js';

/** Small deterministic generator so any failure is reproducible from its seed. */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe('sliding window counter (approximate)', () => {
  const params = { limit: 10, windowMs: 1000 };

  /** Drive the pure function through (time, cost) calls, threading the state. */
  function run(calls: Array<[number, number?]>, p = params) {
    let state: WindowCounterState | undefined;
    return calls.map(([now, cost = 1]) => {
      const step = slidingWindowCounterStep(state, now, p, cost);
      state = step.state;
      return step.decision;
    });
  }

  it('admits up to the limit inside one window and denies the rest', () => {
    const d = run(Array.from({ length: 12 }, (_, i) => [100 + i] as [number]));
    expect(d.map((x) => x.allowed)).toEqual([...Array(10).fill(true), false, false]);
    expect(d.slice(0, 10).map((x) => x.remaining)).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('weights the previous window by how much of it is still inside the trailing window', () => {
    // Ten requests at the very end of window 0. At t=1500 half of window 0 is still in view: the estimate is
    // 5, so exactly five more fit.
    const fill = Array.from({ length: 10 }, (_, i) => [990 + i] as [number]);
    const probes = Array.from({ length: 6 }, () => [1500] as [number]);
    const d = run([...fill, ...probes]);
    expect(d.slice(10).map((x) => x.allowed)).toEqual([true, true, true, true, true, false]);
  });

  it('returns the whole allowance once a full window has passed', () => {
    const fill = Array.from({ length: 10 }, () => [0] as [number]);
    const d = run([...fill, [1000], [2000]]);
    expect(d[10]?.allowed).toBe(false); // t=1000: all of window 0 is still in view, at full weight
    expect(d[11]?.allowed).toBe(true); // t=2000: window 0 has aged out completely
    expect(d[11]?.remaining).toBe(9);
  });

  it('supports weighted requests', () => {
    const d = run([
      [0, 6],
      [0, 6],
      [0, 4],
      [0, 1],
    ]);
    expect(d.map((x) => x.allowed)).toEqual([true, false, true, false]);
  });

  it('advertises a retry time that is tight: denied one ms earlier, admitted exactly then', () => {
    const rand = lcg(12345);
    let checked = 0;
    for (let trial = 0; trial < 300; trial++) {
      const p = { limit: 1 + Math.floor(rand() * 12), windowMs: 100 + Math.floor(rand() * 900) };
      let state: WindowCounterState | undefined;
      let t = Math.floor(rand() * 5000);
      for (let i = 0; i < 40; i++) {
        t += Math.floor(rand() * (p.windowMs / 3));
        const cost = 1 + Math.floor(rand() * Math.min(3, p.limit));
        const step = slidingWindowCounterStep(state, t, p, cost);
        if (step.decision.allowed) {
          state = step.state;
          continue;
        }
        const wait = step.decision.retryAfterMs;
        expect(wait).toBeGreaterThanOrEqual(1);
        const context = `limit ${p.limit}, window ${p.windowMs}, wait ${wait}`;
        expect(slidingWindowCounterStep(state, t + wait - 1, p, cost).decision.allowed, `early: ${context}`).toBe(
          false,
        );
        expect(slidingWindowCounterStep(state, t + wait, p, cost).decision.allowed, `on time: ${context}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200); // the property was actually exercised
  });

  it('stays close to the exact sliding window log under bursty random traffic', () => {
    const rand = lcg(99);
    const p = { limit: 50, windowMs: 1000 };
    let counter: WindowCounterState | undefined;
    const log: number[] = [];
    let t = 0;
    let admittedCounter = 0;
    let admittedExact = 0;
    let disagreements = 0;
    const total = 20_000;
    for (let i = 0; i < total; i++) {
      t += Math.floor(rand() * 40); // about 50 requests per second offered: right at the limit
      const c = slidingWindowCounterStep(counter, t, p, 1);
      const e = slidingWindowStep(log, t, p, 1);
      if (c.decision.allowed) {
        counter = c.state;
        admittedCounter++;
      }
      if (e.decision.allowed) admittedExact++;
      if (c.decision.allowed !== e.decision.allowed) disagreements++;
    }
    expect(Math.abs(admittedCounter - admittedExact) / admittedExact).toBeLessThan(0.05);
    expect(disagreements / total).toBeLessThan(0.1);
  });

  it('does not allow the 2x boundary burst that a plain fixed window does', () => {
    const p = { limit: 100, windowMs: 1000 };
    let state: WindowCounterState | undefined;
    let admitted = 0;
    // 100 requests just before a window boundary and 100 just after it: a fixed window admits all 200.
    for (const t of [...Array(100).fill(990), ...Array(100).fill(1010)]) {
      const step = slidingWindowCounterStep(state, t, p, 1);
      if (step.decision.allowed) {
        state = step.state;
        admitted++;
      }
    }
    expect(admitted).toBeLessThan(110);
  });

  it('survives the clock stepping backwards', () => {
    const d = run([[5000, 10], [100], [5000]]);
    expect(d[1]?.allowed).toBe(false); // an earlier timestamp must not reopen an older window
    expect(d[2]?.allowed).toBe(false);
  });

  it('leaves stored state untouched on a denial', () => {
    const first = slidingWindowCounterStep(undefined, 100, params, 10);
    const denied = slidingWindowCounterStep(first.state, 100, params, 1);
    expect(denied.decision.allowed).toBe(false);
    expect(denied.state).toBe(first.state);
  });
});

describe('in-memory sliding window counter', () => {
  it('keeps keys independent and drops keys whose windows have aged out', async () => {
    let now = 0;
    const limiter = memorySlidingWindowCounter(
      { limit: 1, windowMs: 1000 },
      { clock: () => now, maxKeys: 3, sweepIntervalMs: 0 },
    );
    expect((await limiter.consume('a')).allowed).toBe(true);
    expect((await limiter.consume('a')).allowed).toBe(false);
    expect((await limiter.consume('b')).allowed).toBe(true);
    await limiter.consume('c');
    now += 5000;
    await limiter.consume('d'); // at capacity: sweeps the aged-out keys instead of evicting a live one
    expect(limiter.size).toBe(1);
    limiter.close();
  });

  it('keeps one small state per key however high the limit', async () => {
    const limiter = memorySlidingWindowCounter({ limit: 1_000_000, windowMs: 60_000 }, { sweepIntervalMs: 0 });
    for (let i = 0; i < 20_000; i++) await limiter.consume('one-busy-client');
    expect(limiter.size).toBe(1);
    limiter.close();
  });
});
