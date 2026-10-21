import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { silentLogger } from '../src/observability/logger.js';
import { fixture, rawRequest, startGateway } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const serverCert = fixture('tls/localhost-cert.pem');
const serverKey = fixture('tls/localhost-key.pem');
const clientCert = fixture('tls/client-cert.pem');
const clientKey = fixture('tls/client-key.pem');

/** An HTTPS upstream that only talks to callers presenting a certificate signed by `trusted`. */
async function mtlsUpstream(trusted: string) {
  const callers: string[] = [];
  const server = https.createServer(
    {
      cert: readFileSync(serverCert),
      key: readFileSync(serverKey),
      requestCert: true,
      rejectUnauthorized: true,
      ca: [readFileSync(trusted)],
    },
    (req, res) => {
      const cn = (req.socket as TLSSocket).getPeerCertificate().subject?.CN;
      const caller = Array.isArray(cn) ? cn.join(',') : (cn ?? '');
      callers.push(caller);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, caller }));
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { url: `https://127.0.0.1:${(server.address() as AddressInfo).port}`, callers };
}

const gatewayFor = async (url: string, tls: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const g = await startGateway(
    {
      upstreams: { u: { url, tls: { caFile: serverCert, ...tls }, retry: { maxAttempts: 1 }, ...extra } },
      routes: [{ path: '/', upstream: 'u' }],
    },
    { manualHealthChecks: true },
  );
  cleanups.push(g.close);
  return g;
};

describe('mutual TLS to upstreams', () => {
  it('presents the configured client certificate', async () => {
    const up = await mtlsUpstream(clientCert);
    const g = await gatewayFor(up.url, { certFile: clientCert, keyFile: clientKey });
    const res = await rawRequest(g.base, { path: '/hello' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ path: '/hello', caller: 'gateway-client' });
  });

  it('is turned away, with a plain 502, by an upstream that requires a certificate it did not get', async () => {
    const up = await mtlsUpstream(clientCert);
    const g = await gatewayFor(up.url, {}); // trusts the server, presents nothing
    const res = await rawRequest(g.base, { path: '/hello' });
    expect(res.status).toBe(502);
    expect(JSON.parse(res.body).error.code).toBe('bad_gateway');
    expect(up.callers).toEqual([]);
  });

  it('is turned away when the certificate it presents is one the upstream does not trust', async () => {
    const up = await mtlsUpstream(clientCert);
    const g = await gatewayFor(up.url, {
      certFile: fixture('tls/localhost2-cert.pem'),
      keyFile: fixture('tls/localhost2-key.pem'),
    });
    expect((await rawRequest(g.base, { path: '/hello' })).status).toBe(502);
    expect(up.callers).toEqual([]);
  });

  it('can use an encrypted key, given its passphrase', async () => {
    const up = await mtlsUpstream(serverCert); // this upstream accepts the localhost certificate as a client
    const g = await gatewayFor(up.url, {
      certFile: serverCert,
      keyFile: fixture('tls/localhost-key-encrypted.pem'),
      passphrase: 'test-passphrase-not-a-secret',
    });
    const res = await rawRequest(g.base, { path: '/x' });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).caller).toBe('localhost');
  });

  it('presents the certificate on health probes too', async () => {
    const up = await mtlsUpstream(clientCert);
    const g = await gatewayFor(
      up.url,
      { certFile: clientCert, keyFile: clientKey },
      { healthCheck: { path: '/health', intervalMs: 60_000, timeoutMs: 1_000, unhealthyThreshold: 1 } },
    );
    await g.gateway.checkHealthNow();
    expect(up.callers).toEqual(['gateway-client']);
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).toMatch(/gateway_health_checks_total\{[^}]*result="ok"[^}]*\} 1/);
  });

  describe('refuses to start, naming the setting, when', () => {
    const build = (tls: Record<string, unknown>) => () =>
      new Gateway(
        parseConfig({
          upstreams: { u: { url: 'https://127.0.0.1:9', tls } },
          routes: [{ path: '/', upstream: 'u' }],
        }),
        { logger: silentLogger, manualHealthChecks: true },
      );

    it('the key does not match the certificate', () => {
      expect(build({ certFile: clientCert, keyFile: serverKey })).toThrow(
        /upstreams\.u\.tls: the client certificate and key are not a usable pair/,
      );
    });

    it('the passphrase is wrong or missing', () => {
      const encrypted = fixture('tls/localhost-key-encrypted.pem');
      expect(build({ certFile: serverCert, keyFile: encrypted, passphrase: 'wrong-passphrase' })).toThrow(
        /not a usable pair/,
      );
      expect(build({ certFile: serverCert, keyFile: encrypted })).toThrow(/not a usable pair/);
    });

    it('a file cannot be read', () => {
      expect(build({ certFile: fixture('tls/nope.pem'), keyFile: clientKey })).toThrow(
        /upstreams\.u\.tls\.certFile: cannot read/,
      );
      expect(build({ certFile: fixture('tls/nope.pem'), keyFile: clientKey })).toThrow(ConfigError);
    });
  });

  describe('config', () => {
    const problem = (tls: Record<string, unknown>, url = 'https://127.0.0.1:9') => {
      try {
        parseConfig({ upstreams: { u: { url, tls } }, routes: [{ path: '/', upstream: 'u' }] });
      } catch (error) {
        return (error as Error).message;
      }
      return expect.unreachable('config was accepted');
    };

    it('takes a CA, a client certificate, or both', () => {
      const ok = (tls: Record<string, unknown>) =>
        parseConfig({ upstreams: { u: { url: 'https://127.0.0.1:9', tls } }, routes: [{ path: '/', upstream: 'u' }] });
      expect(ok({ caFile: 'ca.pem' }).upstreams['u']?.tls).toEqual({ caFile: 'ca.pem' });
      expect(ok({ certFile: 'c.pem', keyFile: 'k.pem' }).upstreams['u']?.tls?.certFile).toBe('c.pem');
      expect(
        ok({ caFile: 'ca.pem', certFile: 'c.pem', keyFile: 'k.pem', passphrase: '' }).upstreams['u']?.tls?.passphrase,
      ).toBeUndefined();
    });

    it('refuses half a pair, a stray passphrase, nothing at all, or a plain http upstream', () => {
      expect(problem({ certFile: 'c.pem' })).toMatch(/certFile and keyFile go together/);
      expect(problem({ keyFile: 'k.pem' })).toMatch(/certFile and keyFile go together/);
      expect(problem({ caFile: 'ca.pem', passphrase: 'x' })).toMatch(/a passphrase is for keyFile/);
      expect(problem({})).toMatch(/set caFile/);
      expect(problem({ certFile: 'c.pem', keyFile: 'k.pem' }, 'http://127.0.0.1:9')).toMatch(/https:\/\//);
    });
  });
});
