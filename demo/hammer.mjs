// Fire a burst of requests at the gateway and summarise what came back.
//
//   node demo/hammer.mjs [url] [--n 100] [--concurrency 10] [--key alice]
//
// Example: node demo/hammer.mjs http://localhost:8080/echo --n 50 --key alice
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) ?? 'http://localhost:8080/echo';
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const total = Number(flag('n', 100));
const concurrency = Number(flag('concurrency', 10));
const key = flag('key', undefined);

const status = new Map();
const cache = new Map();
let sent = 0;
const started = performance.now();

async function worker() {
  while (sent < total) {
    sent++;
    try {
      const res = await fetch(url, { headers: key ? { 'x-api-key': key } : {} });
      await res.arrayBuffer();
      status.set(res.status, (status.get(res.status) ?? 0) + 1);
      const c = res.headers.get('x-cache');
      if (c) cache.set(c, (cache.get(c) ?? 0) + 1);
    } catch {
      status.set('network error', (status.get('network error') ?? 0) + 1);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const elapsed = (performance.now() - started) / 1000;
console.log(`${total} requests to ${url} in ${elapsed.toFixed(2)}s (${(total / elapsed).toFixed(0)} req/s)`);
for (const [code, count] of [...status].sort()) console.log(`  ${String(code).padEnd(14)} ${count}`);
if (cache.size) console.log(`  cache: ${[...cache].map(([k, v]) => `${k}=${v}`).join('  ')}`);
