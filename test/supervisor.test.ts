import { describe, expect, it } from 'vitest';
import type { ToWorker } from '../src/cluster/protocol.js';
import { Supervisor, type WorkerHandle, type WorkerLauncher } from '../src/cluster/supervisor.js';
import { silentLogger } from '../src/observability/logger.js';
import { capturingLogger } from './helpers.js';

class FakeWorker implements WorkerHandle {
  sent: ToWorker[] = [];
  killed = false;
  throwOnSend = false;
  private messageListeners: Array<(m: unknown) => void> = [];
  private exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

  constructor(
    readonly index: number,
    readonly pid: number,
  ) {}

  send(message: ToWorker): void {
    if (this.throwOnSend) throw new Error('channel closed');
    this.sent.push(message);
  }
  kill(): void {
    this.killed = true;
    this.exit(null, 'SIGKILL');
  }
  onMessage(listener: (m: unknown) => void): void {
    this.messageListeners.push(listener);
  }
  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  say(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
  ready(port = 8080): void {
    this.say({ gw: 'ready', pid: this.pid, port });
  }
  exit(code: number | null = 1, signal: string | null = null): void {
    for (const listener of this.exitListeners) listener(code, signal);
  }
  /** The `collect` requests this worker has been sent, as {id, what}. */
  requests(): Array<{ id: number; what: string }> {
    return this.sent.flatMap((m) => (m.gw === 'collect' ? [{ id: m.id, what: m.what }] : []));
  }
}

class FakeLauncher implements WorkerLauncher {
  readonly launched: FakeWorker[] = [];
  launch(index: number): FakeWorker {
    const worker = new FakeWorker(index, 1000 + this.launched.length);
    this.launched.push(worker);
    return worker;
  }
  /** The newest process in slot `index`. */
  current(index: number): FakeWorker {
    return this.launched.filter((w) => w.index === index).at(-1) as FakeWorker;
  }
}

class FakeTimers {
  now = 0;
  private nextId = 1;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => void this.tasks.delete(id as number);
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.tasks.delete(due[0]);
      this.now = Math.max(this.now, due[1].at);
      due[1].fn();
    }
    this.now = until;
  }
  get pending(): number {
    return this.tasks.size;
  }
}

function setup(options: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  const launcher = new FakeLauncher();
  const timers = new FakeTimers();
  const supervisor = new Supervisor({
    workers: 3,
    launcher,
    logger: silentLogger,
    stopTimeoutMs: 5_000,
    restartBaseMs: 500,
    restartMaxMs: 8_000,
    stableAfterMs: 10_000,
    collectTimeoutMs: 1_000,
    startTimeoutMs: 30_000,
    maxStartFailures: 3,
    timers,
    now: () => timers.now,
    ...options,
  });
  return { launcher, timers, supervisor };
}

/** Start the supervisor and bring every worker up. */
async function running(options: Parameters<typeof setup>[0] = {}) {
  const t = setup(options);
  const started = t.supervisor.start();
  for (const w of t.launcher.launched) w.ready();
  await started;
  return t;
}

const settled = async (promise: Promise<unknown>): Promise<'resolved' | 'rejected' | 'pending'> => {
  let state: 'resolved' | 'rejected' | 'pending' = 'pending';
  promise.then(
    () => (state = 'resolved'),
    () => (state = 'rejected'),
  );
  await Promise.resolve();
  await Promise.resolve();
  return state;
};

