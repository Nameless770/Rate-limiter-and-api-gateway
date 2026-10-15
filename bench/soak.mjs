// Soak test: sustained mixed traffic with high key churn, sampling the gateway's own metrics to check that memory
// and connection counts plateau instead of growing.
//
//   npm run build && node bench/soak.mjs [--minutes 5] [--connections 48] [--keys 200000]
//        [--redis redis://127.0.0.1:6379]   (also samples Redis memory and key count over time)
//
// Traffic is three concurrent streams so that every bounded structure is exercised:
//   /api      rate limited per API key, drawn from --keys distinct values (limiter key space churns and evicts)
//   /cached   GET with ?id= drawn from 5,000 values and a 3 s TTL (cache fills, expires and evicts)
//   /flaky    2% 503s from the upstream (retries and breaker accounting; the breaker must not trip)
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import {
  baseGatewayConfig,
  projectRoot,
  sleep,
  startBenchGateway,
  startBenchUpstream,
  stopAll,
  vitals,
} from './harness.mjs';
import { runLoad } from './loadgen.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
}
const minutes = Number(args.minutes ?? 5);
const connections = Number(args.connections ?? 48);
const keys = Number(args.keys ?? 200_000);
const sampleEvery = Number(args.sample ?? 5);
const redisUrl = args.redis;
const probe = redisUrl ? new Redis(redisUrl, { maxRetriesPerRequest: 1 }) : undefined;

async function redisInfo() {
  if (!probe) return undefined;
  try {
    const mem = await probe.info('memory');
    const used = /used_memory:(\d+)/.exec(mem)?.[1];
    if (!used) return undefined;
    return { redisMiB: Number(used) / 2 ** 20, redisKeys: await probe.dbsize() };
  } catch {
    return undefined;
  }
}

const upstream = await startBenchUpstream(19001);
const cfg = baseGatewayConfig({
  upstreamUrl: upstream.url,
  ...(redisUrl ? { redis: { url: redisUrl } } : {}),
  rateLimit: { failureMode: 'local', default: { algorithm: 'sliding-window-counter', limit: 1000, windowMs: 60_000 } },
  cache: { maxEntries: 1000, maxBytes: 8 * 2 ** 20, maxEntryBytes: 65_536 },
});
cfg.upstreams.bench.retry = { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 50 };
cfg.upstreams.bench.breaker = {
  failureRateThreshold: 0.5,
  minimumRequests: 50,
  windowMs: 10_000,
  openDurationMs: 5000,
};
cfg.routes = [
  { id: 'cached', path: '/cached', upstream: 'bench', stripPrefix: false, rateLimit: false, cache: { ttlMs: 3000 } },
  { id: 'flaky', path: '/flaky', upstream: 'bench', stripPrefix: false, rateLimit: false },
  { id: 'api', path: '/api', upstream: 'bench', stripPrefix: false },
];
const gw = await startBenchGateway(cfg, { logLevel: 'warn' });

const samples = [];
const startedAt = Date.now();
let stop = false;
const sampler = (async () => {
  while (!stop) {
    const v = vitals(await gw.metrics());
    const r = await redisInfo();
    samples.push({ t: (Date.now() - startedAt) / 1000, ...v, ...(r ?? {}) });
    await sleep(sampleEvery * 1000);
  }
})();

const reporter = (async () => {
  while (!stop) {
    await sleep(30_000);
    const s = samples[samples.length - 1];
    if (!s) continue;
    const redis = s.redisMiB === undefined ? '' : `  redis ${s.redisMiB.toFixed(1)} MiB/${s.redisKeys} keys`;
    console.log(
      `  t=${s.t.toFixed(0).padStart(4)}s  rss ${s.rssMiB.toFixed(0)} MiB  heap ${s.heapMiB.toFixed(0)} MiB  ` +
        `ext ${s.externalMiB.toFixed(0)} MiB  cache ${s.cacheEntries} entries/${s.cacheMiB.toFixed(1)} MiB  ` +
        `conns ${s.connections}  inflight ${s.inFlight}  loop p99 ${s.loopP99Ms.toFixed(1)} ms${redis}`,
    );
  }
})();

