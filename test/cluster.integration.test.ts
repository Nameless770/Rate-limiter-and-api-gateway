/**
 * Cluster mode with real processes: the actual entrypoint, forking real workers that share a port and rate-limit
 * state in a real Redis. Skipped unless REDIS_URL is set (the same condition as the Redis integration tests):
 *
 *   docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine
 *   REDIS_URL=redis://127.0.0.1:6379 npm test
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { closedPort, fixture, json, rawRequest, sleep, startUpstream } from './helpers.js';

const redisUrl = process.env['REDIS_URL'];
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'cluster-test-admin-token';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

interface Running {
  child: ChildProcess;
  logs: Array<Record<string, unknown>>;
  base: string;
  adminBase: string;
  exited: Promise<number | null>;
  stderr: () => string;
}

async function spawnCluster(config: Record<string, unknown>): Promise<Running> {
  const dir = mkdtempSync(join(tmpdir(), 'gw-cluster-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'gateway.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      port: 0,
      host: '127.0.0.1',
      shutdownGraceMs: 5_000,
      // A real, fixed port: with port 0 a worker that kept its own admin listener would just get a random one.
      admin: { port: await closedPort(), token: TOKEN },
      // The default 100 ms command timeout is for production; with the whole suite loading the CPU it can trip, and
      // the limiter then (by design) falls back to counting per worker.
      redis: {
        url: redisUrl,
        commandTimeoutMs: 5_000,
        keyPrefix: `gwt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}:`,
      },
      ...config,
    }),
  );

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
    cwd: projectRoot,
    env: { ...process.env, PORT: undefined, WORKERS: undefined, LOG_LEVEL: 'info' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  cleanups.push(async () => {
    if (child.exitCode !== null) return;
    // Workers outlive nothing: they exit when their channel to the primary closes, but be tidy and quick.
    for (const pid of await workerPids(logs)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    child.kill('SIGKILL');
    await exited;
  });

  const logs: Array<Record<string, unknown>> = [];
  const listening = await new Promise<Record<string, unknown>>((resolve, reject) => {
    let buffered = '';
    child.stdout?.on('data', (d: Buffer) => {
      buffered += d.toString();
      for (let nl = buffered.indexOf('\n'); nl >= 0; nl = buffered.indexOf('\n')) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          logs.push(entry);
          if (entry['msg'] === 'gateway listening') resolve(entry);
        } catch {
          // not a log line
        }
      }
    });
    void exited.then((code) => reject(new Error(`gateway exited early (${code}): ${stderr}`)));
    setTimeout(() => reject(new Error(`gateway did not start: ${stderr}`)), 40_000).unref();
  });
  return {
    child,
    logs,
    base: `http://127.0.0.1:${listening['port']}`,
    adminBase: `http://127.0.0.1:${listening['adminPort']}`,
    exited,
    stderr: () => stderr,
  };
}

/** Worker pids as the logs saw them (for cleanup, when the admin listener may be gone). */
async function workerPids(logs: Array<Record<string, unknown>>): Promise<number[]> {
  return logs.filter((l) => l['msg'] === 'worker ready').map((l) => l['pid'] as number);
}

const auth = { authorization: `Bearer ${TOKEN}` };
const health = async (r: Running) =>
  JSON.parse((await rawRequest(r.adminBase, { path: '/_gateway/health', headers: auth })).body) as {
    status: string;
    cluster: { workers: number; ready: number; restarts: number };
    workers: Array<{ worker: number; pid: number; status: string }>;
  };
const metrics = async (r: Running) =>
  (await rawRequest(r.adminBase, { path: '/_gateway/metrics', headers: auth })).body;

/**
 * Whether a process is still doing anything. An exited process nobody has reaped (an orphan whose new parent, PID 1
 * in a container, never waits for it) still answers `kill(pid, 0)` as a zombie, so on Linux look at its state too.
 */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true; // no /proc here: the signal check above is all there is
  }
}

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(100);
  }
}

