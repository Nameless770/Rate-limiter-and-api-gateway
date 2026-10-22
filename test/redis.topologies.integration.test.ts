/**
 * The limiters and the gateway against the two other ways Redis is deployed: a Redis Cluster, and a primary watched
 * by Sentinel (including a failover forced mid-test). Skipped unless the deployments are reachable; the Compose test
 * profile starts both and sets these variables:
 *
 *   REDIS_CLUSTER_NODES=redis-cluster:7000,redis-cluster:7001,redis-cluster:7002
 *   REDIS_SENTINEL_NODES=redis-sentinel:26379  REDIS_SENTINEL_NAME=gw
 *
 *   docker compose run --rm tests
 */
import { type Cluster, Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type GatewayConfig, parseConfig } from '../src/config.js';
import { silentLogger } from '../src/observability/logger.js';
import { type RedisConnection, RedisSlidingWindow, RedisTokenBucket } from '../src/ratelimit/redis.js';
import { createRedisClient } from '../src/redisClient.js';
import { json, type RunningGateway, rawRequest, sleep, startGateway, startUpstream } from './helpers.js';

const clusterNodes = process.env['REDIS_CLUSTER_NODES']?.split(',').filter(Boolean);
const sentinelNodes = process.env['REDIS_SENTINEL_NODES']?.split(',').filter(Boolean);
const sentinelName = process.env['REDIS_SENTINEL_NAME'] ?? 'gw';
const run = `topo:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}:`;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

/** A client exactly as the gateway builds one from its configuration, connected. */
async function connect(redis: Record<string, unknown>): Promise<RedisConnection> {
  const config = parseConfig({
    upstreams: { u: { url: 'http://127.0.0.1:1' } },
    routes: [{ path: '/', upstream: 'u' }],
    redis,
  }).redis as NonNullable<GatewayConfig['redis']>;
  const client = createRedisClient(config, silentLogger);
  await client.connect();
  cleanups.push(() => void client.disconnect());
  return client;
}

