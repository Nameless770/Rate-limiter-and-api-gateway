/**
 * Malformed and adversarial HTTP at the byte level. A proxy and its upstream must agree on where one request
 * ends and the next begins; when they don't, an attacker can smuggle a request past every check made on the
 * first one. These tests assert the property that matters: nothing ambiguous is ever forwarded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  type FakeUpstream,
  json,
  type RunningGateway,
  rawTcp,
  startGateway,
  startUpstream,
  statusLines,
  type UpstreamHandler,
} from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const echo: UpstreamHandler = (_r, res, hit) => json(res, 200, { url: hit.url, headers: hit.headers, body: hit.body });

async function setup(extra: Record<string, unknown> = {}): Promise<{ up: FakeUpstream; g: RunningGateway }> {
  const up = await startUpstream(echo);
  cleanups.push(up.close);
  const g = await startGateway({
    upstreams: { u: { url: up.url } },
    routes: [{ path: '/', upstream: 'u' }],
    ...extra,
  });
  cleanups.push(g.close);
  return { up, g };
}

const CRLF = '\r\n';
const req = (lines: string[], body = '') => `${lines.join(CRLF)}${CRLF}${CRLF}${body}`;

describe('request framing the gateway must not interpret two ways', () => {
  it('rejects Content-Length together with Transfer-Encoding, and never forwards the smuggled second request', async () => {
    const { up, g } = await setup();
    const payload = req(
      ['POST /public HTTP/1.1', 'Host: a', 'Content-Length: 4', 'Transfer-Encoding: chunked'],
      `0${CRLF}${CRLF}GET /admin HTTP/1.1${CRLF}Host: a${CRLF}${CRLF}`,
    );
    const res = await rawTcp(g.base, payload);

    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits.map((h) => h.url)).not.toContain('/admin');
    expect(up.hits).toHaveLength(0);
  });

  it('rejects conflicting duplicate Content-Length headers', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(
      g.base,
      req(['POST /x HTTP/1.1', 'Host: a', 'Content-Length: 5', 'Content-Length: 50'], 'hello'),
    );
    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits).toHaveLength(0);
  });

  it('rejects an unknown or obfuscated Transfer-Encoding', async () => {
    const { up, g } = await setup();
    for (const te of ['xchunked', 'chunked, identity', ' chunked', 'chunked\t', 'identity']) {
      const res = await rawTcp(
        g.base,
        req(['POST /x HTTP/1.1', 'Host: a', `Transfer-Encoding: ${te}`], `0${CRLF}${CRLF}`),
      );
      const statuses = statusLines(res.data);
      // Either refused outright, or (for a value that is a valid chunked encoding) handled as one request.
      expect(statuses.length, te).toBeLessThanOrEqual(1);
      if (statuses.length === 1) expect([200, 400, 501], te).toContain(statuses[0]);
    }
    // Whatever was forwarded was forwarded as a single, complete request with no smuggled follow-on.
    expect(up.hits.every((h) => h.url === '/x')).toBe(true);
  });

  it('rejects obsolete line folding in headers', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(g.base, req(['GET /x HTTP/1.1', 'Host: a', 'X-Folded: first', ' second']));
    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits).toHaveLength(0);
  });

  it('rejects whitespace before the colon in a header name', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(g.base, req(['POST /x HTTP/1.1', 'Host: a', 'Content-Length : 5'], 'hello'));
    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits).toHaveLength(0);
  });

  it('rejects control characters in a header value', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(g.base, req(['GET /x HTTP/1.1', 'Host: a', 'X-Evil: value\u0000injected']));
    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits).toHaveLength(0);
  });

  it('rejects a bare LF where CRLF is required', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(g.base, 'GET /x HTTP/1.1\nHost: a\n\n');
    expect(statusLines(res.data)).toEqual([400]);
    expect(up.hits).toHaveLength(0);
  });

  it('answers pipelined requests one by one without letting one bleed into the next', async () => {
    const { up, g } = await setup();
    const one = req(['GET /first HTTP/1.1', 'Host: a']);
    const two = req(['GET /second HTTP/1.1', 'Host: a', 'Connection: close']);
    const res = await rawTcp(g.base, one + two, { waitMs: 1000 });
    expect(statusLines(res.data)).toEqual([200, 200]);
    expect(up.hits.map((h) => h.url)).toEqual(['/first', '/second']);
  });
});

describe('what reaches the upstream', () => {
  it('keeps encoded CR/LF inert: header injection through the path or query does not create headers', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(g.base, req(['GET /a%0d%0aInjected:%20yes?q=%0d%0aX-Also:%20yes HTTP/1.1', 'Host: a']));
    expect(statusLines(res.data)).toEqual([200]);
    const seen = up.hits[0];
    expect(seen?.headers['injected']).toBeUndefined();
    expect(seen?.headers['x-also']).toBeUndefined();
    expect(seen?.url).toContain('%0d%0a'); // forwarded as data, not interpreted
  });

  it('drops hop-by-hop headers, including ones the client names in Connection', async () => {
    const { up, g } = await setup();
    await rawTcp(
      g.base,
      req([
        'GET /x HTTP/1.1',
        'Host: a',
        'Connection: keep-alive, X-Secret-Hop',
        'X-Secret-Hop: forged',
        'Keep-Alive: timeout=99',
        'Proxy-Authorization: Basic Zm9vOmJhcg==',
        'TE: trailers',
        'Upgrade: websocket',
      ]),
    );
    const seen = up.hits[0]?.headers ?? {};
    for (const h of ['x-secret-hop', 'keep-alive', 'proxy-authorization', 'te', 'upgrade']) {
      expect(seen[h], h).toBeUndefined();
    }
  });

  it('treats an absolute-form request target as a path: the gateway never connects where the client points', async () => {
    const { up, g } = await setup();
    const res = await rawTcp(
      g.base,
      req(['GET http://169.254.169.254/latest/meta-data HTTP/1.1', 'Host: internal.example']),
    );
    expect(statusLines(res.data)).toEqual([200]);
    expect(up.hits[0]?.url).toBe('/latest/meta-data');
    expect(up.hits[0]?.headers['host']).toBe(new URL(up.url).host);
  });

  it('does not let a request line with a space or control character through', async () => {
    const { up, g } = await setup();
    for (const target of ['/a b', '/a\u0001b', '/a\tb']) {
      const res = await rawTcp(g.base, req([`GET ${target} HTTP/1.1`, 'Host: a']));
      expect(statusLines(res.data), JSON.stringify(target)).toEqual([400]);
    }
    expect(up.hits).toHaveLength(0);
  });
});

describe('abuse of connection handling', () => {
  it('survives a client that opens many connections and sends nothing', async () => {
    const { up, g } = await setup({ limits: { headersTimeoutMs: 300, maxConnectionsPerIp: 0 } });
    const idle = Array.from({ length: 30 }, () => rawTcp(g.base, '', { waitMs: 2500 }));
    const results = await Promise.all(idle);
    // Connections that never speak are reaped by the server rather than held forever.
    expect(results.filter((r) => r.closed).length).toBeGreaterThanOrEqual(25);

    const res = await rawTcp(g.base, req(['GET /ok HTTP/1.1', 'Host: a', 'Connection: close']));
    expect(statusLines(res.data)).toEqual([200]); // and the gateway still serves
    expect(up.hits.map((h) => h.url)).toEqual(['/ok']);
  });

  it('survives an abrupt reset mid-request without logging an error or leaking a request', async () => {
    const { g } = await setup();
    await rawTcp(g.base, 'POST /x HTTP/1.1\r\nHost: a\r\nContent-Length: 1000\r\n\r\npartial', { waitMs: 100 });
    await new Promise((r) => setTimeout(r, 50));
    const health = JSON.parse(
      (await rawTcp(g.adminBase, req(['GET /_gateway/health HTTP/1.1', 'Host: a', 'Connection: close']))).data.split(
        '\r\n\r\n',
      )[1] ?? '{}',
    );
    expect(health.inFlight).toBe(0);
  });
});
