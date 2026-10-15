/**
 * The paths that are easy to get subtly wrong in a proxy: HEAD, chunked uploads, an upstream dying mid-body,
 * HTTPS upstreams, clients leaving during a coalesced cache fetch, and shutting down with requests in flight.
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/observability/logger.js';
import {
  capturingLogger,
  type FakeUpstream,
  fixture,
  json,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
  startUpstream,
  type UpstreamHandler,
  type UpstreamOptions,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function upstream(handler: UpstreamHandler, options?: UpstreamOptions): Promise<FakeUpstream> {
  const u = await startUpstream(handler, options);
  cleanups.push(u.close);
  return u;
}

async function gateway(
  raw: Record<string, unknown>,
  deps?: Parameters<typeof startGateway>[1],
): Promise<RunningGateway> {
  const g = await startGateway(raw, deps);
  cleanups.push(g.close);
  return g;
}

const echo: UpstreamHandler = (_req, res, hit) =>
  json(res, 200, { method: hit.method, url: hit.url, body: hit.body, headers: hit.headers });

const errorCode = async (res: Response): Promise<string> =>
  ((await res.json()) as { error: { code: string } }).error.code;

describe('HEAD requests', () => {
  it('relay the upstream headers with no body, and never touch the cache', async () => {
    const up = await upstream((_r, res, hit) => json(res, 200, { method: hit.method, padding: 'x'.repeat(64) }));
    const g = await gateway({
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u', cache: { ttlMs: 30_000 } }],
    });

    const head = await fetch(`${g.base}/thing`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(Number(head.headers.get('content-length'))).toBeGreaterThan(64); // the GET body's length, as HEAD should
    expect(await head.text()).toBe('');
    expect(head.headers.get('x-cache')).toBeNull();

    // A HEAD must not leave an empty-bodied entry behind for the next GET.
    const get = await fetch(`${g.base}/thing`);
    expect(get.headers.get('x-cache')).toBe('MISS');
    expect(((await get.json()) as { method: string }).method).toBe('GET');
    expect(up.hits.map((h) => h.method)).toEqual(['HEAD', 'GET']);
  });

  it('are retried like any idempotent method', async () => {
    const up = await upstream((_r, res, _hit, n) => json(res, n === 1 ? 503 : 200, {}));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const res = await fetch(`${g.base}/thing`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(up.hits).toHaveLength(2);
  });
});

describe('chunked request bodies', () => {
  it('are buffered and forwarded with an exact Content-Length', async () => {
    const up = await upstream(echo);
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });

    const res = await rawRequest(g.base, {
      method: 'POST',
      path: '/upload',
      chunks: ['hello ', 'chunked ', 'world'],
      chunkDelayMs: 10,
    });

    expect(res.status).toBe(200);
    expect(up.hits[0]?.body).toBe('hello chunked world');
    expect(up.hits[0]?.headers['content-length']).toBe('19');
    expect(up.hits[0]?.headers['transfer-encoding']).toBeUndefined();
  });

  it('are replayed intact on retry', async () => {
    const up = await upstream((_r, res, _hit, n) => json(res, n === 1 ? 503 : 200, {}));
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const res = await rawRequest(g.base, {
      method: 'PUT',
      path: '/doc',
      chunks: ['part-1;', 'part-2'],
      chunkDelayMs: 5,
    });
    expect(res.status).toBe(200);
    expect(up.hits.map((h) => h.body)).toEqual(['part-1;part-2', 'part-1;part-2']);
  });

  it('get a 413, not a dropped connection, when they outgrow the limit without declaring a length', async () => {
    const up = await upstream(echo);
    const g = await gateway({
      maxBodyBytes: 16,
      upstreams: { u: { url: up.url } },
      routes: [{ path: '/', upstream: 'u' }],
    });

    const res = await rawRequest(g.base, {
      method: 'POST',
      path: '/upload',
      chunks: ['0123456789', '0123456789', '0123456789'],
      chunkDelayMs: 20,
    });

    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error.code).toBe('payload_too_large');
    expect(res.headers['connection']).toBe('close');
    expect(up.hits).toHaveLength(0);
  });

  it('leave the gateway healthy when a client abandons an upload halfway', async () => {
    const up = await upstream(echo);
    const { logger, lines } = capturingLogger();
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] }, { logger });
    const { hostname, port } = new URL(g.base);

    await new Promise<void>((resolve) => {
      const req = http.request({ hostname, port, path: '/upload', method: 'POST', agent: false });
      req.on('error', () => resolve());
      req.write('first half of a body that never finishes');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    await sleep(50);

    expect((await fetch(`${g.base}/ok`)).status).toBe(200);
    expect(up.hits.map((h) => h.url)).toEqual(['/ok']); // the half-sent request was never forwarded
    expect(lines.filter((l) => l['level'] === 'error')).toEqual([]);
  });
});

describe('an upstream dying mid-body', () => {
  it.each([
    ['with Content-Length', true],
    ['chunked', false],
  ])(
    '%s: the client sees a broken response rather than a short one, and nothing is cached',
    async (_name, withLength) => {
      const up = await upstream((_r, res) => {
        res.writeHead(200, { 'content-type': 'text/plain', ...(withLength ? { 'content-length': '100' } : {}) });
        res.write('partial-body');
        setTimeout(() => res.socket?.destroy(), 20);
      });
      const g = await gateway({
        upstreams: { u: { url: up.url, retry: { maxAttempts: 1 } } },
        routes: [{ path: '/', upstream: 'u', id: 'files', cache: { ttlMs: 30_000 } }],
      });

      const first = await rawRequest(g.base, { path: '/file' });
      expect(first.status).toBe(200); // the status line had already gone out...
      expect(first.complete).toBe(false); // ...but the body is visibly broken, not silently short
      expect('partial-body'.startsWith(first.body)).toBe(true);

      const second = await rawRequest(g.base, { path: '/file' });
      expect(second.headers['x-cache']).toBe('MISS'); // the truncated body was never stored
      expect(up.hits).toHaveLength(2);

      await sleep(20);
      const metrics = await (await fetch(`${g.adminBase}/_gateway/metrics`)).text();
      expect(metrics).toMatch(/gateway_requests_total\{route="files",status="502"\} 2/); // counted as gateway errors, not 200s
    },
  );
});

describe('HTTPS upstreams', () => {
  const tls = {
    key: readFileSync(fixture('tls/localhost-key.pem')),
    cert: readFileSync(fixture('tls/localhost-cert.pem')),
  };

  it('are proxied when their certificate chains to the configured CA', async () => {
    const up = await upstream(echo, { tls });
    const g = await gateway({
      upstreams: { secure: { url: up.url, tls: { caFile: fixture('tls/localhost-cert.pem') } } },
      routes: [{ path: '/', upstream: 'secure' }],
    });

    const res = await fetch(`${g.base}/hello?x=1`);
    const seen = (await res.json()) as { url: string; headers: Record<string, string> };

    expect(res.status).toBe(200);
    expect(seen.url).toBe('/hello?x=1');
    expect(seen.headers['host']).toBe(new URL(up.url).host);
  });

  it('are refused, without retries, when the certificate cannot be verified', async () => {
    const up = await upstream(echo, { tls });
    const g = await gateway({
      upstreams: { secure: { url: up.url, retry: { maxAttempts: 3 } } }, // no caFile: default trust store
      routes: [{ path: '/', upstream: 'secure' }],
    });

    const res = await fetch(`${g.base}/hello`);
    expect(res.status).toBe(502);
    expect(await errorCode(res)).toBe('bad_gateway');
    expect(up.hits).toHaveLength(0); // the handshake failed, so no request was ever sent

    const metrics = await (await fetch(`${g.adminBase}/_gateway/metrics`)).text();
    expect(metrics).toMatch(
      /gateway_upstream_attempts_total\{outcome="tls",target="127\.0\.0\.1:\d+",upstream="secure"\} 1\n/,
    ); // one try, not three
  });

  it('fail fast at startup when the CA file is missing', () => {
    const config = parseConfig({
      upstreams: { secure: { url: 'https://127.0.0.1:1', tls: { caFile: 'does-not-exist.pem' } } },
      routes: [{ path: '/', upstream: 'secure' }],
    });
    expect(() => new Gateway(config, { logger: silentLogger })).toThrow(/upstreams\.secure\.tls\.caFile/);
  });
});

describe('coalesced cache fetches when clients leave', () => {
  const cached = { path: '/', upstream: 'u', cache: { ttlMs: 30_000 } };

  it('hand off to a waiting request when the leading client disconnects before the response', async () => {
    const up = await upstream(async (_r, res, _hit, n) => {
      await sleep(150);
      json(res, 200, { n });
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cached] });

    const leader = new AbortController();
    const leading = fetch(`${g.base}/hot`, { signal: leader.signal }).catch(() => 'aborted');
    await sleep(30); // the leader's fetch is now in flight
    const waiters = Array.from({ length: 4 }, async () => {
      const r = await fetch(`${g.base}/hot`);
      return { status: r.status, body: (await r.json()) as { n: number } };
    });
    await sleep(30);
    leader.abort();

    expect(await leading).toBe('aborted');
    const results = await Promise.all(waiters);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body.n)).size).toBe(1); // all four were served one shared response
    expect(up.hits).toHaveLength(2); // the abandoned fetch plus a single hand-off, not one per waiter
  });

  it('hand off when the leading client disconnects mid-body', async () => {
    const up = await upstream(async (_r, res, _hit, n) => {
      const body = JSON.stringify({ n, filler: 'y'.repeat(200) });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.write(body.slice(0, 20));
      await sleep(150);
      res.end(body.slice(20));
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cached] });
    const { hostname, port } = new URL(g.base);

    // Leader: hang up as soon as the first bytes of the body arrive.
    const leaderGotBytes = new Promise<void>((resolve) => {
      const req = http.get({ hostname, port, path: '/big', agent: false }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => {});
    });
    await sleep(40);
    const waiters = Array.from(
      { length: 3 },
      async () => (await (await fetch(`${g.base}/big`)).json()) as { n: number; filler: string },
    );
    await leaderGotBytes;

    const bodies = await Promise.all(waiters);
    expect(bodies.every((b) => b.filler.length === 200)).toBe(true); // complete bodies, not the leader's partial one
    expect(new Set(bodies.map((b) => b.n)).size).toBe(1);
    expect(up.hits).toHaveLength(2);
  });

  it('keep serving everyone else when a waiting client disconnects', async () => {
    const up = await upstream(async (_r, res, _hit, n) => {
      await sleep(120);
      json(res, 200, { n });
    });
    const { logger, lines } = capturingLogger();
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [cached] }, { logger });

    const leading = fetch(`${g.base}/hot`).then((r) => r.status);
    await sleep(20);
    const quitter = new AbortController();
    const quitting = fetch(`${g.base}/hot`, { signal: quitter.signal }).catch(() => 'aborted');
    const staying = fetch(`${g.base}/hot`).then((r) => r.headers.get('x-cache'));
    await sleep(20);
    quitter.abort();

    expect(await leading).toBe(200);
    expect(await quitting).toBe('aborted');
    expect(await staying).toBe('HIT');
    expect(up.hits).toHaveLength(1);
    expect((await fetch(`${g.base}/hot`)).headers.get('x-cache')).toBe('HIT');
    expect(lines.filter((l) => l['level'] === 'error')).toEqual([]);
  });

  it("share the leader's upstream failure with every waiter instead of repeating it per waiter", async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(400);
      json(res, 200, {});
    });
    const g = await gateway({
      upstreams: { u: { url: up.url, timeoutMs: 100, retry: { maxAttempts: 1 } } },
      routes: [cached],
    });

    const statuses = await Promise.all(Array.from({ length: 5 }, async () => (await fetch(`${g.base}/slow`)).status));

    expect(statuses).toEqual([504, 504, 504, 504, 504]);
    expect(up.hits).toHaveLength(1);
  });
});

describe('graceful shutdown', () => {
  it('lets in-flight requests finish, refuses new connections, and closes as soon as it is idle', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(300);
      json(res, 200, { done: true });
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    // A client that wants to keep its connection open, as real clients and load balancers do.
    const keepAlive = new http.Agent({ keepAlive: true });
    cleanups.push(async () => keepAlive.destroy());

    const inflight = rawRequest(g.base, { path: '/slow', agent: keepAlive });
    await sleep(50);
    const started = Date.now();
    const closing = g.gateway.close(5_000);

    await expect(rawRequest(g.base, { path: '/late' })).rejects.toThrow(); // no longer accepting connections
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(res.complete).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ done: true });
    expect(res.headers['connection']).toBe('close'); // told not to reuse a connection to a dying process

    await closing;
    expect(Date.now() - started).toBeLessThan(2_000); // did not sit out the 5s grace period
  });

  it('closes a keep-alive connection right after a response that was already streaming when shutdown began', async () => {
    const up = await upstream(async (_r, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '10' });
      res.write('01234');
      await sleep(300);
      res.end('56789');
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    const keepAlive = new http.Agent({ keepAlive: true });
    cleanups.push(async () => keepAlive.destroy());

    const inflight = rawRequest(g.base, { path: '/stream', agent: keepAlive });
    await sleep(100); // headers (with keep-alive) have gone out; the body is still arriving
    const started = Date.now();
    const closing = g.gateway.close(5_000);

    const res = await inflight;
    expect(res.headers['connection']).toBe('keep-alive'); // too late to change the headers...
    expect(res.complete).toBe(true);
    expect(res.body).toBe('0123456789');
    await closing;
    expect(Date.now() - started).toBeLessThan(2_000); // ...so the now-idle connection is closed for it
  });

  it('cuts off requests that outlive the grace period', async () => {
    const up = await upstream(async (_r, res) => {
      await sleep(5_000);
      json(res, 200, {});
    });
    const g = await gateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });

    const inflight = rawRequest(g.base, { path: '/stuck' }).catch((error: Error) => error);
    await sleep(50);
    const started = Date.now();
    await g.gateway.close(200);

    expect(Date.now() - started).toBeLessThan(1_500);
    expect(await inflight).toBeInstanceOf(Error); // the connection was cut, not left hanging
  });
});
