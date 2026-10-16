/**
 * Keeps a fixed number of worker processes alive.
 *
 * A worker that dies is replaced, after a delay that doubles while it keeps dying quickly, so a worker that
 * crashes on every start cannot spin the machine. A worker that never manages to start at all, three times, aborts
 * start-up instead: that is a configuration or environment problem a restart will not fix, and it should fail
 * where a deploy can see it. The supervisor also asks workers for their metrics and health (the primary serves
 * them) and stops them in order on shutdown.
 *
 * Processes are behind {@link WorkerLauncher}, so all of this is tested with fake workers and a fake clock.
 */
import type { Logger } from '../observability/logger.js';
import { type Collected, isToPrimary, type ToWorker } from './protocol.js';

export interface WorkerHandle {
  readonly pid: number | undefined;
  send(message: ToWorker): void;
  /** Forcefully end the process. */
  kill(): void;
  onMessage(listener: (message: unknown) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
}

export interface WorkerLauncher {
  /** Start the worker for slot `index`. */
  launch(index: number): WorkerHandle;
}

export interface SupervisorOptions {
  workers: number;
  launcher: WorkerLauncher;
  logger: Logger;
  /** How long a graceful stop waits for workers to exit before killing them. */
  stopTimeoutMs: number;
  /** First restart delay; doubles for each quick failure in a row. */
  restartBaseMs?: number;
  restartMaxMs?: number;
  /** A worker that ran this long before dying is not counted as crash-looping. */
  stableAfterMs?: number;
  /** How long to wait for a worker to answer a request for its metrics or health. */
  collectTimeoutMs?: number;
  /** Start-up is abandoned if the workers are not all listening by then. */
  startTimeoutMs?: number;
  /** Start-up is abandoned when one worker has failed to start this many times. */
  maxStartFailures?: number;
  /** Told when a worker starts listening. */
  onReady?: (index: number, info: { pid: number; port: number }) => void;
  timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  now?: () => number;
}

export type SlotState = 'starting' | 'ready' | 'waiting' | 'stopped';

interface Slot {
  index: number;
  state: SlotState;
  handle?: WorkerHandle;
  /** Quick failures in a row; sets the next restart delay. */
  failures: number;
  /** Times this slot has failed before ever listening, since it last did. */
  startFailures: number;
  restarts: number;
  startedAt: number;
  timer?: unknown;
}

export type Collection =
  | { index: number; pid: number | undefined; ok: true; payload: string | Record<string, unknown> }
  | { index: number; pid: number | undefined; ok: false; reason: string };

interface Pending {
  slot: number;
  what: Collected;
  settle(result: Collection): void;
}

export class Supervisor {
  private readonly slots: Slot[];
  private readonly pending = new Map<number, Pending>();
  private readonly timers: NonNullable<SupervisorOptions['timers']>;
  private readonly now: () => number;
  private readonly restartBaseMs: number;
  private readonly restartMaxMs: number;
  private readonly stableAfterMs: number;
  private readonly collectTimeoutMs: number;
  private readonly maxStartFailures: number;
  private nextId = 0;
  private stopping = false;
  private booting?: { resolve(): void; reject(error: Error): void; timer: unknown };
  private stopPromise?: Promise<void>;
  private onAllStopped?: () => void;

  constructor(private readonly options: SupervisorOptions) {
    this.timers = options.timers ?? {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
    };
    this.now = options.now ?? Date.now;
    this.restartBaseMs = options.restartBaseMs ?? 500;
    this.restartMaxMs = options.restartMaxMs ?? 30_000;
    this.stableAfterMs = options.stableAfterMs ?? 10_000;
    this.collectTimeoutMs = options.collectTimeoutMs ?? 2_000;
    this.maxStartFailures = options.maxStartFailures ?? 3;
    this.slots = Array.from({ length: options.workers }, (_, index) => ({
      index,
      state: 'waiting' as SlotState,
      failures: 0,
      startFailures: 0,
      restarts: 0,
      startedAt: 0,
    }));
  }