describe.skipIf(!redisUrl)('cluster mode (real processes)', { timeout: 60_000 }, () => {
  const basic = async (extra: Record<string, unknown> = {}) => {
    const up = await startUpstream((_r, res) => json(res, 200, { ok: true }));
    cleanups.push(up.close);
    return {
      up,
      gw: await spawnCluster({
        cluster: { workers: 3 },
        upstreams: { u: { url: up.url } },
        routes: [{ id: 'api', path: '/', upstream: 'u' }],
        ...extra,
      }),
    };
  };

  it('runs the configured workers as separate processes behind one port, with the admin listener in the primary', async () => {
    const { gw } = await basic();
    const report = await health(gw);
    expect(report.status).toBe('ok');
    expect(report.cluster).toMatchObject({ workers: 3, ready: 3, restarts: 0 });
    const pids = report.workers.map((w) => w.pid);
    expect(new Set(pids).size).toBe(3);
    expect(pids).not.toContain(gw.child.pid);
    expect(report.workers.map((w) => w.worker)).toEqual([0, 1, 2]);

    expect((await rawRequest(gw.base, { path: '/hello' })).status).toBe(200);
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('keeps the admin token requirement', async () => {
    const { gw } = await basic();
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/health' })).status).toBe(401);
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/metrics' })).status).toBe(401);
    expect(
      (await rawRequest(gw.adminBase, { path: '/_gateway/metrics', headers: { authorization: 'Bearer wrong' } }))
        .status,
    ).toBe(401);
    expect((await rawRequest(gw.adminBase, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('shares rate limits between workers, so N workers do not mean N times the limit', async () => {
    const { gw } = await basic({
      rateLimit: { default: { algorithm: 'sliding-window', limit: 5, windowMs: 60_000 } },
    });
    // Every request opens a fresh connection, so they land on different workers.
    const statuses: number[] = [];
    for (let i = 0; i < 20; i++) statuses.push((await rawRequest(gw.base, { path: '/x' })).status);
    // If Redis had been slow enough to fall back to per-worker counting, the counts below would be wrong; say why.
    expect(await metrics(gw)).not.toContain('gateway_ratelimit_degraded_total{');
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);

    const served = new Set(
      (await metrics(gw))
        .split('\n')
        .filter((l) => l.startsWith('gateway_requests_total{') && !l.includes('worker="primary"'))
        .map((l) => /worker="(\d+)"/.exec(l)?.[1]),
    );
    // Linux hands connections out round-robin; elsewhere the OS decides, and it may favour one worker.
    if (process.platform === 'linux') expect(served.size).toBe(3);
    else expect(served.size).toBeGreaterThanOrEqual(1);
  });

  it("shows every worker in one metrics scrape, plus the primary's own", async () => {
    const { gw } = await basic();
    for (let i = 0; i < 6; i++) await rawRequest(gw.base, { path: '/x' });
    const text = await metrics(gw);
    for (const worker of ['0', '1', '2', 'primary']) expect(text).toContain(`worker="${worker}"`);
    expect(text).toMatch(/gateway_connections\{worker="0"\} \d+/);
    expect(text).toContain('gateway_cluster_workers{worker="primary"} 3');
    expect(text).toContain('gateway_cluster_worker_ready{worker="primary",slot="2"} 1');
    // one declaration per family, not one per worker
    expect(text.match(/^# TYPE gateway_requests_total /gm)).toHaveLength(1);
  });

  it("labels the workers' log lines", async () => {
    const { gw } = await basic();
    for (let i = 0; i < 6; i++) await rawRequest(gw.base, { path: '/x' });
    await until(async () => gw.logs.some((l) => l['msg'] === 'request'));
    const access = gw.logs.filter((l) => l['msg'] === 'request');
    expect(access.every((l) => [0, 1, 2].includes(l['worker'] as number))).toBe(true);
  });

  it('replaces a worker that is killed, and keeps serving meanwhile', async () => {
    const { gw } = await basic();
    const before = await health(gw);
    const victim = before.workers[1] as { worker: number; pid: number };
    process.kill(victim.pid, 'SIGKILL');

    // The other workers carry on while it is gone.
    let served = 0;
    const deadline = Date.now() + 20_000;
    let after = await health(gw);
    while ((after.cluster.ready < 3 || after.workers[1]?.pid === victim.pid) && Date.now() < deadline) {
      if ((await rawRequest(gw.base, { path: '/x' }).catch(() => ({ status: 0 }))).status === 200) served++;
      await sleep(100);
      after = await health(gw);
    }
    expect(after.cluster).toMatchObject({ ready: 3, restarts: 1 });
    expect(after.workers[1]?.pid).not.toBe(victim.pid);
    expect(served).toBeGreaterThan(0);
    expect(await metrics(gw)).toContain('gateway_cluster_worker_restarts_total{worker="primary",slot="1"} 1');
  });

  it('refuses to start when the workers cannot', async () => {
    const up = await startUpstream((_r, res) => json(res, 200, {}));
    cleanups.push(up.close);
    const dir = mkdtempSync(join(tmpdir(), 'gw-cluster-bad-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 0,
        host: '127.0.0.1',
        cluster: { workers: 2 },
        redis: { url: redisUrl },
        // The certificate does not exist, which only a worker finds out when it tries to serve.
        tls: { certFile: join(dir, 'missing-cert.pem'), keyFile: join(dir, 'missing-key.pem') },
        upstreams: { u: { url: up.url } },
        routes: [{ path: '/', upstream: 'u' }],
      }),
    );
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: projectRoot,
      env: { ...process.env, PORT: undefined, WORKERS: undefined, LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(() => void (child.exitCode === null && child.kill('SIGKILL')));
    let out = '';
    child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    expect(code).toBe(1);
    expect(out).toContain('cluster failed to start');
    expect(out).toContain('could not start');
  });

  it('does not leave workers running when the primary is killed', async () => {
    const { gw } = await basic({ cluster: { workers: 2 } });
    const pids = (await health(gw)).workers.map((w) => w.pid);
    gw.child.kill('SIGKILL'); // no chance to say goodbye
    await gw.exited;
    await until(async () => pids.every((pid) => !isRunning(pid)));
  });

  describe.skipIf(process.platform === 'win32')('shutdown (POSIX signals)', () => {
    it('on SIGHUP has every worker reload its TLS certificate', async () => {
      const up = await startUpstream((_r, res) => json(res, 200, { ok: true }));
      cleanups.push(up.close);
      const gw = await spawnCluster({
        cluster: { workers: 2 },
        tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem') },
        upstreams: { u: { url: up.url } },
        routes: [{ path: '/', upstream: 'u' }],
      });
      gw.child.kill('SIGHUP');
      await until(
        async () =>
          new Set(gw.logs.filter((l) => l['msg'] === 'tls certificate reloaded').map((l) => l['worker'])).size === 2,
      );
      expect(gw.logs.some((l) => String(l['msg']).includes('asking the workers to reload'))).toBe(true);
      expect(gw.child.exitCode).toBeNull(); // SIGHUP's default action would have ended it
    });

    it('on SIGTERM lets in-flight requests finish, stops every worker and exits 0', async () => {
      const up = await startUpstream(async (_r, res) => {
        await sleep(600);
        json(res, 200, { done: true });
      });
      cleanups.push(up.close);
      const gw = await spawnCluster({
        cluster: { workers: 2 },
        upstreams: { u: { url: up.url } },
        routes: [{ path: '/', upstream: 'u' }],
      });
      const pids = (await health(gw)).workers.map((w) => w.pid);

      const inflight = rawRequest(gw.base, { path: '/slow' });
      await sleep(200);
      gw.child.kill('SIGTERM');

      const response = await inflight;
      expect(response.status).toBe(200);
      expect(await gw.exited).toBe(0);
      for (const pid of pids) expect(isRunning(pid), `worker ${pid}`).toBe(false);
      expect(gw.logs.some((l) => l['msg'] === 'shutting down')).toBe(true);
    });
  });
});
