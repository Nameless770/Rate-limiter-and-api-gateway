/**
 * The real entrypoint (src/index.ts) as a child process, driven with a real signal. Windows has no POSIX
 * signals (Node force-kills the child there), so this runs on Linux/macOS, e.g. in the test container:
 *
 *   docker compose run --rm tests
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { json, rawRequest, sleep, startUpstream } from './helpers.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

describe.skipIf(process.platform === 'win32')('process lifecycle (POSIX signals)', () => {
  it('on SIGTERM drains in-flight requests, refuses new connections, and exits 0', async () => {
    const up = await startUpstream(async (_r, res) => {
      await sleep(500);
      json(res, 200, { done: true });
    });
    cleanups.push(up.close);

    const dir = mkdtempSync(join(tmpdir(), 'gw-sigterm-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const configPath = join(dir, 'gateway.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        port: 0,
        host: '127.0.0.1',
        shutdownGraceMs: 5_000,
        upstreams: { u: { url: up.url } },
        routes: [{ path: '/', upstream: 'u' }],
      }),
    );

    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', configPath], {
      cwd: projectRoot,
      env: { ...process.env, PORT: undefined, REDIS_URL: undefined, LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanups.push(() => void (child.exitCode === null && child.kill('SIGKILL')));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));

    const logs: Array<Record<string, unknown>> = [];
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const port = await new Promise<number>((resolve, reject) => {
      let buffered = '';
      child.stdout.on('data', (d: Buffer) => {
        buffered += d.toString();
        for (let newline = buffered.indexOf('\n'); newline >= 0; newline = buffered.indexOf('\n')) {
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          try {
            const entry = JSON.parse(line) as Record<string, unknown>;
            logs.push(entry);
            if (entry['msg'] === 'gateway listening') resolve(entry['port'] as number);
          } catch {
            // not a log line
          }
        }
      });
      void exited.then((code) => reject(new Error(`gateway exited early (${code}): ${stderr}`)));
      setTimeout(() => reject(new Error(`gateway did not start: ${stderr}`)), 20_000).unref();
    });
    const base = `http://127.0.0.1:${port}`;

    const inflight = rawRequest(base, { path: '/slow' });
    await sleep(150);
    child.kill('SIGTERM');
    await sleep(100);

    await expect(rawRequest(base, { path: '/late' })).rejects.toThrow(); // listener already closed
    const res = await inflight;
    expect(res.status).toBe(200);
    expect(res.complete).toBe(true);
    expect(JSON.parse(res.body)).toEqual({ done: true });

    expect(await exited).toBe(0);
    expect(logs.some((l) => l['msg'] === 'shutting down' && l['signal'] === 'SIGTERM')).toBe(true);
  }, 30_000);
});
