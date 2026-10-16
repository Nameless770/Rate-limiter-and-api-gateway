import cluster from 'node:cluster';
import { resolve } from 'node:path';
import { resolveWorkers, runPrimary } from './cluster/primary.js';
import { serveFromPrimary } from './cluster/worker.js';
import { ConfigError, type GatewayConfig, loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { createLogger, type Logger, type LogLevel } from './observability/logger.js';
import { createRedisClient } from './redisClient.js';
import { securityNotes } from './security.js';

async function main(): Promise<void> {
  const worker = cluster.isWorker ? Number(process.env['GATEWAY_WORKER_INDEX']) : undefined;
  const logger = createLogger(
    (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
    undefined,
    worker === undefined ? {} : { worker },
  );
  const configPath = resolve(process.argv[2] ?? process.env['GATEWAY_CONFIG'] ?? 'gateway.config.json');

  const config = loadConfig(configPath);
  const workers = resolveWorkers(config.cluster.workers);

  if (cluster.isPrimary && workers > 1) {
    for (const note of securityNotes(config)) logger.warn('security', { note });
    await runPrimary(config, workers, logger);
    return;
  }
  await runGateway(config, logger, cluster.isWorker);
}

/** One gateway in this process: the whole thing when running alone, or one worker of a cluster. */
async function runGateway(config: GatewayConfig, logger: Logger, isWorker: boolean): Promise<void> {
  if (!isWorker) {
    // A cluster's primary has already said these once for all its workers.
    for (const note of securityNotes(config)) logger.warn('security', { note });
  }

  const redis = config.redis ? createRedisClient(config.redis, logger) : undefined;
  if (redis) {
    // Don't block startup on Redis: if it's down the limiter's failure mode applies and we reconnect in the background.
    redis.connect().catch((error: Error) => logger.warn('redis unavailable at startup', { error: error.message }));
  } else {
    logger.warn('no redis configured: rate limits are per-instance and reset on restart');
  }

  // The primary hosts the admin listener for its workers, with everyone's metrics in one place.
  const gatewayConfig = isWorker ? { ...config, admin: { ...config.admin, enabled: false } } : config;
  const gateway = new Gateway(gatewayConfig, { logger, redis });
  const address = await gateway.listen();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal, graceMs: config.shutdownGraceMs });
    try {
      await gateway.close();
      redis?.disconnect();
    } finally {
      process.exit(0);
    }
  };

  if (isWorker) {
    serveFromPrimary(gateway, shutdown).ready(address.port);
  } else {
    logger.info('gateway listening', {
      port: address.port,
      adminPort: gateway.adminAddress?.port,
      adminHost: gateway.adminAddress?.address,
      routes: config.routes.length,
      upstreams: Object.keys(config.upstreams),
      redis: redis ? 'enabled' : 'disabled',
      failureMode: config.rateLimit.failureMode,
    });
    // Certificate renewal: SIGHUP re-reads the files. (Windows has no such signal.)
    if (config.tls && process.platform !== 'win32') {
      process.on('SIGHUP', () => {
        gateway.reloadTls();
      });
    }
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`fatal: ${(error as Error)?.stack ?? String(error)}\n`);
  }
  process.exit(1);
});