describe('starting', () => {
  it('launches one worker per slot and finishes starting only once every one is listening', async () => {
    const { launcher, supervisor } = setup();
    const started = supervisor.start();
    expect(launcher.launched.map((w) => w.index)).toEqual([0, 1, 2]);

    launcher.launched[0]?.ready();
    launcher.launched[2]?.ready();
    expect(await settled(started)).toBe('pending');
    launcher.launched[1]?.ready();
    await started;
    expect(supervisor.ready).toBe(3);
  });

  it('reports each worker as it starts listening', async () => {
    const seen: Array<[number, number, number]> = [];
    const { launcher, supervisor } = setup({
      workers: 2,
      onReady: (index, info) => void seen.push([index, info.pid, info.port]),
    });
    const started = supervisor.start();
    launcher.launched[1]?.ready(9001);
    launcher.launched[0]?.ready(9001);
    await started;
    expect(seen).toEqual([
      [1, 1001, 9001],
      [0, 1000, 9001],
    ]);
  });

  it('gives up when a worker keeps failing to start, rather than restarting it for ever', async () => {
    const { launcher, timers, supervisor } = setup({ workers: 2 });
    const started = supervisor.start();
    const outcome = started.then(
      () => 'started',
      (error: Error) => error.message,
    );

    launcher.current(0).exit(1);
    timers.advance(500);
    launcher.current(0).exit(1);
    timers.advance(1_000);
    expect(await settled(started)).toBe('pending');
    launcher.current(0).exit(1);

    expect(await outcome).toMatch(/worker 0 could not start \(exited with code 1 3 times\)/);
    // the caller then cleans up the worker that did launch
    const stopping = supervisor.stop();
    launcher.current(1).exit(0);
    await stopping;
  });

  it('gives up when the workers are not all listening in time', async () => {
    const { launcher, timers, supervisor } = setup({ startTimeoutMs: 5_000 });
    const started = supervisor.start();
    const outcome = started.catch((error: Error) => error.message);
    launcher.launched[0]?.ready();
    timers.advance(5_000);
    expect(await outcome).toMatch(/not all listening after 5000ms/);
  });
});

describe('keeping workers alive', () => {
  it('replaces a worker that dies, in the same slot, after a short delay', async () => {
    const { launcher, timers, supervisor } = await running();
    launcher.current(1).exit(1);
    expect(supervisor.stats().workers[1]).toMatchObject({ state: 'waiting', restarts: 1 });
    expect(launcher.launched).toHaveLength(3);

    timers.advance(499);
    expect(launcher.launched).toHaveLength(3);
    timers.advance(1);
    expect(launcher.launched).toHaveLength(4);
    expect(launcher.current(1).index).toBe(1);
    expect(supervisor.stats().workers[1]?.state).toBe('starting');

    launcher.current(1).ready();
    expect(supervisor.stats()).toMatchObject({ ready: 3, restarts: 1 });
  });

  it('waits twice as long for each quick failure in a row, up to a limit', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 1 });
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = launcher.launched.length;
      launcher.current(0).exit(1);
      // find the delay by stepping the clock
      let waited = 0;
      while (launcher.launched.length === before) {
        timers.advance(100);
        waited += 100;
      }
      delays.push(waited);
      launcher.current(0).ready();
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000]);
    expect(supervisor.stats().restarts).toBe(7);
  });

  it('starts the delays over once a worker has run for a while', async () => {
    const { launcher, timers } = await running({ workers: 1 });
    for (let i = 0; i < 3; i++) {
      launcher.current(0).exit(1);
      timers.advance(8_000);
      launcher.current(0).ready();
    }
    // the next failure would wait 4s, but this worker lived long enough to count as healthy
    timers.advance(10_000);
    launcher.current(0).exit(1);
    const before = launcher.launched.length;
    timers.advance(499);
    expect(launcher.launched).toHaveLength(before);
    timers.advance(1);
    expect(launcher.launched).toHaveLength(before + 1);
  });

  it('keeps replacing a worker that can never start once the others are up', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 2 });
    for (let i = 0; i < 5; i++) {
      launcher.current(1).exit(1);
      timers.advance(8_000);
    }
    expect(launcher.launched.filter((w) => w.index === 1).length).toBe(6);
    expect(supervisor.stats().workers[0]?.state).toBe('ready');
  });

  it('ignores whatever a replaced worker says or does after it has gone', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 1 });
    const old = launcher.current(0);
    old.exit(1);
    timers.advance(500);
    old.ready(); // a late message from the dead process
    expect(supervisor.stats().workers[0]?.state).toBe('starting');
    old.exit(1); // and a duplicate exit
    expect(supervisor.stats().restarts).toBe(1);
    expect(launcher.launched).toHaveLength(2);
  });

  it('shrugs off a malformed message from a worker', async () => {
    const { lines, logger } = capturingLogger();
    const { launcher, supervisor } = await running({ workers: 1, logger });
    launcher.current(0).say({ gw: 'ready', pid: 'x', port: {} });
    launcher.current(0).say('hello');
    launcher.current(0).say(null);
    expect(supervisor.ready).toBe(1);
    expect(lines.filter((l) => String(l['msg']).includes('malformed'))).toHaveLength(3);
  });
});

