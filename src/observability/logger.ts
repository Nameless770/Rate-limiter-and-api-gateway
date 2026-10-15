export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** One JSON object per line on stdout: trivially ingestible by any log pipeline. */
export function createLogger(level: LogLevel = 'info', write: (line: string) => void = (l) => process.stdout.write(l)): Logger {
  const threshold = ORDER[level];
  const emit =
    (lvl: Exclude<LogLevel, 'silent'>) =>
    (msg: string, fields: Record<string, unknown> = {}): void => {
      if (ORDER[lvl] < threshold) return;
      write(`${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields })}\n`);
    };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = createLogger('silent');
