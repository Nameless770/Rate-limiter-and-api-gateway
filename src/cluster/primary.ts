/**
 * The primary process of a multi-core deployment. It runs no gateway of its own: it starts the workers (each a
 * complete gateway sharing the listening port through `node:cluster`), keeps them alive, hosts the admin listener
 * with the workers' combined metrics and health, and coordinates shutdown and certificate reloads.
 */
import cluster from 'node:cluster';
import { availableParallelism } from 'node:os';
import { AdminListener } from '../admin.js';
import { type GatewayConfig, loadConfig } from '../config.js';
import type { Logger } from '../observability/logger.js';
import { Registry } from '../observability/metrics.js';
import { registerProcessMetrics } from '../observability/process.js';
import { mergeMetrics } from './metrics.js';
import { Supervisor, type WorkerLauncher } from './supervisor.js';

export function resolveWorkers(setting: 'auto' | number): number {
  return setting === 'auto' ? availableParallelism() : setting;
}

/** Real worker processes, via `node:cluster`. The worker runs this same entrypoint again. */
export function clusterLauncher(): WorkerLauncher {
  return {
    launch(index) {
      const worker = cluster.fork({ GATEWAY_WORKER_INDEX: String(index) });
      return {
        get pid() {
          return worker.process.pid;
        },
        send: (message) => void worker.send(message, () => {}),
        kill: () => void worker.process.kill('SIGKILL'),
        onMessage: (listener) => void worker.on('message', listener),
        onExit: (listener) => void worker.on('exit', listener),
      };
    },
  };
}

export async function runPrimary(
  config: GatewayConfig,
  workers: number,
  logger: Logger,
  configPath: string,
): Promise<void> {
  const startedAt = Date.now();
  let port = config.port;
  const supervisor = new Supervisor({
    workers,
    launcher: clusterLauncher(),
    logger,
    stopTimeoutMs: config.shutdownGraceMs + 5_000,
    onReady: (_index, info) => {
      port = info.port;
    },
  });

  const registry = new Registry();
  registry.gauge('gateway_cluster_workers', 'Worker processes configured.', () => [{ labels: {}, value: workers }]);
  registry.gauge('gateway_cluster_worker_ready', 'Whether each worker slot is accepting traffic (1) or not (0).', () =>
    supervisor.stats().workers.map((w) => ({ labels: { slot: w.index }, value: w.state === 'ready' ? 1 : 0 })),
  );
  registry.gauge(
    'gateway_cluster_worker_restarts_total',
    'Times each worker slot has had to be restarted.',
    () => supervisor.stats().workers.map((w) => ({ labels: { slot: w.index }, value: w.restarts })),
    'counter',
  );
  const stopProcessMetrics = registerProcessMetrics(registry);

  /**
   * Reload every worker's configuration. The primary reads and validates the file first, so a file that does not parse
   * is refused once rather than by every worker; each worker then re-reads it and applies it on its own, all or
   * nothing, and the answer lists how each one fared.
   */
  const reloadCluster = async (): Promise<{ ok: boolean } & Record<string, unknown>> => {
    let next: GatewayConfig;
    try {
      next = loadConfig(configPath);
    } catch (error) {
      const message = (error as Error).message;
      logger.error('configuration reload failed; the workers keep the previous configuration', { error: message });
      return { ok: false, error: message };
    }
    // The primary's own settings: the number of workers and the admin listener's address are fixed once running.
    const restartRequired: string[] = [];
    if (resolveWorkers(next.cluster.workers) !== workers) restartRequired.push('cluster');
    const { admin: was } = config;
    if (next.admin.enabled !== was.enabled || next.admin.host !== was.host || next.admin.port !== was.port) {
      restartRequired.push('admin');
    }
    admin?.setToken(next.admin.token);

    logger.info('asking the workers to reload the configuration', { workers });
    const replies = await supervisor.collect('reload');
    const results = replies.map((r) =>
      r.ok
        ? { worker: r.index, ...(r.payload as Record<string, unknown>) }
        : { worker: r.index, ok: false, error: r.reason },
    );
    const ok = results.every((r) => r.ok === true);
    if (ok) logger.info('every worker reloaded the configuration', { workers, restartRequired });
    else {
      logger.error('not every worker reloaded the configuration', {
        failed: results.filter((r) => r.ok !== true).map((r) => r.worker),
      });
    }
    return { ok, restartRequired, workers: results };
  };

  let shuttingDown = false;
  const admin = config.admin.enabled
    ? new AdminListener(config.admin, {
        live: () => {
          const ready = supervisor.ready;
          return ready > 0
            ? { status: 200, body: { status: 'ok', workers: ready } }
            : { status: 503, body: { status: 'unavailable', workers: 0 } };
        },
        // Not ready the moment shutdown starts (workers are still draining behind it), or with nobody to serve.
        ready: () => {
          if (shuttingDown) return { status: 503, body: { status: 'draining' } };
          const ready = supervisor.ready;
          return ready > 0
            ? { status: 200, body: { status: 'ready', workers: ready } }
            : { status: 503, body: { status: 'unavailable', workers: 0 } };
        },
        health: async () => {
          const replies = await supervisor.collect('health');
          const stats = supervisor.stats();
          return {
            status: replies.every((r) => r.ok) ? 'ok' : 'degraded',
            uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
            cluster: { workers, ready: stats.ready, restarts: stats.restarts },
            workers: replies.map((r) =>
              r.ok
                ? { worker: r.index, pid: r.pid, ...(r.payload as Record<string, unknown>) }
                : { worker: r.index, pid: r.pid, status: 'unavailable', reason: r.reason },
            ),
          };
        },
        metrics: async () => {
          const replies = await supervisor.collect('metrics');
          return mergeMetrics([
            { worker: 'primary', text: registry.render() },
            ...replies.flatMap((r) => (r.ok ? [{ worker: String(r.index), text: r.payload as string }] : [])),
          ]);
        },
        reload: async () => {
          const result = await reloadCluster();
          return { status: result.ok ? 200 : 422, body: result };
        },
      })
    : undefined;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal, graceMs: config.shutdownGraceMs, workers });
    try {
      await supervisor.stop();
      await admin?.close();
      stopProcessMetrics();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // SIGHUP to the primary reloads every worker's configuration, certificate files included. (Windows has no such
  // signal; POST /_gateway/reload does the same.)
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => void reloadCluster());
  }

  try {
    await supervisor.start();
    await admin?.listen();
  } catch (error) {
    logger.error('cluster failed to start', { error: (error as Error).message });
    await supervisor.stop();
    await admin?.close();
    process.exit(1);
  }

  logger.info('gateway listening', {
    port,
    adminPort: admin?.address?.port,
    adminHost: admin?.address?.address,
    workers,
    routes: config.routes.length,
    upstreams: Object.keys(config.upstreams),
    redis: 'enabled',
    failureMode: config.rateLimit.failureMode,
  });
}
