import { describe, expect, it } from 'vitest';
import { formatTraceparent, parseTraceparent, startOrContinue } from '../src/observability/trace.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT = '00f067aa0ba902b7';
const VALID = `00-${TRACE}-${PARENT}-01`; // the spec's own example

describe('parseTraceparent', () => {
  it("reads the spec's example", () => {
    expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '01' });
    expect(parseTraceparent(`  ${VALID} `)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '01' });
  });

  it.each([
    ['nothing', undefined],
    ['two values (the header sent twice)', [VALID, VALID]],
    ['upper case hex', VALID.toUpperCase()],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PARENT}-01`],
    ['an all-zero parent id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['version ff', `ff-${TRACE}-${PARENT}-01`],
    ['version 00 with a fifth field', `${VALID}-extra`],
    ['a short trace id', `00-${TRACE.slice(1)}-${PARENT}-01`],
    ['a long parent id', `00-${TRACE}-${PARENT}0-01`],
    ['a missing field', `00-${TRACE}-${PARENT}`],
    ['non-hex', `00-${TRACE.replace('4', 'g')}-${PARENT}-01`],
    ['garbage', 'hello'],
  ] as const)('refuses %s', (_what, value) => {
    expect(parseTraceparent(value as string | string[] | undefined)).toBeUndefined();
  });

  it('reads a later version by its first four fields, as the spec requires', () => {
    expect(parseTraceparent(`01-${TRACE}-${PARENT}-01-future-stuff`)).toEqual({
      traceId: TRACE,
      parentId: PARENT,
      flags: '01',
    });
    expect(parseTraceparent(`cc-${TRACE}-${PARENT}-00`)).toEqual({ traceId: TRACE, parentId: PARENT, flags: '00' });
  });
});

describe('startOrContinue', () => {
  it("continues the caller's trace with a hop of its own, keeping the sampling flag and tracestate", () => {
    const trace = startOrContinue({ traceparent: VALID, tracestate: 'congo=t61rcWkgMzE' }, { trustIncoming: true });
    expect(trace).toMatchObject({ traceId: TRACE, flags: '01', state: 'congo=t61rcWkgMzE', continued: true });
    expect(trace.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(trace.spanId).not.toBe(PARENT);
    expect(startOrContinue({ traceparent: `00-${TRACE}-${PARENT}-00` }, { trustIncoming: true }).flags).toBe('00');
  });

  it('starts a new, sampled trace when there is none to continue, or the caller is not trusted to choose one', () => {
    for (const [headers, trustIncoming] of [
      [{}, true],
      [{ traceparent: 'nonsense', tracestate: 'a=b' }, true],
      [{ traceparent: VALID, tracestate: 'a=b' }, false],
    ] as const) {
      const trace = startOrContinue(headers, { trustIncoming });
      expect(trace.continued).toBe(false);
      expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(trace.traceId).not.toBe(TRACE);
      expect(trace.flags).toBe('01');
      expect(trace.state).toBeUndefined(); // another trace's tracestate does not belong to this one
    }
  });

  it('never invents the same trace twice', () => {
    const ids = new Set(Array.from({ length: 1_000 }, () => startOrContinue({}, { trustIncoming: true }).traceId));
    expect(ids.size).toBe(1_000);
  });

  it('drops a tracestate that is too long, repeated, or not printable', () => {
    const continued = (tracestate: string | string[]) =>
      startOrContinue({ traceparent: VALID, tracestate }, { trustIncoming: true }).state;
    expect(continued('a=b,c=d')).toBe('a=b,c=d');
    expect(continued(`a=${'x'.repeat(600)}`)).toBeUndefined();
    expect(continued(['a=b', 'c=d'])).toBeUndefined();
    expect(continued('a=b\u0000')).toBeUndefined();
    expect(continued('  ')).toBeUndefined();
  });

  it('formats version 00', () => {
    const trace = startOrContinue({ traceparent: VALID }, { trustIncoming: true });
    expect(formatTraceparent(trace)).toBe(`00-${TRACE}-${trace.spanId}-01`);
    expect(parseTraceparent(formatTraceparent(trace))).toEqual({ traceId: TRACE, parentId: trace.spanId, flags: '01' });
  });
});
