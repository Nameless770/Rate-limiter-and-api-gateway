/**
 * The pieces of WebSocket proxying that do not depend on the gateway: validating the opening handshake,
 * computing the accept key, matching origins, and piping a tunnel with an idle timeout and a lifetime.
 *
 * The gateway does not parse WebSocket frames. After the handshake it moves bytes, so it cannot rate limit or
 * inspect individual messages. What it can and does enforce is everything around the connection: who may open
 * one (origin, authentication, the connection rate limit), how many may be open, and for how long.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** RFC 6455 §4.2.2: the proof, derived from the client's key, that the server really speaks WebSocket. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1')
    .update(clientKey + WS_GUID)
    .digest('base64');
}

export type HandshakeCheck =
  | { ok: true; key: string; protocols: string[]; offersExtensions: boolean }
  | { ok: false; status: number; code: string; message: string; headers?: Record<string, string> };

const TOKEN = "[!#$%&'*+\\-.^_`|~0-9A-Za-z]+";
const PROTOCOL_LIST = new RegExp(`^${TOKEN}(?:\\s*,\\s*${TOKEN})*$`);
/** 16 random bytes in base64: 22 characters and two of padding. */
const CLIENT_KEY = /^[A-Za-z0-9+/]{22}==$/;
const MAX_EXTENSIONS_HEADER = 1024;

const reject = (status: number, code: string, message: string, headers?: Record<string, string>): HandshakeCheck => ({
  ok: false,
  status,
  code,
  message,
  headers,
});

/**
 * Check a client's opening handshake. Anything that does not look exactly like a WebSocket upgrade is refused,
 * because the same mechanism carries other protocols (h2c, for one) that would let a client talk to the upstream
 * in a way the gateway's checks never saw.
 */
export function validateHandshake(req: IncomingMessage): HandshakeCheck {
  if (req.method !== 'GET') return reject(405, 'method_not_allowed', 'method not allowed', { allow: 'GET' });

  const tokens = (value: string | string[] | undefined): string[] =>
    (Array.isArray(value) ? value.join(',') : (value ?? ''))
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);

  const upgrade = tokens(req.headers['upgrade']);
  if (upgrade.length !== 1 || upgrade[0] !== 'websocket') {
    return reject(400, 'bad_upgrade', 'only the websocket upgrade is supported');
  }
  if (!tokens(req.headers['connection']).includes('upgrade')) {
    return reject(400, 'bad_upgrade', 'missing Connection: Upgrade');
  }

  // A handshake carries no body. One that does is either broken or an attempt to smuggle a request behind it.
  const length = req.headers['content-length'];
  if ((length !== undefined && length !== '0') || req.headers['transfer-encoding'] !== undefined) {
    return reject(400, 'bad_upgrade', 'a websocket handshake cannot have a body');
  }

  if (req.headers['sec-websocket-version'] !== '13') {
    return reject(426, 'upgrade_required', 'unsupported websocket version', { 'sec-websocket-version': '13' });
  }

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !CLIENT_KEY.test(key)) {
    return reject(400, 'bad_upgrade', 'invalid Sec-WebSocket-Key');
  }

  const offered = req.headers['sec-websocket-protocol'];
  let protocols: string[] = [];
  if (offered !== undefined) {
    const joined = Array.isArray(offered) ? offered.join(', ') : offered;
    if (!PROTOCOL_LIST.test(joined)) return reject(400, 'bad_upgrade', 'invalid Sec-WebSocket-Protocol');
    protocols = joined.split(',').map((p) => p.trim());
  }

  const extensions = req.headers['sec-websocket-extensions'];
  const extensionsText = Array.isArray(extensions) ? extensions.join(', ') : extensions;
  if (
    extensionsText !== undefined &&
    (extensionsText.length > MAX_EXTENSIONS_HEADER || /[^\x20-\x7E]/.test(extensionsText))
  ) {
    return reject(400, 'bad_upgrade', 'invalid Sec-WebSocket-Extensions');
  }

  return { ok: true, key, protocols, offersExtensions: extensionsText !== undefined };
}