describe('asking the workers', () => {
  it("collects each ready worker's answer, tagged with its slot and pid", async () => {
    const { launcher, supervisor } = await running({ workers: 2 });
    const pending = supervisor.collect('metrics');
    for (const w of launcher.launched) {
      const request = w.requests()[0];
      expect(request?.what).toBe('metrics');
      w.say({ gw: 'reply', id: request?.id, what: 'metrics', payload: `text from ${w.index}` });
    }
    expect(await pending).toEqual([
      { index: 0, pid: 1000, ok: true, payload: 'text from 0' },
      { index: 1, pid: 1001, ok: true, payload: 'text from 1' },
    ]);

    const health = supervisor.collect('health');
    const request = launcher.launched[0]?.requests().at(-1);
    launcher.launched[0]?.say({ gw: 'reply', id: request?.id, what: 'health', payload: { status: 'ok' } });
    launcher.launched[1]?.say({
      gw: 'reply',
      id: launcher.launched[1]?.requests().at(-1)?.id,
      what: 'health',
      payload: { status: 'ok' },
    });
    expect((await health).every((r) => r.ok)).toBe(true);
  });

  it('reports a worker that does not answer, and does not wait for it longer than the timeout', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 2 });
    const pending = supervisor.collect('metrics');
    const quick = launcher.launched[0] as FakeWorker;
    quick.say({ gw: 'reply', id: quick.requests()[0]?.id, what: 'metrics', payload: 'ok' });
    timers.advance(1_000);
    expect(await pending).toMatchObject([
      { index: 0, ok: true },
      { index: 1, ok: false, reason: 'timeout' },
    ]);
  });

  it('does not ask workers that are not ready, and says why they are missing', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 2 });
    launcher.current(1).exit(1); // waiting to be restarted
    const pending = supervisor.collect('health');
    const only = launcher.current(0);
    only.say({ gw: 'reply', id: only.requests()[0]?.id, what: 'health', payload: {} });
    expect(await pending).toMatchObject([
      { index: 0, ok: true },
      { index: 1, ok: false, reason: 'waiting' },
    ]);
    expect(launcher.launched[1]?.requests()).toEqual([]);

    timers.advance(500);
    const again = supervisor.collect('health');
    timers.advance(1_000); // worker 0 is not going to answer this one
    expect((await again)[1]).toMatchObject({ ok: false, reason: 'starting' });
  });

  it('accepts an answer only from the worker that was asked, and only to the question that was asked', async () => {
    const { launcher, supervisor } = await running({ workers: 2 });
    const pending = supervisor.collect('metrics');
    const [a, b] = launcher.launched as [FakeWorker, FakeWorker];
    const idForA = a.requests()[0]?.id;
    b.say({ gw: 'reply', id: idForA, what: 'metrics', payload: 'impostor' }); // B answering A's question
    a.say({ gw: 'reply', id: idForA, what: 'health', payload: {} }); // right worker, wrong question
    a.say({ gw: 'reply', id: 9999, what: 'metrics', payload: 'unsolicited' }); // nobody asked
    a.say({ gw: 'reply', id: idForA, what: 'metrics', payload: { not: 'text' } }); // metrics are text
    a.say({ gw: 'reply', id: idForA, what: 'health', payload: 'not an object' });
    a.say({ gw: 'reply', id: idForA, what: 'metrics', payload: 'genuine' });
    b.say({ gw: 'reply', id: b.requests()[0]?.id, what: 'metrics', payload: 'b' });
    expect(await pending).toMatchObject([
      { index: 0, ok: true, payload: 'genuine' },
      { index: 1, ok: true, payload: 'b' },
    ]);
  });

  it('stops waiting for a worker that dies mid-question', async () => {
    const { launcher, supervisor } = await running({ workers: 1 });
    const pending = supervisor.collect('health');
    launcher.current(0).exit(null, 'SIGSEGV');
    expect(await pending).toMatchObject([{ ok: false, reason: 'exited' }]);
  });

  it('keeps waiting for the other workers when one dies mid-question', async () => {
    const { launcher, supervisor } = await running({ workers: 3 });
    const pending = supervisor.collect('metrics');
    launcher.current(1).exit(null, 'SIGKILL');
    for (const index of [0, 2]) {
      const w = launcher.current(index);
      w.say({ gw: 'reply', id: w.requests()[0]?.id, what: 'metrics', payload: `from ${index}` });
    }
    expect(await pending).toMatchObject([
      { index: 0, ok: true, payload: 'from 0' },
      { index: 1, ok: false, reason: 'exited' },
      { index: 2, ok: true, payload: 'from 2' },
    ]);
  });

  it('forgives failures to start once a worker has started', async () => {
    const { launcher, timers, supervisor } = setup({ workers: 2 });
    const started = supervisor.start();
    const outcome = started.then(
      () => 'started',
      (error: Error) => error.message,
    );
    launcher.current(0).exit(1);
    timers.advance(500);
    launcher.current(0).exit(1);
    timers.advance(1_000);
    launcher.current(0).ready(); // third time lucky, but the other worker is still not up
    launcher.current(0).exit(1); // and it falls over again while the rest of the cluster is still starting
    timers.advance(2_000);
    launcher.current(0).exit(1);
    timers.advance(4_000);
    launcher.current(0).ready();
    launcher.current(1).ready();
    expect(await outcome).toBe('started'); // two failures, success, two more failures: never three in a row
  });

  it('treats a worker whose channel is closed as unreachable', async () => {
    const { launcher, supervisor } = await running({ workers: 1 });
    launcher.current(0).throwOnSend = true;
    expect(await supervisor.collect('metrics')).toMatchObject([{ ok: false, reason: 'unreachable' }]);
  });

  it('broadcasts to the workers that are running and skips the rest', async () => {
    const { launcher, supervisor } = await running({ workers: 3 });
    launcher.current(1).exit(1);
    launcher.current(2).throwOnSend = true;
    supervisor.broadcast({ gw: 'shutdown' });
    expect(launcher.launched[0]?.sent).toEqual([{ gw: 'shutdown' }]);
    expect(launcher.launched[1]?.sent).toEqual([]);
  });
});

