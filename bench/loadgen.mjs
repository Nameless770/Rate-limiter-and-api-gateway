// A small closed-loop HTTP load generator, multi-threaded with worker_threads so the generator is not the
// bottleneck when measuring a single-threaded proxy. No dependencies.
//
//   node bench/loadgen.mjs --url http://127.0.0.1:8080/echo --duration 10 --connections 64 --workers 4
//
//   --url           target (required)
//   --duration      seconds measured after warmup (default 10)
//   --warmup        seconds of load that are not recorded (default 2)
//   --connections   total concurrent connections across workers (default 64)
//   --workers       threads (default 4)
//   --keys          rotate X-API-Key through this many distinct values; 0 = no key (default 0)
//   --variants      append ?id=<0..N-1> to each request, to spread load across that many cache keys (default 0)
//   --method        HTTP method (default GET)
//   --body-bytes    send a body of this size (default 0)
//   --header        "Name: value", repeatable
//   --json          print machine-readable JSON instead of a table
//
// Closed loop: each connection sends its next request when the previous response completes, so the offered
// load adapts to what the target can sustain, and latency percentiles describe a saturated system. They are
// service times under that load, not what an open-loop client population would see at a lower arrival rate.

import http from 'node:http';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

const SUB_BUCKETS = 32; // histogram resolution: about 2% per bucket
const MAX_OCTAVES = 28; // up to ~268 s in microseconds

function bucketOf(micros) {
  if (micros < 1) return 0;
  const idx = Math.floor(Math.log2(micros) * SUB_BUCKETS);
  return Math.min(idx, SUB_BUCKETS * MAX_OCTAVES - 1);
}
function bucketMidpoint(bucket) {
  return 2 ** ((bucket + 0.5) / SUB_BUCKETS); // microseconds, bucket midpoint
}