  /** Start every worker. Resolves when all are listening; rejects if they cannot be got started. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = this.timers.setTimeout(() => {
        this.failBoot(new Error(`the workers were not all listening after ${this.options.startTimeoutMs ?? 30_000}ms`));
      }, this.options.startTimeoutMs ?? 30_000);
      this.booting = { resolve, reject, timer };
      for (const slot of this.slots) this.launch(slot);
    });
  }

  private launch(slot: Slot): void {
    const handle = this.options.launcher.launch(slot.index);
    slot.handle = handle;
    slot.state = 'starting';
    slot.startedAt = this.now();
    handle.onMessage((message) => this.onMessage(slot, handle, message));
    handle.onExit((code, signal) => this.onExit(slot, handle, code, signal));
  }

  private onMessage(slot: Slot, handle: WorkerHandle, message: unknown): void {
    if (slot.handle !== handle) return; // from a worker that has since been replaced
    if (!isToPrimary(message)) {
      this.options.logger.warn('ignoring a malformed message from a worker', { worker: slot.index });
      return;
    }
    if (message.gw === 'ready') {
      slot.state = 'ready';
      slot.startFailures = 0;
      this.options.logger.info('worker ready', { worker: slot.index, pid: message.pid });
      this.options.onReady?.(slot.index, { pid: message.pid, port: message.port });
      if (this.booting && this.slots.every((s) => s.state === 'ready')) {
        this.timers.clearTimeout(this.booting.timer);
        const { resolve } = this.booting;
        this.booting = undefined;
        resolve();
      }
      return;
    }
    const waiting = this.pending.get(message.id);
    // Only the worker that was asked may answer, and only with what was asked for.
    if (waiting && waiting.slot === slot.index && waiting.what === message.what) {
      waiting.settle({ index: slot.index, pid: handle.pid, ok: true, payload: message.payload });
    }
  }

  private onExit(slot: Slot, handle: WorkerHandle, code: number | null, signal: string | null): void {
    if (slot.handle !== handle) return;
    slot.handle = undefined;
    const lived = this.now() - slot.startedAt;
    const wasReady = slot.state === 'ready';
    // Whatever this worker was asked will never be answered. (Other workers' questions stay pending.)
    for (const waiting of [...this.pending.values()]) {
      if (waiting.slot === slot.index) {
        waiting.settle({ index: slot.index, pid: handle.pid, ok: false, reason: 'exited' });
      }
    }

    if (this.stopping) {
      slot.state = 'stopped';
      this.checkStopped();
      return;
    }

    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (!wasReady && this.booting) {
      slot.startFailures++;
      if (slot.startFailures >= this.maxStartFailures) {
        slot.state = 'stopped';
        this.options.logger.error('worker cannot start', {
          worker: slot.index,
          exit: how,
          attempts: slot.startFailures,
        });
        this.failBoot(
          new Error(`worker ${slot.index} could not start (exited with ${how} ${slot.startFailures} times)`),
        );
        return;
      }
    }

    slot.failures = wasReady && lived >= this.stableAfterMs ? 1 : slot.failures + 1;
    slot.restarts++;
    const delayMs = Math.min(this.restartMaxMs, this.restartBaseMs * 2 ** (slot.failures - 1));
    slot.state = 'waiting';
    const fields = { worker: slot.index, exit: how, livedMs: lived, restartInMs: delayMs, restarts: slot.restarts };
    // A worker that was asked to stop (SIGTERM to one worker) and did so cleanly is being recycled, not crashing.
    if (code === 0 && !signal) this.options.logger.warn('worker exited cleanly; restarting', fields);
    else this.options.logger.error('worker exited; restarting', fields);
    slot.timer = this.timers.setTimeout(() => {
      slot.timer = undefined;
      if (!this.stopping) this.launch(slot);
    }, delayMs);
  }

  private failBoot(error: Error): void {
    if (!this.booting) return;
    this.timers.clearTimeout(this.booting.timer);
    const { reject } = this.booting;
    this.booting = undefined;
    reject(error);
  }

  /** Ask every worker for its metrics text or its health report. A worker that does not answer is reported as such. */
  collect(what: Collected): Promise<Collection[]> {
    return Promise.all(this.slots.map((slot) => this.ask(slot, what)));
  }

  private ask(slot: Slot, what: Collected): Promise<Collection> {
    const handle = slot.handle;
    if (!handle || slot.state !== 'ready') {
      return Promise.resolve({ index: slot.index, pid: handle?.pid, ok: false, reason: slot.state });
    }
    return new Promise<Collection>((resolve) => {
      const id = ++this.nextId;
      const timer = this.timers.setTimeout(() => {
        this.pending.delete(id);
        resolve({ index: slot.index, pid: handle.pid, ok: false, reason: 'timeout' });
      }, this.collectTimeoutMs);
      this.pending.set(id, {
        slot: slot.index,
        what,
        settle: (result) => {
          this.timers.clearTimeout(timer);
          this.pending.delete(id);
          resolve(result);
        },
      });
      try {
        handle.send({ gw: 'collect', id, what });
      } catch {
        this.pending.get(id)?.settle({ index: slot.index, pid: handle.pid, ok: false, reason: 'unreachable' });
      }
    });
  }

  /** Send a message to every worker that is running. */
  broadcast(message: ToWorker): void {
    for (const slot of this.slots) {
      try {
        slot.handle?.send(message);
      } catch {
        // a worker that cannot be reached is about to be replaced
      }
    }
  }

  get ready(): number {
    return this.slots.filter((s) => s.state === 'ready').length;
  }

  stats(): {
    configured: number;
    ready: number;
    restarts: number;
    workers: Array<{ index: number; pid?: number; state: SlotState; restarts: number }>;
  } {
    return {
      configured: this.slots.length,
      ready: this.ready,
      restarts: this.slots.reduce((sum, s) => sum + s.restarts, 0),
      workers: this.slots.map((s) => ({ index: s.index, pid: s.handle?.pid, state: s.state, restarts: s.restarts })),
    };
  }

  /**
   * Ask the workers to finish up and exit; any still running after `stopTimeoutMs` are killed. Also what to call
   * after a failed `start()`, to clean up the workers that did start.
   */
  stop(): Promise<void> {
    this.stopPromise ??= this.doStop();
    return this.stopPromise;
  }

  private doStop(): Promise<void> {
    this.stopping = true;
    this.failBoot(new Error('stopped while starting'));
    for (const slot of this.slots) {
      if (slot.timer !== undefined) this.timers.clearTimeout(slot.timer);
      slot.timer = undefined;
      if (!slot.handle) slot.state = 'stopped';
    }
    return new Promise<void>((resolve) => {
      const force = this.timers.setTimeout(() => {
        for (const slot of this.slots) {
          if (!slot.handle) continue;
          this.options.logger.error('worker did not stop in time; killing it', {
            worker: slot.index,
            pid: slot.handle.pid,
          });
          slot.handle.kill();
        }
      }, this.options.stopTimeoutMs);
      this.onAllStopped = () => {
        this.timers.clearTimeout(force);
        resolve();
      };
      this.broadcast({ gw: 'shutdown' });
      this.checkStopped();
    });
  }

  private checkStopped(): void {
    if (this.stopping && this.slots.every((s) => !s.handle)) this.onAllStopped?.();
  }
}
