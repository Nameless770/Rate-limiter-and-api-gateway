/**
 * A just-enough WebSocket, written against the RFC rather than a library, so the tests exercise the gateway with
 * bytes it did not help produce: a client that opens connections and speaks frames, and an upstream that accepts
 * them and echoes.
 */
import { randomBytes } from 'node:crypto';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import tls from 'node:tls';
import { acceptKey } from '../src/proxy/websocket.js';

export const OP = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

export interface Frame {
  opcode: number;
  payload: Buffer;
}

export function encodeFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
  const len = payload.length;
  const head: number[] = [0x80 | opcode];
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) head.push(maskBit | len);
  else if (len < 65_536) head.push(maskBit | 126, len >> 8, len & 0xff);
  else throw new Error('test frames are limited to 64KiB');
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = (masked[i] as number) ^ (key[i % 4] as number);
  return Buffer.concat([Buffer.from(head), key, masked]);
}

/** Reassembles frames from a byte stream. */
export class FrameReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const b = this.buffer;
      if (b.length < 2) break;
      const masked = (b[1] as number) & 0x80;
      let len = (b[1] as number) & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        throw new Error('test frames are limited to 64KiB');
      }
      const total = offset + (masked ? 4 : 0) + len;
      if (b.length < total) break;
      let payload = Buffer.from(b.subarray(offset + (masked ? 4 : 0), total));
      if (masked) {
        const key = b.subarray(offset, offset + 4);
        payload = Buffer.from(payload.map((byte, i) => byte ^ (key[i % 4] as number)));
      }
      frames.push({ opcode: (b[0] as number) & 0x0f, payload });
      this.buffer = b.subarray(total);
    }
    return frames;
  }
}

export interface WsUpstreamOptions {
  /** Pick the subprotocol to answer with, given what the client offered. */
  protocol?: (offered: string[]) => string | undefined;
  /** Send this `Sec-WebSocket-Extensions` back. */
  extensions?: string;
  /** Compute the accept key (override to produce a wrong one). */
  accept?: (clientKey: string) => string;
  /** Answer the handshake with this ordinary HTTP response instead of switching protocols. */
  refuse?: { status: number; body?: string; headers?: Record<string, string> };
  /** Wait this long before answering the handshake. */
  delayMs?: number;
  /** Frames to send as soon as the 101 goes out, in the same write. */
  greeting?: string;
  /** Do not close our side when the peer hangs up (a misbehaving server). */
  stubborn?: boolean;
  /** Serve wss:// with this key and certificate. */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

export interface WsUpstream {
  url: string;
  port: number;
  /** Request line target and headers of every handshake (and plain request) received. */
  hits: Array<{ method: string; url: string; headers: IncomingHttpHeaders; upgrade: boolean }>;
  /** Sockets currently open to it. */
  open(): number;
  /** Everything each connection received from the client, decoded, in order. */
  received: string[];
  /** Send a text frame to every connected client. */
  broadcast(text: string): void;
  /** Drop every connection abruptly. */
  dropAll(): void;
  close(): Promise<void>;
}

/** An upstream WebSocket server that echoes data frames, answers pings and closes on a close frame. */
export async function startWsUpstream(options: WsUpstreamOptions = {}): Promise<WsUpstream> {
  const hits: WsUpstream['hits'] = [];
  const received: string[] = [];
  const sockets = new Set<net.Socket>();

  const onRequest = (req: IncomingMessage, res: http.ServerResponse): void => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, upgrade: false });
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('this is a websocket endpoint');
  };
  const server = options.tls ? https.createServer(options.tls, onRequest) : http.createServer(onRequest);

  server.on('upgrade', (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, upgrade: true });
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    // A real server closes its side when the peer hangs up, even while it is still thinking about the handshake.
    if (!options.stubborn) socket.on('end', () => socket.end());

    const answer = (): void => {
      if (socket.destroyed) return;
      if (options.refuse) {
        const { status, body = '', headers = {} } = options.refuse;
        const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`);
        socket.write(
          `HTTP/1.1 ${status} Refused\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n${extra.join('')}\r\n${body}`,
        );
        socket.end();
        return;
      }
      const key = req.headers['sec-websocket-key'] as string;
      const offered = String(req.headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const protocol = options.protocol?.(offered);
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${(options.accept ?? acceptKey)(key)}`,
      ];
      if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
      if (options.extensions) lines.push(`Sec-WebSocket-Extensions: ${options.extensions}`);
      const greeting = options.greeting ? encodeFrame(OP.text, Buffer.from(options.greeting), false) : Buffer.alloc(0);
      socket.write(Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), greeting]));

      const reader = new FrameReader();
      const handle = (chunk: Buffer): void => {
        for (const frame of reader.push(chunk)) {
          if (frame.opcode === OP.text || frame.opcode === OP.binary) {
            received.push(frame.payload.toString('latin1'));
            socket.write(encodeFrame(frame.opcode, frame.payload, false));
          } else if (frame.opcode === OP.ping) {
            socket.write(encodeFrame(OP.pong, frame.payload, false));
          } else if (frame.opcode === OP.close) {
            socket.write(encodeFrame(OP.close, frame.payload, false));
            socket.end();
          }
        }
      };
      if (head.length > 0) handle(head);
      socket.on('data', handle);
    };
    if (options.delayMs) setTimeout(answer, options.delayMs);
    else answer();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    hits,
    received,
    open: () => sockets.size,
    broadcast: (text) => {
      for (const s of sockets) s.write(encodeFrame(OP.text, Buffer.from(text), false));
    },
    dropAll: () => {
      for (const s of sockets) s.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One side of an established WebSocket, as seen by a test client. */
export class WsSession {
  readonly frames: Frame[] = [];
  closed = false;
  readonly closedPromise: Promise<void>;
  private waiters: Array<(frame: Frame) => void> = [];
  private readonly reader = new FrameReader();

  constructor(
    readonly socket: net.Socket,
    leftover: Buffer,
  ) {
    this.closedPromise = new Promise((resolve) => {
      socket.once('close', () => {
        this.closed = true;
        resolve();
      });
    });
    socket.on('error', () => {});
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    if (leftover.length > 0) this.feed(leftover);
  }

  private feed(chunk: Buffer): void {
    for (const frame of this.reader.push(chunk)) {
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.frames.push(frame);
    }
  }

  send(text: string): void {
    this.socket.write(encodeFrame(OP.text, Buffer.from(text, 'latin1'), true));
  }

  sendBinary(data: Buffer): void {
    this.socket.write(encodeFrame(OP.binary, data, true));
  }

  ping(payload = ''): void {
    this.socket.write(encodeFrame(OP.ping, Buffer.from(payload), true));
  }

  /** The next frame to arrive (or one that already has). */
  next(timeoutMs = 2_000): Promise<Frame> {
    const ready = this.frames.shift();
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onFrame);
        reject(new Error(`no frame within ${timeoutMs}ms`));
      }, timeoutMs);
      const onFrame = (frame: Frame): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiters.push(onFrame);
    });
  }

  async nextText(timeoutMs?: number): Promise<string> {
    const frame = await this.next(timeoutMs);
    return frame.payload.toString('latin1');
  }

  /** Resolves once the connection has closed, or false if it is still open after `ms`. */
  async closesWithin(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    const result = await Promise.race([this.closedPromise.then(() => true as const), timedOut]);
    clearTimeout(timer);
    return result;
  }

  destroy(): void {
    this.socket.destroy();
  }
}

