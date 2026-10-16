import { readFileSync } from 'node:fs';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { acceptKey } from '../src/proxy/websocket.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import { securityNotes } from '../src/security.js';
import {
  capturingLogger,
  closedPort,
  fixture,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
} from './helpers.js';
import { signJwt, testKeys } from './jwtHelpers.js';
import {
  encodeFrame,
  handshakeBytes,
  OP,
  openWs,
  startWsUpstream,
  type WsOpenOptions,
  type WsSession,
  type WsUpstream,
  type WsUpstreamOptions,
} from './wsHelpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const APP = 'https://app.example.com';
const sw = (limit: number) => ({ algorithm: 'sliding-window', limit, windowMs: 60_000 });

interface Setup {
  up: WsUpstream;
  g: RunningGateway;
  lines: Array<Record<string, unknown>>;
  /** Open a websocket through the gateway and insist that it was accepted. */
  connect: (options?: WsOpenOptions) => Promise<WsSession>;
  open: (options?: WsOpenOptions) => ReturnType<typeof openWs>;
  metrics: () => Promise<string>;
}

async function setup(
  options: {
    up?: WsUpstreamOptions;
    ws?: Record<string, unknown>;
    route?: Record<string, unknown>;
    gateway?: Record<string, unknown>;
    upstream?: Record<string, unknown>;
    /** Target URLs; `dead` is one nothing is listening on (picked after the upstream is up, so it cannot be reused). */
    urls?: (up: WsUpstream, dead: string) => string[];
  } = {},
): Promise<Setup> {
  const up = await startWsUpstream(options.up);
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const dead = options.urls ? `http://127.0.0.1:${await closedPort()}` : '';
  const g = await startGateway(
    {
      upstreams: {
        u: options.urls ? { urls: options.urls(up, dead), ...options.upstream } : { url: up.url, ...options.upstream },
      },
      routes: [
        {
          id: 'ws',
          path: '/ws',
          upstream: 'u',
          stripPrefix: false,
          websocket: { allowedOrigins: [APP], ...options.ws },
          ...options.route,
        },
        { id: 'plain', path: '/plain', upstream: 'u', stripPrefix: false },
      ],
      ...options.gateway,
    },
    { logger },
  );
  cleanups.push(g.close);
  const tlsCa = options.gateway?.['tls'] ? readFileSync(fixture('tls/localhost-cert.pem')) : undefined;
  const base = tlsCa ? g.base.replace('http://', 'https://') : g.base;
  const open = (o: WsOpenOptions = {}) => openWs(base, { tlsCa, ...o });
  return {
    up,
    g,
    lines,
    open,
    connect: async (o = {}) => {
      const attempt = await open(o);
      expect(attempt.status, attempt.body).toBe(101);
      const ws = attempt.ws as WsSession;
      cleanups.push(() => ws.destroy());
      return ws;
    },
    metrics: async () => (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body,
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(15);
  }
}

/** The value of one metric sample, or undefined if it does not exist. */
function sample(text: string, name: string, labels: Record<string, string> = {}): number | undefined {
  const wanted = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split('\n')) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    if (wanted.every((w) => line.includes(w))) return Number(line.slice(line.lastIndexOf(' ') + 1));
  }
  return undefined;
}

const open = (s: Setup) => async () => sample(await s.metrics(), 'gateway_websocket_connections', { route: 'ws' }) ?? 0;

