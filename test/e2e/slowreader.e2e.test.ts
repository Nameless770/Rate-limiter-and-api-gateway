/**
 * End to end: clients that misbehave on the way *out*. Request-side abuse (slow headers, slow bodies, oversized
 * input) was always bounded; this is the other direction. A client that asks for a big response and then stops
 * reading must not be able to hold an upstream connection, or the cache fetch other clients are waiting on, for as
 * long as it likes. Needs no Redis.
 */
import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { json, rawRequest, sleep, startUpstream } from '../helpers.js';
import { cleanupAll, metric, onCleanup, startGatewayProc, until } from './stack.js';

afterEach(cleanupAll);

const STALL_MS = Number(process.env['E2E_STALL_MS'] ?? 600);

/** An upstream with a 256 MiB body (written as fast as the reader allows) and a small endpoint. */
async function bigUpstream() {
  const up = await startUpstream(async (_req, res, hit) => {
    if (hit.url.startsWith('/big')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'max-age=60' });
      const chunk = Buffer.alloc(64 * 1024, 7);
      for (let i = 0; i < 4_096 && !res.destroyed; i++) {
        if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve).once('close', resolve));
      }
      res.end();
      return;
    }
    if (hit.url.startsWith('/huge')) {
      res.writeHead(200, { 'content-length': 32 * 1024 * 1024 });
      res.end(Buffer.alloc(32 * 1024 * 1024, 5));
      return;
    }
    if (hit.url.startsWith('/medium')) {
      res.writeHead(200, { 'content-length': 3 * 1024 * 1024 });
      res.end(Buffer.alloc(3 * 1024 * 1024, 9));
      return;
    }
    json(res, 200, { ok: true });
  });
  onCleanup(up.close);
  return up;
}

/** Fail with a message saying what was being waited for, rather than leave the test to time out silently. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for ${what}`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A connection that sends a request and then never reads a byte of the answer. */
function stalledClient(base: string, path = '/big'): net.Socket {
  const { hostname, port } = new URL(base);
  const socket = net.connect({ host: hostname, port: Number(port) }, () => {
    socket.write(`GET ${path} HTTP/1.1\r\nHost: x\r\n\r\n`);
  });
  socket.pause();
  socket.on('error', () => {});
  onCleanup(() => void socket.destroy());
  return socket;
}

