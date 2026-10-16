import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import net, { type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { Gateway, type GatewayDeps } from '../src/gateway.js';
import { createLogger, type Logger, silentLogger } from '../src/observability/logger.js';

/** Absolute path of a file under test/fixtures. */
export const fixture = (relative: string): string => fileURLToPath(new URL(`./fixtures/${relative}`, import.meta.url));

export interface Hit {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeUpstream {
  url: string;
  port: number;
  hits: Hit[];
  /** TCP connections accepted so far. */
  connections(): number;
  close(): Promise<void>;
}

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  hit: Hit,
  hitNumber: number,
) => void | Promise<void>;

export interface UpstreamOptions {
  /** Serve HTTPS with this key and certificate instead of plain HTTP. */
  tls?: { key: string | Buffer; cert: string | Buffer };
}

/** Start a real HTTP(S) server on an ephemeral port that records every request it receives. */
export async function startUpstream(handler: UpstreamHandler, options: UpstreamOptions = {}): Promise<FakeUpstream> {
  const hits: Hit[] = [];
  const listener = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const hit: Hit = {
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    };
    hits.push(hit);
    try {
      await handler(req, res, hit, hits.length);
    } catch {
      res.destroy();
    }
  };
  const server = options.tls ? https.createServer(options.tls, listener) : http.createServer(listener);
  let connections = 0;
  server.on('connection', () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}`,
    port,
    hits,
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * GET with the request target sent exactly as given. `fetch` normalizes dot-segments before sending, so it
 * can't exercise how the server treats a hostile path.
 */
export function rawGet(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path, method: 'GET', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

export interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** False when the connection died before the full body arrived. */
  complete: boolean;
}

/**
 * One request on its own connection, with full control over framing. Each entry in `chunks` is written
 * separately, so without a Content-Length header the body goes out chunked. Writing stops as soon as a
 * response arrives (a server may answer, say 413, before the upload is finished).
 */
export function rawRequest(
  base: string,
  opts: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    chunks?: string[];
    chunkDelayMs?: number;
    /** Defaults to a fresh connection that asks to be closed afterwards (Connection: close). */
    agent?: http.Agent;
  },
): Promise<RawResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    let responded = false;
    const req = http.request(
      {
        hostname,
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        agent: opts.agent ?? false,
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', () => {}); // a body cut short surfaces below as complete === false
        res.on('close', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            complete: res.complete,
          }),
        );
      },
    );
    req.on('error', (error) => {
      if (!responded) reject(error);
    });
    void (async () => {
      for (const chunk of opts.chunks ?? []) {
        if (responded || req.destroyed) return;
        req.write(chunk);
        if (opts.chunkDelayMs) await sleep(opts.chunkDelayMs);
      }
      if (!responded && !req.destroyed) req.end();
    })();
  });
}

/** A logger that keeps every line, so tests can assert nothing was logged at error level. */
export function capturingLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    logger: createLogger('debug', (line) => void lines.push(JSON.parse(line) as Record<string, unknown>)),
    lines,
  };
}

/**
 * A stand-in for an ioredis client that implements just enough for the Lua-backed limiters. Lets the tests
 * drive the real gateway through Redis success and failure paths without a Redis server.
 */
export function fakeRedis() {
  const state = { failing: false, calls: [] as string[] };
  const commands: Record<string, (key: string, ...args: unknown[]) => Promise<number[]>> = {};
  const client = {
    status: 'ready',
    defineCommand(name: string) {
      commands[name] = async (key: string) => {
        state.calls.push(key);
        if (state.failing) throw new Error('ECONNREFUSED fake redis down');
        return [1, 2, 0, 1000]; // allowed, 2 remaining
      };
      (client as Record<string, unknown>)[name] = commands[name];
    },
  };
  return { client: client as never, state };
}

/** A port with nothing listening on it, for exercising connect failures. */
export async function closedPort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface TestClock {
  (): number;
  advance(ms: number): void;
}

export function fakeClock(start = 1_700_000_000_000): TestClock {
  let now = start;
  const clock = (() => now) as TestClock;
  clock.advance = (ms: number) => {
    now += ms;
  };
  return clock;
}

export interface RunningGateway {
  gateway: Gateway;
  /** Proxied traffic. */
  base: string;
  /** Health and metrics (the separate admin listener). */
  adminBase: string;
  clock: TestClock;
  /** Backoff delays the retry loop asked for (sleeps are skipped, not performed). */
  delays: number[];
  close(): Promise<void>;
}

export async function startGateway(raw: Record<string, unknown>, deps: GatewayDeps = {}): Promise<RunningGateway> {
  const adminOverrides = (raw['admin'] ?? {}) as Record<string, unknown>;
  const config = parseConfig({
    host: '127.0.0.1',
    port: 0,
    shutdownGraceMs: 500,
    ...raw,
    admin: { port: 0, ...adminOverrides },
  });
  const clock = fakeClock();
  const delays: number[] = [];
  const gateway = new Gateway(config, {
    logger: silentLogger,
    clock,
    sleep: async (ms) => void delays.push(ms),
    random: () => 0.999999,
    ...deps,
  });
  const { port } = await gateway.listen(0, '127.0.0.1');
  const adminHost = gateway.adminAddress?.address ?? '127.0.0.1';
  const adminBase = `http://${adminHost}:${gateway.adminAddress?.port ?? 0}`;
  return { gateway, base: `http://127.0.0.1:${port}`, adminBase, clock, delays, close: () => gateway.close(500) };
}

