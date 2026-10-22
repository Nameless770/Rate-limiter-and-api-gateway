/**
 * Callers authenticating with a TLS client certificate (route auth method "client-cert"). The fixtures in
 * test/fixtures/tls/callers are a test CA, certificates it issued (alice, bob), one it revoked (mallory, on crl.pem),
 * one that has expired, and an impostor: a certificate for "alice" from a different CA.
 */
import { X509Certificate } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import {
  capturingLogger,
  type FakeUpstream,
  fixture,
  httpsRequest,
  json,
  type RunningGateway,
  startGateway,
  startUpstream,
} from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const serverCa = readFileSync(fixture('tls/localhost-cert.pem'));
const callers = (name: string) => fixture(`tls/callers/${name}`);
const as = (who: 'alice' | 'bob' | 'mallory' | 'expired' | 'impostor') => ({
  cert: readFileSync(callers(`${who}-cert.pem`)),
  key: readFileSync(callers(`${who}-key.pem`)),
});
const sha256Of = (who: string) =>
  new X509Certificate(readFileSync(callers(`${who}-cert.pem`))).fingerprint256.replace(/:/g, '').toLowerCase();

interface Setup {
  up: FakeUpstream;
  g: RunningGateway;
  lines: Array<Record<string, unknown>>;
  get(
    path: string,
    opts?: { who?: Parameters<typeof as>[0]; headers?: Record<string, string> },
  ): ReturnType<typeof httpsRequest>;
}

