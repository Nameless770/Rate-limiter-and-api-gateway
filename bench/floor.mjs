// The floor: a bare-bones Node proxy (http.request + pipe, no parsing of its own, no policy) measured with the same
// load generator and upstream as bench/run.mjs. It answers "how fast can *any* single-threaded Node proxy go on
// this machine", which is what the gateway's numbers should be read against.
//
//   node bench/floor.mjs [--duration 8] [--connections 64] [--repeat 3]
import http from 'node:http';
import { startBenchUpstream, stopAll } from './harness.mjs';
import { runLoad } from './loadgen.mjs';

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[++i];
}
const duration = Number(args.duration ?? 8);
const connections = Number(args.connections ?? 64);
const repeat = Number(args.repeat ?? 3);

await startBenchUpstream(19001); // stopped by stopAll()
const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 256 });
const proxy = http.createServer((req, res) => {
  const out = http.request(
    { host: '127.0.0.1', port: 19001, path: req.url, method: req.method, headers: req.headers, agent },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  out.on('error', () => res.destroy());
  req.pipe(out);
});
await new Promise((resolve) => proxy.listen(18081, '127.0.0.1', resolve));

const cpuStart = process.cpuUsage();
const t0 = Date.now();
const runs = [];
for (let i = 0; i < repeat; i++) {
  runs.push(await runLoad({ url: 'http://127.0.0.1:18081/x', duration, warmup: 3, connections, workers: 4 }));
}
const wall = (Date.now() - t0) / 1000;
const cpu = process.cpuUsage(cpuStart);
const sorted = [...runs].sort((a, b) => a.rps - b.rps);
const mid = sorted[Math.floor(sorted.length / 2)];
console.log(
  `bare proxy, ${connections} connections: ${Math.round(mid.rps).toLocaleString('en-US')} req/s ` +
    `(${Math.round(sorted[0].rps).toLocaleString('en-US')}-${Math.round(sorted[sorted.length - 1].rps).toLocaleString('en-US')}), ` +
    `p50 ${mid.latencyMs.p50.toFixed(2)} ms, p99 ${mid.latencyMs.p99.toFixed(2)} ms, ` +
    `proxy-process CPU ${((cpu.user + cpu.system) / 1e3 / wall / 10).toFixed(0)}% (includes the load-generator threads)`,
);
stopAll();
proxy.close();
process.exit(0);
