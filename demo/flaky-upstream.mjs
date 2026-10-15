// A tiny upstream service for trying the gateway by hand. Plain JS so the container image can run it
// without a TypeScript toolchain.
//
//   GET /time                 current time + a call counter (watch the cache serve the same value)
//   GET /echo                 echoes the request back
//   GET /slow?ms=1500         responds after a delay (try it past the gateway's timeout)
//   GET /flaky                fails with 503 at the configured failure rate
//   GET /_demo/failure?rate=1 make every request (except /_demo/*) fail with a 500; rate=0 heals it
//   GET /_demo/latency?ms=300 add fixed latency to every request
//   GET /health               liveness probe (no side effects)
import http from 'node:http';

const port = Number(process.env.PORT ?? 9001);
let counter = 0;
let failureRate = 0;
let latencyMs = 0;

const send = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://upstream');

  if (url.pathname === '/health') return send(res, 200, { ok: true }); // liveness probe; touches no demo state
  if (url.pathname === '/_demo/failure') {
    failureRate = Math.min(1, Math.max(0, Number(url.searchParams.get('rate') ?? 0)));
    return send(res, 200, { failureRate });
  }
  if (url.pathname === '/_demo/latency') {
    latencyMs = Math.max(0, Number(url.searchParams.get('ms') ?? 0));
    return send(res, 200, { latencyMs });
  }

  const n = ++counter;
  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

  if (failureRate > 0 && Math.random() < failureRate) {
    return send(res, 500, { error: 'simulated failure', call: n });
  }

  switch (url.pathname) {
    case '/time':
      return send(res, 200, { now: new Date().toISOString(), call: n });
    case '/slow': {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') ?? 1000)));
      return send(res, 200, { slow: true, call: n });
    }
    case '/flaky':
      return Math.random() < 0.5 ? send(res, 503, { error: 'flaky', call: n }) : send(res, 200, { ok: true, call: n });
    default:
      return send(res, 200, { call: n, method: req.method, path: url.pathname, query: url.search, headers: req.headers });
  }
});

server.listen(port, () => console.log(`demo upstream listening on :${port}`));