export interface WsAttempt {
  status: number;
  headers: Record<string, string>;
  /** Body of a refusal (empty for a 101). */
  body: string;
  /** Set when the handshake succeeded. */
  ws?: WsSession;
  key: string;
}

export interface WsOpenOptions {
  path?: string;
  /** Extra or replacement request headers; `null` removes a default. Names are matched case-insensitively. */
  headers?: Record<string, string | null>;
  method?: string;
  key?: string;
  /** Bytes to write in the same TCP segment as the request head. */
  trailing?: Buffer;
  /** Use TLS, trusting this CA. */
  tlsCa?: Buffer;
  /** How long to wait for a refusal to finish arriving. */
  waitMs?: number;
}

/** The bytes of a client's opening handshake, with the key it carries. */
export function handshakeBytes(base: string, options: WsOpenOptions = {}): { request: Buffer; key: string } {
  const url = new URL(base);
  const key = options.key ?? randomBytes(16).toString('base64');
  const headers = new Map<string, [string, string]>();
  const set = (name: string, value: string | null): void => {
    if (value === null) headers.delete(name.toLowerCase());
    else headers.set(name.toLowerCase(), [name, value]);
  };
  set('Host', url.host);
  set('Upgrade', 'websocket');
  set('Connection', 'Upgrade');
  set('Sec-WebSocket-Key', key);
  set('Sec-WebSocket-Version', '13');
  for (const [name, value] of Object.entries(options.headers ?? {})) set(name, value);

  const lines = [`${options.method ?? 'GET'} ${options.path ?? '/ws'} HTTP/1.1`];
  for (const [name, value] of headers.values()) lines.push(`${name}: ${value}`);
  const head = `${lines.join('\r\n')}\r\n\r\n`;
  return { request: Buffer.concat([Buffer.from(head), options.trailing ?? Buffer.alloc(0)]), key };
}

/** Open a WebSocket the long way: write the handshake, read the answer, hand back the live socket on a 101. */
export function openWs(base: string, options: WsOpenOptions = {}): Promise<WsAttempt> {
  const url = new URL(base);
  const { request, key } = handshakeBytes(base, options);

  return new Promise((resolve, reject) => {
    const socket = options.tlsCa
      ? tls.connect({ host: url.hostname, port: Number(url.port), ca: options.tlsCa })
      : net.connect({ host: url.hostname, port: Number(url.port) });
    let received = Buffer.alloc(0);
    let settled = false;
    const settle = (attempt: WsAttempt): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(attempt);
    };
    const parse = (): { status: number; headers: Record<string, string>; rest: Buffer } | undefined => {
      const end = received.indexOf('\r\n\r\n');
      if (end < 0) return undefined;
      const [statusLine, ...lines] = received.subarray(0, end).toString('latin1').split('\r\n');
      const parsed: Record<string, string> = {};
      for (const line of lines) {
        const i = line.indexOf(':');
        parsed[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
      }
      return {
        status: Number(/HTTP\/1\.1 (\d{3})/.exec(statusLine as string)?.[1]),
        headers: parsed,
        rest: received.subarray(end + 4),
      };
    };
    const timer = setTimeout(() => {
      const parsed = parse();
      socket.destroy();
      if (parsed) settle({ status: parsed.status, headers: parsed.headers, body: parsed.rest.toString(), key });
      else reject(new Error('no handshake response'));
    }, options.waitMs ?? 1_500);

    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      const parsed = parse();
      if (!parsed) return;
      if (parsed.status === 101) {
        socket.off('data', onData);
        socket.off('close', onClose);
        settle({ status: 101, headers: parsed.headers, body: '', ws: new WsSession(socket, parsed.rest), key });
      }
    };
    const onClose = (): void => {
      const parsed = parse();
      if (parsed) settle({ status: parsed.status, headers: parsed.headers, body: parsed.rest.toString(), key });
      else if (!settled) reject(new Error('connection closed before a handshake response'));
    };
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', () => {});
    socket.on(options.tlsCa ? 'secureConnect' : 'connect', () => socket.write(request));
  });
}
