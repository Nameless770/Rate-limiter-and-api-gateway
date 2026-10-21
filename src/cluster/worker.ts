/**
 * The worker's side of the conversation with the primary: answer requests for metrics and health, reload the
 * configuration when asked (and say how it went), stop when told, and say when it is listening.
 */
import type { Gateway } from '../gateway.js';
import { isToWorker, type ToPrimary } from './protocol.js';

export function serveFromPrimary(
  gateway: Gateway,
  shutdown: (reason: string) => Promise<void>,
): { ready(port: number): void } {
  const send = (message: ToPrimary): void => {
    try {
      process.send?.(message);
    } catch {
      // the primary is gone; the disconnect handler ends this process
    }
  };

  process.on('message', (message: unknown) => {
    if (!isToWorker(message)) return;
    switch (message.gw) {
      case 'collect':
        send({
          gw: 'reply',
          id: message.id,
          what: message.what,
          payload:
            message.what === 'metrics'
              ? gateway.renderMetrics()
              : message.what === 'health'
                ? gateway.healthReport()
                : gateway.reloadFromSource(),
        } as ToPrimary);
        break;
      case 'shutdown':
        void shutdown('primary');
        break;
    }
  });

  return { ready: (port) => send({ gw: 'ready', pid: process.pid, port }) };
}