async function setup(clientAuth: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Setup> {
  const up = await startUpstream((_req, res, hit) => json(res, 200, { headers: hit.headers }));
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const g = await startGateway(
    {
      tls: {
        certFile: fixture('tls/localhost-cert.pem'),
        keyFile: fixture('tls/localhost-key.pem'),
        clientAuth: { caFile: callers('ca-cert.pem'), crlFile: callers('crl.pem'), ...clientAuth },
      },
      rateLimit: { apiKeys: [{ name: 'svc', sha256: keyDigest('svc-key') }] },
      upstreams: { u: { url: up.url } },
      routes: [
        { id: 'mtls', path: '/mtls', upstream: 'u', auth: { methods: ['client-cert'] } },
        { id: 'either', path: '/either', upstream: 'u', auth: { methods: ['client-cert', 'api-key'] } },
        { id: 'open', path: '/open', upstream: 'u' },
      ],
      ...extra,
    },
    { logger },
  );
  cleanups.push(g.close);
  const base = g.base.replace('http://', 'https://');
  return {
    up,
    g,
    lines,
    get: (path, opts = {}) =>
      httpsRequest(base, { path, ca: serverCa, headers: opts.headers, ...(opts.who ? as(opts.who) : {}) }),
  };
}

const authFailures = (lines: Array<Record<string, unknown>>) =>
  lines.filter((l) => l['msg'] === 'request' && l['authFailure']).map((l) => l['authFailure']);

describe('client-certificate authentication', () => {
  it('lets a caller in on a certificate the CA issued, and tells the upstream who it is', async () => {
    const t = await setup();
    const res = await t.get('/mtls/x', { who: 'alice' });
    expect(res.status).toBe(200);
    const seen = JSON.parse(res.body).headers as Record<string, string>;
    expect(seen['x-authenticated-method']).toBe('client-cert');
    expect(seen['x-authenticated-client']).toBe('alice');
    expect(seen['x-authenticated-issuer']).toBe('Test Callers CA');
    expect(seen['x-client-cert-sha256']).toBe(sha256Of('alice'));
    expect(t.lines.find((l) => l['msg'] === 'request')?.['client']).toBe('alice');
  });

  it('refuses a caller with no certificate on a route that needs one, and lets it in elsewhere', async () => {
    const t = await setup();
    const refused = await t.get('/mtls/x');
    expect(refused.status).toBe(401);
    expect(refused.headers['www-authenticate']).toBeUndefined(); // there is no HTTP challenge for a certificate
    expect((await t.get('/open/x')).status).toBe(200);
    expect(t.up.hits.map((h) => h.url)).toEqual(['/x']);
  });

  it('refuses a revoked, an expired, and an impostor certificate, and says why in the log', async () => {
    const t = await setup();
    for (const who of ['mallory', 'expired', 'impostor'] as const) {
      expect((await t.get('/mtls/x', { who })).status, who).toBe(401);
    }
    expect(t.up.hits).toHaveLength(0);
    expect(authFailures(t.lines)).toEqual([
      'client_cert_cert_revoked',
      'client_cert_cert_has_expired',
      'client_cert_unable_to_verify_leaf_signature',
    ]);
  });

  it('refuses a bad certificate even where a valid API key would have done: a presented credential must be good', async () => {
    const t = await setup();
    const withKey = { headers: { 'x-api-key': 'svc-key' } };
    expect((await t.get('/either/x', { who: 'mallory', ...withKey })).status).toBe(401);
    const byKey = await t.get('/either/x', withKey);
    expect(byKey.status).toBe(200);
    expect(JSON.parse(byKey.body).headers['x-authenticated-method']).toBe('api-key');
    const byCert = await t.get('/either/x', { who: 'bob', ...withKey });
    expect(JSON.parse(byCert.body).headers['x-authenticated-client']).toBe('bob');
  });

  it('never lets a client claim a certificate identity with headers', async () => {
    const t = await setup();
    const forged = {
      'x-authenticated-client': 'alice',
      'x-authenticated-method': 'client-cert',
      'x-client-cert-sha256': sha256Of('alice'),
    };
    const res = await t.get('/open/x', { headers: forged });
    const seen = JSON.parse(res.body).headers as Record<string, string>;
    for (const name of Object.keys(forged)) expect(seen[name]).toBeUndefined();
  });

  it('gives each certificate its own rate-limit budget, kept across connections', async () => {
    const t = await setup(
      {},
      {
        rateLimit: {
          apiKeys: [{ name: 'svc', sha256: keyDigest('svc-key') }],
          default: { algorithm: 'sliding-window', limit: 2, windowMs: 60_000 },
        },
      },
    );
    const statuses = async (who: 'alice' | 'bob', n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await t.get('/mtls/x', { who })).status); // a new connection each time
      return out;
    };
    expect(await statuses('alice', 3)).toEqual([200, 200, 429]);
    expect(await statuses('bob', 2)).toEqual([200, 200]);
  });

  it('tells apart two trusted CAs that issued the same name: the issuer is part of who the caller is', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-cas-'));
    const bundle = join(dir, 'cas.pem');
    writeFileSync(bundle, `${readFileSync(callers('ca-cert.pem'))}${readFileSync(callers('other-ca-cert.pem'))}`);
    const t = await setup(
      { caFile: bundle, crlFile: undefined },
      {
        rateLimit: {
          apiKeys: [{ name: 'svc', sha256: keyDigest('svc-key') }],
          default: { algorithm: 'sliding-window', limit: 2, windowMs: 60_000 },
        },
      },
    );
    expect((await t.get('/mtls/x', { who: 'alice' })).status).toBe(200);
    expect((await t.get('/mtls/x', { who: 'alice' })).status).toBe(200);
    const other = await t.get('/mtls/x', { who: 'impostor' }); // the other CA's "alice": a budget of its own
    expect(other.status).toBe(200);
    expect(JSON.parse(other.body).headers['x-authenticated-issuer']).toBe("Someone Else's CA");
  });

  it('accepts only the names it is told to, when told', async () => {
    const t = await setup({ allowedNames: ['alice'] });
    expect((await t.get('/mtls/x', { who: 'alice' })).status).toBe(200);
    expect((await t.get('/mtls/x', { who: 'bob' })).status).toBe(401);
    expect(authFailures(t.lines)).toEqual(['client_cert_name_not_allowed']);
  });

  it('with required: true, refuses a connection without a valid certificate in the handshake', async () => {
    const t = await setup({ required: true });
    expect((await t.get('/open/x', { who: 'alice' })).status).toBe(200);
    await expect(t.get('/open/x')).rejects.toThrow();
    await expect(t.get('/open/x', { who: 'mallory' })).rejects.toThrow();
    expect(t.up.hits).toHaveLength(1);
  });

  it('leaves the API-key header alone with forwardCredentials off: a certificate consumes no header', async () => {
    const t = await setup({}, { auth: { forwardCredentials: false } });
    const res = await t.get('/mtls/x', { who: 'alice', headers: { 'x-api-key': 'meant-for-the-upstream' } });
    expect(JSON.parse(res.body).headers['x-api-key']).toBe('meant-for-the-upstream');
  });

  it('picks up a new revocation list on reload, for new connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-crl-'));
    const crl = join(dir, 'crl.pem');
    writeFileSync(crl, ''); // replaced below
    const t = await setup({ crlFile: undefined });
    expect((await t.get('/mtls/x', { who: 'mallory' })).status).toBe(200); // no revocation list yet

    copyFileSync(callers('crl.pem'), crl);
    const next = parseConfig({
      ...t.g.gateway.config,
      tls: { ...t.g.gateway.config.tls, clientAuth: { ...t.g.gateway.config.tls?.clientAuth, crlFile: crl } },
    });
    expect(t.g.gateway.reload(next)).toMatchObject({ ok: true, restartRequired: [] });
    expect((await t.get('/mtls/x', { who: 'mallory' })).status).toBe(401);
    expect((await t.get('/mtls/x', { who: 'alice' })).status).toBe(200);
  });

  it('needs a restart to start or stop asking for certificates, or to start or stop insisting on one', async () => {
    const t = await setup();
    const current = t.g.gateway.config;
    const tls = current.tls as NonNullable<typeof current.tls>;
    const off = parseConfig({ ...current, tls: { ...tls, clientAuth: undefined }, routes: [current.routes[2]] });
    expect(t.g.gateway.reload(off)).toMatchObject({ ok: true, restartRequired: ['tls.clientAuth'] });
    expect(t.g.gateway.config.tls?.clientAuth).toBeDefined();

    const strict = parseConfig({ ...current, tls: { ...tls, clientAuth: { ...tls.clientAuth, required: true } } });
    expect(t.g.gateway.reload(strict)).toMatchObject({ ok: true, restartRequired: ['tls.clientAuth'] });
    expect(t.g.gateway.config.tls?.clientAuth?.required).toBe(false);
    expect((await t.get('/open/x')).status).toBe(200); // still optional
  });
});

