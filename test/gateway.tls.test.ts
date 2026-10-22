import { X509Certificate } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/observability/logger.js';
import {
  capturingLogger,
  type FakeUpstream,
  fixture,
  httpsRequest,
  json,
  type RunningGateway,
  rawRequest,
  rawTcp,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const cert1 = fixture('tls/localhost-cert.pem');
const key1 = fixture('tls/localhost-key.pem');
const cert2 = fixture('tls/localhost2-cert.pem');
const key2 = fixture('tls/localhost2-key.pem');
const ca1 = readFileSync(cert1);
const ca2 = readFileSync(cert2);
const fingerprintOf = (path: string): string => new X509Certificate(readFileSync(path)).fingerprint256;

const echo: UpstreamHandler = (_r, res, hit) => json(res, 200, { headers: hit.headers });

async function setup(
  tls: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  deps: Parameters<typeof startGateway>[1] = {},
): Promise<{ up: FakeUpstream; g: RunningGateway; base: string }> {
  const up = await startUpstream(echo);
  cleanups.push(up.close);
  const g = await startGateway(
    { upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }], tls, ...extra },
    deps,
  );
  cleanups.push(g.close);
  return { up, g, base: g.base.replace('http://', 'https://') };
}

const metrics = async (g: RunningGateway) => (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;

describe('TLS termination', () => {
  it('serves HTTPS and proxies to a plain-HTTP upstream, telling it the client used https', async () => {
    const { up, base } = await setup({ certFile: cert1, keyFile: key1 });
    const res = await httpsRequest(base, { path: '/hello', ca: ca1 });
    expect(res.status).toBe(200);
    expect(res.fingerprint).toBe(fingerprintOf(cert1));
    expect(up.hits[0]?.headers['x-forwarded-proto']).toBe('https');
    expect(JSON.parse(res.body).headers['x-forwarded-for']).toMatch(/^(127\.0\.0\.1|::1)$/);
  });

  it('does not answer plain HTTP on the TLS port, and counts the failed handshake', async () => {
    const { g, up } = await setup({ certFile: cert1, keyFile: key1 });
    const result = await rawTcp(g.base, 'GET /x HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n', { waitMs: 500 });
    expect(result.data).not.toMatch(/^HTTP\/1\.1 200/);
    expect(up.hits).toHaveLength(0);
    expect(await metrics(g)).toMatch(/gateway_tls_handshake_failures_total\{reason="ERR_SSL_HTTP_REQUEST"\} 1/);
  });

  it('refuses clients that cannot meet minVersion, and negotiates the newest otherwise', async () => {
    const strict = await setup({ certFile: cert1, keyFile: key1, minVersion: 'TLSv1.3' });
    await expect(httpsRequest(strict.base, { path: '/', ca: ca1, maxVersion: 'TLSv1.2' })).rejects.toThrow();
    expect((await httpsRequest(strict.base, { path: '/', ca: ca1 })).protocol).toBe('TLSv1.3');

    const lenient = await setup({ certFile: cert1, keyFile: key1 }); // default minVersion TLSv1.2
    const old = await httpsRequest(lenient.base, { path: '/', ca: ca1, maxVersion: 'TLSv1.2' });
    expect(old.status).toBe(200);
    expect(old.protocol).toBe('TLSv1.2');
  });

  it('serves many concurrent TLS clients', async () => {
    const { base } = await setup({ certFile: cert1, keyFile: key1 });
    const results = await Promise.all(Array.from({ length: 40 }, () => httpsRequest(base, { path: '/x', ca: ca1 })));
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('sends HSTS only when asked to', async () => {
    const off = await setup({ certFile: cert1, keyFile: key1 });
    expect((await httpsRequest(off.base, { path: '/', ca: ca1 })).headers['strict-transport-security']).toBeUndefined();
    const on = await setup({ certFile: cert1, keyFile: key1, hstsMaxAgeSeconds: 31_536_000 });
    expect((await httpsRequest(on.base, { path: '/', ca: ca1 })).headers['strict-transport-security']).toBe(
      'max-age=31536000',
    );
  });

  it('keeps the admin listener on plain loopback HTTP', async () => {
    const { g } = await setup({ certFile: cert1, keyFile: key1 });
    expect((await rawRequest(g.adminBase, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('cuts off a client that connects and never completes the handshake', async () => {
    const { g } = await setup({ certFile: cert1, keyFile: key1 }, { limits: { headersTimeoutMs: 300 } });
    const result = await rawTcp(g.base, '', { waitMs: 4_000 });
    expect(result.closed).toBe(true);
    expect(result.openedForMs).toBeLessThan(3_000);
  });
});

describe('private keys', () => {
  it('accepts a passphrase-protected key', async () => {
    const { base } = await setup({
      certFile: cert1,
      keyFile: fixture('tls/localhost-key-encrypted.pem'),
      passphrase: 'test-passphrase-not-a-secret',
    });
    expect((await httpsRequest(base, { path: '/', ca: ca1 })).status).toBe(200);
  });

  it('refuses to start with the wrong passphrase, a mismatched pair, or missing files', () => {
    const build = (tls: Record<string, unknown>) =>
      new Gateway(
        parseConfig({
          upstreams: { u: { url: 'http://127.0.0.1:1' } },
          routes: [{ path: '/', upstream: 'u' }],
          tls,
        }),
        { logger: silentLogger },
      );
    const encrypted = fixture('tls/localhost-key-encrypted.pem');
    expect(() => build({ certFile: cert1, keyFile: encrypted, passphrase: 'wrong' })).toThrow(/not a usable pair/);
    expect(() => build({ certFile: cert1, keyFile: encrypted })).toThrow(/not a usable pair/); // passphrase missing
    expect(() => build({ certFile: cert1, keyFile: key2 })).toThrow(/not a usable pair/); // key of another cert
    expect(() => build({ certFile: 'nope.pem', keyFile: key1 })).toThrow(/tls\.certFile: cannot read "nope\.pem"/);
    expect(() => build({ certFile: cert1, keyFile: 'nope.pem' })).toThrow(ConfigError);
  });

  it('does not put the key or passphrase in the error message', () => {
    try {
      new Gateway(
        parseConfig({
          upstreams: { u: { url: 'http://127.0.0.1:1' } },
          routes: [{ path: '/', upstream: 'u' }],
          tls: {
            certFile: cert1,
            keyFile: fixture('tls/localhost-key-encrypted.pem'),
            passphrase: 'a-wrong-passphrase-123',
          },
        }),
        { logger: silentLogger },
      );
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('a-wrong-passphrase-123');
      expect((error as Error).message).not.toContain('BEGIN');
    }
  });
});

describe('certificate reload', () => {
  /** Copies cert1/key1 into a temp dir the test can overwrite, as a renewal would. */
  function writable() {
    const dir = mkdtempSync(join(tmpdir(), 'gw-tls-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const certFile = join(dir, 'cert.pem');
    const keyFile = join(dir, 'key.pem');
    copyFileSync(cert1, certFile);
    copyFileSync(key1, keyFile);
    return { certFile, keyFile };
  }

  it('starts serving a renewed certificate to new connections, leaving open ones undisturbed', async () => {
    const files = writable();
    const { g, base } = await setup(files);
    const keepAlive = new https.Agent({ keepAlive: true, maxSockets: 1 });
    cleanups.push(() => keepAlive.destroy());

    const before = await httpsRequest(base, { path: '/', ca: ca1, agent: keepAlive });
    expect(before.fingerprint).toBe(fingerprintOf(cert1));

    copyFileSync(cert2, files.certFile); // the renewal lands on disk...
    copyFileSync(key2, files.keyFile);
    const result = g.gateway.reloadTls();
    expect(result.ok).toBe(true);

    const fresh = await httpsRequest(base, { path: '/', ca: ca2 }); // a new connection verifies against the new cert
    expect(fresh.fingerprint).toBe(fingerprintOf(cert2));
    const reused = await httpsRequest(base, { path: '/', ca: ca1, agent: keepAlive }); // the old connection still works
    expect(reused.status).toBe(200);
    expect(reused.fingerprint).toBe(fingerprintOf(cert1));
    await expect(httpsRequest(base, { path: '/', ca: ca1 })).rejects.toThrow(); // a new connection no longer matches ca1
  });

  it('keeps serving the old certificate when the new files are broken, and says so', async () => {
    const files = writable();
    const { logger, lines } = capturingLogger();
    const { g, base } = await setup(files, {}, { logger });

    writeFileSync(files.certFile, 'this is not a certificate');
    const garbage = g.gateway.reloadTls();
    expect(garbage.ok).toBe(false);

    copyFileSync(cert2, files.certFile); // a certificate whose key is still the old one: a half-finished renewal
    const mismatched = g.gateway.reloadTls();
    expect(mismatched).toMatchObject({ ok: false });
    expect((mismatched as { reason: string }).reason).toMatch(/not a usable pair/);

    rmSync(files.keyFile); // and a missing file
    expect(g.gateway.reloadTls().ok).toBe(false);

    const still = await httpsRequest(base, { path: '/', ca: ca1 });
    expect(still.fingerprint).toBe(fingerprintOf(cert1)); // never interrupted
    expect(lines.filter((l) => l['msg'] === 'tls reload failed; still serving the previous certificate')).toHaveLength(
      3,
    );
  });

  it('can be reloaded repeatedly', async () => {
    const files = writable();
    const { g, base } = await setup(files);
    for (const [c, k, ca] of [
      [cert2, key2, ca2],
      [cert1, key1, ca1],
      [cert2, key2, ca2],
    ] as const) {
      copyFileSync(c, files.certFile);
      copyFileSync(k, files.keyFile);
      expect(g.gateway.reloadTls().ok).toBe(true);
      expect((await httpsRequest(base, { path: '/', ca })).fingerprint).toBe(fingerprintOf(c));
    }
  });

  it('reports plainly when there is no TLS to reload', async () => {
    const up = await startUpstream(echo);
    cleanups.push(up.close);
    const g = await startGateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    cleanups.push(g.close);
    expect(g.gateway.reloadTls()).toEqual({ ok: false, reason: 'TLS is not enabled' });
  });
});

describe('certificate expiry', () => {
  const notAfter = new X509Certificate(ca1).validToDate.getTime();

  it('is exported as a gauge in seconds', async () => {
    const { g } = await setup({ certFile: cert1, keyFile: key1 });
    const m = await metrics(g);
    const seconds = Number(/gateway_tls_certificate_expiry_seconds (-?\d+)/.exec(m)?.[1]);
    expect(seconds).toBeGreaterThan(50 * 365 * 86_400); // the fixture is good for a century
  });

  it('warns when the certificate is close to expiring, and errors once it has', async () => {
    const soon = capturingLogger();
    await setup(
      { certFile: cert1, keyFile: key1 },
      {},
      { logger: soon.logger, clock: () => notAfter - 5 * 86_400_000 },
    );
    expect(soon.lines.find((l) => l['msg'] === 'tls certificate expires soon')).toMatchObject({
      daysLeft: 5,
      level: 'warn',
    });

    const expired = capturingLogger();
    const { g } = await setup(
      { certFile: cert1, keyFile: key1 },
      {},
      { logger: expired.logger, clock: () => notAfter + 86_400_000 },
    );
    expect(expired.lines.find((l) => l['msg'] === 'tls certificate has expired')).toMatchObject({ level: 'error' });
    expect(Number(/gateway_tls_certificate_expiry_seconds (-?\d+)/.exec(await metrics(g))?.[1])).toBeLessThan(0);
  });

  it('stays quiet when there is plenty of time', async () => {
    const calm = capturingLogger();
    await setup({ certFile: cert1, keyFile: key1 }, {}, { logger: calm.logger });
    expect(calm.lines.filter((l) => String(l['msg']).startsWith('tls certificate'))).toEqual([]);
  });

  it('is not exported without TLS', async () => {
    const up = await startUpstream(echo);
    cleanups.push(up.close);
    const g = await startGateway({ upstreams: { u: { url: up.url } }, routes: [{ path: '/', upstream: 'u' }] });
    cleanups.push(g.close);
    expect(await metrics(g)).not.toContain('gateway_tls_certificate_expiry_seconds{');
    expect(await metrics(g)).not.toMatch(/^gateway_tls_certificate_expiry_seconds \d/m);
  });
});

describe('tls configuration', () => {
  const base = { upstreams: { u: { url: 'http://localhost:9000' } }, routes: [{ path: '/', upstream: 'u' }] };
  const withTls = (tls: Record<string, unknown>) => parseConfig({ ...base, tls });

  it('needs both files, defaults to TLS 1.2 and above, and rejects older versions outright', () => {
    expect(withTls({ certFile: 'c', keyFile: 'k' }).tls).toEqual({
      certFile: 'c',
      keyFile: 'k',
      minVersion: 'TLSv1.2',
      http2: false,
    });
    expect(() => withTls({ certFile: 'c' })).toThrow();
    expect(() => withTls({ certFile: 'c', keyFile: 'k', minVersion: 'TLSv1.1' })).toThrow();
    expect(() => withTls({ certFile: 'c', keyFile: 'k', minVersion: 'TLSv1' })).toThrow();
    expect(() => withTls({ certFile: 'c', keyFile: 'k', typo: true })).toThrow();
  });

  it('bounds HSTS and treats an empty passphrase as unset', () => {
    expect(() => withTls({ certFile: 'c', keyFile: 'k', hstsMaxAgeSeconds: 0 })).toThrow();
    expect(() => withTls({ certFile: 'c', keyFile: 'k', hstsMaxAgeSeconds: 63_072_001 })).toThrow();
    expect(withTls({ certFile: 'c', keyFile: 'k', passphrase: '' }).tls?.passphrase).toBeUndefined();
  });
});
