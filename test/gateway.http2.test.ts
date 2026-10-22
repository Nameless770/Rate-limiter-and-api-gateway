/**
 * HTTP/2 on the TLS listener (tls.http2): negotiated by ALPN, with HTTP/1.1 (and WebSocket upgrades) still served on
 * the same port, and the gateway's protections applying to every stream as to every HTTP/1.1 request.
 */
import { readFileSync } from 'node:fs';
import http2, { type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  capturingLogger,
  type FakeUpstream,
  fixture,
  httpsRequest,
  json,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
  startUpstream,
} from './helpers.js';
import { openWs, startWsUpstream } from './wsHelpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const ca = readFileSync(fixture('tls/localhost-cert.pem'));
const tls = { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem'), http2: true };

interface H2Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** A connection, once the server's SETTINGS have arrived (until then the client only knows the defaults). */
function connect(base: string, options: http2.SecureClientSessionOptions = {}): Promise<ClientHttp2Session> {
  return new Promise((resolve, reject) => {
    const session = http2.connect(base, { ca, ...options });
    session.once('remoteSettings', () => resolve(session));
    session.once('error', reject);
    cleanups.push(() => void session.destroy());
  });
}

function request(
  session: ClientHttp2Session,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: Buffer | string; endStream?: boolean } = {},
): Promise<H2Response> {
  return new Promise((resolve, reject) => {
    const stream = session.request(
      { ':path': path, ':method': options.method ?? 'GET', ...options.headers },
      { endStream: options.body === undefined && options.endStream !== false },
    );
    let headers: IncomingHttpHeaders = {};
    const chunks: Buffer[] = [];
    stream.on('response', (h) => {
      headers = h;
    });
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () =>
      resolve({ status: Number(headers[':status']), headers, body: Buffer.concat(chunks).toString() }),
    );
    stream.on('error', reject);
    if (options.body !== undefined) stream.end(options.body);
  });
}

async function setup(extra: Record<string, unknown> = {}, tlsExtra: Record<string, unknown> = {}) {
  const up = await startUpstream(async (req, res, hit) => {
    if (hit.url.startsWith('/slow')) await sleep(300);
    json(res, 200, { headers: hit.headers, body: hit.body, url: hit.url });
  });
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const g = await startGateway(
    {
      tls: { ...tls, ...tlsExtra },
      upstreams: { u: { url: up.url } },
      routes: [
        { id: 'api', path: '/api', upstream: 'u' },
        { id: 'cached', path: '/cached', upstream: 'u', cache: { ttlMs: 60_000, varyHeaders: [] } },
      ],
      ...extra,
    },
    { logger },
  );
  cleanups.push(g.close);
  return { up, g, lines, base: g.base.replace('http://', 'https://') };
}

const seenBy = (up: FakeUpstream, i = 0) => up.hits[i]?.headers ?? {};