describe('client-certificate configuration', () => {
  const base = (clientAuth: Record<string, unknown>, routes?: unknown[]) => ({
    tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem'), clientAuth },
    upstreams: { u: { url: 'http://127.0.0.1:1' } },
    routes: routes ?? [{ path: '/', upstream: 'u', auth: { methods: ['client-cert'] } }],
  });

  it('wants tls.clientAuth before a route can use client-cert', () => {
    expect(() =>
      parseConfig({
        upstreams: { u: { url: 'http://a:1' } },
        routes: [{ path: '/', upstream: 'u', auth: { methods: ['client-cert'] } }],
      }),
    ).toThrow(/the "client-cert" method needs tls.clientAuth to be configured/);
  });

  it('refuses to start without a usable CA bundle or revocation list, naming the setting', () => {
    const start = (clientAuth: Record<string, unknown>) => () =>
      new Gateway(parseConfig(base(clientAuth)), { manualHealthChecks: true });
    expect(start({ caFile: 'no/such/ca.pem' })).toThrow(/tls\.clientAuth\.caFile/);
    expect(start({ caFile: callers('ca-cert.pem'), crlFile: 'no/such/crl.pem' })).toThrow(/tls\.clientAuth\.crlFile/);
    const dir = mkdtempSync(join(tmpdir(), 'gw-ca-'));
    writeFileSync(join(dir, 'junk.pem'), 'not a certificate');
    expect(start({ caFile: join(dir, 'junk.pem') })).toThrow(/tls\.clientAuth: the CA bundle or revocation list/);
    expect(start({ caFile: callers('ca-cert.pem'), crlFile: join(dir, 'junk.pem') })).toThrow(
      /tls\.clientAuth: the CA bundle or revocation list/,
    );
  });
});
