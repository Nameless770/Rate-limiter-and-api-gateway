/**
 * Plumbing for the end-to-end tests: real processes talking over real sockets.
 *
 * The gateway is the actual entrypoint, the upstreams are the actual demo service, and Redis is the actual Redis
 * (reached through a TCP proxy the test can cut, so an outage is something that happens to a running gateway rather
 * than something it is started into). Nothing is stubbed in the gateway's process.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closedPort, rawRequest, sleep } from '../helpers.js';

export const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

export interface Proc {
  child: ChildProcess;
  /** Every JSON line the process wrote to stdout (the gateway's log). */
  logs: Array<Record<string, unknown>>;
  /** Everything it wrote, raw. */
  output(): string;
  exited: Promise<number | null>;
  /** Ask it to stop with `signal` and wait for it to go (killing it if it will not). */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<number | null>;
}

const cleanups: Array<() => Promise<void> | void> = [];
/** Register something to stop when the test is over. */
export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(fn);
}
/** Stop everything the test started, newest first. Call from afterEach/afterAll. */
export async function cleanupAll(): Promise<void> {
  while (cleanups.length) await cleanups.pop()?.();
}

export function spawnNode(args: string[], env: NodeJS.ProcessEnv = {}): Proc {
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    env: { ...process.env, REDIS_URL: undefined, PORT: undefined, WORKERS: undefined, LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logs: Array<Record<string, unknown>> = [];
  let raw = '';
  let buffered = '';
  child.stdout?.on('data', (d: Buffer) => {
    raw += d.toString();
    buffered += d.toString();
    for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      try {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // not a log line
      }
    }
  });
  child.stderr?.on('data', (d: Buffer) => {
    raw += d.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const proc: Proc = {
    child,
    logs,
    output: () => raw,
    exited,
    stop: async (signal = 'SIGTERM', timeoutMs = 15_000) => {
      if (child.exitCode !== null || child.signalCode !== null) return exited;
      child.kill(signal);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) await proc.stop('SIGKILL', 2_000);
  });
  return proc;
}

export async function until(check: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${what} not met within ${ms}ms`);
    await sleep(50);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The demo upstream (demo/flaky-upstream.mjs), exactly as the README tells a user to run it.
// ---------------------------------------------------------------------------------------------------------------

export interface DemoUpstream {
  port: number;
  url: string;
  proc: Proc;
  /** Make every request (except /health and /_demo/*) fail with a 500 at this rate. */
  fail(rate: number): Promise<void>;
  latency(ms: number): Promise<void>;
  /** Kill it hard, as a crashed instance would be. */
  crash(): Promise<void>;
}

export async function startDemoUpstream(port?: number): Promise<DemoUpstream> {
  const chosen = port ?? (await closedPort());
  const proc = spawnNode(['demo/flaky-upstream.mjs'], { PORT: String(chosen) });
  const url = `http://127.0.0.1:${chosen}`;
  await until(
    async () => {
      try {
        return (await rawRequest(url, { path: '/health', headers: {} })).status === 200;
      } catch {
        return false;
      }
    },
    10_000,
    `demo upstream on :${chosen}`,
  );
  return {
    port: chosen,
    url,
    proc,
    fail: async (rate) => void (await rawRequest(url, { path: `/_demo/failure?rate=${rate}` })),
    latency: async (ms) => void (await rawRequest(url, { path: `/_demo/latency?ms=${ms}` })),
    crash: async () => void (await proc.stop('SIGKILL', 2_000)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The gateway, as `node src/index.ts <config>`.
// ---------------------------------------------------------------------------------------------------------------

/** What the tests read out of the admin endpoints. JSON from a process under test, so deliberately loose. */
// biome-ignore lint/suspicious/noExplicitAny: parsed JSON from the process under test
export type Loose = Record<string, any>;

export interface GatewayProc {
  proc: Proc;
  base: string;
  adminBase: string;
  /** Admin bearer token, when the config has one. */
  adminToken?: string;
  /** The file the gateway was started with. */
  configPath: string;
  /** Replace the file's contents (with the same test-safe address defaults); the gateway notices on a reload. */
  rewrite(config: Record<string, unknown>): void;
  metrics(): Promise<string>;
  health(): Promise<Loose>;
}

/** Test-safe defaults: loopback, a free port, and its own admin port (the default 9090 would be shared). */
function forTest(config: Record<string, unknown>): Record<string, unknown> {
  const admin = { port: 0, ...((config['admin'] as object | undefined) ?? {}) };
  return { host: '127.0.0.1', port: 0, ...config, admin };
}

export async function startGatewayProc(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): Promise<GatewayProc> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-e2e-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'gateway.json');
  writeFileSync(path, JSON.stringify(forTest(config)));
  const gw = await launchGateway(path, { tls: Boolean(config['tls']), admin: config['admin'] }, env);
  return { ...gw, rewrite: (next) => writeFileSync(path, JSON.stringify(forTest(next))) };
}

/**
 * Start the gateway on a config file exactly as it is (the shipped one, say), relying on the environment for anything
 * that must differ in a test (PORT, ADMIN_PORT, ...).
 */
export async function startGatewayFromFile(path: string, env: NodeJS.ProcessEnv = {}): Promise<GatewayProc> {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const gw = await launchGateway(path, { tls: Boolean(raw['tls']), admin: undefined }, env);
  return {
    ...gw,
    rewrite: () => {
      throw new Error('this gateway runs on a file the test does not own');
    },
  };
}

async function launchGateway(
  path: string,
  shape: { tls: boolean; admin: unknown },
  env: NodeJS.ProcessEnv,
): Promise<Omit<GatewayProc, 'rewrite'>> {
  const proc = spawnNode(['--import', 'tsx', 'src/index.ts', path], env);
  const listening = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway did not start:\n${proc.output()}`)), 40_000);
    const poll = setInterval(() => {
      const entry = proc.logs.find((l) => l['msg'] === 'gateway listening');
      if (entry) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve(entry);
      }
    }, 25);
    void proc.exited.then((code) => {
      clearInterval(poll);
      clearTimeout(timer);
      reject(new Error(`gateway exited early (${code}):\n${proc.output()}`));
    });
  });

  const scheme = shape.tls ? 'https' : 'http';
  const adminBase = `http://127.0.0.1:${listening['adminPort']}`;
  const adminToken = (shape.admin as { token?: string } | undefined)?.token;
  const headers: Record<string, string> = adminToken ? { authorization: `Bearer ${adminToken}` } : {};
  return {
    proc,
    base: `${scheme}://127.0.0.1:${listening['port']}`,
    adminBase,
    adminToken,
    configPath: path,
    metrics: async () => (await rawRequest(adminBase, { path: '/_gateway/metrics', headers })).body,
    health: async () => JSON.parse((await rawRequest(adminBase, { path: '/_gateway/health', headers })).body),
  };
}

/** Sum of every series of `name` whose labels include all of `labels` (across workers, if clustered). */
export function metric(text: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (!wanted.every((w) => line.includes(w))) continue;
    total += Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return total;
}

// ---------------------------------------------------------------------------------------------------------------
// A TCP proxy in front of Redis that can start failing while the gateway is running.
// ---------------------------------------------------------------------------------------------------------------

export type ProxyMode = 'open' | 'refuse' | 'blackhole';

export interface TcpProxy {
  port: number;
  /**
   *   open       pass bytes both ways
   *   refuse     drop every connection immediately (what a crashed Redis looks like)
   *   blackhole  keep connections open and deliver nothing for now (what a frozen Redis, or a network partition that
   *              heals, looks like). Bytes are held, not lost, and delivered in order when the mode returns to
   *              "open": inside an established TCP connection data is delayed, never silently dropped, and a proxy
   *              that dropped it would desynchronise the protocol (replies matched to the wrong commands) and test
   *              nothing real.
   */
  setMode(mode: ProxyMode): void;
  connections(): number;
}

export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  let mode: ProxyMode = 'open';
  const sockets = new Set<net.Socket>();
  /** One per live connection: writes held back while the proxy is cut, to be flushed when it heals. */
  const flushers = new Set<() => void>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    if (mode === 'refuse') return void client.destroy();
    const upstream = net.connect(target.port, target.host);
    sockets.add(upstream);

    const held: Array<[net.Socket, Buffer]> = [];
    const send = (to: net.Socket, data: Buffer): void => {
      if (mode === 'open') to.write(data);
      else held.push([to, data]);
    };
    const flush = (): void => {
      if (mode !== 'open') return;
      for (const [to, data] of held.splice(0)) if (!to.destroyed) to.write(data);
    };
    flushers.add(flush);

    const end = (): void => {
      flushers.delete(flush);
      client.destroy();
      upstream.destroy();
    };
    upstream.on('close', () => {
      sockets.delete(upstream);
      end();
    });
    upstream.on('error', end);
    client.on('close', end);
    // Checked per chunk, so a cut applies to connections that are already open.
    client.on('data', (d: Buffer) => send(upstream, d));
    upstream.on('data', (d: Buffer) => send(client, d));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    setMode: (next) => {
      mode = next;
      if (next === 'refuse') for (const s of sockets) s.destroy();
      if (next === 'open') for (const flush of [...flushers]) flush();
    },
    connections: () => sockets.size,
  };
}
