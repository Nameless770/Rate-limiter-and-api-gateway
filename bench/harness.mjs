// Shared plumbing for the benchmark and soak scripts: start the upstream and the built gateway as child
// processes, read the gateway's own metrics, and clean up.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const children = new Set();
export function stopAll() {
  for (const c of children) {
    if (c.exitCode === null) c.kill();
  }
  children.clear();
}
process.on('exit', stopAll);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopAll();
    process.exit(130);
  });
}

function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolveGet, reject) => {
    const req = http.get(url, { agent: false, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolveGet({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function waitFor(fn, what, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {
      // not ready yet
    }
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

export async function startBenchUpstream(port) {
  const child = spawn(process.execPath, [join(projectRoot, 'bench', 'upstream.mjs')], {
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  });
  children.add(child);
  await waitFor(() => httpGet(`http://127.0.0.1:${port}/__stats`).then((r) => r.status === 200), 'bench upstream');
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stats: async () => JSON.parse((await httpGet(`http://127.0.0.1:${port}/__stats`)).body),
    stop: () => child.kill(),
  };
}

/** Start the compiled gateway (run `npm run build` first) with a generated config. */
export async function startBenchGateway(config, { logLevel = 'warn', logToFile } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gw-bench-'));
  const configPath = join(dir, 'gateway.json');
  writeFileSync(configPath, JSON.stringify(config));
  const child = spawn(process.execPath, [join(projectRoot, 'dist', 'index.js'), configPath], {
    cwd: projectRoot,
    env: { ...process.env, LOG_LEVEL: logLevel, PORT: undefined, REDIS_URL: undefined },
    stdio: ['ignore', logToFile ? 'ignore' : 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  children.add(child);
  const adminBase = `http://127.0.0.1:${config.admin.port}`;
  try {
    await waitFor(() => httpGet(`${adminBase}/_gateway/live`).then((r) => r.status === 200), 'gateway', 20_000);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${stderr}`);
  }
  return {
    base: `http://127.0.0.1:${config.port}`,
    adminBase,
    pid: child.pid,
    metrics: async () => parseMetrics((await httpGet(`${adminBase}/_gateway/metrics`)).body),
    health: async () => JSON.parse((await httpGet(`${adminBase}/_gateway/health`)).body),
    stop: async () => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Prometheus text to a flat map keyed by the metric line up to the value, e.g. `name{a="b"}`. */
export function parseMetrics(text) {
  const out = {};
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const i = line.lastIndexOf(' ');
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

/** The numbers worth watching from a gateway metrics snapshot. */
export function vitals(m) {
  let requests = 0;
  for (const [k, v] of Object.entries(m)) if (k.startsWith('gateway_requests_total{')) requests += v;
  return {
    requests,
    rssMiB: m.process_resident_memory_bytes / 2 ** 20,
    heapMiB: m.nodejs_heap_used_bytes / 2 ** 20,
    externalMiB: m.nodejs_external_memory_bytes / 2 ** 20,
    cpuSeconds:
      (m['process_cpu_seconds_total{mode="user"}'] ?? 0) + (m['process_cpu_seconds_total{mode="system"}'] ?? 0),
    loopP99Ms: (m['nodejs_eventloop_delay_seconds{quantile="0.99"}'] ?? 0) * 1000,
    loopMaxMs: (m['nodejs_eventloop_delay_seconds{quantile="1"}'] ?? 0) * 1000,
    connections: m.gateway_connections ?? 0,
    inFlight: m.gateway_inflight_requests ?? 0,
    cacheEntries: m.gateway_cache_entries ?? 0,
    cacheMiB: (m.gateway_cache_bytes ?? 0) / 2 ** 20,
  };
}

export function baseGatewayConfig(overrides = {}) {
  const { upstreamUrl, ...rest } = overrides;
  return {
    port: 18080,
    host: '127.0.0.1',
    admin: { port: 19090 },
    limits: { maxInFlight: 20_000, maxConnections: 20_000, maxConnectionsPerIp: 0 },
    upstreams: { bench: { url: upstreamUrl, timeoutMs: 5000, retry: { maxAttempts: 2 } } },
    routes: [{ id: 'all', path: '/', upstream: 'bench', stripPrefix: false }],
    ...rest,
  };
}
