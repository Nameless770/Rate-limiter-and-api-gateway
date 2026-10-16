import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config.js';
import {
  type FakeUpstream,
  fixture,
  json,
  type RunningGateway,
  rawRequest,
  sleep,
  startGateway,
  startUpstream,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A target whose /health answer is switchable at runtime; every other path answers 200 naming the target. */
interface Switchable {
  up: FakeUpstream;
  healthStatus: number;
  healthDelayMs: number;
  /** Requests that were not health probes: the traffic the gateway actually proxied here. */
  proxied(): number;
  probes(): FakeUpstream['hits'];
}

async function target(name: string, tls?: { key: Buffer; cert: Buffer }, healthPath = '/health'): Promise<Switchable> {
  const state = { healthStatus: 200, healthDelayMs: 0 };
  const handler: UpstreamHandler = async (_r, res, hit) => {
    if (hit.url.split('?')[0]?.endsWith(healthPath)) {
      if (state.healthDelayMs) await sleep(state.healthDelayMs);
      return json(res, state.healthStatus, { name });
    }
    return json(res, 200, { from: name });
  };
  const up = await startUpstream(handler, tls ? { tls } : {});
  cleanups.push(up.close);
  return {
    up,
    get healthStatus() {
      return state.healthStatus;
    },
    set healthStatus(v: number) {
      state.healthStatus = v;
    },
    get healthDelayMs() {
      return state.healthDelayMs;
    },
    set healthDelayMs(v: number) {
      state.healthDelayMs = v;
    },
    proxied: () => up.hits.filter((h) => !h.url.endsWith(healthPath)).length,
    probes: () => up.hits.filter((h) => h.url.endsWith(healthPath)),
  };
}

const hc = { path: '/health', intervalMs: 60_000, timeoutMs: 500, unhealthyThreshold: 2, healthyThreshold: 2 };

async function gateway(
  urls: string[],
  health: Record<string, unknown> | null = hc,
  extra: Record<string, unknown> = {},
  deps: Parameters<typeof startGateway>[1] = { manualHealthChecks: true },
): Promise<RunningGateway> {
  const g = await startGateway(
    {
      upstreams: { pool: { urls, ...(health ? { healthCheck: health } : {}), retry: { maxAttempts: 1 }, ...extra } },
      routes: [{ path: '/', upstream: 'pool' }],
    },
    deps,
  );
  cleanups.push(g.close);
  return g;
}

const get = (g: RunningGateway, path = '/x') => rawRequest(g.base, { path });
const times = async (n: number, fn: () => Promise<unknown>) => {
  for (let i = 0; i < n; i++) await fn();
};
const adminJson = async (g: RunningGateway, path: string) => JSON.parse((await rawRequest(g.adminBase, { path })).body);

describe('active health checks', () => {
  it('keep traffic off a failing target before any client has to fail to find out', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url]);

    await g.gateway.checkHealthNow(); // both healthy
    b.healthStatus = 500;
    await g.gateway.checkHealthNow();
    expect(b.up.hits.length).toBeGreaterThan(0);
    await g.gateway.checkHealthNow(); // second consecutive failure: condemned

    const before = b.proxied();
    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await get(g)).status);

    expect(statuses.every((s) => s === 200)).toBe(true);
    expect(b.proxied() - before).toBe(0); // not one request reached it...
    expect(a.proxied()).toBe(20);
    // ...and the breaker never saw it, because no request was sent: this is what active checking adds.
    expect(g.gateway.circuits('pool')[b.up.url.replace('http://', '')]?.snapshot().total).toBe(0);
  });

  it('put the target back in rotation after enough consecutive good probes', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url]);
    b.healthStatus = 503;
    await times(2, () => g.gateway.checkHealthNow());
    await times(6, () => get(g));
    expect(b.proxied()).toBe(0);

    b.healthStatus = 200;
    await g.gateway.checkHealthNow();
    await times(6, () => get(g));
    expect(b.proxied()).toBe(0); // one good probe is not enough (healthyThreshold is 2)

    await g.gateway.checkHealthNow();
    await times(10, () => get(g));
    expect(b.proxied()).toBeGreaterThan(3); // back, and sharing the load
  });

  it('ignore the verdict when every target is unhealthy, so a wrong health path cannot take a service offline', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url]);
    a.healthStatus = 404; // e.g. the configured path does not exist
    b.healthStatus = 404;
    await times(2, () => g.gateway.checkHealthNow());

    const health = await adminJson(g, '/_gateway/health');
    expect(health.upstreams.pool.targets.map((t: { healthy: boolean }) => t.healthy)).toEqual([false, false]);

    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await get(g)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]); // still served
  });

  it('apply to single-target upstreams too, with the same safety net', async () => {
    const only = await target('only');
    const g = await gateway([only.up.url]);
    only.healthStatus = 500;
    await times(2, () => g.gateway.checkHealthNow());
    expect((await get(g)).status).toBe(200);
    expect((await adminJson(g, '/_gateway/health')).upstreams.pool.targets[0].healthy).toBe(false);
  });

  it('treat a slow health endpoint as unhealthy', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url], { ...hc, timeoutMs: 100 });
    b.healthDelayMs = 400;
    await times(2, () => g.gateway.checkHealthNow());

    const health = await adminJson(g, '/_gateway/health');
    const slow = health.upstreams.pool.targets.find((t: { id: string }) => t.id === new URL(b.up.url).host);
    expect(slow.healthy).toBe(false);
    expect(slow.healthCheck.lastError).toBe('timeout');
  });

  it('treat a refused connection as unhealthy', async () => {
    const live = await target('live');
    const dead = await target('dead');
    const deadUrl = dead.up.url;
    await dead.up.close();
    const g = await gateway([live.up.url, deadUrl]);
    await times(2, () => g.gateway.checkHealthNow());

    const health = await adminJson(g, '/_gateway/health');
    const downed = health.upstreams.pool.targets.find((t: { id: string }) => t.id === new URL(deadUrl).host);
    expect(downed.healthy).toBe(false);
    expect(downed.healthCheck.lastError).toBe('connect');
  });

  it('honour method, headers, expected statuses and the target base path', async () => {
    const t = await target('t', undefined, '/status/ready');
    const g = await gateway(
      [`${t.up.url}/base`],
      {
        ...hc,
        path: '/status/ready',
        method: 'HEAD',
        expectStatus: [204, 200],
        headers: { 'X-Probe-Token': 'secret-probe-token' },
      },
      { retry: { maxAttempts: 1 } },
    );
    t.healthStatus = 204;
    await g.gateway.checkHealthNow();
    const probe = t.up.hits[0];
    expect(probe?.method).toBe('HEAD');
    expect(probe?.url).toBe('/base/status/ready');
    expect(probe?.headers['x-probe-token']).toBe('secret-probe-token');
    expect(probe?.headers['user-agent']).toBe('api-gateway-healthcheck');
    expect(probe?.headers['host']).toBe(new URL(t.up.url).host);

    t.healthStatus = 202; // 2xx, but not in the expected list
    await times(2, () => g.gateway.checkHealthNow());
    expect((await adminJson(g, '/_gateway/health')).upstreams.pool.targets[0].healthy).toBe(false);
  });

  it('default to any 2xx, and treat redirects and client errors as failures', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url]);
    for (const [status, healthy] of [
      [200, true],
      [204, true],
      [299, true],
      [301, false],
      [404, false],
      [500, false],
    ] as const) {
      b.healthStatus = status;
      await times(2, () => g.gateway.checkHealthNow());
      const h = (await adminJson(g, '/_gateway/health')).upstreams.pool.targets.find(
        (x: { id: string }) => x.id === new URL(b.up.url).host,
      );
      expect(h.healthy, `status ${status}`).toBe(healthy);
    }
  });

  it('are independent of proxied traffic: probes do not touch the breaker, the rate limiter or the cache', async () => {
    const t = await target('t');
    const g = await gateway([t.up.url], hc, { breaker: { minimumRequests: 1 } }, { manualHealthChecks: true });
    t.healthStatus = 500;
    await times(10, () => g.gateway.checkHealthNow());

    const circuit = g.gateway.circuit('pool')?.snapshot();
    expect(circuit).toMatchObject({ state: 'closed', total: 0, failures: 0 });
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).not.toMatch(/gateway_requests_total\{route="[^"]*",status="5/);
  });

  it('are visible in metrics and on the health page without leaking addresses', async () => {
    const [a, b] = [await target('a'), await target('b')];
    const g = await gateway([a.up.url, b.up.url]);
    b.healthStatus = 500;
    await times(2, () => g.gateway.checkHealthNow());

    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    const bHost = new URL(b.up.url).host.replace('.', '\\.');
    expect(metrics).toMatch(new RegExp(`gateway_target_healthy\\{target="${bHost}",upstream="pool"\\} 0`));
    expect(metrics).toMatch(/gateway_target_healthy\{target="127\.0\.0\.1:\d+",upstream="pool"\} 1/);
    expect(metrics).toMatch(/gateway_health_checks_total\{result="fail",target="127\.0\.0\.1:\d+",upstream="pool"\} 2/);
    expect(metrics).toMatch(
      /gateway_health_transitions_total\{target="127\.0\.0\.1:\d+",to="unhealthy",upstream="pool"\} 1/,
    );

    const body = (await rawRequest(g.adminBase, { path: '/_gateway/health' })).body;
    const parsed = JSON.parse(body);
    const bad = parsed.upstreams.pool.targets.find((t: { healthy: boolean }) => !t.healthy);
    expect(bad.healthCheck).toMatchObject({
      healthy: false,
      consecutiveFailures: 2,
      lastStatus: 500,
      lastError: 'status 500',
    });
  });

  it('do not expose the metric for upstreams without a health check', async () => {
    const t = await target('t');
    const g = await gateway([t.up.url], null);
    const metrics = (await rawRequest(g.adminBase, { path: '/_gateway/metrics' })).body;
    expect(metrics).not.toContain('gateway_target_healthy{');
    expect((await adminJson(g, '/_gateway/health')).upstreams.pool.targets[0].healthCheck).toBeUndefined();
  });

  it('probe HTTPS targets using the configured CA', async () => {
    const tls = {
      key: readFileSync(fixture('tls/localhost-key.pem')),
      cert: readFileSync(fixture('tls/localhost-cert.pem')),
    };
    const t = await target('secure', tls);
    const g = await gateway([t.up.url], hc, { tls: { caFile: fixture('tls/localhost-cert.pem') } });
    await times(2, () => g.gateway.checkHealthNow());
    expect(t.probes().length).toBe(2);
    expect((await adminJson(g, '/_gateway/health')).upstreams.pool.targets[0].healthCheck.lastError).toBeUndefined();

    const noCa = await gateway([t.up.url], hc, {}); // default trust store: the self-signed cert must fail
    await times(2, () => noCa.gateway.checkHealthNow());
    const failing = (await adminJson(noCa, '/_gateway/health')).upstreams.pool.targets[0];
    expect(failing.healthy).toBe(false);
    expect(failing.healthCheck.lastError).toBe('tls');
  });
});

