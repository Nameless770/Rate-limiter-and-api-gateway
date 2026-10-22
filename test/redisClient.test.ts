/**
 * The three ways to reach Redis (one server, Sentinel, Cluster): what the configuration accepts, and the client each
 * one builds. Nothing here connects; test/redis.topologies.integration.test.ts runs against real deployments.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cluster, Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { type GatewayConfig, loadConfig, parseConfig, redisMode, splitHostPort } from '../src/config.js';
import { silentLogger } from '../src/observability/logger.js';
import { createRedisClient } from '../src/redisClient.js';
import { securityNotes } from '../src/security.js';
import { fixture, startGateway } from './helpers.js';

const base = { upstreams: { u: { url: 'http://127.0.0.1:1' } }, routes: [{ path: '/', upstream: 'u' }] };
const withRedis = (redis: Record<string, unknown>): GatewayConfig => parseConfig({ ...base, redis });
const refused = (redis: Record<string, unknown>): string => {
  try {
    withRedis(redis);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the configuration was accepted');
};

const clients: Array<Redis | Cluster> = [];
afterEach(() => {
  while (clients.length) clients.pop()?.disconnect();
});
const build = (redis: Record<string, unknown>) => {
  const config = withRedis(redis).redis as NonNullable<GatewayConfig['redis']>;
  const client = createRedisClient(config, silentLogger);
  clients.push(client);
  return client;
};

describe('redis configuration', () => {
  it('takes one server, a sentinel group, or a cluster', () => {
    expect(redisMode(withRedis({ url: 'redis://10.0.0.1:6379' }).redis as never)).toBe('standalone');
    const sentinel = withRedis({ sentinel: { name: 'gw', nodes: ['10.0.0.1:26379', '[::1]:26380'] } }).redis;
    expect(redisMode(sentinel as never)).toBe('sentinel');
    const cluster = withRedis({ cluster: { nodes: ['redis-a:7000', 'redis-b:7001'] }, password: 'pw' }).redis;
    expect(redisMode(cluster as never)).toBe('cluster');
  });

  it('refuses none, or more than one, of the three', () => {
    expect(refused({ keyPrefix: 'x:' })).toMatch(/exactly one of "url", "sentinel" or "cluster"/);
    expect(refused({ url: 'redis://a:1', cluster: { nodes: ['a:1'] } })).toMatch(/exactly one/);
    expect(refused({ sentinel: { name: 'gw', nodes: ['a:1'] }, cluster: { nodes: ['a:1'] } })).toMatch(/exactly one/);
  });

  it('wants node addresses as host:port', () => {
    expect(refused({ cluster: { nodes: ['redis://a:7000'] } })).toMatch(/must be host:port/);
    expect(refused({ cluster: { nodes: ['a'] } })).toMatch(/must be host:port/);
    expect(refused({ cluster: { nodes: ['a:70000'] } })).toMatch(/at most 65535/);
    expect(refused({ sentinel: { name: 'gw', nodes: [] } })).toMatch(/nodes/);
    expect(splitHostPort('[fd00::5]:26379')).toEqual({ host: 'fd00::5', port: 26379 });
    expect(splitHostPort('redis-a:7000')).toEqual({ host: 'redis-a', port: 7000 });
  });

  it('keeps credentials and TLS for one server in its URL, where there is one place for them', () => {
    expect(refused({ url: 'redis://a:1', password: 'secret' })).toMatch(/password: with "url", put this in the URL/);
    expect(refused({ url: 'redis://a:1', username: 'gw' })).toMatch(/username: with "url"/);
    expect(refused({ url: 'redis://a:1', tls: true })).toMatch(/tls: with "url", put this in the URL \(rediss:\/\/\)/);
  });

  it('wants TLS before a CA bundle means anything', () => {
    expect(refused({ cluster: { nodes: ['a:1'] }, caFile: 'ca.pem' })).toMatch(/caFile requires tls: true/);
    expect(refused({ url: 'redis://a:1', caFile: 'ca.pem' })).toMatch(/caFile requires a rediss:\/\/ url/);
    expect(() => withRedis({ cluster: { nodes: ['a:1'] }, tls: true, caFile: 'ca.pem' })).not.toThrow();
  });

  it('lets REDIS_URL replace a sentinel or cluster setup with one server, keeping the other settings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-redis-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({ ...base, redis: { cluster: { nodes: ['a:1'] }, password: 'pw', tls: true, keyPrefix: 'p:' } }),
    );
    const redis = loadConfig(path, { REDIS_URL: 'redis://127.0.0.1:6379' }).redis;
    expect(redis).toMatchObject({ url: 'redis://127.0.0.1:6379', keyPrefix: 'p:' });
    expect(redis?.cluster).toBeUndefined();
    expect(redis?.password).toBeUndefined();
  });
});

describe('the client each configuration builds', () => {
  it('a cluster: the seed nodes, and fail-fast settings for every node', () => {
    const client = build({ cluster: { nodes: ['redis-a:7000', 'redis-b:7001'] }, password: 'pw', username: 'gw' });
    expect(client).toBeInstanceOf(Cluster);
    const cluster = client as Cluster;
    // Private in the typings, but it is exactly what the client will try first.
    expect((cluster as unknown as { startupNodes: unknown }).startupNodes).toEqual([
      { host: 'redis-a', port: 7000 },
      { host: 'redis-b', port: 7001 },
    ]);
    expect(cluster.options.enableOfflineQueue).toBe(false);
    expect(cluster.options.lazyConnect).toBe(true);
    expect(cluster.options.redisOptions).toMatchObject({
      commandTimeout: 100,
      maxRetriesPerRequest: 0,
      password: 'pw',
      username: 'gw',
    });
    expect(cluster.options.redisOptions?.tls).toBeUndefined();
  });

  it('a sentinel group: asks the sentinels for the primary and follows a failover', () => {
    const client = build({
      sentinel: { name: 'gw', nodes: ['s1:26379', 's2:26379'], password: 'sentinel-pw' },
      password: 'data-pw',
    }) as Redis;
    expect(client).toBeInstanceOf(Redis);
    const { options } = client;
    expect(options.sentinels).toEqual([
      { host: 's1', port: 26379 },
      { host: 's2', port: 26379 },
    ]);
    expect(options).toMatchObject({
      name: 'gw',
      sentinelPassword: 'sentinel-pw',
      password: 'data-pw',
      failoverDetector: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: 100,
    });
    // A demoted primary refuses writes with READONLY: reconnect (and so ask the sentinels again), nothing else.
    const reconnect = options.reconnectOnError as (error: Error) => boolean | 1 | 2;
    expect(reconnect(new Error("READONLY You can't write against a read only replica."))).toBe(1);
    expect(reconnect(new Error('ERR something else'))).toBe(false);
  });

  it('TLS to every node, with a private CA when one is given', () => {
    const cluster = build({ cluster: { nodes: ['a:1'] }, tls: true, caFile: fixture('tls/localhost-cert.pem') });
    expect((cluster as Cluster).options.redisOptions?.tls?.ca).toBeInstanceOf(Buffer);
    const sentinel = build({ sentinel: { name: 'gw', nodes: ['a:1'] }, tls: true }) as Redis;
    expect(sentinel.options).toMatchObject({ enableTLSForSentinelMode: true, tls: {}, sentinelTLS: {} });
  });

  it('one server, as before', () => {
    const client = build({ url: 'redis://127.0.0.1:6390' }) as Redis;
    expect(client).toBeInstanceOf(Redis);
    expect(client.options).toMatchObject({ host: '127.0.0.1', port: 6390, enableOfflineQueue: false });
    expect(client.options.sentinels).toBeFalsy();
  });

  it('refuses an unreadable CA bundle, naming the setting', () => {
    expect(() => build({ cluster: { nodes: ['a:1'] }, tls: true, caFile: 'no/such/ca.pem' })).toThrow(
      /redis\.caFile: cannot read "no\/such\/ca\.pem"/,
    );
  });
});

describe('what the gateway says about it', () => {
  it('warns about plaintext sentinel or cluster traffic off this machine, and not on loopback or with TLS', () => {
    const note = (redis: Record<string, unknown>) =>
      securityNotes(withRedis(redis)).find((n) => n.startsWith('redis ')) ?? '';
    expect(note({ cluster: { nodes: ['127.0.0.1:7000', '10.1.2.3:7001'] } })).toMatch(
      /redis cluster connections \(to "10\.1\.2\.3" and others\) are not encrypted/,
    );
    expect(note({ sentinel: { name: 'gw', nodes: ['sentinel.internal:26379'] } })).toMatch(
      /redis sentinel connections/,
    );
    expect(note({ cluster: { nodes: ['127.0.0.1:7000', '[::1]:7001'] } })).toBe('');
    expect(note({ cluster: { nodes: ['10.1.2.3:7001'] }, tls: true })).toBe('');
  });

  it('reports the mode next to the connection state', async () => {
    const fake = { status: 'ready', defineCommand() {} } as never;
    const g = await startGateway(
      { ...base, redis: { sentinel: { name: 'gw', nodes: ['10.0.0.1:26379'] } } },
      { redis: fake },
    );
    try {
      expect(g.gateway.healthReport()).toMatchObject({ redis: 'ready', redisMode: 'sentinel' });
    } finally {
      await g.close();
    }
  });
});
