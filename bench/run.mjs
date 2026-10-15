// Throughput and latency benchmark: the gateway's overhead relative to talking to the upstream directly, and the
// cost of each feature (limiter, Redis, cache, access logging).
//
//   npm run build
//   node bench/run.mjs [--duration 10] [--connections 64] [--repeat 3] [--redis redis://127.0.0.1:6379] [--only <name substring>]
//
// Each scenario runs --repeat times against a freshly started gateway; the table shows the median run and the
// min-max throughput across runs.
//
// Everything runs on one machine, so the load generator, gateway, upstream and Redis compete for CPU. Read the
// numbers as relative costs on this hardware, not as capacity planning figures.
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { baseGatewayConfig, projectRoot, startBenchGateway, startBenchUpstream, stopAll, vitals } from './harness.mjs';
import { runLoad } from './loadgen.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
}
const duration = Number(args.duration ?? 10);
const connections = Number(args.connections ?? 64);
const repeat = Number(args.repeat ?? 1);
const redisUrl = args.redis;
const warmup = 3;

const HUGE = 1_000_000_000;
const sw = { algorithm: 'sliding-window', limit: HUGE, windowMs: 60_000 };
const swc = { algorithm: 'sliding-window-counter', limit: HUGE, windowMs: 60_000 };
const tb = { algorithm: 'token-bucket', capacity: HUGE, refillPerSecond: HUGE };
const redis = redisUrl ? { redis: { url: redisUrl } } : undefined;
const short = Math.min(duration, 5);

const scenarios = [
  // One connection: no queueing, so latency is the cost of a single request, not of waiting in line.
  { name: 'direct to upstream', direct: true, connections: 1, duration: short },
  { name: 'proxy only', gateway: {}, connections: 1, duration: short },
  { name: 'proxy + token bucket (memory)', gateway: { rateLimit: { default: tb } }, connections: 1, duration: short },
  ...(redis
    ? [
        {
          name: 'proxy + token bucket (Redis)',
          gateway: { ...redis, rateLimit: { default: tb } },
          keys: 1000,
          connections: 1,
          duration: short,
        },
      ]
    : []),

  // Saturation: throughput and CPU cost per request.
  { name: 'direct to upstream', direct: true },
  { name: 'proxy only', gateway: {} },
  { name: 'proxy + access log (info)', gateway: {}, logLevel: 'info' },
  { name: 'proxy + token bucket (memory)', gateway: { rateLimit: { default: tb } } },
  { name: 'proxy + sliding window log (memory)', gateway: { rateLimit: { default: sw } } },
  { name: 'proxy + sliding window counter (memory)', gateway: { rateLimit: { default: swc } } },
  { name: 'proxy + token bucket + address ceiling', gateway: { rateLimit: { default: tb, ip: swc } }, keys: 5000 },
  ...(redis
    ? [
        { name: 'proxy + token bucket (Redis)', gateway: { ...redis, rateLimit: { default: tb } }, keys: 1000 },
        { name: 'proxy + sliding window log (Redis)', gateway: { ...redis, rateLimit: { default: sw } }, keys: 1000 },
        {
          name: 'proxy + sliding window counter (Redis)',
          gateway: { ...redis, rateLimit: { default: swc } },
          keys: 1000,
        },
      ]
    : []),
  { name: 'proxy + cache hit', gateway: {}, cached: true, path: '/cached' },
  {
    name: 'proxy, every request rate limited (429)',
    gateway: { rateLimit: { default: { algorithm: 'token-bucket', capacity: 1, refillPerSecond: 0.0001 } } },
    keys: 1,
  },
  { name: 'proxy, 64 KiB response', gateway: {}, path: '/?size=65536' },
  { name: 'proxy, 16 KiB POST body', gateway: {}, method: 'POST', bodyBytes: 16384 },
];

const only = args.only;
const selected = only ? scenarios.filter((s) => s.name.includes(only)) : scenarios;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const upstream = await startBenchUpstream(19001);
const rows = [];

