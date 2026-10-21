/**
 * Reloading a running gateway's configuration, from the outside: edit the file, ask for a reload (the admin endpoint,
 * or SIGHUP), and watch the running process change, without a restart and without a refused connection.
 */
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { keyDigest } from '../../src/ratelimit/identity.js';
import { json, rawRequest, startUpstream } from '../helpers.js';
import { cleanupAll, type GatewayProc, onCleanup, startGatewayProc, until } from './stack.js';

afterEach(cleanupAll);

const TOKEN = 'reload-e2e-admin-token-123';
const redisUrl = process.env['REDIS_URL'];

async function echo() {
  const up = await startUpstream((_req, res, hit) => json(res, 200, { path: hit.url }));
  onCleanup(up.close);
  return up;
}

const config = (upstream: string, keys: string[], extraRoutes: Array<Record<string, unknown>> = []) => ({
  admin: { port: 0, token: TOKEN },
  rateLimit: { apiKeys: keys.map((name) => ({ name, sha256: keyDigest(`${name}-key`) })) },
  upstreams: { u: { url: upstream } },
  routes: [{ id: 'api', path: '/api', upstream: 'u', auth: { methods: ['api-key'] } }, ...extraRoutes],
});

const reload = (gw: GatewayProc) =>
  rawRequest(gw.adminBase, {
    method: 'POST',
    path: '/_gateway/reload',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
const get = (gw: GatewayProc, path: string, key?: string) =>
  rawRequest(gw.base, { path, headers: key ? { 'x-api-key': `${key}-key` } : {} });

describe('reloading a running gateway', { timeout: 60_000 }, () => {
  it('applies an edited file when asked through the admin listener, and refuses a broken one', async () => {
    const up = await echo();
    const gw = await startGatewayProc(config(up.url, ['alice']));
    expect((await get(gw, '/api/x', 'alice')).status).toBe(200);
    expect((await get(gw, '/public/x')).status).toBe(404);

    gw.rewrite(config(up.url, ['bob'], [{ id: 'public', path: '/public', upstream: 'u' }]));
    const done = await reload(gw);
    expect(done.status).toBe(200);
    expect(JSON.parse(done.body)).toMatchObject({ ok: true, generation: 2 });
    expect((await get(gw, '/public/x')).status).toBe(200); // a route that did not exist
    expect((await get(gw, '/api/x', 'alice')).status).toBe(401); // a key that was withdrawn
    expect((await get(gw, '/api/x', 'bob')).status).toBe(200); // and one that was issued

    writeFileSync(gw.configPath, '{ "this is": "not a gateway configuration" ');
    const refused = await reload(gw);
    expect(refused.status).toBe(422);
    expect(JSON.parse(refused.body).error).toMatch(/Could not read config/);
    expect((await get(gw, '/api/x', 'bob')).status).toBe(200); // the last good configuration is still in force
    expect(
      gw.proc.logs.some((l) => l['msg'] === 'configuration reload failed; still running the previous configuration'),
    ).toBe(true);
  });

  describe.skipIf(process.platform === 'win32')('on SIGHUP (POSIX)', () => {
    it('re-reads the file and applies it', async () => {
      const up = await echo();
      const gw = await startGatewayProc(config(up.url, ['alice']));
      gw.rewrite(config(up.url, ['alice'], [{ id: 'public', path: '/public', upstream: 'u' }]));
      gw.proc.child.kill('SIGHUP');
      await until(async () => (await get(gw, '/public/x')).status === 200, 10_000, 'the new route to appear');
      expect(gw.proc.child.exitCode).toBeNull(); // SIGHUP's default action would have ended the process
      expect(gw.proc.logs.some((l) => l['msg'] === 'configuration reloaded')).toBe(true);
    });
  });

  describe.skipIf(!redisUrl)('as a cluster', () => {
    it('reloads every worker, and says how each one fared', async () => {
      const up = await echo();
      const cluster = (extra: Array<Record<string, unknown>> = []) => ({
        ...config(up.url, ['alice'], extra),
        cluster: { workers: 2 },
        redis: { url: redisUrl, keyPrefix: `reload-e2e-${process.pid}-${Date.now()}:` },
      });
      const gw = await startGatewayProc(cluster());
      gw.rewrite(cluster([{ id: 'public', path: '/public', upstream: 'u' }]));

      const done = await reload(gw);
      expect(done.status).toBe(200);
      const body = JSON.parse(done.body) as { ok: boolean; workers: Array<{ worker: number; ok: boolean }> };
      expect(body.ok).toBe(true);
      expect(body.workers.map((w) => [w.worker, w.ok])).toEqual([
        [0, true],
        [1, true],
      ]);
      // Every connection lands on some worker; all of them know the new route.
      for (let i = 0; i < 8; i++) expect((await get(gw, '/public/x')).status).toBe(200);
    });
  });
});