describe('websocket route config', () => {
  const route = (extra: Record<string, unknown>) =>
    parseConfig({
      upstreams: { u: { url: 'http://localhost:9000' } },
      routes: [{ path: '/ws', upstream: 'u', ...extra }],
    }).routes[0];
  const problem = (extra: Record<string, unknown>): string => {
    try {
      route(extra);
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      return (error as Error).message;
    }
    return expect.unreachable('config was accepted');
  };

  it('is off unless a route asks for it, and then has conservative defaults', () => {
    expect(route({})?.websocket).toBeUndefined();
    expect(route({ websocket: {} })?.websocket).toEqual({
      allowedOrigins: [],
      allowAnyOrigin: false,
      idleTimeoutMs: 60_000,
      maxDurationMs: undefined,
      maxConnections: 1_000,
    });
  });

  it('normalizes origins and refuses anything that is not scheme://host[:port]', () => {
    expect(
      route({ websocket: { allowedOrigins: ['HTTPS://App.Example.com:8443'] } })?.websocket?.allowedOrigins,
    ).toEqual(['https://app.example.com:8443']);
    for (const bad of ['app.example.com', 'https://app.example.com/', 'https://app.example.com/path', '*', 'ftp://x']) {
      expect(problem({ websocket: { allowedOrigins: [bad] } }), bad).toMatch(/origin/);
    }
  });

  it('refuses combinations that cannot work or do not mean what they say', () => {
    expect(problem({ websocket: {}, cache: { ttlMs: 1000 } })).toMatch(/cannot also be cached/);
    expect(problem({ websocket: {}, methods: ['POST'] })).toMatch(/must allow GET/);
    expect(problem({ websocket: { allowAnyOrigin: true, allowedOrigins: [APP] } })).toMatch(/meaningless/);
    expect(problem({ websocket: { idleTimeoutMs: 0 } })).toBeTruthy();
    expect(problem({ websocket: { surprise: true } })).toBeTruthy();
  });

  it('warns about the configurations that leave a socket open to the wrong people', () => {
    const notes = (websocket: Record<string, unknown>, auth?: Record<string, unknown>) =>
      securityNotes(
        parseConfig({
          upstreams: { u: { url: 'http://localhost:9000' } },
          routes: [{ id: 'chat', path: '/chat', upstream: 'u', websocket, ...(auth ? { auth } : {}) }],
          rateLimit: { apiKeys: [{ name: 'a', sha256: keyDigest('k') }] },
        }),
      ).filter((n) => n.includes('websocket route "chat"'));

    expect(notes({ allowAnyOrigin: true }, { methods: ['api-key'] }).join()).toMatch(/accepts any Origin/);
    expect(notes({}, { methods: ['api-key'] }).join()).toMatch(/no allowedOrigins/);
    expect(notes({ allowedOrigins: [APP] }).join()).toMatch(/no auth/);
    expect(notes({ allowedOrigins: [APP] }, { methods: ['api-key'] })).toEqual([]);
  });
});