export interface RawTcpResult {
  /** Everything the server sent, decoded as latin1 so byte values survive. */
  data: string;
  /** True if the server closed the connection before `waitMs` elapsed. */
  closed: boolean;
  /** How long the connection stayed open, in ms. */
  openedForMs: number;
}

/**
 * Write exact bytes to the gateway's listener and report what comes back. For sending framing no HTTP client
 * would produce: conflicting lengths, folded headers, a request that is never finished.
 */
export function rawTcp(
  base: string,
  payload: string | Buffer | Array<string | Buffer>,
  opts: { waitMs?: number; chunkDelayMs?: number } = {},
): Promise<RawTcpResult> {
  const { hostname, port } = new URL(base);
  const waitMs = opts.waitMs ?? 400;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const received: Buffer[] = [];
    let closed = false;
    const socket = net.connect({ host: hostname, port: Number(port) });
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ data: Buffer.concat(received).toString('latin1'), closed, openedForMs: Date.now() - started });
    };
    const timer = setTimeout(finish, waitMs);
    socket.on('data', (d: Buffer) => received.push(d));
    socket.on('close', () => {
      closed = true;
      finish();
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // A reset after the server has had its say is a normal way for it to refuse a bad request.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') {
        closed = true;
        finish();
      } else {
        clearTimeout(timer);
        reject(error);
      }
    });
    socket.on('connect', () => {
      void (async () => {
        const parts = Array.isArray(payload) ? payload : [payload];
        for (const part of parts) {
          if (socket.destroyed) return;
          socket.write(part);
          if (opts.chunkDelayMs) await sleep(opts.chunkDelayMs);
        }
      })();
    });
  });
}

/** The numeric status of every response found in a raw reply, in order. */
export function statusLines(data: string): number[] {
  return [...data.matchAll(/HTTP\/1\.[01] (\d{3})/g)].map((m) => Number(m[1]));
}

export interface TlsResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  /** SHA-256 fingerprint of the certificate the server presented on this connection. */
  fingerprint: string;
  /** Negotiated protocol, e.g. TLSv1.3. */
  protocol: string | null;
}

/** An HTTPS request that verifies the server against `ca` and reports what was negotiated. */
export function httpsRequest(
  base: string,
  opts: {
    path: string;
    ca: Buffer;
    method?: string;
    headers?: Record<string, string>;
    agent?: https.Agent | false;
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
    maxVersion?: 'TLSv1.2' | 'TLSv1.3';
  },
): Promise<TlsResponse> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        port,
        path: opts.path,
        method: opts.method ?? 'GET',
        headers: opts.headers,
        ca: opts.ca,
        agent: opts.agent ?? false,
        minVersion: opts.minVersion,
        maxVersion: opts.maxVersion,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const socket = res.socket as import('node:tls').TLSSocket;
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
            fingerprint: socket.getPeerCertificate().fingerprint256,
            protocol: socket.getProtocol(),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}
