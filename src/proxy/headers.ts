import type { IncomingHttpHeaders } from 'node:http';

/** RFC 9110 §7.6.1: connection-scoped headers that a proxy must not forward. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Copy headers minus hop-by-hop ones, including any named in the `Connection` header itself. */
export function stripHopByHop(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = new Set(
    String(headers['connection'] ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    out[lower] = value;
  }
  return out;
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Accept a client-supplied correlation id only if it's boring enough to be safe in logs and headers. */
export function sanitizeRequestId(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && REQUEST_ID.test(v) ? v : undefined;
}
