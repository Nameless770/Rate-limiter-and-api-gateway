import { readFileSync } from 'node:fs';
import { Cluster, Redis, type RedisOptions } from 'ioredis';
import { ConfigError, type GatewayConfig, redisMode, splitHostPort } from './config.js';
import type { Logger } from './observability/logger.js';
import type { RedisConnection } from './ratelimit/redis.js';

type RedisConfig = NonNullable<GatewayConfig['redis']>;

/** Reconnect forever with capped backoff; the limiter's circuit breaker decides whether to even try meanwhile. */
const backoff = (attempt: number): number => Math.min(attempt * 200, 2_000);

/**
 * A client tuned for a hot path: fail fast rather than queue.
 *
 * ioredis defaults to queueing commands while disconnected and retrying them for a long time, which would
 * turn a Redis outage into every gateway request hanging. Here a command either completes within
 * `commandTimeoutMs` or fails immediately, and the limiter's failure mode takes over. The same holds whichever way
 * Redis is deployed: one server, a primary behind Sentinel, or a cluster.
 */
export function createRedisClient(cfg: RedisConfig, logger: Logger): RedisConnection {
  let ca: Buffer | undefined;
  if (cfg.caFile) {
    try {
      ca = readFileSync(cfg.caFile);
    } catch (error) {
      throw new ConfigError(`redis.caFile: cannot read "${cfg.caFile}": ${(error as Error).message}`);
    }
  }
  const tls = cfg.tls ? (ca ? { ca } : {}) : undefined;
  const perCommand = {
    commandTimeout: cfg.commandTimeoutMs,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 0,
  } satisfies RedisOptions;

  let client: RedisConnection;
  if (cfg.cluster) {
    client = new Cluster(cfg.cluster.nodes.map(splitHostPort), {
      enableOfflineQueue: false,
      lazyConnect: true,
      clusterRetryStrategy: backoff,
      // A slot map that cannot be fetched in time is retried, not waited on forever.
      slotsRefreshTimeout: 2_000,
      redisOptions: { ...perCommand, username: cfg.username, password: cfg.password, tls },
    });
    client.on('+node', (node: Redis) => logger.info('redis cluster node added', { node: nodeName(node) }));
    client.on('-node', (node: Redis) => logger.warn('redis cluster node removed', { node: nodeName(node) }));
    client.on('node error', (error: Error, node: string) =>
      logger.warn('redis cluster node error', { node, error: error.message }),
    );
  } else if (cfg.sentinel) {
    client = new Redis({
      ...perCommand,
      sentinels: cfg.sentinel.nodes.map(splitHostPort),
      name: cfg.sentinel.name,
      sentinelPassword: cfg.sentinel.password,
      username: cfg.username,
      password: cfg.password,
      tls,
      enableTLSForSentinelMode: cfg.tls,
      sentinelTLS: tls,
      // Hear about a failover from the sentinels as it happens, instead of when the old primary stops answering.
      failoverDetector: true,
      sentinelRetryStrategy: backoff,
      // After a failover the old primary can come back as a replica and refuse writes. Reconnecting asks the
      // sentinels again and lands on the new primary; the failed command itself is not replayed.
      reconnectOnError: (error) => (error.message.startsWith('READONLY') ? 1 : false),
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: backoff,
    });
  } else {
    client = new Redis(cfg.url as string, {
      ...perCommand,
      // A rediss:// URL turns TLS on; this only adds a private CA to the trust store used to verify the server.
      ...(ca ? { tls: { ca } } : {}),
      enableOfflineQueue: false,
      lazyConnect: true,
      retryStrategy: backoff,
    });
  }

  client.on('error', (error: Error) => logger.warn('redis error', { error: error.message }));
  client.on('ready', () => logger.info('redis ready', { mode: redisMode(cfg) }));
  client.on('close', () => logger.warn('redis connection closed'));
  return client;
}

function nodeName(node: Redis): string {
  return `${node.options.host}:${node.options.port}`;
}