describe('websocket proxying', () => {
  it('completes the handshake and relays text, binary and large messages unchanged and in order', async () => {
    const t = await setup();
    const attempt = await t.open();
    expect(attempt.status, attempt.body).toBe(101);
    const ws = attempt.ws as WsSession;
    cleanups.push(() => ws.destroy());

    expect(attempt.headers['sec-websocket-accept']).toBe(acceptKey(attempt.key));
    expect(attempt.headers['upgrade']?.toLowerCase()).toBe('websocket');
    expect(attempt.headers['connection']?.toLowerCase()).toBe('upgrade');
    expect(attempt.headers['x-request-id']).toBeTruthy();

    ws.send('hello');
    expect(await ws.nextText()).toBe('hello');

    const binary = Buffer.from(Array.from({ length: 60_000 }, (_, i) => (i * 7) % 256));
    ws.sendBinary(binary);
    const echoed = await ws.next();
    expect(echoed.opcode).toBe(OP.binary);
    expect(echoed.payload.equals(binary)).toBe(true);

    for (let i = 0; i < 200; i++) ws.send(`message ${i}`);
    for (let i = 0; i < 200; i++) expect(await ws.nextText()).toBe(`message ${i}`);

    ws.ping('are you there');
    const pong = await ws.next();
    expect(pong.opcode).toBe(OP.pong);
    expect(pong.payload.toString()).toBe('are you there');
  });

  it('relays frames the upstream sends unprompted, including ones that arrive with its 101', async () => {
    const t = await setup({ up: { greeting: 'welcome' } });
    const ws = await t.connect();
    expect(await ws.nextText()).toBe('welcome');
    t.up.broadcast('server push');
    expect(await ws.nextText()).toBe('server push');
  });

  it('forwards bytes the client sent right behind its handshake', async () => {
    const t = await setup();
    const ws = await t.connect({ trailing: encodeFrame(OP.text, Buffer.from('early bird'), true) });
    expect(await ws.nextText()).toBe('early bird');
  });

  it('sends the upstream a handshake it can trust: its own host, verified forwarding headers, no forged identity', async () => {
    const t = await setup({ up: { protocol: (offered) => offered[0] } });
    const attempt = await t.open({
      path: '/ws/room/7?token=abc',
      headers: {
        Origin: APP,
        Cookie: 'sid=abc',
        'Sec-WebSocket-Protocol': 'chat, superchat',
        'X-Forwarded-For': '6.6.6.6',
        'X-Forwarded-Proto': 'https',
        'X-Authenticated-Client': 'root',
        'X-Original-URL': '/admin',
        Forwarded: 'for=6.6.6.6',
      },
    });
    expect(attempt.status).toBe(101);
    cleanups.push(() => attempt.ws?.destroy());

    const hit = t.up.hits[0];
    expect(hit?.upgrade).toBe(true);
    expect(hit?.url).toBe('/ws/room/7?token=abc');
    expect(hit?.headers['host']).toBe(`127.0.0.1:${t.up.port}`);
    expect(hit?.headers['sec-websocket-key']).toBe(attempt.key);
    expect(hit?.headers['sec-websocket-version']).toBe('13');
    expect(hit?.headers['origin']).toBe(APP);
    expect(hit?.headers['cookie']).toBe('sid=abc');
    expect(hit?.headers['sec-websocket-protocol']).toBe('chat, superchat');
    expect(hit?.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(hit?.headers['x-forwarded-proto']).toBe('http');
    expect(hit?.headers['x-request-id']).toBe(attempt.headers['x-request-id']);
    for (const forged of ['x-authenticated-client', 'x-original-url', 'forwarded']) {
      expect(hit?.headers[forged], forged).toBeUndefined();
    }
    expect(attempt.headers['sec-websocket-protocol']).toBe('chat');
  });

  it('still sends the upstream the handshake headers when the client names them in Connection', async () => {
    const t = await setup();
    const attempt = await t.open({ headers: { Connection: 'Upgrade, Sec-WebSocket-Key, Sec-WebSocket-Version' } });
    expect(attempt.status).toBe(101);
    cleanups.push(() => attempt.ws?.destroy());
    expect(t.up.hits[0]?.headers['sec-websocket-key']).toBe(attempt.key);
    expect(t.up.hits[0]?.headers['sec-websocket-version']).toBe('13');
  });

  it('passes a negotiated extension through untouched', async () => {
    const t = await setup({ up: { extensions: 'permessage-deflate' } });
    const attempt = await t.open({
      headers: { 'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits' },
    });
    expect(attempt.status).toBe(101);
    expect(attempt.headers['sec-websocket-extensions']).toBe('permessage-deflate');
    attempt.ws?.destroy();
  });

  it('serves a plain GET to a websocket route as an ordinary request', async () => {
    const t = await setup();
    const res = await rawRequest(t.g.base, { path: '/ws' });
    expect(res.status).toBe(426); // the upstream's own answer, relayed
    expect(t.up.hits[0]?.upgrade).toBe(false);
  });
});

describe('what the gateway refuses to upgrade', () => {
  it('answers 404 for a route that did not opt in, an unknown path and the gateway namespace, without touching the upstream', async () => {
    const t = await setup();
    for (const path of ['/plain', '/plain/x', '/nowhere', '/_gateway/metrics']) {
      const res = await t.open({ path });
      expect(res.status, path).toBe(404);
      expect(JSON.parse(res.body).error.code).toBe('route_not_found');
    }
    expect(t.up.hits).toEqual([]);
  });

  it('refuses every protocol upgrade that is not websocket, so a client cannot tunnel past the gateway (h2c smuggling)', async () => {
    const t = await setup();
    const h2c = {
      Upgrade: 'h2c',
      Connection: 'Upgrade, HTTP2-Settings',
      'HTTP2-Settings': 'AAMAAABkAAQCAAAAAAIAAAAA',
      'Sec-WebSocket-Key': null,
      'Sec-WebSocket-Version': null,
    };
    for (const path of ['/ws', '/plain']) {
      const res = await t.open({ path, headers: h2c });
      expect([400, 404], path).toContain(res.status);
    }
    expect((await t.open({ headers: { Upgrade: 'websocket, h2c' } })).status).toBe(400);
    expect((await t.open({ headers: { Upgrade: 'TLS/1.2' } })).status).toBe(400);
    expect(t.up.hits).toEqual([]);
  });

  it.each([
    ['an unsupported version', { 'Sec-WebSocket-Version': '8' }, 426],
    ['a missing key', { 'Sec-WebSocket-Key': null }, 400],
    ['a key of the wrong length', { 'Sec-WebSocket-Key': 'dGVzdA==' }, 400],
    ['a key that is not base64', { 'Sec-WebSocket-Key': '!!!!!!!!!!!!!!!!!!!!!!==' }, 400],
    ['a body', { 'Content-Length': '5' }, 400],
    ['a malformed subprotocol list', { 'Sec-WebSocket-Protocol': 'chat,,\u007f' }, 400],
  ] as const)('refuses a handshake with %s before the upstream sees it', async (_name, headers, status) => {
    const t = await setup();
    const res = await t.open({ headers, trailing: Buffer.from('hello') });
    expect(res.status).toBe(status);
    if (status === 426) expect(res.headers['sec-websocket-version']).toBe('13');
    expect(t.up.hits).toEqual([]);
  });

  it('refuses a handshake that is not a GET', async () => {
    const t = await setup();
    const res = await t.open({ method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers['allow']).toBe('GET');
    expect(t.up.hits).toEqual([]);
  });

  it('sends the same generic error body as every other refusal, with the request id', async () => {
    const t = await setup();
    const res = await t.open({ path: '/nowhere' });
    const body = JSON.parse(res.body) as { error: { code: string; requestId: string } };
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['connection']).toBe('close');
  });
});

describe('cross-site websocket hijacking', () => {
  it('accepts the listed origin, in any letter case, and refuses every other', async () => {
    const t = await setup();
    expect((await t.connect({ headers: { Origin: APP } })).closed).toBe(false);
    expect((await t.connect({ headers: { Origin: 'HTTPS://APP.EXAMPLE.COM' } })).closed).toBe(false);

    for (const origin of [
      'https://evil.example',
      'http://app.example.com',
      'https://app.example.com:444',
      'https://app.example.com.evil.example',
      'https://evil.example/https://app.example.com',
      'null',
      '',
    ]) {
      const res = await t.open({ headers: { Origin: origin } });
      expect(res.status, origin).toBe(403);
      expect(JSON.parse(res.body).error.code).toBe('origin_not_allowed');
    }
    expect(t.up.hits).toHaveLength(2);
  });

  it('refuses a request that names two origins, one of them allowed', async () => {
    const t = await setup();
    const { request } = handshakeBytes(t.g.base, { headers: { Origin: APP } });
    const doubled = Buffer.from(
      request.toString().replace(`Origin: ${APP}\r\n`, `Origin: ${APP}\r\nOrigin: https://evil.example\r\n`),
    );
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(t.g.base).port) });
    cleanups.push(() => void socket.destroy());
    const answer = await new Promise<string>((resolve) => {
      let data = '';
      socket.on('data', (d) => {
        data += d.toString('latin1');
      });
      socket.on('close', () => resolve(data));
      socket.on('error', () => {});
      socket.write(doubled);
      setTimeout(() => resolve(data), 500);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 403 /);
    expect(t.up.hits).toEqual([]);
  });

  it("lets clients that send no Origin through: they are not browsers, so they cannot ride a victim's cookies", async () => {
    const t = await setup();
    expect((await t.connect()).closed).toBe(false);
  });

  it('turns browsers away entirely when no origin is listed, and admits every origin only when told to', async () => {
    const closed = await setup({ ws: { allowedOrigins: [] } });
    expect((await closed.open({ headers: { Origin: APP } })).status).toBe(403);
    expect((await closed.connect()).closed).toBe(false);

    const any = await setup({ ws: { allowedOrigins: [], allowAnyOrigin: true } });
    expect((await any.connect({ headers: { Origin: 'https://anything.example' } })).closed).toBe(false);
    expect((await any.connect({ headers: { Origin: 'null' } })).closed).toBe(false);
  });

  it('checks the origin before it spends a rate-limit token or looks at a credential', async () => {
    const t = await setup({
      route: { rateLimit: sw(2), auth: { methods: ['api-key'] } },
      gateway: { rateLimit: { apiKeys: [{ name: 'alice', sha256: keyDigest('alice-key') }] } },
    });
    for (let i = 0; i < 6; i++) {
      const res = await t.open({ headers: { Origin: 'https://evil.example', 'X-Api-Key': 'alice-key' } });
      expect(res.status).toBe(403);
    }
    const good = { 'X-Api-Key': 'alice-key', Origin: APP };
    expect((await t.connect({ headers: good })).closed).toBe(false);
    expect((await t.connect({ headers: good })).closed).toBe(false);
    expect((await t.open({ headers: good })).status).toBe(429);
  });
});

