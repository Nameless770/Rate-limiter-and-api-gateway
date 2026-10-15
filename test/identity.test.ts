import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { IdentityResolver, keyDigest, ruleFingerprint, scaleRule } from '../src/ratelimit/identity.js';

function resolver(rateLimit: Record<string, unknown>, routeIds: string[] = ['api']): IdentityResolver {
  const config = parseConfig({
    upstreams: { u: { url: 'http://localhost:9000' } },
    routes: routeIds.map((id) => ({ path: `/${id}`, id, upstream: 'u' })),
    rateLimit,
  });
  return new IdentityResolver(config.rateLimit);
}

const alice = { name: 'alice', sha256: keyDigest('alice-secret') };
const bob = { name: 'bob', sha256: keyDigest('bob-secret'), plan: 'pro' };

describe('open mode (no key registry)', () => {
  const r = resolver({});

  it('accepts any header value as its own identity, never storing it raw', () => {
    const result = r.resolve('anything-goes', '203.0.113.7');
    expect(result.ok && result.identity.kind).toBe('key');
    expect(result.ok && result.identity.id).toMatch(/^k:[0-9a-f]{32}$/);
    expect(JSON.stringify(result)).not.toContain('anything-goes');
  });

  it('gives different values different identities and the same value the same one', () => {
    const id = (k: string) => {
      const x = r.resolve(k, '1.1.1.1');
      return x.ok ? x.identity.id : '';
    };
    expect(id('a')).not.toBe(id('b'));
    expect(id('a')).toBe(id('a'));
  });

  it('falls back to the address when there is no key', () => {
    const result = r.resolve(undefined, '203.0.113.7');
    expect(result.ok && result.identity).toMatchObject({ id: 'ip:203.0.113.7', kind: 'anonymous' });
  });
});

describe('registry mode', () => {
  const r = resolver({ apiKeys: [alice, bob], plans: { pro: { multiplier: 5 } } });

  it('recognises registered keys and reports their name, plan and multiplier', () => {
    const a = r.resolve('alice-secret', '1.1.1.1');
    const b = r.resolve('bob-secret', '1.1.1.1');
    expect(a.ok && a.identity).toMatchObject({ kind: 'key', name: 'alice', multiplier: 1 });
    expect(b.ok && b.identity).toMatchObject({ kind: 'key', name: 'bob', multiplier: 5 });
  });

  it('gives a registered key the same identity from any address', () => {
    const one = r.resolve('alice-secret', '1.1.1.1');
    const two = r.resolve('alice-secret', '9.9.9.9');
    expect(one.ok && two.ok && one.identity.id === two.identity.id).toBe(true);
  });

  it('puts unregistered keys on the budget of their address, so rotating values gains nothing', () => {
    const ids = ['guess-1', 'guess-2', 'guess-3', undefined].map((k) => {
      const x = r.resolve(k, '203.0.113.7');
      return x.ok ? x.identity.id : '';
    });
    expect(new Set(ids)).toEqual(new Set(['ip:203.0.113.7']));
  });

  it('matches digests case-insensitively', () => {
    const upper = resolver({ apiKeys: [{ name: 'u', sha256: keyDigest('k').toUpperCase() }] });
    const result = upper.resolve('k', '1.1.1.1');
    expect(result.ok && result.identity.name).toBe('u');
  });
});

describe('requireKey and anonymousMultiplier', () => {
  it('rejects missing and unknown keys when a key is required', () => {
    const r = resolver({ apiKeys: [alice], requireKey: true });
    expect(r.resolve(undefined, '1.1.1.1')).toEqual({ ok: false, reason: 'key_required' });
    expect(r.resolve('nope', '1.1.1.1')).toEqual({ ok: false, reason: 'key_required' });
    expect(r.resolve('alice-secret', '1.1.1.1').ok).toBe(true);
  });

  it('applies the anonymous multiplier only to callers without a registered key', () => {
    const r = resolver({ apiKeys: [alice], anonymousMultiplier: 0.1 });
    const anon = r.resolve('guess', '1.1.1.1');
    const known = r.resolve('alice-secret', '1.1.1.1');
    expect(anon.ok && anon.identity.multiplier).toBe(0.1);
    expect(known.ok && known.identity.multiplier).toBe(1);
  });
});

describe('per-key overrides', () => {
  it('are carried on the identity', () => {
    const r = resolver(
      {
        apiKeys: [
          {
            ...alice,
            overrides: {
              api: { algorithm: 'sliding-window', limit: 7, windowMs: 1000 },
              other: false,
            },
          },
        ],
      },
      ['api', 'other'],
    );
    const x = r.resolve('alice-secret', '1.1.1.1');
    expect(x.ok && x.identity.overrides).toEqual({
      api: { algorithm: 'sliding-window', limit: 7, windowMs: 1000 },
      other: false,
    });
  });
});

describe('scaleRule', () => {
  it('returns the same rule for a multiplier of 1', () => {
    const rule = { algorithm: 'token-bucket', capacity: 10, refillPerSecond: 2 } as const;
    expect(scaleRule(rule, 1)).toBe(rule);
  });

  it('scales every allowance a rule has', () => {
    expect(scaleRule({ algorithm: 'token-bucket', capacity: 10, refillPerSecond: 2 }, 5)).toEqual({
      algorithm: 'token-bucket',
      capacity: 50,
      refillPerSecond: 10,
    });
    expect(scaleRule({ algorithm: 'sliding-window', limit: 100, windowMs: 1000 }, 0.5)).toEqual({
      algorithm: 'sliding-window',
      limit: 50,
      windowMs: 1000,
    });
    expect(scaleRule({ algorithm: 'sliding-window-counter', limit: 7, windowMs: 1000 }, 2.5)).toEqual({
      algorithm: 'sliding-window-counter',
      limit: 18, // ceil(17.5)
      windowMs: 1000,
    });
  });

  it('never scales an allowance to zero', () => {
    expect(scaleRule({ algorithm: 'sliding-window', limit: 3, windowMs: 1000 }, 0.01)).toMatchObject({ limit: 1 });
    expect(scaleRule({ algorithm: 'token-bucket', capacity: 3, refillPerSecond: 1 }, 0.01)).toMatchObject({
      capacity: 1,
    });
  });
});

describe('ruleFingerprint', () => {
  it('is independent of key order and differs when any parameter does', () => {
    const a = ruleFingerprint({ algorithm: 'sliding-window', limit: 5, windowMs: 1000 });
    const b = ruleFingerprint({ windowMs: 1000, limit: 5, algorithm: 'sliding-window' });
    const c = ruleFingerprint({ algorithm: 'sliding-window', limit: 6, windowMs: 1000 });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