// ---------------------------------------------------------------------------------------------------------------
// Worker: one thread driving `connections` closed-loop connections.
// ---------------------------------------------------------------------------------------------------------------
async function runWorker(opts) {
  const url = new URL(opts.url);
  const agent = new http.Agent({ keepAlive: true, maxSockets: opts.connections, maxFreeSockets: opts.connections });
  const hist = new Uint32Array(SUB_BUCKETS * MAX_OCTAVES);
  const statuses = {};
  const errors = {};
  let requests = 0;
  let bytes = 0;
  const headers = { ...opts.headers };
  const body = opts.bodyBytes > 0 ? Buffer.alloc(opts.bodyBytes, 0x61) : undefined;
  if (body) headers['content-length'] = String(body.length);

  const startAt = Date.now();
  const measureFrom = startAt + opts.warmupMs;
  const endAt = measureFrom + opts.durationMs;

  function once() {
    return new Promise((resolve) => {
      const t0 = process.hrtime.bigint();
      const h = headers;
      if (opts.keys > 0) h['x-api-key'] = `bench-key-${Math.floor(Math.random() * opts.keys)}`;
      let path = url.pathname + url.search;
      if (opts.variants > 0) {
        path += `${url.search ? '&' : '?'}id=${Math.floor(Math.random() * opts.variants)}`;
      }
      const req = http.request(
        {
          agent,
          hostname: url.hostname,
          port: url.port,
          path,
          method: opts.method,
          headers: h,
        },
        (res) => {
          let n = 0;
          res.on('data', (c) => {
            n += c.length;
          });
          res.on('end', () => {
            const t1 = process.hrtime.bigint();
            if (Date.now() >= measureFrom) {
              hist[bucketOf(Number(t1 - t0) / 1000)]++;
              requests++;
              bytes += n;
              statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
            }
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', (e) => {
        if (Date.now() >= measureFrom) {
          const k = e.code ?? e.message;
          errors[k] = (errors[k] ?? 0) + 1;
        }
        resolve();
      });
      req.end(body);
    });
  }

  async function connection() {
    while (Date.now() < endAt) await once();
  }
  await Promise.all(Array.from({ length: opts.connections }, connection));
  agent.destroy();
  parentPort.postMessage({ hist: Array.from(hist), statuses, errors, requests, bytes });
}

// ---------------------------------------------------------------------------------------------------------------
// Main: spawn workers, merge, report.
// ---------------------------------------------------------------------------------------------------------------
export async function runLoad(options) {
  const o = {
    duration: 10,
    warmup: 2,
    connections: 64,
    workers: 4,
    keys: 0,
    variants: 0,
    method: 'GET',
    bodyBytes: 0,
    headers: {},
    ...options,
  };
  const workers = Math.max(1, Math.min(o.workers, o.connections));
  const perWorker = Array.from(
    { length: workers },
    (_, i) => Math.floor(o.connections / workers) + (i < o.connections % workers ? 1 : 0),
  );

  const started = Date.now();
  const results = await Promise.all(
    perWorker.map(
      (connections) =>
        new Promise((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {
            workerData: {
              url: o.url,
              connections,
              durationMs: o.duration * 1000,
              warmupMs: o.warmup * 1000,
              keys: o.keys,
              variants: o.variants,
              method: o.method,
              bodyBytes: o.bodyBytes,
              headers: o.headers,
            },
          });
          w.once('message', resolve);
          w.once('error', reject);
        }),
    ),
  );
  const wallSeconds = (Date.now() - started) / 1000;

  const hist = new Array(SUB_BUCKETS * MAX_OCTAVES).fill(0);
  const statuses = {};
  const errors = {};
  let requests = 0;
  let bytes = 0;
  for (const r of results) {
    r.hist.forEach((c, i) => {
      hist[i] += c;
    });
    for (const [k, v] of Object.entries(r.statuses)) statuses[k] = (statuses[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
    requests += r.requests;
    bytes += r.bytes;
  }

  const total = hist.reduce((a, b) => a + b, 0);
  const percentile = (p) => {
    if (total === 0) return 0;
    const target = Math.ceil((p / 100) * total);
    let seen = 0;
    for (let i = 0; i < hist.length; i++) {
      seen += hist[i];
      if (seen >= target) return bucketMidpoint(i) / 1000; // ms
    }
    return bucketMidpoint(hist.length - 1) / 1000;
  };
  const maxBucket = hist.reduce((m, c, i) => (c > 0 ? i : m), 0);

  return {
    url: o.url,
    connections: o.connections,
    seconds: o.duration,
    wallSeconds,
    requests,
    rps: requests / o.duration,
    mbps: bytes / o.duration / 1e6,
    statuses,
    errors,
    latencyMs: {
      p50: percentile(50),
      p90: percentile(90),
      p99: percentile(99),
      p999: percentile(99.9),
      max: total ? bucketMidpoint(maxBucket) / 1000 : 0,
    },
  };
}

function parseArgs(argv) {
  const out = { headers: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const name = a.slice(2);
    if (name === 'json') {
      out.json = true;
      continue;
    }
    const value = argv[++i];
    if (name === 'header') {
      const idx = value.indexOf(':');
      out.headers[value.slice(0, idx).trim().toLowerCase()] = value.slice(idx + 1).trim();
    } else if (name === 'bodyBytes' || name === 'body-bytes') out.bodyBytes = Number(value);
    else if (['duration', 'warmup', 'connections', 'workers', 'keys', 'variants'].includes(name))
      out[name] = Number(value);
    else out[name] = value;
  }
  return out;
}

if (!isMainThread) {
  await runWorker(workerData);
} else if (import.meta.url === new URL(process.argv[1], 'file://').href || process.argv[1]?.endsWith('loadgen.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('usage: node bench/loadgen.mjs --url http://127.0.0.1:8080/ [--duration 10] [--connections 64] ...');
    process.exit(2);
  }
  const r = await runLoad(args);
  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    const l = r.latencyMs;
    console.log(`${r.url}  ${r.connections} connections, ${r.seconds}s`);
    console.log(`  ${r.rps.toFixed(0)} req/s   ${r.mbps.toFixed(2)} MB/s   ${r.requests} requests`);
    console.log(
      `  latency ms  p50 ${l.p50.toFixed(2)}  p90 ${l.p90.toFixed(2)}  p99 ${l.p99.toFixed(2)}  p99.9 ${l.p999.toFixed(2)}  max ${l.max.toFixed(2)}`,
    );
    console.log(
      `  status  ${JSON.stringify(r.statuses)}${Object.keys(r.errors).length ? `  errors ${JSON.stringify(r.errors)}` : ''}`,
    );
  }
}
