import { Redis } from 'ioredis';
import type { GatewayConfig } from './config.js';
import type { Logger } from './observability/logger.js';

/**
 * A client tuned for a hot path: fail fast rather than queue.
 *
 * ioredis defaults to queueing commands while disconnected and retrying them for a long time, which would
 * turn a Redis outage into every gateway request hanging. Here a command either completes within
 * `commandTimeoutMs` or fails immediately, and the limiter's failure mode takes over.
 */
export function createRedisClient(cfg: NonNullable<GatewayConfig['redis']>, logger: Logger): Redis {
  const client = new Redis(cfg.url, {
    commandTimeout: cfg.commandTimeoutMs,
    connectTimeout: 2_000,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    // Reconnect forever with capped backoff; the limiter's circuit breaker decides whether to even try meanwhile.
    retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
  });

  client.on('error', (error) => logger.warn('redis error', { error: error.message }));
  client.on('ready', () => logger.info('redis ready'));
  client.on('close', () => logger.warn('redis connection closed'));
  return client;
}
