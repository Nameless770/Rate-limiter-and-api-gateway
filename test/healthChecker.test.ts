import { describe, expect, it } from 'vitest';
import { HealthChecker, type ProbeResult, type Timer } from '../src/resilience/healthChecker.js';

/** A scheduler the test drives by hand, so no test waits on a real interval. */
function manualScheduler() {
  interface Scheduled extends Timer {
    fn: () => void;
    ms: number;
    cleared: boolean;
    fired: boolean;
  }
  const timers: Scheduled[] = [];
  return {
    timers,
    setTimer: (fn: () => void, ms: number): Timer => {
      const t: Scheduled = { fn, ms, cleared: false, fired: false, unref: () => undefined };
      timers.push(t);
      return t;
    },
    clearTimer: (t: Timer) => {
      (t as Scheduled).cleared = true;
    },
    /** Fire the oldest pending timer, then let the resulting probe settle. */
    async fire() {
      const next = timers.find((t) => !t.cleared && !t.fired);
      if (!next) throw new Error('no pending timer');
      next.fired = true;
      next.fn();
      await flush();
    },
    pending: () => timers.filter((t) => !t.cleared && !t.fired),
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Partial<ConstructorParameters<typeof HealthChecker>[1]> = {}, ids = ['a']) {
  const results: ProbeResult[] = [];
  const probed: string[] = [];
  const changes: Array<{ id: string; healthy: boolean; reason?: string }> = [];
  const scheduler = manualScheduler();
  const checker = new HealthChecker(
    ids,
    {
      intervalMs: 1000,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
      random: () => 0.5,
      probe: async (id) => {
        probed.push(id);
        return results.shift() ?? { ok: true, status: 200 };
      },
      onChange: (id, healthy, reason) => changes.push({ id, healthy, reason }),
      setTimer: scheduler.setTimer,
      clearTimer: scheduler.clearTimer,
      ...overrides,
    },
    () => 1_000_000,
  );
  const push = (...r: ProbeResult[]) => results.push(...r);
  return { checker, scheduler, push, probed, changes };
}

const ok = (): ProbeResult => ({ ok: true, status: 200 });
const bad = (reason = 'status 500'): ProbeResult => ({ ok: false, status: 500, reason });

describe('HealthChecker', () => {
  it('trusts a target until a probe says otherwise', () => {
    const { checker } = setup();
    expect(checker.isHealthy('a')).toBe(true);
    expect(checker.isHealthy('never-heard-of-it')).toBe(true);
  });

  it('probes immediately on start, then once per interval', async () => {
    const { checker, scheduler, probed } = setup();
    checker.start();
    await flush();
    expect(probed).toEqual(['a']);
    expect(scheduler.pending()).toHaveLength(1);
    await scheduler.fire();
    await scheduler.fire();
    expect(probed).toEqual(['a', 'a', 'a']);
  });

  it('needs a run of consecutive failures to condemn a healthy target', async () => {
    const { checker, push, changes } = setup();
    push(bad(), bad(), ok(), bad(), bad()); // the success in the middle resets the count
    for (let i = 0; i < 5; i++) await checker.probeAll();
    expect(checker.isHealthy('a')).toBe(true);
    expect(changes).toEqual([]);

    push(bad('status 503'));
    await checker.probeAll(); // third consecutive failure
    expect(checker.isHealthy('a')).toBe(false);
    expect(changes).toEqual([{ id: 'a', healthy: false, reason: 'status 503' }]);
  });

  it('needs a run of consecutive successes to forgive an unhealthy target', async () => {
    const { checker, push, changes } = setup();
    push(bad(), bad(), bad());
    for (let i = 0; i < 3; i++) await checker.probeAll();
    expect(checker.isHealthy('a')).toBe(false);

    push(ok(), bad(), ok()); // a failure interrupts the streak
    for (let i = 0; i < 3; i++) await checker.probeAll();
    expect(checker.isHealthy('a')).toBe(false);

    push(ok());
    await checker.probeAll(); // second consecutive success
    expect(checker.isHealthy('a')).toBe(true);
    expect(changes.map((c) => c.healthy)).toEqual([false, true]);
  });

  it('reports a change only when the verdict changes, not on every probe', async () => {
    const { checker, push, changes } = setup();
    push(...Array.from({ length: 10 }, bad));
    for (let i = 0; i < 10; i++) await checker.probeAll();
    expect(changes).toHaveLength(1);
    push(...Array.from({ length: 10 }, ok));
    for (let i = 0; i < 10; i++) await checker.probeAll();
    expect(changes).toHaveLength(2);
  });

  it('tracks targets independently', async () => {
    const { checker, changes } = setup(
      {
        probe: async (id) => (id === 'bad' ? bad() : ok()),
        unhealthyThreshold: 1,
      },
      ['good', 'bad'],
    );
    await checker.probeAll();
    expect(checker.isHealthy('good')).toBe(true);
    expect(checker.isHealthy('bad')).toBe(false);
    expect(changes).toEqual([{ id: 'bad', healthy: false, reason: 'status 500' }]);
  });

  it('schedules the next probe with ±10% jitter, after the previous one finishes', async () => {
    const lowest = setup({ random: () => 0 });
    lowest.checker.start();
    await flush();
    expect(lowest.scheduler.timers[0]?.ms).toBe(900);

    const highest = setup({ random: () => 1 });
    highest.checker.start();
    await flush();
    expect(highest.scheduler.timers[0]?.ms).toBe(1100);
  });

  it('never runs two probes of one target at once', async () => {
    let release: () => void = () => undefined;
    let concurrent = 0;
    let peak = 0;
    const { checker } = setup({
      probe: async () => {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        concurrent--;
        return ok();
      },
    });
    const first = checker.probeAll();
    const second = checker.probeAll(); // while the first is still in flight
    await flush();
    release();
    await Promise.all([first, second]);
    expect(peak).toBe(1);
  });

  it('stop() cancels pending timers and stops rescheduling even with a probe in flight', async () => {
    let release: () => void = () => undefined;
    const { checker, scheduler } = setup({
      probe: () =>
        new Promise<ProbeResult>((resolve) => {
          release = () => resolve(ok());
        }),
    });
    checker.start();
    await flush(); // first probe is now waiting
    checker.stop();
    release();
    await flush();
    expect(scheduler.pending()).toHaveLength(0); // nothing was scheduled after stopping
  });

  it('survives a probe that throws, counting it as a failure', async () => {
    const { checker, scheduler, changes } = setup({
      unhealthyThreshold: 1,
      probe: async () => {
        throw new Error('boom');
      },
    });
    checker.start();
    await flush();
    expect(checker.isHealthy('a')).toBe(false);
    expect(changes[0]?.reason).toBe('probe error: boom');
    expect(scheduler.pending()).toHaveLength(1); // the schedule carries on
  });

  it('keeps a snapshot of the latest probe', async () => {
    const { checker, push } = setup();
    push(bad('status 502'), ok());
    await checker.probeAll();
    expect(checker.snapshot('a')).toMatchObject({
      healthy: true,
      consecutiveFailures: 1,
      consecutiveSuccesses: 0,
      checks: 1,
      lastStatus: 500,
      lastError: 'status 502',
      lastCheckAt: 1_000_000,
    });
    await checker.probeAll();
    expect(checker.snapshot('a')).toMatchObject({
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      checks: 2,
      lastStatus: 200,
    });
    expect(checker.snapshot('a')?.lastError).toBeUndefined(); // a good probe clears the old complaint
    expect(checker.snapshot('missing')).toBeUndefined();
  });
});