async function runOnce(s) {
  let gw;
  let target;
  if (s.direct) {
    target = upstream.url;
  } else {
    const cfg = baseGatewayConfig({ upstreamUrl: upstream.url, ...s.gateway });
    if (s.cached) {
      cfg.routes = [{ id: 'cached', path: '/', upstream: 'bench', stripPrefix: false, cache: { ttlMs: 600_000 } }];
    }
    gw = await startBenchGateway(cfg, { logLevel: s.logLevel ?? 'warn' });
    target = gw.base;
  }

  const c = s.connections ?? connections;
  const before = gw ? vitals(await gw.metrics()) : undefined;
  const upBefore = await upstream.stats();
  const started = Date.now();
  const r = await runLoad({
    url: `${target}${s.path ?? '/x'}`,
    duration: s.duration ?? duration,
    warmup,
    connections: c,
    workers: c === 1 ? 1 : 4,
    keys: s.keys ?? 0,
    method: s.method ?? 'GET',
    bodyBytes: s.bodyBytes ?? 0,
  });
  const wall = (Date.now() - started) / 1000;
  const after = gw ? vitals(await gw.metrics()) : undefined;
  const upAfter = await upstream.stats();
  if (gw) await gw.stop();

  const total = (o, skip) =>
    Object.entries(o)
      .filter(([k]) => !skip.includes(k))
      .reduce((a, [, v]) => a + v, 0);
  return {
    rps: r.rps,
    p50: r.latencyMs.p50,
    p99: r.latencyMs.p99,
    p999: r.latencyMs.p999,
    max: r.latencyMs.max,
    limited: r.statuses['429'] ?? 0,
    other: total(r.statuses, ['200', '429']),
    errors: total(r.errors, []),
    gatewayCpuPct: gw ? ((after.cpuSeconds - before.cpuSeconds) / wall) * 100 : null,
    gatewayCpuUsPerReq: gw
      ? ((after.cpuSeconds - before.cpuSeconds) / Math.max(1, after.requests - before.requests)) * 1e6
      : null,
    upstreamCpuPct: ((upAfter.cpuSeconds - upBefore.cpuSeconds) / wall) * 100,
    rssMiB: after?.rssMiB ?? null,
  };
}

try {
  for (const s of selected) {
    const c = s.connections ?? connections;
    process.stdout.write(`\n${s.name} [${c} conn] ... `);
    const runs = [];
    for (let i = 0; i < repeat; i++) runs.push(await runOnce(s));
    const byRps = [...runs].sort((a, b) => a.rps - b.rps);
    const mid = byRps[Math.floor(byRps.length / 2)];
    rows.push({
      name: s.name,
      connections: c,
      ...mid,
      rpsMin: byRps[0].rps,
      rpsMax: byRps[byRps.length - 1].rps,
      runs: runs.length,
      errors: runs.reduce((a, r) => a + r.errors, 0),
      other: median(runs.map((r) => r.other)),
    });
    process.stdout.write(`${Math.round(mid.rps)} req/s, p50 ${mid.p50.toFixed(2)} ms, p99 ${mid.p99.toFixed(2)} ms`);
  }
} finally {
  stopAll();
}

const fmt = (n, d = 2) => (n === null || n === undefined ? '-' : n.toFixed(d));
const num = (n) => Math.round(n).toLocaleString('en-US');
const spread = (r) => (r.runs > 1 ? ` (${num(r.rpsMin)}-${num(r.rpsMax)})` : '');
console.log('\n');
console.log(
  '| Scenario | conn | req/s (range) | p50 ms | p99 ms | p99.9 ms | max ms | gateway CPU µs/req | gateway CPU | upstream CPU | non-2xx/429 | errors |',
);
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) {
  const cpu = r.gatewayCpuPct === null ? '-' : `${fmt(r.gatewayCpuPct, 0)}%`;
  console.log(
    `| ${r.name} | ${r.connections} | ${num(r.rps)}${spread(r)} | ${fmt(r.p50)} | ${fmt(r.p99)} | ${fmt(r.p999)} | ${fmt(r.max)} | ${fmt(r.gatewayCpuUsPerReq, 0)} | ${cpu} | ${fmt(r.upstreamCpuPct, 0)}% | ${r.other} | ${r.errors} |`,
  );
}

const cpus = os.cpus();
const meta = {
  date: new Date().toISOString(),
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  cpu: `${cpus.length} x ${cpus[0].model.trim()}`,
  ramGiB: Math.round(os.totalmem() / 2 ** 30),
  duration,
  connections,
  repeat,
  warmup,
  redis: redisUrl ? 'Redis 7 in Docker' : 'not measured',
};
mkdirSync(join(projectRoot, 'bench', 'results'), { recursive: true });
const file = join(projectRoot, 'bench', 'results', `run-${meta.date.replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ meta, rows }, null, 2));
console.log(`\nwrote ${file}`);
process.exit(0);