/**
 * Cross-site WebSocket hijacking: a page on any website can open a WebSocket to any host, and the browser attaches
 * that host's cookies. The only signal the server gets is the `Origin` header, which a browser always sends and a
 * page cannot forge. So: if there is an Origin it must be allowed; if there is none the client is not a browser
 * (a script, a native app), which cannot be used to ride a victim's cookies, so it is not this attack.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[], allowAny: boolean): boolean {
  if (origin === undefined) return true;
  if (allowAny) return true;
  return allowed.includes(origin.toLowerCase());
}

/** What the upstream answered to our handshake, checked against what we asked. */
export function checkUpstreamHandshake(
  headers: {
    upgrade?: string | string[];
    'sec-websocket-accept'?: string | string[];
    'sec-websocket-protocol'?: string | string[];
    'sec-websocket-extensions'?: string | string[];
  },
  client: { key: string; protocols: readonly string[]; offersExtensions: boolean },
): { ok: true; protocol?: string; extensions?: string } | { ok: false; reason: string } {
  const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v.join(', ') : v);

  if (one(headers.upgrade)?.toLowerCase() !== 'websocket')
    return { ok: false, reason: 'upstream did not upgrade to websocket' };
  if (one(headers['sec-websocket-accept']) !== acceptKey(client.key)) {
    return { ok: false, reason: 'upstream sent the wrong Sec-WebSocket-Accept' };
  }
  const protocol = one(headers['sec-websocket-protocol']);
  if (protocol !== undefined && !client.protocols.includes(protocol)) {
    return { ok: false, reason: 'upstream chose a subprotocol the client did not offer' };
  }
  const extensions = one(headers['sec-websocket-extensions']);
  if (extensions !== undefined && !client.offersExtensions) {
    return { ok: false, reason: 'upstream negotiated an extension the client did not offer' };
  }
  if ([protocol, extensions].some((v) => v !== undefined && /[^\x20-\x7E]/.test(v))) {
    return { ok: false, reason: 'upstream sent a malformed handshake header' };
  }
  return { ok: true, protocol, extensions };
}

export type TunnelCloseReason = 'client' | 'upstream' | 'idle' | 'max_duration' | 'shutdown' | 'error';

/**
 * After one side sends FIN the other is ended once what it had in flight is flushed. A peer that never finishes
 * its own half would otherwise hold the tunnel (and its sockets) open until the idle timeout; this bounds it.
 */
export const HALF_CLOSE_GRACE_MS = 1_000;

export interface TunnelOptions {
  idleTimeoutMs: number;
  maxDurationMs?: number;
  onClose: (reason: TunnelCloseReason, bytesFromClient: number, bytesFromUpstream: number) => void;
}

export interface Tunnel {
  close(reason: TunnelCloseReason): void;
}

/** Move bytes both ways until either side goes away, goes quiet, or the connection has lived long enough. */
export function openTunnel(client: Duplex, upstream: Duplex, opts: TunnelOptions): Tunnel {
  let closed = false;
  let fromClient = 0;
  let fromUpstream = 0;
  let lifetime: NodeJS.Timeout | undefined;
  let lingering: NodeJS.Timeout | undefined;

  const close = (reason: TunnelCloseReason): void => {
    if (closed) return;
    closed = true;
    if (lifetime) clearTimeout(lifetime);
    if (lingering) clearTimeout(lingering);
    client.destroy();
    upstream.destroy();
    opts.onClose(reason, fromClient, fromUpstream);
  };

  client.on('data', (chunk: Buffer) => {
    fromClient += chunk.length;
  });
  upstream.on('data', (chunk: Buffer) => {
    fromUpstream += chunk.length;
  });
  client.pipe(upstream);
  upstream.pipe(client);

  // A socket's 'close' fires after any 'error' too, so the first to go decides the reason.
  client.on('close', () => close('client'));
  upstream.on('close', () => close('upstream'));
  client.on('error', () => close('error'));
  upstream.on('error', () => close('error'));

  // FIN from a peer means it hung up. pipe() passes that on; this makes sure a stubborn far end cannot keep us open.
  const hungUp = (reason: 'client' | 'upstream') => (): void => {
    lingering ??= setTimeout(() => close(reason), HALF_CLOSE_GRACE_MS);
  };
  client.on('end', hungUp('client'));
  upstream.on('end', hungUp('upstream'));

  // Idle means no traffic in either direction. Ping/pong keeps a healthy connection alive; silence does not.
  for (const side of [client, upstream]) {
    if ('setTimeout' in side) (side as unknown as { setTimeout(ms: number): void }).setTimeout(opts.idleTimeoutMs);
    side.on('timeout', () => close('idle'));
  }
  if (opts.maxDurationMs !== undefined) {
    lifetime = setTimeout(() => close('max_duration'), opts.maxDurationMs);
    lifetime.unref();
  }
  return { close };
}
