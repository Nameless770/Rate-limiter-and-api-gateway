/**
 * W3C Trace Context (https://www.w3.org/TR/trace-context/): continue the caller's trace, or start one, and pass it on.
 *
 * The gateway records no spans of its own (it has no tracer to send them to). What it adds is correlation: every
 * request it forwards carries a `traceparent` with the gateway's hop as the parent, and its access-log line carries
 * the trace id, so a request can be followed from the gateway's log into the services behind it.
 */
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  /** 32 lowercase hex characters, never all zeros. */
  traceId: string;
  /** The gateway's hop: forwarded as the parent id, so the upstream's span hangs off it. */
  spanId: string;
  /** Two hex characters; 01 means sampled. */
  flags: string;
  /** The caller's `tracestate`, passed on unchanged, only when the caller's trace is the one continued. */
  state?: string;
  /** The trace came from the caller (as opposed to being started here). */
  continued: boolean;
  /** The span this hop hangs off: the caller's span for a continued trace, or the request that set off background work. */
  parentId?: string;
}

/** The trace's sampled flag: whether whoever records spans (the gateway's exporter, the services behind) should. */
export function isSampled(trace: TraceContext): boolean {
  return (Number.parseInt(trace.flags, 16) & 0x01) === 1;
}

export interface Traceparent {
  traceId: string;
  parentId: string;
  flags: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ALL_ZEROS = /^0+$/;
/** The spec asks vendors to pass on at least 512 characters; anything longer is dropped rather than cut mid-entry. */
const MAX_TRACESTATE = 512;

/**
 * The caller's trace, if its `traceparent` is valid. The spec is strict and so is this: lowercase hex only, no
 * all-zero ids, version ff is invalid, and version 00 has exactly four fields. A later version is read by its first
 * four fields, as the spec requires, so a newer client is not cut off from its trace.
 */
export function parseTraceparent(value: string | string[] | undefined): Traceparent | undefined {
  if (typeof value !== 'string') return undefined; // absent, or sent twice: there is no single trace to continue
  const match = TRACEPARENT.exec(value.trim());
  if (!match) return undefined;
  const [, version, traceId, parentId, flags, rest] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string?,
  ];
  if (version === 'ff') return undefined;
  if (version === '00' && rest !== undefined) return undefined;
  if (ALL_ZEROS.test(traceId) || ALL_ZEROS.test(parentId)) return undefined;
  return { traceId, parentId, flags };
}

/** A `tracestate` worth passing on: one value, printable ASCII, and of a sane length. */
function usableState(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const state = value.trim();
  if (state === '' || state.length > MAX_TRACESTATE || !/^[\x20-\x7e]+$/.test(state)) return undefined;
  return state;
}

function randomHex(bytes: number): string {
  for (;;) {
    const hex = randomBytes(bytes).toString('hex');
    if (!ALL_ZEROS.test(hex)) return hex; // all zeros is the spec's "invalid": astronomically unlikely, still excluded
  }
}

/**
 * The trace a request belongs to: the caller's when it sent a valid one and the caller is trusted to, otherwise a new
 * one. A continued trace keeps the caller's sampling decision. A new one is sampled at `sampleRatio` (default: all of
 * them, which is what the services behind would decide for themselves if the gateway sent nothing), and the decision
 * goes downstream in the flags, so the gateway and the services record the same traces.
 */
export function startOrContinue(
  headers: Record<string, string | string[] | undefined>,
  options: { trustIncoming: boolean; sampleRatio?: number },
): TraceContext {
  const incoming = options.trustIncoming ? parseTraceparent(headers['traceparent']) : undefined;
  if (incoming) {
    return {
      traceId: incoming.traceId,
      spanId: randomHex(8),
      flags: incoming.flags,
      state: usableState(headers['tracestate']),
      continued: true,
      parentId: incoming.parentId,
    };
  }
  const traceId = randomHex(16);
  return {
    traceId,
    spanId: randomHex(8),
    flags: sampledAt(traceId, options.sampleRatio ?? 1) ? '01' : '00',
    continued: false,
  };
}

/**
 * Sampling by trace id, as OpenTelemetry's ratio sampler does: the id's last 8 hex digits, read as a fraction of 2^32,
 * against the ratio. Trace ids are random, so this keeps that share of traces, and it is the same answer every time
 * for the same trace.
 */
export function sampledAt(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return Number.parseInt(traceId.slice(-8), 16) / 2 ** 32 < ratio;
}

/** A new span id: one per upstream attempt, so each shows up as its own hop. */
export function newSpanId(): string {
  return randomHex(8);
}

/** A further hop in the same trace: work a request set off (a background refresh) shows up beneath it. */
export function childOf(trace: TraceContext): TraceContext {
  return { ...trace, spanId: randomHex(8), parentId: trace.spanId };
}

export function formatTraceparent(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;
}
