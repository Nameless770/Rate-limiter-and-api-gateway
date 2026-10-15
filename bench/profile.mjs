// CPU-profile the gateway under load and print where the time goes.
//
//   npm run build && node bench/profile.mjs [--seconds 8] [--connections 64] [--redis redis://127.0.0.1:6379]
//
// The gateway runs inside this process (so a V8 profile can be taken without signals, which Windows lacks); the
// load generator runs in worker threads and the upstream in a child process.

import { writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { baseGatewayConfig, projectRoot, startBenchUpstream, stopAll } from './harness.mjs';
import { runLoad } from './loadgen.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
const seconds = Number(args.seconds ?? 8);
const connections = Number(args.connections ?? 64);

const { Gateway } = await import(pathToFileURL(join(projectRoot, 'dist', 'gateway.js')).href);
const { parseConfig } = await import(pathToFileURL(join(projectRoot, 'dist', 'config.js')).href);
const { silentLogger } = await import(pathToFileURL(join(projectRoot, 'dist', 'observability', 'logger.js')).href);

const upstream = await startBenchUpstream(19001);
const config = parseConfig(
  baseGatewayConfig({
    upstreamUrl: upstream.url,
    rateLimit: args.limit ? { default: { algorithm: 'sliding-window-counter', limit: 1e9, windowMs: 60000 } } : {},
  }),
);
const gateway = new Gateway(config, { logger: silentLogger });
const { port } = await gateway.listen(18080, '127.0.0.1');

const session = new inspector.Session();
session.connect();
const post = (m, p) => new Promise((res, rej) => session.post(m, p, (e, r) => (e ? rej(e) : res(r))));
await post('Profiler.enable');
await post('Profiler.setSamplingInterval', { interval: 200 });

await runLoad({ url: `http://127.0.0.1:${port}/x`, duration: 2, warmup: 1, connections, workers: 4 }); // warm JIT
await post('Profiler.start');
const result = await runLoad({
  url: `http://127.0.0.1:${port}/x`,
  duration: seconds,
  warmup: 0,
  connections,
  workers: 4,
  keys: args.keys ? Number(args.keys) : 0,
});
const { profile } = await post('Profiler.stop');
writeFileSync(join(projectRoot, 'bench', 'results', 'gateway.cpuprofile'), JSON.stringify(profile));

// Self time per function, from sample counts.
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const id = profile.samples[i];
  self.set(id, (self.get(id) ?? 0) + (dt[i] ?? 0));
}
const totalUs = [...self.values()].reduce((a, b) => a + b, 0);
const agg = new Map();
for (const [id, us] of self) {
  const n = byId.get(id);
  const f = n.callFrame;
  const where = f.url.replace(/^file:\/\/\/.*\/(dist|node_modules)\//, '$1/').replace(/^node:/, 'node:');
  const key = `${f.functionName || '(anonymous)'}  ${where}:${f.lineNumber + 1}`;
  agg.set(key, (agg.get(key) ?? 0) + us);
}
console.log(`\n${result.rps.toFixed(0)} req/s while profiled; ${(totalUs / 1e6).toFixed(2)}s of samples\n`);
console.log('self time   function');
for (const [k, us] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 35)) {
  console.log(`${((us / totalUs) * 100).toFixed(1).padStart(5)}%    ${k}`);
}
const bucket = (re) => ([...agg].filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0) / totalUs) * 100;
console.log('\nby area:');
for (const [label, re] of [
  ['idle / waiting', /\(idle\)|\(program\)/],
  ['garbage collection', /\(garbage collector\)/],
  [
    'node:http / net / streams (internals)',
    /node:(http|_http|net|stream|internal\/streams|internal\/http|internal\/stream)/,
  ],
  ['gateway source (dist/)', /dist\//],
  [
    'timers / events / async plumbing',
    /node:(timers|events|internal\/timers|internal\/process|internal\/async|async_hooks|internal\/abort)/,
  ],
  ['crypto', /node:crypto|node:internal\/crypto/],
])
  console.log(`  ${bucket(re).toFixed(1).padStart(5)}%  ${label}`);

await gateway.close(500);
stopAll();
process.exit(0);