console.log(
  `soak: ${minutes} min, ${connections} connections, ${keys.toLocaleString('en-US')} distinct keys, ` +
    `${redisUrl ? 'Redis' : 'in-memory'} limiter`,
);
const seconds = minutes * 60;
const share = (f) => Math.max(1, Math.round(connections * f));
const results = await Promise.all([
  runLoad({ url: `${gw.base}/api/x`, duration: seconds, warmup: 0, connections: share(0.5), workers: 2, keys }),
  runLoad({
    url: `${gw.base}/cached/page`,
    duration: seconds,
    warmup: 0,
    connections: share(0.3),
    workers: 2,
    variants: 5000,
  }),
  runLoad({ url: `${gw.base}/flaky/x?fail=0.02`, duration: seconds, warmup: 0, connections: share(0.2), workers: 1 }),
]);
stop = true;
await Promise.all([sampler, reporter]);
const health = await gw.health();
await gw.stop();
stopAll();
probe?.disconnect();

// Least-squares slope of a field over time (per minute), using samples from `from` seconds on.
function slope(field, from) {
  const pts = samples.filter((s) => s.t >= from);
  const n = pts.length;
  if (n < 3) return Number.NaN;
  const mt = pts.reduce((a, p) => a + p.t, 0) / n;
  const my = pts.reduce((a, p) => a + p[field], 0) / n;
  const num = pts.reduce((a, p) => a + (p.t - mt) * (p[field] - my), 0);
  const den = pts.reduce((a, p) => a + (p.t - mt) ** 2, 0);
  return (num / den) * 60;
}
const nearest = (t) => samples.reduce((best, s) => (Math.abs(s.t - t) < Math.abs(best.t - t) ? s : best));
const peak = (field) => Math.max(...samples.map((s) => s[field]));
const last = samples[samples.length - 1];
const settle = Math.min(90, seconds / 3);
const settled = nearest(settle);

const total = results.reduce((a, r) => a + r.requests, 0);
const statuses = {};
for (const r of results) for (const [k, v] of Object.entries(r.statuses)) statuses[k] = (statuses[k] ?? 0) + v;
const errors = results.reduce((a, r) => a + Object.values(r.errors).reduce((x, y) => x + y, 0), 0);
const loops = samples.map((s) => s.loopP99Ms).sort((a, b) => a - b);
const loopMedian = loops[Math.floor(loops.length / 2)];

console.log('\n=== soak summary ===');
console.log(`requests      ${total.toLocaleString('en-US')} in ${seconds}s (${(total / seconds).toFixed(0)} req/s)`);
console.log(`statuses      ${JSON.stringify(statuses)}   transport errors: ${errors}`);
console.log(
  `RSS           ${settled.rssMiB.toFixed(0)} MiB at ${settle.toFixed(0)}s -> ${last.rssMiB.toFixed(0)} MiB at end ` +
    `(peak ${peak('rssMiB').toFixed(0)} MiB)`,
);
console.log(`RSS trend     ${slope('rssMiB', settle).toFixed(2)} MiB/min after ${settle.toFixed(0)}s`);
console.log(
  `heap used     ${settled.heapMiB.toFixed(0)} MiB -> ${last.heapMiB.toFixed(0)} MiB ` +
    `(trend ${slope('heapMiB', settle).toFixed(2)} MiB/min)`,
);
console.log(
  `event loop    median per-interval p99 ${loopMedian.toFixed(1)} ms; worst per-interval p99 ${peak('loopP99Ms').toFixed(1)} ms; ` +
    `worst single delay ${peak('loopMaxMs').toFixed(1)} ms`,
);
console.log(
  `cache         peak ${peak('cacheEntries')} entries, ${peak('cacheMiB').toFixed(1)} MiB (limits: 1000 entries, 8 MiB)`,
);
console.log(
  `connections   peak ${peak('connections')}; in flight at end ${health.inFlight}; circuit ${health.upstreams.bench.state}`,
);
if (samples[0].redisMiB !== undefined) {
  console.log(
    `redis         ${settled.redisMiB.toFixed(1)} MiB -> ${last.redisMiB.toFixed(1)} MiB, ` +
      `keys ${settled.redisKeys} -> ${last.redisKeys} (peak ${peak('redisKeys')})`,
  );
}

mkdirSync(join(projectRoot, 'bench', 'results'), { recursive: true });
const file = join(projectRoot, 'bench', 'results', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const meta = {
  minutes,
  connections,
  keys,
  redis: Boolean(redisUrl),
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
  cpu: os.cpus()[0].model.trim(),
};
writeFileSync(file, JSON.stringify({ meta, samples }, null, 1));
console.log(`\nwrote ${file}`);
process.exit(0);
