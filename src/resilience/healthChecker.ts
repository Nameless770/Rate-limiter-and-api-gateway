/**
 * Active health checking: probe each target on a schedule and take it out of rotation after consecutive failures,
 * bring it back after consecutive successes.
 *
 * This complements the circuit breaker rather than replacing it. The breaker is *passive*: it learns a target is
 * bad only by sending it real requests that fail, so some clients always pay for the discovery. A health check
 * learns it from a probe and keeps traffic away before any client is hurt, and it is also how an idle target
 * that has come back gets noticed. The breaker still guards against failures that probes miss (a target whose
 * /health is fine while a specific endpoint is broken).
 *
 * The state machine is separate from how a probe is made (an injected function), so it is tested without sockets.
 */

export interface ProbeResult {
  ok: boolean;
  /** Short, non-sensitive description of a failure (a status or an error kind), for logs and the health page. */
  reason?: string;
  status?: number;
}

export interface HealthCheckerOptions {
  intervalMs: number;
  /** Consecutive failed probes before a healthy target is marked unhealthy. */
  unhealthyThreshold: number;
  /** Consecutive successful probes before an unhealthy target is marked healthy again. */
  healthyThreshold: number;
  /** Probe a target. Must not throw; return `{ ok: false }` for failures. Should enforce its own timeout. */
  probe: (targetId: string) => Promise<ProbeResult>;
  onChange?: (targetId: string, healthy: boolean, reason: string | undefined) => void;
  onResult?: (targetId: string, result: ProbeResult) => void;
  /** 0..1, injected for deterministic tests. */
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}

/** The part of a timer handle this class uses; `setTimeout`'s return value satisfies it. */
export interface Timer {
  unref(): unknown;
}

export interface TargetHealth {
  healthy: boolean;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  checks: number;
  lastCheckAt?: number;
  lastStatus?: number;
  lastError?: string;
}

interface State extends TargetHealth {
  timer?: Timer;
  probing: boolean;
}

export class HealthChecker {
  private readonly states = new Map<string, State>();
  private readonly random: () => number;
  private readonly setTimer: NonNullable<HealthCheckerOptions['setTimer']>;
  private readonly clearTimer: NonNullable<HealthCheckerOptions['clearTimer']>;
  private running = false;

  constructor(
    targetIds: readonly string[],
    private readonly opts: HealthCheckerOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.random = opts.random ?? Math.random;
    this.setTimer =
      opts.setTimer ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref();
        return t;
      });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    for (const id of targetIds) {
      // Optimistic start: a target is trusted until probes say otherwise, so startup doesn't black-hole traffic
      // for the first interval.
      this.states.set(id, {
        healthy: true,
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        checks: 0,
        probing: false,
      });
    }
  }

  isHealthy(targetId: string): boolean {
    return this.states.get(targetId)?.healthy ?? true;
  }

  snapshot(targetId: string): TargetHealth | undefined {
    const s = this.states.get(targetId);
    if (!s) return undefined;
    const { healthy, consecutiveFailures, consecutiveSuccesses, checks, lastCheckAt, lastStatus, lastError } = s;
    return { healthy, consecutiveFailures, consecutiveSuccesses, checks, lastCheckAt, lastStatus, lastError };
  }

  /** Begin probing every target: an immediate first probe, then one per (jittered) interval. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const id of this.states.keys()) void this.cycle(id);
  }

  stop(): void {
    this.running = false;
    for (const s of this.states.values()) {
      if (s.timer) this.clearTimer(s.timer);
      s.timer = undefined;
    }
  }

  /** Probe every target once, now, and wait for the results. A target already being probed is skipped. */
  async probeAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((id) => this.probeOnce(id)));
  }

  private async cycle(id: string): Promise<void> {
    await this.probeOnce(id);
    if (!this.running) return;
    const state = this.states.get(id);
    if (!state) return;
    // ±10% jitter so a fleet of gateways doesn't probe a backend in lockstep.
    const delay = Math.max(1, Math.round(this.opts.intervalMs * (0.9 + 0.2 * this.random())));
    state.timer = this.setTimer(() => void this.cycle(id), delay);
  }

  private async probeOnce(id: string): Promise<void> {
    const state = this.states.get(id);
    if (!state || state.probing) return;
    state.probing = true;
    let result: ProbeResult;
    try {
      result = await this.opts.probe(id);
    } catch (error) {
      // A probe that throws is a bug in the probe, but it must never stop the schedule or leave the target in limbo.
      result = { ok: false, reason: `probe error: ${(error as Error).message}` };
    } finally {
      state.probing = false;
    }
    this.record(id, state, result);
  }

  private record(id: string, state: State, result: ProbeResult): void {
    state.checks++;
    state.lastCheckAt = this.now();
    state.lastStatus = result.status;
    this.opts.onResult?.(id, result);

    if (result.ok) {
      state.lastError = undefined;
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses++;
      if (!state.healthy && state.consecutiveSuccesses >= this.opts.healthyThreshold) {
        state.healthy = true;
        this.opts.onChange?.(id, true, undefined);
      }
    } else {
      state.lastError = result.reason;
      state.consecutiveSuccesses = 0;
      state.consecutiveFailures++;
      if (state.healthy && state.consecutiveFailures >= this.opts.unhealthyThreshold) {
        state.healthy = false;
        this.opts.onChange?.(id, false, result.reason);
      }
    }
  }
}
