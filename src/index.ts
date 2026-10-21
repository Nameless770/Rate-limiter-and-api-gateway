import cluster from 'node:cluster';
import { resolve } from 'node:path';
import { resolveWorkers, runPrimary } from './cluster/primary.js';
import { serveFromPrimary } from './cluster/worker.js';
import { ConfigError, type GatewayConfig, loadConfig } from './config.js';
import { Gateway } from './gateway.js';
import { createLogger, type Logger, type LogLevel, silentLogger } from './observability/logger.js';
import { createRedisClient } from './redisClient.js';
import { configNotes, securityNotes } from './security.js';

/** The longest startup waits for Redis to connect (a little over the client's own 2 s connect timeout). */
const REDIS_STARTUP_WAIT_MS = 2_500;

const USAGE = `Usage: node dist/index.js [config.json] [--check]

  config.json   gateway configuration (default: $GATEWAY_CONFIG, then ./gateway.config.json)
  --check       validate the configuration and every file it refers to (certificates, keys, CA bundles),
                print what start-up would warn about, and exit: 0 if the gateway would start, 1 if not.
                Nothing is bound and nothing is contacted.
  --help        show this text

Environment: PORT, ADMIN_PORT, REDIS_URL and WORKERS override the file; LOG_LEVEL is debug, info (default),
warn, error or silent. Values in the file may use \${VAR} and \${VAR:-default}.
`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--check');
  if (unknown.length > 0) {
    process.stderr.write(`unknown option ${unknown.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }

  const worker = cluster.isWorker ? Number(process.env['GATEWAY_WORKER_INDEX']) : undefined;
  const logger = createLogger(
    (process.env['LOG_LEVEL'] as LogLevel | undefined) ?? 'info',
    undefined,
    worker === undefined ? {} : { worker },
  );
  const configArg = args.find((a) => !a.startsWith('-'));
  const configPath = resolve(configArg ?? process.env['GATEWAY_CONFIG'] ?? 'gateway.config.json');

  const config = loadConfig(configPath);
  if (args.includes('--check')) {
    await checkConfig(config, configPath, logger);
    return;
  }
  const workers = resolveWorkers(config.cluster.workers);

  if (cluster.isPrimary && workers > 1) {
    logNotes(config, logger);
    await runPrimary(config, workers, logger, configPath);
    return;
  }
  await runGateway(config, logger, cluster.isWorker, configPath);
}

/** What start-up has to say about a configuration that is legal but questionable. */
function logNotes(config: GatewayConfig, logger: Logger): void {
  for (const note of securityNotes(config)) logger.warn('security', { note });
  for (const note of configNotes(config)) logger.warn('config', { note });
}

/**
 * `--check`: everything start-up would verify, without starting. Building the gateway reads and checks every file the
 * configuration names (a certificate that does not match its key, a JWT key that is too weak, an unreadable CA
 * bundle) and opens nothing: no listener, no connection to Redis or an upstream. A ConfigError from here is reported
 * like any other start-up failure, with exit status 1.
 */
async function checkConfig(config: GatewayConfig, path: string, logger: Logger): Promise<void> {
  const gateway = new Gateway(config, { logger: silentLogger, manualHealthChecks: true });
  await gateway.close(0);
  logNotes(config, logger);
  logger.info('configuration ok', {
    path,
    routes: config.routes.length,
    upstreams: Object.keys(config.upstreams),
    workers: resolveWorkers(config.cluster.workers),
    tls: config.tls !== undefined,
    redis: config.redis !== undefined,
  });
}

/** One gateway in this process: the whole thing when running alone, or one worker of a cluster. */
async function runGateway(config: GatewayConfig, logger: Logger, isWorker: boolean, configPath: string): Promise<void> {
  if (!isWorker) {
    // A cluster's primary has already said these once for all its workers.
    logNotes(config, logger);
  }

  const redis = config.redis ? createRedisClient(config.redis, logger) : undefined;
  if (redis) {
    // Give Redis a moment to connect before taking traffic. Otherwise every start, every rolling deploy, begins with
    // a window in which this instance counts requests in its per-process fallback instead of the shared budget.
    // But never hold startup hostage to it: if Redis is slow or down the limiter's failure mode applies and the
    // client keeps reconnecting in the background.
    const connecting = redis.connect().then(
      () => undefined,
      (error: Error) => logger.warn('redis unavailable at startup', { error: error.message }),
    );
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, REDIS_STARTUP_WAIT_MS);
    });
    await Promise.race([connecting, gaveUp]);
    clearTimeout(timer);
  } else {
    logger.warn('no redis configured: rate limits are per-instance and reset on restart');
  }

  // The primary hosts the admin listener for its workers, with everyone's metrics in one place.
  const forThisProcess = (c: GatewayConfig): GatewayConfig =>
    isWorker ? { ...c, admin: { ...c.admin, enabled: false } } : c;
  const gateway = new Gateway(forThisProcess(config), {
    logger,
    redis,
    // A reload reads the file again, environment overrides and all, exactly as start-up did.
    loadConfig: () => forThisProcess(loadConfig(configPath)),
  });
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
    // SIGHUP re-reads the configuration and applies it, certificate files included (which is how renewals are picked
    // up). Windows has no such signal: POST /_gateway/reload on the admin listener does the same everywhere.
    if (process.platform !== 'win32') {
      process.on('SIGHUP', () => {
        gateway.reloadFromSource();
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