describe('clients that stop reading their response', { timeout: 60_000 }, () => {
  it('cannot pin the upstream connections other clients need', async () => {
    const up = await bigUpstream();
    const gw = await startGatewayProc({
      limits: { responseStallTimeoutMs: STALL_MS },
      // Four connections to the upstream in all, so four stalled readers would take every one of them.
      upstreams: { u: { url: up.url, maxConnections: 4, timeoutMs: 1_500, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'u' }],
    });

    const stalled = Array.from({ length: 4 }, () => stalledClient(gw.base));
    await until(() => up.hits.length === 4, 5_000, 'the four big requests to reach the upstream');
    const closed = stalled.map((s) => new Promise<void>((resolve) => s.once('close', () => resolve())));

    // A well-behaved client arrives while all four are stuck. It must get through once the gateway reclaims them.
    const started = Date.now();
    const ok = await within(rawRequest(gw.base, { path: '/small' }), 12_000, 'the healthy request to be answered');
    expect(ok.status, `after ${Date.now() - started} ms`).toBe(200);

    // Every one of them is dropped, not just enough to let the healthy request through. (Only then start reading
    // again: a client that is reading is not stalled, and could not be dropped for it.)
    await until(
      async () => metric(await gw.metrics(), 'gateway_requests_shed_total', { reason: 'slow_reader' }) === 4,
      8_000,
      'all four stalled readers to be dropped',
    );
    // A client that is not reading cannot see the connection was closed on it; reading again shows it.
    for (const s of stalled) s.resume();
    try {
      await within(Promise.all(closed), 12_000, 'every stalled connection to be closed by the gateway');
    } catch (error) {
      const shed = metric(await gw.metrics(), 'gateway_requests_shed_total', { reason: 'slow_reader' });
      const states = stalled.map((s) => `destroyed=${s.destroyed} readableEnded=${s.readableEnded}`).join('; ');
      throw new Error(`${(error as Error).message} (gateway dropped ${shed} slow readers; sockets: ${states})`);
    }
    const text = await gw.metrics();
    expect(metric(text, 'gateway_requests_shed_total', { reason: 'slow_reader' })).toBe(4);
    expect(gw.proc.logs.filter((l) => l['msg'] === 'dropping a client that stopped reading its response')).toHaveLength(
      4,
    );
    expect(metric(text, 'gateway_requests_total', { status: '499' })).toBeGreaterThanOrEqual(4);
  });

  it('answers within its timeout when every upstream connection is busy, instead of queueing past it', async () => {
    // One connection to the upstream, and a response that keeps trickling for 3 s (so it never idles out).
    const up = await startUpstream(async (_req, res, hit) => {
      if (hit.url.startsWith('/hold')) {
        res.writeHead(200);
        for (let i = 0; i < 15 && !res.destroyed; i++) {
          res.write('.');
          await sleep(200);
        }
        res.end();
        return;
      }
      json(res, 200, { ok: true });
    });
    onCleanup(up.close);
    const gw = await startGatewayProc({
      upstreams: { u: { url: up.url, maxConnections: 1, timeoutMs: 500, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/', upstream: 'u' }],
    });

    const holding = rawRequest(gw.base, { path: '/hold' });
    await until(() => up.hits.length === 1, 5_000, 'the first request to take the only connection');

    const started = Date.now();
    const queued = await rawRequest(gw.base, { path: '/small' });
    const took = Date.now() - started;
    expect(queued.status).toBe(504); // not 200 after waiting out the other request
    expect(took).toBeLessThan(1_500); // the 500 ms attempt timeout, not the 3 s the connection stays busy
    expect(JSON.parse(queued.body).error.code).toBe('upstream_timeout');
    expect((await holding).status).toBe(200); // and the request that held the connection was not disturbed
  });

  it('also drops a client that stops reading a response served from the cache', async () => {
    const up = await bigUpstream();
    const gw = await startGatewayProc({
      limits: { responseStallTimeoutMs: STALL_MS },
      cache: { maxEntries: 10, maxBytes: 128 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024 },
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', cache: { ttlMs: 60_000 } }],
    });

    const primed = await rawRequest(gw.base, { path: '/huge' });
    expect(primed.headers['x-cache']).toBe('MISS');
    expect(primed.body.length).toBe(32 * 1024 * 1024);

    // From now on it is served from memory: nothing upstream is involved, but the connection is still held.
    const stalled = Array.from({ length: 3 }, () => stalledClient(gw.base, '/huge'));
    await until(
      async () => metric(await gw.metrics(), 'gateway_requests_shed_total', { reason: 'slow_reader' }) === 3,
      8_000,
      'the three stalled readers to be dropped',
    );
    expect(up.hits).toHaveLength(1); // they really were cache hits
    for (const s of stalled) s.resume();
    await Promise.all(stalled.map((s) => new Promise<void>((resolve) => s.once('close', () => resolve()))));
  });

  it('does not touch a slow client that keeps reading', async () => {
    const up = await bigUpstream();
    const gw = await startGatewayProc({
      // The client below takes data every 100 ms. Leave room for the machine running this test to be busy: a pause
      // of the *test's* own event loop is indistinguishable, to the gateway, from a client that has stopped.
      limits: { responseStallTimeoutMs: 3_000 },
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
    });

    // 3 MiB read in 64 KiB gulps, one every 100 ms: slow (about 12 s of reading is not needed; pace is what matters).
    const received = await new Promise<number>((resolve, reject) => {
      const req = http.get(`${gw.base}/medium`, { agent: false }, (res) => {
        let total = 0;
        res.pause();
        const gulp = (): void => {
          const chunk = res.read(64 * 1024) as Buffer | null;
          if (chunk) total += chunk.length;
          if (res.readableEnded || total >= 3 * 1024 * 1024) {
            resolve(total);
            return;
          }
          setTimeout(gulp, 100);
        };
        res.on('end', () => resolve(total));
        res.on('error', reject);
        gulp();
      });
      req.on('error', reject);
    });
    expect(received).toBe(3 * 1024 * 1024);
    expect(metric(await gw.metrics(), 'gateway_requests_shed_total', { reason: 'slow_reader' })).toBe(0);
  });

  it('does not let one stalled reader hold up everyone waiting on the same cached response', async () => {
    const up = await bigUpstream();
    const gw = await startGatewayProc({
      limits: { responseStallTimeoutMs: STALL_MS },
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', cache: { ttlMs: 60_000 } }],
    });

    // The first request for a key is the one that fetches it, streaming the body to its own client as it goes.
    // If that client stops reading the fetch cannot finish, and everyone else asking for the key waits on it.
    stalledClient(gw.base, '/big');
    await until(() => up.hits.length === 1, 5_000, 'the leader to reach the upstream');
    await sleep(150);

    const started = Date.now();
    const firstByte = await new Promise<number>((resolve, reject) => {
      const req = http.get(`${gw.base}/big`, { agent: false }, (res) => {
        res.once('data', () => {
          resolve(Date.now() - started);
          req.destroy(); // that is all we wanted; do not download 256 MiB
        });
      });
      req.on('error', () => {});
      setTimeout(
        () => reject(new Error('the follower was never served: it is stuck behind the stalled leader')),
        15_000,
      ).unref();
    });
    // Held for about the stall timeout (the leader is dropped, one waiter takes over), not for ever.
    // (No lower bound: the leader's stall clock started before this client arrived.)
    expect(firstByte).toBeLessThan(STALL_MS + 5_000);
    expect(metric(await gw.metrics(), 'gateway_requests_shed_total', { reason: 'slow_reader' })).toBeGreaterThanOrEqual(
      1,
    );
  });
});
