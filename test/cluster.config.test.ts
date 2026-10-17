import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminListener } from '../src/admin.js';
import { resolveWorkers } from '../src/cluster/primary.js';
import { ConfigError, loadConfig, parseConfig } from '../src/config.js';
import { rawRequest } from './helpers.js';

const base = {
  upstreams: { u: { url: 'http://localhost:9000' } },
  routes: [{ path: '/', upstream: 'u' }],
};
const redis = { url: 'redis://localhost:6379' };
const config = (extra: Record<string, unknown>) => parseConfig({ ...base, ...extra });
const problem = (extra: Record<string, unknown>): string => {
  try {
    config(extra);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  return expect.unreachable('config was accepted');
};

describe('cluster config', () => {
  it('is a single process by default', () => {
    expect(config({}).cluster).toEqual({ workers: 1 });
  });

  it('takes a worker count or "auto" once there is a shared store to keep the limits in', () => {
    expect(config({ redis, cluster: { workers: 4 } }).cluster.workers).toBe(4);
    expect(config({ redis, cluster: { workers: 'auto' } }).cluster.workers).toBe('auto');
    expect(config({ redis, cluster: { workers: 1 } }).cluster.workers).toBe(1);
  });

  it('refuses more than one worker without Redis, because every worker would grant the full limit', () => {
    expect(problem({ cluster: { workers: 2 } })).toMatch(/more than one worker requires a redis section/);
    expect(problem({ cluster: { workers: 'auto' } })).toMatch(/requires a redis section/);
    expect(config({ cluster: { workers: 1 } }).cluster.workers).toBe(1);
  });

  it('refuses nonsense', () => {
    for (const workers of [0, -1, 1.5, 257, '4', 'many', null]) {
      expect(problem({ redis, cluster: { workers } }), String(workers)).toMatch(/cluster\.workers/);
    }
    expect(problem({ redis, cluster: { workers: 2, surprise: true } })).toBeTruthy();
  });
});

describe('WORKERS override', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const load = (file: Record<string, unknown>, env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-workers-'));
    dirs.push(dir);
    const path = join(dir, 'gateway.json');
    writeFileSync(path, JSON.stringify({ ...base, ...file }));
    return loadConfig(path, env);
  };

  it('sets the worker count from the environment, so one file serves every machine', () => {
    expect(load({ redis }, { WORKERS: '3' }).cluster.workers).toBe(3);
    expect(load({ redis }, { WORKERS: 'auto' }).cluster.workers).toBe('auto');
    expect(load({ redis, cluster: { workers: 8 } }, { WORKERS: '2' }).cluster.workers).toBe(2);
    expect(load({ redis, cluster: { workers: 8 } }, {}).cluster.workers).toBe(8);
  });

  it('still validates what the environment says', () => {
    expect(() => load({ redis }, { WORKERS: 'lots' })).toThrow(/cluster\.workers/);
    expect(() => load({}, { WORKERS: '2' })).toThrow(/requires a redis section/);
  });
});

describe('resolveWorkers', () => {
  it('turns "auto" into one worker per available core and passes a number through', () => {
    expect(resolveWorkers('auto')).toBe(availableParallelism());
    expect(resolveWorkers(5)).toBe(5);
  });
});

describe('AdminListener', () => {
  const listeners: AdminListener[] = [];
  afterEach(async () => {
    while (listeners.length) await listeners.pop()?.close();
  });
  const start = async (sources: Partial<ConstructorParameters<typeof AdminListener>[1]>, token?: string) => {
    const admin = new AdminListener(
      { host: '127.0.0.1', port: 0, token },
      {
        live: () => ({ status: 200, body: { status: 'ok' } }),
        ready: () => ({ status: 200, body: { status: 'ready' } }),
        health: () => ({ status: 'ok' }),
        metrics: () => 'm 1\n',
        ...sources,
      },
    );
    listeners.push(admin);
    const { port } = await admin.listen();
    return `http://127.0.0.1:${port}`;
  };

  it('serves what its sources say, awaiting them when they are async', async () => {
    const url = await start({ health: async () => ({ workers: 3 }), metrics: async () => 'async_metric 7\n' });
    expect(JSON.parse((await rawRequest(url, { path: '/_gateway/health' })).body)).toEqual({ workers: 3 });
    const metrics = await rawRequest(url, { path: '/_gateway/metrics' });
    expect(metrics.body).toBe('async_metric 7\n');
    expect(metrics.headers['content-type']).toMatch(/text\/plain/);
  });

  it('lets liveness choose its own status', async () => {
    const url = await start({ live: () => ({ status: 503, body: { status: 'unavailable' } }) });
    expect((await rawRequest(url, { path: '/_gateway/live' })).status).toBe(503);
  });

  it('answers a failing source with a generic 500 and stays up', async () => {
    const url = await start({
      health: () => {
        throw new Error('secret detail: 10.0.0.5');
      },
      metrics: async () => Promise.reject(new Error('another secret')),
    });
    for (const path of ['/_gateway/health', '/_gateway/metrics']) {
      const res = await rawRequest(url, { path });
      expect(res.status).toBe(500);
      expect(res.body).not.toMatch(/secret|10\.0\.0\.5/);
    }
    expect((await rawRequest(url, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('asks for the token everywhere but liveness', async () => {
    const url = await start({}, 'a-sufficiently-long-token');
    expect((await rawRequest(url, { path: '/_gateway/health' })).status).toBe(401);
    expect(
      (await rawRequest(url, { path: '/_gateway/health', headers: { authorization: 'Bearer nope' } })).status,
    ).toBe(401);
    expect(
      (
        await rawRequest(url, {
          path: '/_gateway/health',
          headers: { authorization: 'Bearer a-sufficiently-long-token' },
        })
      ).status,
    ).toBe(200);
    expect((await rawRequest(url, { path: '/_gateway/live' })).status).toBe(200);
  });

  it('only answers GET and HEAD, and knows its own paths', async () => {
    const url = await start({});
    expect((await rawRequest(url, { method: 'POST', path: '/_gateway/health' })).status).toBe(405);
    expect((await rawRequest(url, { path: '/_gateway/nothing' })).status).toBe(404);
    expect((await rawRequest(url, { method: 'HEAD', path: '/_gateway/health' })).body).toBe('');
  });
});