describe('HTTP/2', () => {
  it('is negotiated by ALPN and proxied to an HTTP/1.1 upstream, with no HTTP/2 pseudo-headers passed on', async () => {
    const t = await setup();
    const session = await connect(t.base);
    expect(session.alpnProtocol).toBe('h2');
    const res = await request(session, '/api/users/7?x=1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).url).toBe('/users/7?x=1');
    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['connection']).toBeUndefined();
    const seen = seenBy(t.up);
    expect(Object.keys(seen).some((k) => k.startsWith(':'))).toBe(false);
    expect(seen['x-forwarded-proto']).toBe('https');
    expect(seen['host']).toBe(new URL(t.up.url).host);
    expect(t.lines.find((l) => l['msg'] === 'request')?.['protocol']).toBe('h2');
  });

  it('still serves HTTP/1.1 on the same port, to clients that do not offer HTTP/2', async () => {
    const t = await setup();
    const res = await httpsRequest(t.base, { path: '/api/x', ca });
    expect(res.status).toBe(200);
    expect(t.lines.find((l) => l['msg'] === 'request')?.['protocol']).toBe('http/1.1');
  });

  it('carries many requests at once on one connection, and counts the connection', async () => {
    const t = await setup();
    const session = await connect(t.base);
    const answers = await Promise.all(Array.from({ length: 10 }, (_, i) => request(session, `/api/slow/${i}`)));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(t.up.hits).toHaveLength(10);
    const metrics = (await rawRequest(t.g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).toMatch(/gateway_http2_connections 1/);
  });

  it("announces the configured stream limit, and applies a reload's new one to new connections", async () => {
    const t = await setup({ limits: { maxConcurrentStreams: 7 } });
    const first = await connect(t.base);
    expect(first.remoteSettings.maxConcurrentStreams).toBe(7);

    const config = t.g.gateway.config;
    expect(
      t.g.gateway.reload(parseConfig({ ...config, limits: { ...config.limits, maxConcurrentStreams: 3 } })),
    ).toMatchObject({ ok: true });
    const second = await connect(t.base);
    expect(second.remoteSettings.maxConcurrentStreams).toBe(3);
    expect(first.remoteSettings.maxConcurrentStreams).toBe(7); // an open connection keeps what it agreed
  });

  it('forwards request bodies, and refuses one over the limit without a connection header (and without waiting for it)', async () => {
    const t = await setup({ maxBodyBytes: 1_000 });
    const session = await connect(t.base);
    const posted = await request(session, '/api/echo', { method: 'POST', body: 'hello h2' });
    expect(JSON.parse(posted.body).body).toBe('hello h2');
    expect(seenBy(t.up)['content-length']).toBe('8');

    // HTTP/2 forbids connection headers; Node drops one it is given, with a warning. The gateway must not give one.
    const warnings: string[] = [];
    const onWarning = (w: Error) => warnings.push(`${w.name}: ${w.message}`);
    process.on('warning', onWarning);
    cleanups.push(() => void process.off('warning', onWarning));
    const big = await request(session, '/api/echo', {
      method: 'POST',
      headers: { 'content-length': '5000' },
      body: Buffer.alloc(5_000, 1),
    });
    expect(big.status).toBe(413);
    expect(big.headers['connection']).toBeUndefined();
    await sleep(20);
    expect(warnings.filter((w) => /connection header/i.test(w))).toEqual([]);
    // The connection is fine: the refusal ended one stream, not the session.
    expect((await request(session, '/api/after')).status).toBe(200);
  });

  it('caches and rate limits HTTP/2 requests like any others', async () => {
    const t = await setup({ rateLimit: { default: { algorithm: 'sliding-window', limit: 3, windowMs: 60_000 } } });
    const session = await connect(t.base);
    expect((await request(session, '/cached/a')).headers['x-cache']).toBe('MISS');
    expect((await request(session, '/cached/a')).headers['x-cache']).toBe('HIT');
    const third = await request(session, '/cached/a');
    expect(third.headers['ratelimit-remaining']).toBe('0');
    expect((await request(session, '/cached/a')).status).toBe(429);
  });

  it('keeps WebSocket upgrades working over HTTP/1.1 on an HTTP/2 listener', async () => {
    const ws = await startWsUpstream();
    cleanups.push(ws.close);
    const g = await startGateway({
      tls,
      upstreams: { chat: { url: ws.url } },
      routes: [{ path: '/chat', upstream: 'chat', stripPrefix: false, websocket: { allowAnyOrigin: true } }],
    });
    cleanups.push(g.close);
    const attempt = await openWs(g.base.replace('http://', 'https://'), { path: '/chat', tlsCa: ca });
    expect(attempt.status).toBe(101);
    attempt.ws?.send('over h1');
    expect(await attempt.ws?.nextText()).toBe('over h1');
    attempt.ws?.destroy();
  });

  it('authenticates a client certificate presented on an HTTP/2 connection', async () => {
    const t = await setup(
      { routes: [{ id: 'mtls', path: '/mtls', upstream: 'u', auth: { methods: ['client-cert'] } }] },
      { clientAuth: { caFile: fixture('tls/callers/ca-cert.pem') } },
    );
    const session = await connect(t.base, {
      cert: readFileSync(fixture('tls/callers/alice-cert.pem')),
      key: readFileSync(fixture('tls/callers/alice-key.pem')),
    });
    const res = await request(session, '/mtls/x');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).headers['x-authenticated-client']).toBe('alice');
    const anonymous = await connect(t.base);
    expect((await request(anonymous, '/mtls/x')).status).toBe(401);
  });

  it('cancels a stream whose request is not finished within the request timeout, and only that stream', async () => {
    const t = await setup({ limits: { requestTimeoutMs: 300 } });
    const session = await connect(t.base);
    const stuck = session.request({ ':path': '/api/upload', ':method': 'POST' }, { endStream: false });
    stuck.write('a start, and then nothing');
    const outcome = await new Promise<string>((resolve) => {
      stuck.on('close', () => resolve(`closed ${stuck.rstCode}`));
      stuck.on('error', () => {});
    });
    expect(outcome).toBe(`closed ${http2.constants.NGHTTP2_CANCEL}`);
    expect((await request(session, '/api/ok')).status).toBe(200);
    expect(t.up.hits.map((h) => h.url)).toEqual(['/ok']);
  });

  it('closes an idle connection politely after the keep-alive timeout', async () => {
    const t = await setup({ limits: { keepAliveTimeoutMs: 200 } });
    const session = await connect(t.base);
    await request(session, '/api/x');
    const goaway = new Promise<number>((resolve) => session.once('goaway', (code) => resolve(code)));
    expect(await goaway).toBe(http2.constants.NGHTTP2_NO_ERROR);
  });

  it('on shutdown, finishes the request in progress, sends GOAWAY, and takes no new ones', async () => {
    const t = await setup();
    const session = await connect(t.base);
    const inFlight = request(session, '/api/slow/1');
    await sleep(50);
    const goaway = new Promise<void>((resolve) => session.once('goaway', () => resolve()));
    const closing = t.g.close();
    await goaway;
    expect((await inFlight).status).toBe(200);
    await closing;
    await expect(request(session, '/api/late')).rejects.toThrow();
  });

  it('drops a stream whose client stops reading, and leaves the other streams on its connection alone', async () => {
    const big = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(4 * 1024 * 1024, 1));
    });
    cleanups.push(big.close);
    const g: RunningGateway = await startGateway({
      tls,
      limits: { responseStallTimeoutMs: 300 },
      upstreams: { big: { url: big.url }, u: { url: big.url } },
      routes: [{ path: '/big', upstream: 'big' }],
    });
    cleanups.push(g.close);
    const session = await connect(g.base.replace('http://', 'https://'));
    const stalled = session.request({ ':path': '/big/file' });
    stalled.pause(); // never read: flow control fills, and the gateway's writes stop draining
    stalled.on('error', () => {});
    const dropped = await new Promise<number>((resolve) => stalled.on('close', () => resolve(stalled.rstCode)));
    expect(dropped).toBe(http2.constants.NGHTTP2_CANCEL); // not NO_ERROR, which would read as a complete response
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).toMatch(/gateway_requests_shed_total\{reason="slow_reader"\} 1/);
    // A stream that does read, on the same connection, gets the whole response.
    const whole = await request(session, '/big/again');
    expect(whole.status).toBe(200);
    expect(whole.body.length).toBe(4 * 1024 * 1024);
  });

  it('resets the stream with an error when the upstream dies mid-body: a truncated body never looks complete', async () => {
    const dying = await startUpstream((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100000' });
      res.write('only the first part');
      setTimeout(() => res.socket?.destroy(), 50);
    });
    cleanups.push(dying.close);
    const g = await startGateway({
      tls,
      upstreams: { d: { url: dying.url, retry: { maxAttempts: 1 } } },
      routes: [{ path: '/d', upstream: 'd' }],
    });
    cleanups.push(g.close);
    const session = await connect(g.base.replace('http://', 'https://'));
    const stream = session.request({ ':path': '/d/x' });
    let ended = false;
    stream.on('data', () => {});
    stream.on('end', () => {
      ended = true;
    });
    stream.on('error', () => {});
    await new Promise((resolve) => stream.on('close', resolve));
    expect(ended).toBe(false);
    expect(stream.rstCode).toBe(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });

  it('needs a restart to turn HTTP/2 on or off', async () => {
    const t = await setup();
    const config = t.g.gateway.config;
    const off = parseConfig({ ...config, tls: { ...config.tls, http2: false } });
    expect(t.g.gateway.reload(off)).toMatchObject({ ok: true, restartRequired: ['tls.http2'] });
    expect(t.g.gateway.config.tls?.http2).toBe(true);
    const session = await connect(t.base);
    expect(session.alpnProtocol).toBe('h2');
  });
});