describe('authentication and limits on the handshake', () => {
  const alice = { name: 'alice', sha256: keyDigest('alice-key') };

  it('requires the credential a route asks for, and tells the upstream who connected', async () => {
    const t = await setup({
      route: { auth: { methods: ['api-key'] } },
      gateway: { rateLimit: { apiKeys: [alice] }, auth: { forwardCredentials: false } },
    });
    const missing = await t.open();
    expect(missing.status).toBe(401);
    expect(missing.headers['www-authenticate']).toBe('ApiKey');
    expect((await t.open({ headers: { 'X-Api-Key': 'guess' } })).status).toBe(401);
    expect(t.up.hits).toEqual([]);

    await t.connect({ headers: { 'X-Api-Key': 'alice-key' } });
    const seen = t.up.hits[0]?.headers;
    expect(seen?.['x-authenticated-client']).toBe('alice');
    expect(seen?.['x-authenticated-method']).toBe('api-key');
    expect(seen?.['x-api-key']).toBeUndefined(); // consumed here, not passed on
  });

  it('accepts a bearer JWT', async () => {
    const keys = testKeys();
    const t = await setup({
      route: { auth: { methods: ['jwt'] } },
      gateway: {
        auth: {
          forwardCredentials: false,
          jwt: { issuers: [{ name: 'partner', alg: 'HS256', secret: keys.hmacSecret, audience: 'gateway' }] },
        },
      },
    });
    const token = signJwt({
      alg: 'HS256',
      key: keys.hmacSecret,
      payload: { sub: 'carol', exp: t.g.clock() / 1000 + 600, aud: 'gateway' },
    });
    expect((await t.open({ headers: { Authorization: 'Bearer nonsense' } })).status).toBe(401);
    await t.connect({ headers: { Authorization: `Bearer ${token}` } });
    const seen = t.up.hits[0]?.headers;
    expect(seen?.['x-authenticated-client']).toBe('carol');
    expect(seen?.['x-authenticated-issuer']).toBe('partner');
    expect(seen?.['authorization']).toBeUndefined();
  });

  it('strips identity headers a client invents on a route that does no authentication', async () => {
    const t = await setup();
    await t.connect({ headers: { 'X-Authenticated-Client': 'root', 'X-Authenticated-Method': 'jwt' } });
    expect(t.up.hits[0]?.headers['x-authenticated-client']).toBeUndefined();
    expect(t.up.hits[0]?.headers['x-authenticated-method']).toBeUndefined();
  });

  it('counts opening a connection against the rate limit, not the messages sent over it', async () => {
    const t = await setup({ route: { rateLimit: sw(2) } });
    const first = await t.connect();
    for (let i = 0; i < 40; i++) first.send(`m${i}`);
    for (let i = 0; i < 40; i++) expect(await first.nextText()).toBe(`m${i}`);
    await t.connect();
    const refused = await t.open();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(t.up.hits).toHaveLength(2);
  });

  it('applies the address ceiling before looking at credentials, so guessed keys are throttled too', async () => {
    const t = await setup({
      route: { auth: { methods: ['api-key'] } },
      gateway: { rateLimit: { apiKeys: [alice], ip: sw(2) } },
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await t.open({ headers: { 'X-Api-Key': `guess-${i}` } })).status);
    expect(statuses).toEqual([401, 401, 429, 429]);
  });

  it('caps simultaneous connections per route and frees a slot when one closes', async () => {
    const t = await setup({ ws: { maxConnections: 2 } });
    const a = await t.connect();
    await t.connect();
    const refused = await t.open();
    expect(refused.status).toBe(503);
    expect(JSON.parse(refused.body).error.code).toBe('too_many_websockets');
    expect(refused.headers['retry-after']).toBe('5');
    expect(t.up.hits).toHaveLength(2);

    a.destroy();
    await waitFor(async () => (await open(t)()) === 1);
    expect((await t.connect()).closed).toBe(false);
  });

  it('sheds handshakes beyond the in-flight limit instead of queueing them', async () => {
    const t = await setup({ up: { delayMs: 400 }, gateway: { limits: { maxInFlight: 1 } } });
    const first = t.open();
    await waitFor(() => t.up.hits.length === 1);
    const shed = await t.open();
    expect(shed.status).toBe(503);
    expect(JSON.parse(shed.body).error.code).toBe('overloaded');
    expect(t.up.hits).toHaveLength(1);

    const accepted = await first;
    expect(accepted.status).toBe(101);
    cleanups.push(() => accepted.ws?.destroy());
  });

  it('does not leak a slot when the handshake fails', async () => {
    const t = await setup({
      ws: { maxConnections: 1 },
      up: { refuse: { status: 401, body: 'log in' } },
      upstream: { retry: { maxAttempts: 1 } },
    });
    for (let i = 0; i < 4; i++) {
      const res = await t.open();
      expect(res.status, `attempt ${i}`).toBe(401);
      expect(res.body).toBe('log in');
    }
    expect(await open(t)()).toBe(0);
  });
});

