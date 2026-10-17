import { afterEach, describe, expect, it } from 'vitest';
import { json, type RunningGateway, rawRequest, sleep, startGateway, startUpstream } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(admin: Record<string, unknown> = {}, delayMs = 0) {
  const up = await startUpstream(async (_req, res) => {
    if (delayMs) await sleep(delayMs);
    json(res, 200, { ok: true });
  });
  cleanups.push(up.close);
  const g = await startGateway({
    admin,
    upstreams: { u: { url: up.url } },
    routes: [{ path: '/', upstream: 'u' }],
  });
  cleanups.push(g.close);
  return { up, g };
}

const status = (g: RunningGateway, path: string) => rawRequest(g.adminBase, { path });

describe('readiness (/_gateway/ready)', () => {
  it('says ready while serving, and is open like liveness even when the rest of the admin listener needs a token', async () => {
    const { g } = await setup({ token: 'a-sufficiently-long-admin-token' });
    const ready = await status(g, '/_gateway/ready');
    expect(ready.status).toBe(200);
    expect(JSON.parse(ready.body)).toEqual({ status: 'ready' });
    expect((await status(g, '/_gateway/live')).status).toBe(200);
    expect((await status(g, '/_gateway/health')).status).toBe(401); // the token still guards the rest
  });

  it('is not reachable through the proxy port', async () => {
    const { g } = await setup();
    expect((await rawRequest(g.base, { path: '/_gateway/ready' })).status).toBe(404);
  });

  it('turns to "draining" the moment shutdown begins, while the process is alive and still finishing requests', async () => {
    const { g } = await setup({}, 700);
    const inflight = rawRequest(g.base, { path: '/slow' });
    await sleep(150);

    const closing = g.gateway.close(5_000); // not awaited: this is the drain
    await sleep(100);
    const ready = await status(g, '/_gateway/ready');
    expect(ready.status).toBe(503);
    expect(JSON.parse(ready.body)).toEqual({ status: 'draining' });
    expect((await status(g, '/_gateway/live')).status).toBe(200); // still alive: do not restart it mid-drain

    expect((await inflight).status).toBe(200); // and the request that was in flight is served in full
    await closing;
  });
});
