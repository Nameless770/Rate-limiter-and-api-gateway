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
 * one. A new trace is marked sampled, which is what the services behind would decide for themselves if the gateway
 * sent nothing (a parent saying "not sampled" would switch their tracing off).
 */
export function startOrContinue(
  headers: Record<string, string | string[] | undefined>,
  options: { trustIncoming: boolean },
): TraceContext {
  const incoming = options.trustIncoming ? parseTraceparent(headers['traceparent']) : undefined;
  if (incoming) {
    return {
      traceId: incoming.traceId,
      spanId: randomHex(8),
      flags: incoming.flags,
      state: usableState(headers['tracestate']),
      continued: true,
    };
  }
  return { traceId: randomHex(16), spanId: randomHex(8), flags: '01', continued: false };
}

/** A further hop in the same trace: work a request set off (a background refresh) shows up beside it. */
export function childOf(trace: TraceContext): TraceContext {
  return { ...trace, spanId: randomHex(8) };
}

export function formatTraceparent(trace: TraceContext): string {
  return `00-${trace.traceId}-${trace.spanId}-${trace.flags}`;
}
