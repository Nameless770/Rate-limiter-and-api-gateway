import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { Router } from '../src/router.js';

function router(routes: Array<Record<string, unknown>>): Router {
  const config = parseConfig({
    upstreams: { svc: { url: 'http://localhost:9000' } },
    routes: routes.map((r) => ({ upstream: 'svc', ...r })),
  });
  return new Router(config.routes);
}

describe('Router', () => {
  it('matches on whole path segments only', () => {
    const r = router([{ path: '/users' }]);
    expect(r.match('/users', 'GET')?.upstreamPath).toBe('/');
    expect(r.match('/users/42', 'GET')?.upstreamPath).toBe('/42');
    expect(r.match('/usersettings', 'GET')).toBeUndefined();
    expect(r.match('/user', 'GET')).toBeUndefined();
  });

  it('prefers the most specific prefix regardless of config order', () => {
    const r = router([{ path: '/api', id: 'general' }, { path: '/api/orders', id: 'orders' }]);
    expect(r.match('/api/orders/7', 'GET')?.routeId).toBe('orders');
    expect(r.match('/api/other', 'GET')?.routeId).toBe('general');
  });

  it('keeps the prefix when stripPrefix is false', () => {
    const r = router([{ path: '/v1', stripPrefix: false }]);
    expect(r.match('/v1/things', 'GET')?.upstreamPath).toBe('/v1/things');
  });

  it('supports a catch-all root route', () => {
    const r = router([{ path: '/' }]);
    expect(r.match('/anything/at/all', 'GET')?.upstreamPath).toBe('/anything/at/all');
    expect(r.match('/', 'GET')?.upstreamPath).toBe('/');
  });

  it('falls through to a broader route when the method does not match', () => {
    const r = router([
      { path: '/items', id: 'write', methods: ['POST'] },
      { path: '/', id: 'fallback' },
    ]);
    expect(r.match('/items', 'POST')?.routeId).toBe('write');
    expect(r.match('/items', 'GET')?.routeId).toBe('fallback');
  });

  it('returns undefined when nothing matches', () => {
    expect(router([{ path: '/a' }]).match('/b', 'GET')).toBeUndefined();
  });
});