describe('stopping', () => {
  it('tells every worker to shut down and finishes when they have all gone', async () => {
    const { launcher, supervisor } = await running();
    const stopped = supervisor.stop();
    for (const w of launcher.launched) expect(w.sent).toContainEqual({ gw: 'shutdown' });

    launcher.launched[0]?.exit(0);
    launcher.launched[1]?.exit(0);
    expect(await settled(stopped)).toBe('pending');
    launcher.launched[2]?.exit(0);
    await stopped;
  });

  it('does not replace workers that exit while it is stopping', async () => {
    const { launcher, timers, supervisor } = await running();
    const stopped = supervisor.stop();
    for (const w of launcher.launched) w.exit(0);
    await stopped;
    timers.advance(60_000);
    expect(launcher.launched).toHaveLength(3);
    expect(supervisor.stats().restarts).toBe(0);
  });

  it('cancels a pending restart', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 2 });
    launcher.current(1).exit(1); // waiting to restart
    const stopped = supervisor.stop();
    launcher.current(0).exit(0);
    await stopped;
    expect(timers.pending).toBe(0); // the restart that was waiting is cancelled, not merely ignored
    timers.advance(60_000);
    expect(launcher.launched).toHaveLength(2);
  });

  it('kills a worker that has not exited by the deadline', async () => {
    const { launcher, timers, supervisor } = await running({ workers: 2, stopTimeoutMs: 3_000 });
    const stopped = supervisor.stop();
    launcher.launched[0]?.exit(0);
    timers.advance(2_999);
    expect(launcher.launched[1]?.killed).toBe(false);
    timers.advance(1);
    expect(launcher.launched[1]?.killed).toBe(true);
    await stopped;
    expect(launcher.launched[0]?.killed).toBe(false);
  });

  it('is safe to call twice, and finishes immediately with nothing running', async () => {
    const { launcher, supervisor } = await running({ workers: 1 });
    const first = supervisor.stop();
    const second = supervisor.stop();
    expect(second).toBe(first);
    launcher.current(0).exit(0);
    await first;
    await supervisor.stop();
    expect(launcher.current(0).sent.filter((m) => m.gw === 'shutdown')).toHaveLength(1);
  });

  it('abandons a start that is still under way', async () => {
    const { launcher, supervisor } = setup({ workers: 2 });
    const started = supervisor.start();
    const outcome = started.catch((error: Error) => error.message);
    const stopped = supervisor.stop();
    for (const w of launcher.launched) w.exit(0);
    await stopped;
    expect(await outcome).toBe('stopped while starting');
  });
});
