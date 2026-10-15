import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, upstreamTargets } from '../src/config.js';
import { securityNotes } from '../src/security.js';

const path = fileURLToPath(new URL('../gateway.config.json', import.meta.url));

describe('the shipped gateway.config.json', () => {
  it('loads with no environment variables set, so it works out of the box', () => {
    const cfg = loadConfig(path, {});
    expect(cfg.port).toBe(8080);
    expect(upstreamTargets(cfg.upstreams['demo'] as never)).toEqual(['http://localhost:9001']);
    expect(cfg.routes.map((r) => r.id)).toEqual(['time', 'echo', 'slow', 'flaky']);
  });

  it('keeps the admin listener on loopback unless the operator opts out and supplies a token', () => {
    expect(loadConfig(path, {}).admin).toMatchObject({ host: '127.0.0.1', port: 9090, token: undefined });
    expect(() => loadConfig(path, { ADMIN_HOST: '0.0.0.0' })).toThrow(/admin\.token/);
    const exposed = loadConfig(path, { ADMIN_HOST: '0.0.0.0', ADMIN_TOKEN: 'a-long-enough-bearer-token' });
    expect(exposed.admin.host).toBe('0.0.0.0');
  });

  it('applies the documented environment overrides', () => {
    const cfg = loadConfig(path, { PORT: '9999', REDIS_URL: 'redis://redis:6379', UPSTREAM_URL: 'http://svc:1' });
    expect(cfg.port).toBe(9999);
    expect(cfg.redis?.url).toBe('redis://redis:6379');
    expect(upstreamTargets(cfg.upstreams['demo'] as never)).toEqual(['http://svc:1']);
  });

  it('ships with a per-address ceiling, so it does not trip the "header can be dodged" note', () => {
    const cfg = loadConfig(path, {});
    expect(cfg.rateLimit.ip).toBeDefined();
    expect(securityNotes(cfg).join('\n')).not.toMatch(/fresh budget/);
  });
});