async function until(check: () => Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check().catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** Two gateways sharing one Redis deployment, in front of one upstream, with a budget of 5 per client. */
async function pair(redis: Record<string, unknown>): Promise<[RunningGateway, RunningGateway]> {
  const up = await startUpstream((_req, res) => json(res, 200, { ok: true }));
  cleanups.push(up.close);
  const config = {
    redis: { ...redis, keyPrefix: `${run}gw:` },
    rateLimit: { default: { algorithm: 'sliding-window', limit: 5, windowMs: 60_000 } },
    upstreams: { u: { url: up.url } },
    routes: [{ id: 'api', path: '/api', upstream: 'u' }],
  };
  const gateways: RunningGateway[] = [];
  for (let i = 0; i < 2; i++) {
    const g = await startGateway(config, { redis: await connect(redis), clock: Date.now });
    cleanups.push(g.close);
    gateways.push(g);
  }
  return gateways as [RunningGateway, RunningGateway];
}

describe.skipIf(!clusterNodes)('redis cluster', () => {
  const cluster = { cluster: { nodes: clusterNodes } };

  it('admits exactly the limit for each key under a concurrent flood, with the keys spread over the nodes', async () => {
    const clients = await Promise.all(Array.from({ length: 3 }, () => connect(cluster)));
    const keys = Array.from({ length: 6 }, (_, i) => `flood-${i}`);
    // The keys really do live on different nodes: otherwise this would only test one server again.
    const owners = new Set(
      await Promise.all(
        keys.map(async (k) => {
          const slot = Number(await (clients[0] as Cluster).cluster('KEYSLOT', `${run}${k}`));
          return (clients[0] as Cluster).slots[slot]?.[0];
        }),
      ),
    );
    expect(owners.size).toBeGreaterThan(1);

    const limit = 20;
    const limiters = clients.map((c) => new RedisSlidingWindow(c, { limit, windowMs: 60_000 }, { keyPrefix: run }));
    const buckets = clients.map(
      (c) => new RedisTokenBucket(c, { capacity: limit, refillPerSecond: 0.0001 }, { keyPrefix: `${run}tb:` }),
    );
    const results = await Promise.all(
      keys.flatMap((key) =>
        Array.from({ length: 60 }, async (_, i) => ({
          key,
          window: (await (limiters[i % 3] as RedisSlidingWindow).consume(key)).allowed,
          bucket: (await (buckets[i % 3] as RedisTokenBucket).consume(key)).allowed,
        })),
      ),
    );
    for (const key of keys) {
      const mine = results.filter((r) => r.key === key);
      expect(mine.filter((r) => r.window)).toHaveLength(limit);
      expect(mine.filter((r) => r.bucket)).toHaveLength(limit);
    }
  });

  it('gives two gateways one budget per client', async () => {
    const [a, b] = await pair(cluster);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const g = i % 2 === 0 ? a : b;
      statuses.push((await rawRequest(g.base, { path: '/api/x', headers: { 'x-api-key': 'shared' } })).status);
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    expect(a.gateway.healthReport()).toMatchObject({ redis: 'ready', redisMode: 'cluster' });
  });
});

describe.skipIf(!sentinelNodes)('redis sentinel', () => {
  const sentinel = { sentinel: { name: sentinelName, nodes: sentinelNodes } };
  const [first] = sentinelNodes ?? [];
  const sentinelAdmin = (): Redis => {
    const [host, port] = (first as string).split(':');
    const client = new Redis({ host, port: Number(port), maxRetriesPerRequest: 1 });
    cleanups.push(() => void client.disconnect());
    return client;
  };
  const primaryOf = async (admin: Redis): Promise<string> =>
    ((await admin.call('SENTINEL', 'get-master-addr-by-name', sentinelName)) as string[]).join(':');

  afterAll(async () => {
    // Leave no keys behind on whichever node is primary now.
    if (!first) return;
    const admin = sentinelAdmin();
    const [host, port] = (await primaryOf(admin)).split(':');
    const primary = new Redis({ host, port: Number(port), maxRetriesPerRequest: 1 });
    const keys = await primary.keys(`${run}*`);
    if (keys.length) await primary.del(...keys);
    primary.disconnect();
    admin.disconnect();
  });

  it('writes to the primary the sentinels name', async () => {
    const client = await connect(sentinel);
    const limiter = new RedisSlidingWindow(client, { limit: 3, windowMs: 60_000 }, { keyPrefix: run });
    expect((await limiter.consume('where')).allowed).toBe(true);

    const [host, port] = (await primaryOf(sentinelAdmin())).split(':');
    const primary = new Redis({ host, port: Number(port), maxRetriesPerRequest: 1 });
    cleanups.push(() => void primary.disconnect());
    expect(await primary.zcard(`${run}where`)).toBe(1);
  });

  it('follows a failover: limiting carries on, and soon goes back to the shared budget on the new primary', async () => {
    const [a] = await pair(sentinel);
    const ask = () => rawRequest(a.base, { path: '/api/x', headers: { 'x-api-key': `fo-${Math.random()}` } });
    const before = await ask();
    expect(before.status).toBe(200);
    expect(before.headers['ratelimit-remaining']).toBe('4'); // a decision Redis made

    const admin = sentinelAdmin();
    const old = await primaryOf(admin);
    await admin.call('SENTINEL', 'FAILOVER', sentinelName);
    await until(async () => (await primaryOf(admin)) !== old, 30_000, 'the sentinel to promote the replica');

    const [host, port] = (await primaryOf(admin)).split(':');
    const primary = new Redis({ host, port: Number(port), maxRetriesPerRequest: 1 });
    cleanups.push(() => void primary.disconnect());
    const keysOnNewPrimary = async () => (await primary.keys(`${run}gw:*`)).length;

    // For a moment after the promotion the old primary still takes writes (until the sentinel demotes it), and while
    // the client switches over the limiter decides locally. Either way every request is answered, never with a 5xx,
    // and soon a new client's decision is made, and kept, on the new primary.
    const statuses: number[] = [];
    await until(
      async () => {
        const keys = await keysOnNewPrimary();
        const res = await ask();
        statuses.push(res.status);
        return res.headers['ratelimit-remaining'] === '4' && (await keysOnNewPrimary()) === keys + 1;
      },
      30_000,
      'decisions made on the new primary',
    );
    expect(statuses.every((s) => s === 200)).toBe(true);
  }, 90_000);
});
