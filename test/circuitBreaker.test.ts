import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from '../src/resilience/circuitBreaker.js';

function setup(overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  let now = 1_000_000;
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({
    failureRateThreshold: 0.5,
    minimumRequests: 4,
    windowMs: 10_000,
    openDurationMs: 5_000,
    halfOpenMaxCalls: 1,
    halfOpenSuccesses: 2,
    clock: () => now,
    onStateChange: (from: CircuitState, to: CircuitState) => transitions.push(`${from}->${to}`),
    ...overrides,
  });
  return {
    breaker,
    transitions,
    advance: (ms: number) => void (now += ms),
    call: (ok: boolean) => {
      const permit = breaker.tryAcquire();
      if (!permit) return false;
      if (ok) permit.success();
      else permit.failure();
      return true;
    },
  };
}

describe('circuit breaker', () => {
  it('stays closed while failures are below the minimum request volume', () => {
    const { breaker, call } = setup();
    call(false);
    call(false);
    call(false); // 3 failures out of 3, but minimumRequests is 4
    expect(breaker.state).toBe('closed');
  });

  it('opens once the failure rate crosses the threshold with enough volume', () => {
    const { breaker, call, transitions } = setup();
    call(true);
    call(true);
    call(false);
    expect(breaker.state).toBe('closed'); // 1/3 and below minimum volume
    call(false); // 2/4 = 50%
    expect(breaker.state).toBe('open');
    expect(transitions).toEqual(['closed->open']);
  });

  it('does not open when failures are a minority', () => {
    const { breaker, call } = setup();
    for (let i = 0; i < 20; i++) call(i % 5 !== 0); // 20% failures
    expect(breaker.state).toBe('closed');
  });

  it('fails fast while open and reports how long until it will probe', () => {
    const { breaker, call, advance } = setup();
    for (let i = 0; i < 4; i++) call(false);
    expect(breaker.tryAcquire()).toBeUndefined();
    advance(2_000);
    expect(breaker.snapshot().retryAfterMs).toBe(3_000);
    expect(() => breaker.acquire()).toThrow(CircuitOpenError);
  });

  it('half-opens after the cool-down and admits only the configured number of probes', () => {
    const { breaker, call, advance } = setup();
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    expect(breaker.state).toBe('half-open');
    const probe = breaker.tryAcquire();
    expect(probe).toBeDefined();
    expect(breaker.tryAcquire()).toBeUndefined(); // second concurrent probe is rejected
    probe?.success();
    expect(breaker.tryAcquire()).toBeDefined(); // slot freed
  });

  it('closes after enough consecutive probe successes', () => {
    const { breaker, call, advance, transitions } = setup();
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    call(true);
    expect(breaker.state).toBe('half-open');
    call(true);
    expect(breaker.state).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });

  it('re-opens immediately on a failed probe and restarts the cool-down', () => {
    const { breaker, call, advance } = setup();
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    call(false);
    expect(breaker.state).toBe('open');
    advance(4_999);
    expect(breaker.state).toBe('open');
    advance(1);
    expect(breaker.state).toBe('half-open');
  });

  it('starts from a clean slate after closing', () => {
    const { breaker, call, advance } = setup();
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    call(true);
    call(true);
    expect(breaker.state).toBe('closed');
    call(false); // a single failure must not re-trip using pre-open history
    expect(breaker.state).toBe('closed');
  });

  it('forgets failures that have aged out of the rolling window', () => {
    const { breaker, call, advance } = setup();
    call(false);
    call(false);
    call(false);
    advance(11_000); // all three are now outside the 10s window
    call(false);
    expect(breaker.state).toBe('closed'); // 1 failure, below minimum volume
    expect(breaker.snapshot().failures).toBe(1);
  });

  it('ignores outcomes from calls admitted in a previous era', () => {
    const { breaker, call, advance } = setup();
    const slow = breaker.tryAcquire(); // admitted while closed, still running
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    expect(breaker.state).toBe('half-open');
    slow?.failure(); // must not be mistaken for a probe failure
    expect(breaker.state).toBe('half-open');
  });

  it('release() frees a probe slot without counting as success or failure', () => {
    const { breaker, call, advance } = setup();
    for (let i = 0; i < 4; i++) call(false);
    advance(5_000);
    const probe = breaker.tryAcquire();
    probe?.release();
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBeDefined();
  });

  it('only counts the first outcome reported on a permit', () => {
    const { breaker } = setup({ minimumRequests: 2 });
    const permit = breaker.tryAcquire();
    permit?.failure();
    permit?.failure();
    permit?.failure();
    expect(breaker.snapshot().failures).toBe(1);
  });

  it('execute() wraps a call and propagates the result or error', async () => {
    const { breaker } = setup({ minimumRequests: 3, failureRateThreshold: 0.5 });
    await expect(breaker.execute(async () => 42)).resolves.toBe(42);
    await expect(breaker.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(breaker.execute(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(breaker.execute(async () => 1)).rejects.toBeInstanceOf(CircuitOpenError);
  });
});
