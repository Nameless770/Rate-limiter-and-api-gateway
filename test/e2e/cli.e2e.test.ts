/**
 * The command line, as a deploy pipeline uses it: `--check` must say whether the gateway would start, including the
 * problems only a look at the files reveals, without starting anything.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixture } from '../helpers.js';
import { testKeys } from '../jwtHelpers.js';
import { cleanupAll, onCleanup, projectRoot, spawnNode } from './stack.js';

afterEach(cleanupAll);

const base = {
  host: '127.0.0.1',
  admin: { port: 0 },
  upstreams: { u: { url: 'http://127.0.0.1:9' } },
  routes: [{ path: '/', upstream: 'u' }],
};

function configFile(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'gw-cli-'));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'gateway.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

async function run(...args: string[]): Promise<{ code: number | null; output: string }> {
  const proc = spawnNode(['--import', 'tsx', 'src/index.ts', ...args]);
  const code = await proc.exited;
  return { code, output: proc.output() };
}

describe('the command line', { timeout: 30_000 }, () => {
  it('--check accepts a good configuration, says what it found, and starts nothing', async () => {
    // Hold the port the configuration names: if --check bound it, it would fail.
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    onCleanup(() => new Promise<void>((resolve) => holder.close(() => resolve())));
    const port = (holder.address() as net.AddressInfo).port;

    // 0.0.0.0 and plain HTTP: start-up would warn about that, and so must --check (it binds nothing, so it is safe).
    const { code, output } = await run(configFile({ ...base, host: '0.0.0.0', port }), '--check');
    expect(code, output).toBe(0);
    expect(output).toContain('"msg":"configuration ok"');
    expect(output).toContain('"routes":1');
    expect(output).toMatch(/"msg":"security","note":"the proxy listener is plain HTTP/);
  });

  it('--check refuses a configuration that fails the schema, naming the setting', async () => {
    const { code, output } = await run(
      configFile({ ...base, routes: [{ path: 'no-slash', upstream: 'u' }] }),
      '--check',
    );
    expect(code).toBe(1);
    expect(output).toMatch(/routes\.0\.path/);
  });

  it.each([
    [
      'a certificate file that does not exist',
      { tls: { certFile: join(projectRoot, 'missing.pem'), keyFile: fixture('tls/localhost-key.pem') } },
      /tls\.certFile: cannot read/,
    ],
    [
      'a certificate that does not match its key',
      { tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost2-key.pem') } },
      /not a usable pair/,
    ],
    [
      'a JWT key file that does not exist',
      {
        auth: {
          jwt: { issuers: [{ name: 'idp', alg: 'RS256', publicKeyFile: join(projectRoot, 'missing-key.pem') }] },
        },
      },
      /missing-key\.pem/,
    ],
    [
      'an HMAC secret too short to be safe',
      { auth: { jwt: { issuers: [{ name: 'idp', alg: 'HS256', secret: 'short' }] } } },
      /32 bytes|too short|at least/i,
    ],
  ])('--check catches %s, which only reading the files reveals', async (_what, extra, message) => {
    const { code, output } = await run(configFile({ ...base, ...extra }), '--check');
    expect(code).toBe(1);
    expect(output).toMatch(message);
    expect(output).not.toContain('configuration ok');
  });

  it('--check accepts a good HMAC issuer and TLS pair', async () => {
    const { code, output } = await run(
      configFile({
        ...base,
        tls: { certFile: fixture('tls/localhost-cert.pem'), keyFile: fixture('tls/localhost-key.pem') },
        auth: { jwt: { issuers: [{ name: 'idp', alg: 'HS256', secret: testKeys().hmacSecret }] } },
      }),
      '--check',
    );
    expect(code, output).toBe(0);
    expect(output).toContain('"tls":true');
  });

  it('--help prints usage, and an unknown option is refused with it', async () => {
    const help = await run('--help');
    expect(help.code).toBe(0);
    expect(help.output).toMatch(/Usage:/);
    expect(help.output).toMatch(/ADMIN_PORT/);

    const wrong = await run('--chek');
    expect(wrong.code).toBe(2);
    expect(wrong.output).toMatch(/unknown option --chek/);
  });
});
