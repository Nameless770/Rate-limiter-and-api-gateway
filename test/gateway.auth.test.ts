import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/observability/logger.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import {
  capturingLogger,
  type FakeUpstream,
  json,
  type RunningGateway,
  rawRequest,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';
import { signJwt, tamper, testKeys } from './jwtHelpers.js';

const keys = testKeys();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const echo: UpstreamHandler = (_r, res, hit) =>
  json(res, 200, { url: hit.url, headers: hit.headers, client: hit.headers['x-authenticated-client'] ?? null });

const sw = (limit: number) => ({ algorithm: 'sliding-window', limit, windowMs: 60_000 });

const partner = { name: 'partner', alg: 'HS256', secret: keys.hmacSecret, audience: 'gateway' };
const idp = {
  name: 'idp',
  alg: 'RS256',
  publicKey: keys.rsa.publicPem,
  issuer: 'https://idp.example',
  audience: 'gateway',
  plan: 'pro',
};

interface Setup {
  up: FakeUpstream;
  g: RunningGateway;
  /** Token for the fake clock's present, signed by the HS256 "partner" issuer. */
  hs: (sub?: string, extra?: Record<string, unknown>) => string;
  /** Token signed by the RS256 "idp" issuer. */
  rs: (sub?: string, extra?: Record<string, unknown>) => string;
  get: (path: string, headers?: Record<string, string>) => ReturnType<typeof rawRequest>;
  lines: Array<Record<string, unknown>>;
}

async function setup(
  options: { auth?: Record<string, unknown>; rateLimit?: Record<string, unknown> } = {},
): Promise<Setup> {
  const up = await startUpstream(echo);
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const g = await startGateway(
    {
      upstreams: { u: { url: up.url } },
      auth: { jwt: { issuers: [partner, idp] }, ...options.auth },
      rateLimit: {
        default: sw(3),
        plans: { pro: { multiplier: 3 } },
        apiKeys: [
          { name: 'alice', sha256: keyDigest('alice-key') },
          { name: 'bob', sha256: keyDigest('bob-key') },
        ],
        ...options.rateLimit,
      },
      routes: [
        { id: 'open', path: '/open', upstream: 'u', stripPrefix: false },
        { id: 'jwt', path: '/jwt', upstream: 'u', stripPrefix: false, auth: { methods: ['jwt'] } },
        { id: 'key', path: '/key', upstream: 'u', stripPrefix: false, auth: { methods: ['api-key'] } },
        { id: 'any', path: '/any', upstream: 'u', stripPrefix: false, auth: { methods: ['api-key', 'jwt'] } },
        {
          id: 'maybe',
          path: '/maybe',
          upstream: 'u',
          stripPrefix: false,
          auth: { methods: ['api-key', 'jwt'], required: false },
        },
        {
          id: 'cached',
          path: '/cached',
          upstream: 'u',
          stripPrefix: false,
          auth: { methods: ['jwt'] },
          cache: { ttlMs: 60_000 },
        },
      ],
    },
    { logger },
  );
  cleanups.push(g.close);
  const exp = () => g.clock() / 1000 + 600;
  return {
    up,
    g,
    lines,
    hs: (sub = 'alice', extra = {}) =>
      signJwt({ alg: 'HS256', key: keys.hmacSecret, payload: { sub, exp: exp(), aud: 'gateway', ...extra } }),
    rs: (sub = 'carol', extra = {}) =>
      signJwt({
        alg: 'RS256',
        key: keys.rsa.privateKey,
        payload: { sub, exp: exp(), aud: 'gateway', iss: 'https://idp.example', ...extra },
      }),
    get: (path, headers = {}) => rawRequest(g.base, { path, headers }),
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const body = (r: { body: string }) => JSON.parse(r.body) as { headers: Record<string, string>; client: string | null };
const code = (r: { body: string }) => (JSON.parse(r.body) as { error: { code: string } }).error.code;

describe('required JWT authentication', () => {
  it('turns away a request with no credential, before it reaches the upstream', async () => {
    const t = await setup();
    const res = await t.get('/jwt/x');
    expect(res.status).toBe(401);
    expect(code(res)).toBe('unauthorized');
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(t.up.hits).toHaveLength(0);
  });

  it('admits a valid token and tells the upstream who it is', async () => {
    const t = await setup();
    const res = await t.get('/jwt/x', bearer(t.hs('alice')));
    expect(res.status).toBe(200);
    expect(body(res).headers).toMatchObject({
      'x-authenticated-client': 'alice',
      'x-authenticated-method': 'jwt',
      'x-authenticated-issuer': 'partner',
    });
  });

  it.each([
    ['garbage', () => 'not.a.jwt'],
    [
      'a token signed with the wrong key',
      () => signJwt({ alg: 'HS256', key: `${keys.hmacSecret}!`, payload: { sub: 'a', exp: 9e9, aud: 'gateway' } }),
    ],
    ['a tampered payload', (t: Setup) => tamper(t.hs('alice'), 1, (p) => (p['sub'] = 'admin'))],
    ['an expired token', (t: Setup) => t.hs('alice', { exp: t.g.clock() / 1000 - 120 })],
    ['a token for another audience', (t: Setup) => t.hs('alice', { aud: 'someone-else' })],
    [
      'alg none',
      () =>
        `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"admin","exp":9999999999}').toString('base64url')}.`,
    ],
  ])('refuses %s with a generic 401 that explains nothing', async (_label, makeToken) => {
    const t = await setup();
    const res = await t.get('/jwt/x', bearer(makeToken(t)));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer error="invalid_token"');
    expect(JSON.parse(res.body).error).toEqual({
      code: 'unauthorized',
      message: 'a valid credential is required',
      requestId: res.headers['x-request-id'],
    });
    expect(t.up.hits).toHaveLength(0);
  });

  it('treats an empty bearer like no credential at all', async () => {
    const t = await setup();
    const res = await t.get('/jwt/x', { authorization: 'Bearer ' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('treats a non-bearer Authorization scheme as no credential', async () => {
    const t = await setup();
    const res = await t.get('/jwt/x', { authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer'); // "missing", not "invalid_token"
  });

  it('logs why it refused, by reason code, and never logs the token', async () => {
    const t = await setup();
    const expired = t.hs('alice', { exp: t.g.clock() / 1000 - 120 });
    await t.get('/jwt/x', bearer(expired));
    await t.get('/jwt/x', bearer(t.hs('alice')));
    await t.get('/jwt/x');
    const requests = t.lines.filter((l) => l['msg'] === 'request');
    expect(requests.map((l) => l['authFailure'])).toEqual(['expired', undefined, 'missing_credentials']);
    const everything = JSON.stringify(t.lines);
    expect(everything).not.toContain(expired);
    expect(everything).not.toContain(expired.split('.')[2] as string);
    expect(requests[1]?.['client']).toBe('partner:alice'); // the authenticated caller is named
  });

  it('accepts tokens from either configured issuer', async () => {
    const t = await setup();
    const fromRs = await t.get('/jwt/x', bearer(t.rs('carol')));
    expect(fromRs.status).toBe(200);
    expect(body(fromRs).headers).toMatchObject({ 'x-authenticated-client': 'carol', 'x-authenticated-issuer': 'idp' });
    // idp insists on its iss claim; a token from its key without it is not an idp token.
    const noIss = signJwt({
      alg: 'RS256',
      key: keys.rsa.privateKey,
      payload: { sub: 'x', exp: t.g.clock() / 1000 + 60, aud: 'gateway' },
    });
    expect((await t.get('/jwt/x', bearer(noIss))).status).toBe(401);
  });
});

describe('API-key authentication', () => {
  it('admits registered keys and names them to the upstream', async () => {
    const t = await setup();
    const res = await t.get('/key/x', { 'x-api-key': 'alice-key' });
    expect(res.status).toBe(200);
    expect(body(res).headers).toMatchObject({ 'x-authenticated-client': 'alice', 'x-authenticated-method': 'api-key' });
    expect(body(res).headers['x-authenticated-issuer']).toBeUndefined();
  });

  it('refuses an unknown key and a missing key', async () => {
    const t = await setup();
    const unknown = await t.get('/key/x', { 'x-api-key': 'guess' });
    const missing = await t.get('/key/x');
    expect([unknown.status, missing.status]).toEqual([401, 401]);
    expect(unknown.headers['www-authenticate']).toBe('ApiKey');
    expect(t.up.hits).toHaveLength(0);
  });

  it('ignores a bearer token on a route that only takes API keys', async () => {
    const t = await setup();
    expect((await t.get('/key/x', bearer(t.hs()))).status).toBe(401);
    expect((await t.get('/key/x', { ...bearer(t.hs()), 'x-api-key': 'alice-key' })).status).toBe(200);
  });
});

describe('routes accepting either credential', () => {
  it('lists every accepted scheme in the challenge', async () => {
    const t = await setup();
    expect((await t.get('/any/x')).headers['www-authenticate']).toBe('Bearer, ApiKey');
  });

  it('accepts either', async () => {
    const t = await setup();
    expect((await t.get('/any/x', bearer(t.hs()))).status).toBe(200);
    expect((await t.get('/any/x', { 'x-api-key': 'bob-key' })).status).toBe(200);
  });

  it('refuses a bad token even when a valid API key accompanies it: no silent fallback', async () => {
    const t = await setup();
    const res = await t.get('/any/x', { ...bearer('not.a.jwt'), 'x-api-key': 'alice-key' });
    expect(res.status).toBe(401);
  });

  it('prefers the token when both are valid', async () => {
    const t = await setup();
    const res = await t.get('/any/x', { ...bearer(t.hs('dave')), 'x-api-key': 'alice-key' });
    expect(body(res).headers['x-authenticated-client']).toBe('dave');
    expect(body(res).headers['x-authenticated-method']).toBe('jwt');
  });
});

describe('optional authentication', () => {
  it('lets anonymous callers through, with no identity claimed to the upstream', async () => {
    const t = await setup();
    const res = await t.get('/maybe/x');
    expect(res.status).toBe(200);
    expect(body(res).headers['x-authenticated-client']).toBeUndefined();
    expect(body(res).headers['x-authenticated-method']).toBeUndefined();
  });

  it('still refuses a credential that is presented and wrong: bad tokens never downgrade to anonymous', async () => {
    const t = await setup();
    expect((await t.get('/maybe/x', bearer('not.a.jwt'))).status).toBe(401);
    expect((await t.get('/maybe/x', { 'x-api-key': 'guess' })).status).toBe(401);
    expect((await t.get('/maybe/x', bearer(t.hs('alice', { exp: 1 })))).status).toBe(401);
  });

  it('identifies callers who do present a good credential', async () => {
    const t = await setup();
    expect(body(await t.get('/maybe/x', bearer(t.hs('erin')))).headers['x-authenticated-client']).toBe('erin');
  });

  it('ignores a non-bearer Authorization header rather than rejecting it', async () => {
    const t = await setup();
    const res = await t.get('/maybe/x', { authorization: 'Basic dXNlcjpwYXNz' });
    expect(res.status).toBe(200);
    expect(body(res).headers['authorization']).toBe('Basic dXNlcjpwYXNz'); // the upstream's business
  });
});

describe('routes without auth', () => {
  it('do not look at credentials: an opaque bearer token passes through untouched', async () => {
    const t = await setup();
    const res = await t.get('/open/x', bearer('opaque-token-for-the-upstream'));
    expect(res.status).toBe(200);
    expect(body(res).headers['authorization']).toBe('Bearer opaque-token-for-the-upstream');
    expect(body(res).headers['x-authenticated-client']).toBeUndefined();
  });

  it('never claim an identity to the upstream, even for a registered API key used for rate limiting', async () => {
    const t = await setup();
    const res = await t.get('/open/x', { 'x-api-key': 'alice-key' });
    expect(body(res).headers['x-authenticated-client']).toBeUndefined();
  });
});

describe('identity headers cannot be forged', () => {
  const forged = {
    'x-authenticated-client': 'admin',
    'x-authenticated-method': 'jwt',
    'x-authenticated-issuer': 'partner',
  };

  it('are stripped from requests to routes without auth', async () => {
    const t = await setup();
    const seen = body(await t.get('/open/x', forged)).headers;
    for (const h of Object.keys(forged)) expect(seen[h], h).toBeUndefined();
  });

  it('are replaced, not merged, on authenticated routes', async () => {
    const t = await setup();
    const seen = body(await t.get('/jwt/x', { ...bearer(t.hs('alice')), ...forged })).headers;
    expect(seen['x-authenticated-client']).toBe('alice');
    expect(seen['x-authenticated-method']).toBe('jwt');
    expect(seen['x-authenticated-issuer']).toBe('partner');
  });

  it('are stripped on optional-auth routes for anonymous callers', async () => {
    const t = await setup();
    const seen = body(await t.get('/maybe/x', forged)).headers;
    for (const h of Object.keys(forged)) expect(seen[h], h).toBeUndefined();
  });

  it('are set when the upstream is told, and never when forwardIdentity is off', async () => {
    const t = await setup({ auth: { forwardIdentity: false } });
    const seen = body(await t.get('/jwt/x', { ...bearer(t.hs('alice')), ...forged })).headers;
    for (const h of Object.keys(forged)) expect(seen[h], h).toBeUndefined();
  });

  it('survive a hostile subject: CR/LF cannot split the header block, non-ASCII is percent-encoded', async () => {
    const t = await setup();
    const crlf = await t.get('/jwt/x', bearer(t.hs('mallory\r\nX-Evil: 1')));
    expect(crlf.status).toBe(200);
    expect(body(crlf).headers['x-evil']).toBeUndefined();
    expect(body(crlf).headers['x-authenticated-client']).toBe('mallory%0D%0AX-Evil%3A%201');

    const unicode = await t.get('/jwt/x', bearer(t.hs('zoë')));
    expect(body(unicode).headers['x-authenticated-client']).toBe('zo%C3%AB');
    const plain = await t.get('/jwt/x', bearer(t.hs('auth0|abc:123 @x')));
    expect(body(plain).headers['x-authenticated-client']).toBe('auth0|abc:123 @x'); // printable ASCII is untouched
  });
});

describe('credential forwarding', () => {
  it('forwards the verified credential by default', async () => {
    const t = await setup();
    const token = t.hs();
    expect(body(await t.get('/jwt/x', bearer(token))).headers['authorization']).toBe(`Bearer ${token}`);
    expect(body(await t.get('/key/x', { 'x-api-key': 'alice-key' })).headers['x-api-key']).toBe('alice-key');
  });

  it('withholds only the credential the gateway consumed when forwardCredentials is off', async () => {
    const t = await setup({ auth: { forwardCredentials: false } });
    const viaJwt = body(
      await t.get('/jwt/x', { ...bearer(t.hs()), 'x-api-key': 'alice-key', 'x-other': 'kept' }),
    ).headers;
    expect(viaJwt['authorization']).toBeUndefined();
    expect(viaJwt['x-api-key']).toBe('alice-key'); // not what authenticated this request
    expect(viaJwt['x-other']).toBe('kept');

    const viaKey = body(
      await t.get('/key/x', { 'x-api-key': 'alice-key', authorization: 'Basic dXNlcjpwYXNz' }),
    ).headers;
    expect(viaKey['x-api-key']).toBeUndefined();
    expect(viaKey['authorization']).toBe('Basic dXNlcjpwYXNz');
  });

  it('leaves unauthenticated routes alone even when forwardCredentials is off', async () => {
    const t = await setup({ auth: { forwardCredentials: false } });
    const seen = body(await t.get('/open/x', { ...bearer('opaque'), 'x-api-key': 'alice-key' })).headers;
    expect(seen['authorization']).toBe('Bearer opaque');
    expect(seen['x-api-key']).toBe('alice-key');
  });
});

describe('rate limiting follows the authenticated identity', () => {
  it('gives each subject one budget however many tokens it mints', async () => {
    const t = await setup();
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      // A different token every time (a different `jti`), for the same subject.
      statuses.push((await t.get('/jwt/x', bearer(t.hs('alice', { jti: `token-${i}` })))).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await t.get('/jwt/x', bearer(t.hs('bob')))).status).toBe(200); // another subject: its own budget
  });

  it('applies the issuer plan multiplier to its subjects', async () => {
    const t = await setup();
    const results: number[] = [];
    for (let i = 0; i < 10; i++) results.push((await t.get('/jwt/x', bearer(t.rs('carol')))).status);
    expect(results.filter((s) => s === 200)).toHaveLength(9); // default 3 x pro 3
    expect(results[9]).toBe(429);
  });

  it('keeps issuers apart: the same subject at two issuers is two identities', async () => {
    // Same plan on both, so the only thing separating the budgets is the issuer being part of the identity.
    const t = await setup({ auth: { jwt: { issuers: [partner, { ...idp, plan: undefined }] } } });
    for (let i = 0; i < 3; i++) expect((await t.get('/jwt/x', bearer(t.hs('shared')))).status).toBe(200);
    expect((await t.get('/jwt/x', bearer(t.hs('shared')))).status).toBe(429);
    expect((await t.get('/jwt/x', bearer(t.rs('shared')))).status).toBe(200);
  });

  it('counts failed authentication against the address ceiling, so guessing credentials is throttled', async () => {
    const t = await setup({ rateLimit: { ip: sw(6) } });
    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) statuses.push((await t.get('/jwt/x', bearer(`bad.token.${i}`))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 401, 429, 429, 429]);
    // The address is spent for everyone behind it, including a caller with a perfectly good token.
    expect((await t.get('/jwt/x', bearer(t.hs()))).status).toBe(429);
  });

  it('applies the ceiling before checking credentials at all', async () => {
    const t = await setup({ rateLimit: { ip: sw(1) } });
    await t.get('/open/x');
    const res = await t.get('/key/x', { 'x-api-key': 'guess' });
    expect(res.status).toBe(429); // not 401: the credential was never examined
    expect(t.lines.filter((l) => l['msg'] === 'request').at(-1)?.['authFailure']).toBeUndefined();
  });
});

describe('caching authenticated routes', () => {
  it("keeps one entry per credential, so one caller is never served another caller's response", async () => {
    const t = await setup({ rateLimit: { default: sw(100) } });
    const alice = t.hs('alice');
    const bob = t.hs('bob');
    const first = await t.get('/cached/x', bearer(alice));
    const second = await t.get('/cached/x', bearer(alice));
    const other = await t.get('/cached/x', bearer(bob));

    expect(first.headers['x-cache']).toBe('MISS');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(other.headers['x-cache']).toBe('MISS');
    expect(body(second).client).toBe('alice');
    expect(body(other).client).toBe('bob');
  });

  it('still verifies the token on a cache hit: an expired token gets nothing from the cache', async () => {
    const t = await setup({ rateLimit: { default: sw(100) } });
    const short = t.hs('alice', { exp: t.g.clock() / 1000 + 10 });
    expect((await t.get('/cached/x', bearer(short))).status).toBe(200);
    expect((await t.get('/cached/x', bearer(short))).headers['x-cache']).toBe('HIT');
    t.g.clock.advance(120_000); // past the 10 s lifetime plus the 30 s leeway
    const after = await t.get('/cached/x', bearer(short));
    expect(after.status).toBe(401);
    expect(after.headers['x-cache']).toBeUndefined();
  });
});

describe('metrics', () => {
  it('count outcomes by route, method and result', async () => {
    const t = await setup({ rateLimit: { default: sw(100) } });
    await t.get('/jwt/x', bearer(t.hs()));
    await t.get('/jwt/x', bearer('bad.bad.bad'));
    await t.get('/key/x');
    await t.get('/key/x', { 'x-api-key': 'alice-key' });
    await t.get('/maybe/x');
    const text = (await rawRequest(t.g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(text).toMatch(/gateway_auth_total\{method="jwt",result="ok",route="jwt"\} 1/);
    expect(text).toMatch(/gateway_auth_total\{method="jwt",result="fail",route="jwt"\} 1/);
    expect(text).toMatch(/gateway_auth_total\{method="none",result="fail",route="key"\} 1/);
    expect(text).toMatch(/gateway_auth_total\{method="api-key",result="ok",route="key"\} 1/);
    expect(text).toMatch(/gateway_auth_total\{method="none",result="ok",route="maybe"\} 1/);
    expect(text).toMatch(/gateway_unauthorized_total\{route="jwt"\} 1/);
  });
});

describe('configuration', () => {
  const base = {
    upstreams: { u: { url: 'http://localhost:9000' } },
    routes: [{ path: '/', upstream: 'u', auth: { methods: ['jwt'] } }],
  };
  const jwt = { issuers: [{ name: 'i', alg: 'HS256', secret: keys.hmacSecret }] };

  it('requires JWT issuers for the jwt method and a key registry for the api-key method', () => {
    expect(() => parseConfig(base)).toThrow(/needs auth\.jwt\.issuers/);
    expect(() =>
      parseConfig({ ...base, routes: [{ path: '/', upstream: 'u', auth: { methods: ['api-key'] } }] }),
    ).toThrow(/needs rateLimit\.apiKeys/);
    expect(parseConfig({ ...base, auth: { jwt } }).routes[0]?.auth).toEqual({ methods: ['jwt'], required: true });
  });

  it('rejects duplicate issuer names, unknown plans and unknown options', () => {
    const dup = { issuers: [jwt.issuers[0], jwt.issuers[0]] };
    expect(() => parseConfig({ ...base, auth: { jwt: dup } })).toThrow(/duplicate issuer name/);
    const plan = { issuers: [{ ...jwt.issuers[0], plan: 'gold' }] };
    expect(() => parseConfig({ ...base, auth: { jwt: plan } })).toThrow(/unknown plan "gold"/);
    expect(() => parseConfig({ ...base, auth: { jwt, unknown: 1 } })).toThrow();
    expect(() =>
      parseConfig({ ...base, auth: { jwt }, routes: [{ path: '/', upstream: 'u', auth: { methods: [] } }] }),
    ).toThrow();
    expect(() =>
      parseConfig({ ...base, auth: { jwt }, routes: [{ path: '/', upstream: 'u', auth: { methods: ['basic'] } }] }),
    ).toThrow();
  });

  it('checks each issuer has the right kind of key', () => {
    const issuer = (extra: Record<string, unknown>) => ({
      auth: { jwt: { issuers: [{ name: 'i', ...extra }] } },
      ...base,
    });
    expect(() => parseConfig(issuer({ alg: 'HS256' }))).toThrow(/needs a "secret"/);
    expect(() => parseConfig(issuer({ alg: 'RS256' }))).toThrow(/exactly one of "publicKey" and "publicKeyFile"/);
    expect(() => parseConfig(issuer({ alg: 'RS256', secret: 'x'.repeat(40), publicKey: 'k' }))).toThrow();
    expect(() => parseConfig(issuer({ alg: 'none', secret: 'x'.repeat(40) }))).toThrow(); // not an algorithm we accept
    expect(() => parseConfig(issuer({ alg: 'HS512', secret: 'x'.repeat(40) }))).toThrow();
  });

  it('fails at startup, naming the issuer, when a key is weak or unreadable', () => {
    const build = (issuer: Record<string, unknown>) =>
      new Gateway(parseConfig({ ...base, auth: { jwt: { issuers: [{ name: 'broken', ...issuer }] } } }), {
        logger: silentLogger,
      });
    expect(() => build({ alg: 'HS256', secret: 'short' })).toThrow(/auth\.jwt\.issuers\.broken: .*at least 32 bytes/);
    expect(() => build({ alg: 'RS256', publicKeyFile: 'does-not-exist.pem' })).toThrow(ConfigError);
    expect(() => build({ alg: 'RS256', publicKey: 'not a pem' })).toThrow(/not a valid PEM/);
  });
});
