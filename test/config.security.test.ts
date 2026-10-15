import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig, upstreamTargets } from '../src/config.js';
import { keyDigest } from '../src/ratelimit/identity.js';
import { securityNotes } from '../src/security.js';

const base = {
  upstreams: { u: { url: 'http://localhost:9000' } },
  routes: [{ path: '/api', id: 'api', upstream: 'u' }],
};
const config = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
const problem = (extra: Record<string, unknown>) => {
  try {
    config(extra);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  return expect.unreachable('config was accepted');
};

describe('admin listener', () => {
  it('defaults to loopback on port 9090 with no token', () => {
    expect(config({}).admin).toEqual({ enabled: true, host: '127.0.0.1', port: 9090, token: undefined });
  });

  it('requires a token as soon as it is reachable beyond this machine', () => {
    expect(problem({ admin: { host: '0.0.0.0' } })).toMatch(/admin\.token.*required/);
    expect(problem({ admin: { host: '10.0.0.5' } })).toMatch(/admin\.token.*required/);
    expect(config({ admin: { host: '0.0.0.0', token: 'a-sufficiently-long-token' } }).admin.host).toBe('0.0.0.0');
  });

  it('rejects a token that is too short to be a credential', () => {
    expect(problem({ admin: { host: '0.0.0.0', token: 'short' } })).toMatch(/at least 16/);
  });

  it('treats an empty token as unset, so "${ADMIN_TOKEN:-}" works', () => {
    expect(config({ admin: { token: '' } }).admin.token).toBeUndefined();
    expect(problem({ admin: { host: '0.0.0.0', token: '' } })).toMatch(/token.*required/);
  });

  it('must not share the proxy port', () => {
    expect(problem({ port: 8080, admin: { port: 8080 } })).toMatch(/must differ/);
  });

  it('can be disabled', () => {
    expect(config({ admin: { enabled: false, host: '0.0.0.0' } }).admin.enabled).toBe(false);
  });
});

describe('upstream targets', () => {
  it('accepts exactly one of url and urls', () => {
    expect(problem({ upstreams: { u: {} } })).toMatch(/exactly one of "url" or "urls"/);
    expect(problem({ upstreams: { u: { url: 'http://a', urls: ['http://b'] } } })).toMatch(/exactly one/);
    const many = config({ upstreams: { u: { urls: ['http://a:1', 'http://b:2'] } } });
    expect(upstreamTargets(many.upstreams['u'] as never)).toEqual(['http://a:1', 'http://b:2']);
    expect(many.upstreams['u']?.balance).toBe('round-robin');
  });

  it('rejects duplicate targets', () => {
    expect(problem({ upstreams: { u: { urls: ['http://a:1', 'http://a:1'] } } })).toMatch(/duplicates/);
  });

  it('requires every target to be https when tls options are given', () => {
    expect(problem({ upstreams: { u: { urls: ['https://a', 'http://b'], tls: { caFile: 'ca.pem' } } } })).toMatch(
      /every target/,
    );
  });

  it('accepts a known balance strategy and rejects others', () => {
    expect(config({ upstreams: { u: { urls: ['http://a'], balance: 'least-pending' } } }).upstreams['u']?.balance).toBe(
      'least-pending',
    );
    expect(() => config({ upstreams: { u: { urls: ['http://a'], balance: 'random' } } })).toThrow();
  });
});

describe('api key registry', () => {
  const alice = { name: 'alice', sha256: keyDigest('alice-key') };

  it('accepts digests, plans and per-route overrides', () => {
    const cfg = config({
      rateLimit: {
        plans: { pro: { multiplier: 10 } },
        apiKeys: [
          { ...alice, plan: 'pro' },
          {
            name: 'bob',
            sha256: keyDigest('bob-key'),
            overrides: { api: { algorithm: 'token-bucket', capacity: 5, refillPerSecond: 1 } },
          },
        ],
      },
    });
    expect(cfg.rateLimit.apiKeys).toHaveLength(2);
  });

  it('refuses a raw key where a digest belongs, so a secret is not left in the config file', () => {
    expect(problem({ rateLimit: { apiKeys: [{ name: 'x', sha256: 'my-actual-api-key' }] } })).toMatch(
      /64-character hex SHA-256/,
    );
  });

  it('rejects duplicates and dangling references', () => {
    expect(problem({ rateLimit: { apiKeys: [alice, { ...alice, sha256: keyDigest('other') }] } })).toMatch(
      /duplicate key name/,
    );
    expect(problem({ rateLimit: { apiKeys: [alice, { name: 'twin', sha256: alice.sha256 }] } })).toMatch(
      /duplicate key digest/,
    );
    expect(problem({ rateLimit: { apiKeys: [{ ...alice, plan: 'ghost' }] } })).toMatch(/unknown plan "ghost"/);
    expect(problem({ rateLimit: { apiKeys: [{ ...alice, overrides: { nope: false } }] } })).toMatch(
      /unknown route id "nope"/,
    );
  });

  it('only allows requireKey when there is a registry to check against', () => {
    expect(problem({ rateLimit: { requireKey: true } })).toMatch(/requireKey needs at least one/);
    expect(config({ rateLimit: { requireKey: true, apiKeys: [alice] } }).rateLimit.requireKey).toBe(true);
  });

  it('bounds the anonymous multiplier to (0, 1]', () => {
    expect(() => config({ rateLimit: { anonymousMultiplier: 0 } })).toThrow();
    expect(() => config({ rateLimit: { anonymousMultiplier: 1.5 } })).toThrow();
    expect(config({ rateLimit: { anonymousMultiplier: 0.25 } }).rateLimit.anonymousMultiplier).toBe(0.25);
  });
});

describe('redis and limits', () => {
  it('only accepts redis:// and rediss:// urls', () => {
    expect(problem({ redis: { url: 'http://localhost' } })).toMatch(/redis:\/\/ or rediss:\/\//);
    expect(config({ redis: { url: 'rediss://:pw@cache.internal:6380' } }).redis?.url).toMatch(/^rediss:/);
  });

  it('allows a CA bundle only with TLS', () => {
    expect(problem({ redis: { url: 'redis://cache', caFile: 'ca.pem' } })).toMatch(/caFile requires a rediss/);
    expect(config({ redis: { url: 'rediss://cache', caFile: 'ca.pem' } }).redis?.caFile).toBe('ca.pem');
  });

  it('ships safe defaults', () => {
    const cfg = config({});
    expect(cfg.allowedMethods).toEqual(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
    expect(cfg.allowedMethods).not.toContain('TRACE');
    expect(cfg.limits).toMatchObject({ maxHeaderBytes: 16384, headersTimeoutMs: 15000, maxInFlight: 2000 });
    expect(cfg.rateLimit.ipv6Prefix).toBe(64);
  });

  it('upper-cases configured methods', () => {
    expect(config({ allowedMethods: ['get', 'post'] }).allowedMethods).toEqual(['GET', 'POST']);
  });

  it('defaults cached routes to forwarding only accept and accept-language', () => {
    const cfg = config({ routes: [{ path: '/c', upstream: 'u', cache: { ttlMs: 1000 } }] });
    expect(cfg.routes[0]?.cache?.forwardHeaders).toEqual(['accept', 'accept-language']);
  });
});

describe('securityNotes', () => {
  const limited = { rateLimit: { default: { algorithm: 'sliding-window', limit: 10, windowMs: 1000 } } };

  it('warns that a header-keyed limit can be dodged when there is no registry or address ceiling', () => {
    expect(securityNotes(config(limited)).join('\n')).toMatch(/fresh budget by changing the header/);
  });

  it('stays quiet about that once either defence is configured', () => {
    const withCeiling = config({
      rateLimit: { ...limited.rateLimit, ip: { algorithm: 'sliding-window', limit: 100, windowMs: 1000 } },
    });
    const withRegistry = config({
      rateLimit: { ...limited.rateLimit, apiKeys: [{ name: 'a', sha256: keyDigest('a') }] },
    });
    expect(securityNotes(withCeiling).join('\n')).not.toMatch(/fresh budget/);
    expect(securityNotes(withRegistry).join('\n')).not.toMatch(/fresh budget/);
  });

  it('does not nag about limits when nothing is rate limited', () => {
    expect(securityNotes(config({})).join('\n')).not.toMatch(/fresh budget/);
  });

  it('flags plaintext Redis to a remote host, but not to loopback or over TLS', () => {
    expect(securityNotes(config({ redis: { url: 'redis://cache.example.com:6379' } })).join('\n')).toMatch(
      /not encrypted/,
    );
    expect(securityNotes(config({ redis: { url: 'redis://127.0.0.1:6379' } })).join('\n')).not.toMatch(/not encrypted/);
    expect(securityNotes(config({ redis: { url: 'rediss://cache.example.com:6380' } })).join('\n')).not.toMatch(
      /not encrypted/,
    );
  });

  it('flags a cache with no vary headers', () => {
    const cfg = config({ routes: [{ path: '/pub', id: 'pub', upstream: 'u', cache: { ttlMs: 1, varyHeaders: [] } }] });
    expect(securityNotes(cfg).join('\n')).toMatch(/route "pub" caches with no varyHeaders/);
  });
});
