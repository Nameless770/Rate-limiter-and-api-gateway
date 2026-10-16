import { resolve } from 'node:path';
import { ConfigError, loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { createLogger, type LogLevel } from './observability/logger.js';
import { createRedisClient } from './redisClient.js';
import { securityNotes } from './security.js';

async function main(): Promise<void> {
  const logger = createLogger((process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info');
  const configPath = resolve(process.argv[2] ?? process.env['GATEWAY_CONFIG'] ?? 'gateway.config.json');

  const config = loadConfig(configPath);
  for (const note of securityNotes(config)) logger.warn('security', { note });

  const redis = config.redis ? createRedisClient(config.redis, logger) : undefined;
  if (redis) {
    // Don't block startup on Redis: if it's down the limiter's failure mode applies and we reconnect in the background.
    redis.connect().catch((error: Error) => logger.warn('redis unavailable at startup', { error: error.message }));
  } else {
    logger.warn('no redis configured: rate limits are per-instance and reset on restart');
  }

  const gateway = new Gateway(config, { logger, redis });
  const address = await gateway.listen();
  logger.info('gateway listening', {
    port: address.port,
    adminPort: gateway.adminAddress?.port,
    adminHost: gateway.adminAddress?.address,
    routes: config.routes.length,
    upstreams: Object.keys(config.upstreams),
    redis: redis ? 'enabled' : 'disabled',
    failureMode: config.rateLimit.failureMode,
  });

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
  // Certificate renewal: SIGHUP re-reads the files. (Windows has no such signal.)
  if (config.tls && process.platform !== 'win32') {
    process.on('SIGHUP', () => {
      gateway.reloadTls();
    });
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