describe('background scheduling', () => {
  it('detects a failing target on its own, and stops probing once the gateway closes', async () => {
    const [a, b] = [await target('a'), await target('b')];
    b.healthStatus = 500;
    const g = await gateway(
      [a.up.url, b.up.url],
      { ...hc, intervalMs: 40, timeoutMs: 30 },
      {},
      {}, // timers on
    );

    let unhealthy = false;
    for (let i = 0; i < 100 && !unhealthy; i++) {
      await sleep(20);
      const h = await adminJson(g, '/_gateway/health');
      unhealthy = h.upstreams.pool.targets.some((t: { healthy: boolean }) => !t.healthy);
    }
    expect(unhealthy).toBe(true);
    const probesWhileRunning = b.probes().length;
    expect(probesWhileRunning).toBeGreaterThanOrEqual(2);

    await g.close();
    const after = b.probes().length;
    await sleep(200); // five intervals
    expect(b.probes().length).toBe(after); // no further probes: the timers were cancelled
  });
});

describe('health check configuration', () => {
  const base = {
    upstreams: { u: { url: 'http://localhost:9000', healthCheck: { path: '/health' } } },
    routes: [{ path: '/', upstream: 'u' }],
  };
  const withHealth = (healthCheck: Record<string, unknown>) =>
    parseConfig({ ...base, upstreams: { u: { url: 'http://localhost:9000', healthCheck } } });

  it('has sensible defaults', () => {
    expect(parseConfig(base).upstreams['u']?.healthCheck).toEqual({
      path: '/health',
      method: 'GET',
      intervalMs: 5000,
      timeoutMs: 2000,
      unhealthyThreshold: 2,
      healthyThreshold: 2,
      headers: {},
    });
  });

  it('requires a path that starts with a slash', () => {
    expect(() => withHealth({ path: 'health' })).toThrow(ConfigError);
    expect(() => withHealth({})).toThrow(ConfigError);
  });

  it('rejects a timeout that would let probes overlap', () => {
    expect(() => withHealth({ path: '/h', intervalMs: 1000, timeoutMs: 1000 })).toThrow(/shorter than intervalMs/);
    expect(withHealth({ path: '/h', intervalMs: 1000, timeoutMs: 999 })).toBeDefined();
  });

  it('refuses to let a probe set framing or routing headers', () => {
    for (const name of ['Host', 'content-length', 'Connection', 'Transfer-Encoding', 'upgrade']) {
      expect(() => withHealth({ path: '/h', headers: { [name]: 'x' } }), name).toThrow(
        /cannot be set on a health probe/,
      );
    }
    expect(withHealth({ path: '/h', headers: { Authorization: 'Bearer probe' } })).toBeDefined();
  });

  it('only allows GET and HEAD probes, and sane thresholds', () => {
    expect(() => withHealth({ path: '/h', method: 'POST' })).toThrow();
    expect(() => withHealth({ path: '/h', unhealthyThreshold: 0 })).toThrow();
    expect(() => withHealth({ path: '/h', expectStatus: [] })).toThrow();
    expect(() => withHealth({ path: '/h', typo: 1 })).toThrow();
  });
});