describe('the upstream side of the handshake', () => {
  it("relays the upstream's refusal, status, headers and body, and closes", async () => {
    const t = await setup({
      up: { refuse: { status: 403, body: 'no such room', headers: { 'www-authenticate': 'Bearer' } } },
      upstream: { retry: { maxAttempts: 1 } },
    });
    const res = await t.open();
    expect(res.status).toBe(403);
    expect(res.body).toBe('no such room');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.headers['connection']).toBe('close');
  });

  it('retries an upstream that is momentarily unavailable, as it does for a plain GET', async () => {
    const t = await setup({ up: { refuse: { status: 503 } }, upstream: { retry: { maxAttempts: 3 } } });
    expect((await t.open()).status).toBe(503);
    expect(t.up.hits).toHaveLength(3);
    expect(t.g.delays).toHaveLength(2);
  });

  it('moves on to another target when one cannot be reached', async () => {
    const t = await setup({ urls: (up, dead) => [dead, up.url] });
    expect((await t.connect()).closed).toBe(false);
    expect(t.up.hits).toHaveLength(1);
  });

  it('answers 502, without detail, when no target can be reached, and counts the failures against the breaker', async () => {
    const dead: string[] = [];
    const t = await setup({
      urls: (_up, deadUrl) => {
        dead.push(deadUrl);
        return [deadUrl];
      },
      upstream: { retry: { maxAttempts: 2 } },
    });
    const res = await t.open();
    expect(res.status).toBe(502);
    expect(res.body).not.toContain(new URL(dead[0] as string).port);
    expect(t.g.gateway.circuit('u')?.snapshot().failures).toBe(2);
  });

  it('answers 504 when the upstream never answers the handshake', async () => {
    const t = await setup({
      up: { delayMs: 800 },
      upstream: { timeoutMs: 150, retry: { maxAttempts: 1 } },
    });
    expect((await t.open()).status).toBe(504);
  });

  it('rejects an upstream that answers with the wrong Sec-WebSocket-Accept, and does not retry it', async () => {
    const t = await setup({ up: { accept: () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=' } });
    const res = await t.open();
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.code).toBe('bad_gateway');
    expect(t.up.hits).toHaveLength(1);
    expect(t.g.gateway.circuit('u')?.snapshot().failures).toBe(1);
    expect(await open(t)()).toBe(0);
  });

  it('rejects a subprotocol the client never offered, and an extension it never asked for', async () => {
    const protocol = await setup({ up: { protocol: () => 'admin' } });
    expect((await protocol.open({ headers: { 'Sec-WebSocket-Protocol': 'chat' } })).status).toBe(502);
    expect((await protocol.open()).status).toBe(502); // none offered at all

    const extension = await setup({ up: { extensions: 'permessage-deflate' } });
    expect((await extension.open()).status).toBe(502);
  });
});

describe('the life of a connection', () => {
  it('closes the upstream when the client leaves, and the client when the upstream does', async () => {
    const t = await setup();
    const a = await t.connect();
    await waitFor(() => t.up.open() === 1);
    a.destroy();
    await waitFor(() => t.up.open() === 0);
    await waitFor(async () => (await open(t)()) === 0);

    const b = await t.connect();
    await waitFor(() => t.up.open() === 1);
    t.up.dropAll();
    expect(await b.closesWithin(1_000)).toBe(true);

    const text = await t.metrics();
    expect(sample(text, 'gateway_websocket_closed_total', { route: 'ws', reason: 'client' })).toBe(1);
    expect(sample(text, 'gateway_websocket_closed_total', { route: 'ws', reason: 'upstream' })).toBe(1);
  });

  it('does not let a peer that hangs up but never finishes closing keep the tunnel open', async () => {
    const t = await setup({ up: { stubborn: true } });
    const ws = await t.connect();
    await waitFor(() => t.up.open() === 1);
    ws.destroy();
    await waitFor(async () => (await open(t)()) === 0, 3_000);
    expect(sample(await t.metrics(), 'gateway_websocket_closed_total', { route: 'ws', reason: 'client' })).toBe(1);
  });

  it('relays a close handshake in both directions', async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.socket.write(encodeFrame(OP.close, Buffer.from([0x03, 0xe8]), true));
    const reply = await ws.next();
    expect(reply.opcode).toBe(OP.close);
    expect(await ws.closesWithin(1_000)).toBe(true);
  });

  it('closes a connection that goes quiet, but not one that keeps talking', async () => {
    const t = await setup({ ws: { idleTimeoutMs: 250 } });
    const quiet = await t.connect();
    const chatty = await t.connect();
    const talk = setInterval(() => chatty.ping(), 80);
    cleanups.push(() => clearInterval(talk));

    expect(await quiet.closesWithin(1_200)).toBe(true);
    expect(chatty.closed).toBe(false);
    expect(sample(await t.metrics(), 'gateway_websocket_closed_total', { route: 'ws', reason: 'idle' })).toBe(1);
  });

  it('closes a connection at its maximum lifetime however busy it is', async () => {
    const t = await setup({ ws: { maxDurationMs: 300, idleTimeoutMs: 5_000 } });
    const ws = await t.connect();
    const talk = setInterval(() => ws.ping(), 40);
    cleanups.push(() => clearInterval(talk));
    const started = Date.now();
    expect(await ws.closesWithin(2_000)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    await waitFor(
      async () =>
        sample(await t.metrics(), 'gateway_websocket_closed_total', { route: 'ws', reason: 'max_duration' }) === 1,
    );
  });

  it('is not cut off by the HTTP header and request timeouts that govern ordinary requests', async () => {
    const t = await setup({ gateway: { limits: { headersTimeoutMs: 100, requestTimeoutMs: 100 } } });
    const ws = await t.connect();
    for (let i = 0; i < 8; i++) {
      await sleep(100);
      ws.send(`still here ${i}`);
      expect(await ws.nextText()).toBe(`still here ${i}`);
    }
  });

  it('abandons a handshake whose client gives up, and tells the upstream attempt to stop', async () => {
    const t = await setup({ up: { delayMs: 500 }, upstream: { timeoutMs: 5_000 } });
    const { request } = handshakeBytes(t.g.base);
    const socket = net.connect({ host: '127.0.0.1', port: Number(new URL(t.g.base).port) });
    socket.on('error', () => {});
    socket.write(request);
    await waitFor(() => t.up.hits.length === 1);
    socket.destroy();

    await waitFor(() => t.up.open() === 0);
    await waitFor(() => t.lines.some((l) => l['msg'] === 'request' && l['status'] === 499));
    expect(await open(t)()).toBe(0);
  });

  it('counts the bytes it relays in each direction', async () => {
    const t = await setup();
    const ws = await t.connect();
    ws.send('hello'); // masked client frame: 2 + 4 + 5 bytes; server frame: 2 + 5
    expect(await ws.nextText()).toBe('hello');
    ws.destroy();
    await waitFor(
      async () => sample(await t.metrics(), 'gateway_websocket_closed_total', { route: 'ws', reason: 'client' }) === 1,
    );
    const text = await t.metrics();
    expect(sample(text, 'gateway_websocket_bytes_total', { direction: 'client_to_upstream' })).toBe(11);
    expect(sample(text, 'gateway_websocket_bytes_total', { direction: 'upstream_to_client' })).toBe(7);
  });

  it('logs the handshake like any request, and the connection when it ends', async () => {
    const t = await setup();
    const ws = await t.connect({ path: '/ws/room' });
    ws.send('hi');
    await ws.nextText();
    ws.destroy();
    await waitFor(() => t.lines.some((l) => l['msg'] === 'websocket closed'));

    const request = t.lines.find((l) => l['msg'] === 'request' && l['status'] === 101);
    expect(request).toMatchObject({ method: 'GET', route: 'ws', path: '/ws/room', status: 101 });
    const closed = t.lines.find((l) => l['msg'] === 'websocket closed');
    expect(closed).toMatchObject({ route: 'ws', reason: 'client', requestId: request?.['requestId'] });
    expect(closed?.['bytesFromClient']).toBeGreaterThan(0);
    expect(t.lines.filter((l) => l['level'] === 'error')).toEqual([]);
  });

  it('ends open connections promptly on shutdown instead of waiting for them', async () => {
    const t = await setup();
    const ws = await t.connect();
    await waitFor(() => t.up.open() === 1);
    const started = Date.now();
    await t.g.close();
    expect(await ws.closesWithin(500)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_500);
    await waitFor(() => t.up.open() === 0);
    expect(t.lines.find((l) => l['msg'] === 'websocket closed')).toMatchObject({ reason: 'shutdown' });
  });
});

describe('websockets over TLS', () => {
  it('connects to a wss:// upstream, verifying its certificate against the configured CA', async () => {
    const cert = fixture('tls/localhost-cert.pem');
    const t = await setup({
      up: { tls: { key: readFileSync(fixture('tls/localhost-key.pem')), cert: readFileSync(cert) } },
      upstream: { tls: { caFile: cert } },
    });
    const ws = await t.connect();
    ws.send('through two tls hops');
    expect(await ws.nextText()).toBe('through two tls hops');
    expect(t.up.hits[0]?.upgrade).toBe(true);
  });

  it('refuses a wss:// upstream whose certificate it does not trust', async () => {
    const cert = fixture('tls/localhost-cert.pem');
    const t = await setup({
      up: {
        tls: {
          key: readFileSync(fixture('tls/localhost2-key.pem')),
          cert: readFileSync(fixture('tls/localhost2-cert.pem')),
        },
      },
      upstream: { tls: { caFile: cert }, retry: { maxAttempts: 3 } },
    });
    const res = await t.open();
    expect(res.status).toBe(502);
    expect(t.up.hits).toEqual([]); // never got as far as sending the handshake
    expect(t.g.delays).toEqual([]); // and a certificate failure is not retried
  });

  it('serves wss, and tells the upstream the client used https', async () => {
    const t = await setup({
      gateway: { tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem') } },
    });
    const ws = await t.connect();
    ws.send('over tls');
    expect(await ws.nextText()).toBe('over tls');
    expect(t.up.hits[0]?.headers['x-forwarded-proto']).toBe('https');
  });
});
