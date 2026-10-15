import { describe, expect, it, vi } from 'vitest';
import { backoffDelayMs, retry } from '../src/resilience/retry.js';

const backoff = { baseDelayMs: 100, maxDelayMs: 1000 };

describe('backoffDelayMs', () => {
  it('doubles the ceiling each retry', () => {
    const max = () => 0.999999; // just under 1: picks the top of the range
    expect(backoffDelayMs(1, backoff, max)).toBe(100);
    expect(backoffDelayMs(2, backoff, max)).toBe(200);
    expect(backoffDelayMs(3, backoff, max)).toBe(400);
    expect(backoffDelayMs(4, backoff, max)).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    expect(backoffDelayMs(10, backoff, () => 0.999999)).toBe(1000);
    expect(backoffDelayMs(50, backoff, () => 0.999999)).toBe(1000);
  });

  it('applies full jitter: anywhere from 0 to the ceiling', () => {
    expect(backoffDelayMs(3, backoff, () => 0)).toBe(0);
    expect(backoffDelayMs(3, backoff, () => 0.5)).toBeGreaterThan(0);
    expect(backoffDelayMs(3, backoff, () => 0.5)).toBeLessThan(400);
  });
});

describe('retry', () => {
  const base = {
    maxAttempts: 4,
    backoff,
    random: () => 0.5,
    shouldRetry: (o: { ok: boolean }) => !o.ok,
  };

  it('returns immediately on success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const fn = vi.fn(async () => 'ok');
    await expect(retry(fn, { ...base, sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries failures with growing delays until success', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await retry(
      async () => {
        if (++calls < 3) throw new Error('flaky');
        return 'recovered';
      },
      { ...base, random: () => 0.999999, sleep: async (ms) => void delays.push(ms) },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it('rethrows the last error once attempts are exhausted', async () => {
    let calls = 0;
    await expect(
      retry(
        async () => {
          throw new Error(`fail ${++calls}`);
        },
        { ...base, sleep: async () => {} },
      ),
    ).rejects.toThrow('fail 4');
    expect(calls).toBe(4);
  });

  it('does not retry outcomes shouldRetry rejects', async () => {
    const fn = vi.fn(async () => {
      throw new Error('permanent');
    });
    await expect(retry(fn, { ...base, shouldRetry: () => false, sleep: async () => {} })).rejects.toThrow('permanent');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('can retry on a returned value, returns the final one, and discards the rest', async () => {
    const discarded: number[] = [];
    let n = 0;
    const result = await retry(async () => ++n, {
      maxAttempts: 3,
      backoff,
      sleep: async () => {},
      shouldRetry: () => true, // never satisfied, so we exhaust attempts
      discard: (v) => void discarded.push(v),
    });
    expect(result).toBe(3); // the last response is handed back as-is
    expect(discarded).toEqual([1, 2]);
  });

  it('waits at least as long as a Retry-After style hint', async () => {
    const delays: number[] = [];
    let n = 0;
    await retry(async () => ++n, {
      maxAttempts: 2,
      backoff,
      random: () => 0, // jitter alone would give 0
      sleep: async (ms) => void delays.push(ms),
      shouldRetry: (o) => o.ok && o.value < 2,
      retryAfterMs: () => 750,
    });
    expect(delays).toEqual([750]);
  });

  it('gives up instead of retrying when the hint exceeds the maximum delay', async () => {
    const fn = vi.fn(async () => 'busy');
    const sleep = vi.fn(async () => {});
    await expect(
      retry(fn, { ...base, maxAttempts: 5, shouldRetry: () => true, retryAfterMs: () => 60_000, sleep }),
    ).resolves.toBe('busy');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('stops promptly when aborted during backoff', async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => {
      throw new Error('down');
    });
    const pending = retry(fn, {
      ...base,
      backoff: { baseDelayMs: 10_000, maxDelayMs: 10_000 },
      random: () => 0.999,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('client left')), 20);
    await expect(pending).rejects.toThrow('client left');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
