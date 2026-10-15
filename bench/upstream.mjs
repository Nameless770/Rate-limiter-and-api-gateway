// A deliberately boring upstream for benchmarks: constant-time responses, no logging, no per-request state.
//
//   PORT=19001 node bench/upstream.mjs
//
//   GET/POST  /anything          200 {"ok":true}            (POST bodies are drained and discarded)
//   GET       /anything?size=N   200 with an N-byte body
//   GET       /anything?fail=P   503 with probability P (0..1), else 200
//   GET       /anything?delay=MS 200 after MS milliseconds
//   GET       /__stats           this process's CPU seconds, RSS and request count
import http from 'node:http';

const port = Number(process.env.PORT ?? 19001);
const SMALL = Buffer.from('{"ok":true}');
let served = 0;

const server = http.createServer((req, res) => {
  if (req.url === '/__stats') {
    const cpu = process.cpuUsage();
    const body = JSON.stringify({ cpuSeconds: (cpu.user + cpu.system) / 1e6, rss: process.memoryUsage().rss, served });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }

  const respond = () => {
    served++;
    const q = req.url.indexOf('?');
    let body = SMALL;
    let status = 200;
    if (q !== -1) {
      const params = new URLSearchParams(req.url.slice(q + 1));
      const size = Number(params.get('size') ?? 0);
      if (size > 0) body = Buffer.alloc(size, 0x62);
      if (Math.random() < Number(params.get('fail') ?? 0)) status = 503;
    }
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length });
    res.end(body);
  };

  const q = req.url.indexOf('?');
  const delay = q === -1 ? 0 : Number(new URLSearchParams(req.url.slice(q + 1)).get('delay') ?? 0);
  const go = () => (delay > 0 ? setTimeout(respond, delay) : respond());
  if (req.method === 'GET' || req.method === 'HEAD') {
    req.resume();
    go();
  } else {
    req.on('end', go);
    req.resume();
  }
});
server.keepAliveTimeout = 65_000;
server.listen(port, '127.0.0.1', () => console.log(`bench upstream on :${port}`));
