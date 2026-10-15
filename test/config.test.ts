import { describe, expect, it } from 'vitest';
import { ConfigError, expandEnv, parseConfig } from '../src/config.js';

const minimal = {
  upstreams: { users: { url: 'http://localhost:9000' } },
  routes: [{ path: '/users', upstream: 'users' }],
};

describe('expandEnv', () => {
  it('substitutes variables, with optional fallbacks, anywhere in the tree', () => {
    const out = expandEnv(
      { url: 'http://${HOST}:${PORT:-9000}/v1', nested: [{ k: '${HOST}' }], n: 5 },
      { HOST: 'svc' },
    );
    expect(out).toEqual({ url: 'http://svc:9000/v1', nested: [{ k: 'svc' }], n: 5 });
  });

  it('treats an empty variable as unset', () => {
    expect(expandEnv('${X:-fallback}', { X: '' })).toBe('fallback');
  });

  it('fails loudly on an unset variable with no fallback', () => {
    expect(() => expandEnv('${MISSING}', {})).toThrow(/MISSING/);
  });
});

describe('parseConfig', () => {
  it('fills in defaults for everything optional', () => {
    const cfg = parseConfig(minimal);
    expect(cfg.port).toBe(8080);
    expect(cfg.rateLimit.failureMode).toBe('local');
    expect(cfg.rateLimit.identityHeader).toBe('x-api-key');
    expect(cfg.upstreams['users']?.retry.maxAttempts).toBe(3);
    expect(cfg.upstreams['users']?.breaker.failureRateThreshold).toBe(0.5);
    expect(cfg.routes[0]?.stripPrefix).toBe(true);
  });

  it('accepts both rate-limit algorithms', () => {
    const cfg = parseConfig({
      ...minimal,
      rateLimit: { default: { algorithm: 'sliding-window', limit: 100, windowMs: 60_000 } },
      routes: [
        { path: '/a', upstream: 'users', rateLimit: { algorithm: 'token-bucket', capacity: 10, refillPerSecond: 2 } },
        { path: '/b', upstream: 'users', rateLimit: false },
      ],
    });
    expect(cfg.routes[0]?.rateLimit).toMatchObject({ algorithm: 'token-bucket', capacity: 10 });
    expect(cfg.routes[1]?.rateLimit).toBe(false);
  });

  it('rejects a route pointing at an upstream that does not exist', () => {
    expect(() => parseConfig({ ...minimal, routes: [{ path: '/x', upstream: 'nope' }] })).toThrow(
      /unknown upstream "nope"/,
    );
  });

  it('rejects typos instead of silently ignoring them', () => {
    expect(() => parseConfig({ ...minimal, prot: 9000 })).toThrow(ConfigError);
    expect(() =>
      parseConfig({
        ...minimal,
        routes: [
          { path: '/x', upstream: 'users', rateLimit: { algorithm: 'sliding-window', limt: 5, windowMs: 1000 } },
        ],
      }),
    ).toThrow(ConfigError);
  });

  it('rejects invalid limiter parameters', () => {
    const bad = (rule: unknown) =>
      parseConfig({ ...minimal, routes: [{ path: '/x', upstream: 'users', rateLimit: rule }] });
    expect(() => bad({ algorithm: 'sliding-window', limit: 0, windowMs: 1000 })).toThrow();
    expect(() => bad({ algorithm: 'token-bucket', capacity: 5, refillPerSecond: -1 })).toThrow();
    expect(() => bad({ algorithm: 'leaky-bucket' })).toThrow();
  });

  it('rejects duplicate route ids and the reserved admin prefix', () => {
    expect(() =>
      parseConfig({
        ...minimal,
        routes: [
          { path: '/a', upstream: 'users' },
          { path: '/b', id: '/a', upstream: 'users' },
        ],
      }),
    ).toThrow(/duplicate route id/);
    expect(() => parseConfig({ ...minimal, routes: [{ path: '/_gateway/x', upstream: 'users' }] })).toThrow(/reserved/);
  });

  it('only accepts tls options for https upstreams', () => {
    expect(() =>
      parseConfig({
        upstreams: { u: { url: 'http://svc', tls: { caFile: 'ca.pem' } } },
        routes: [{ path: '/', upstream: 'u' }],
      }),
    ).toThrow(/upstreams\.u\.tls: tls options require an https:\/\/ url/);
    expect(
      parseConfig({
        upstreams: { u: { url: 'https://svc', tls: { caFile: 'ca.pem' } } },
        routes: [{ path: '/', upstream: 'u' }],
      }).upstreams['u']?.tls,
    ).toEqual({ caFile: 'ca.pem' });
  });

  it('only allows http(s) upstreams', () => {
    expect(() =>
      parseConfig({ upstreams: { u: { url: 'ftp://example.com' } }, routes: [{ path: '/', upstream: 'u' }] }),
    ).toThrow();
  });

  it('reports every problem with its path', () => {
    try {
      parseConfig({ upstreams: {}, routes: [{ path: 'no-slash', upstream: 'x' }], port: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(/routes\.0\.path/);
      expect((error as Error).message).toMatch(/port/);
    }
  });
});
