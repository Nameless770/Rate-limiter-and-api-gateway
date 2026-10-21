/**
 * What the primary process and its workers say to each other over the IPC channel `node:cluster` provides.
 *
 * Only the primary talks to workers and only workers talk to it, and both are processes this gateway started, so
 * these messages carry no secrets and are not an attack surface. They are still shape-checked, because a message
 * that does not look right is a bug worth ignoring loudly rather than acting on.
 */

/** What the primary can ask every worker for: its metrics text, its health report, or to reload its configuration. */
export type Collected = 'metrics' | 'health' | 'reload';

export type ToWorker =
  /** Report your metrics text or your health report, or reload your configuration and report how it went. */
  | { gw: 'collect'; id: number; what: Collected }
  /** Stop accepting, finish what is in flight, and exit. */
  | { gw: 'shutdown' };

export type ToPrimary =
  /** The worker is listening. */
  | { gw: 'ready'; pid: number; port: number }
  | { gw: 'reply'; id: number; what: Collected; payload: string | Record<string, unknown> };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isCollected = (value: unknown): value is Collected =>
  value === 'metrics' || value === 'health' || value === 'reload';

export function isToWorker(message: unknown): message is ToWorker {
  if (!isRecord(message)) return false;
  switch (message['gw']) {
    case 'collect':
      return Number.isSafeInteger(message['id']) && isCollected(message['what']);
    case 'shutdown':
      return true;
    default:
      return false;
  }
}

export function isToPrimary(message: unknown): message is ToPrimary {
  if (!isRecord(message)) return false;
  switch (message['gw']) {
    case 'ready':
      return Number.isSafeInteger(message['pid']) && Number.isSafeInteger(message['port']);
    case 'reply':
      return (
        Number.isSafeInteger(message['id']) &&
        isCollected(message['what']) &&
        (message['what'] === 'metrics' ? typeof message['payload'] === 'string' : isRecord(message['payload']))
      );
    default:
      return false;
  }
}
