import { afterEach, describe, expect, it } from 'vitest';
import { parseTraceparent } from '../src/observability/trace.js';
import { capturingLogger, json, rawRequest, startGateway, startUpstream } from './helpers.js';
import { openWs, startWsUpstream } from './wsHelpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const INCOMING = `00-${TRACE}-00f067aa0ba902b7-01`;

async function setup(tracing?: Record<string, unknown>) {
  const up = await startUpstream((_req, res, hit) => json(res, 200, { headers: hit.headers }));
  cleanups.push(up.close);
  const { logger, lines } = capturingLogger();
  const g = await startGateway(
    {
      ...(tracing ? { tracing } : {}),
      upstreams: { u: { url: up.url } },
      routes: [
        { id: 'api', path: '/api', upstream: 'u' },
        { id: 'cached', path: '/cached', upstream: 'u', cache: { ttlMs: 60_000, varyHeaders: [] } },
      ],
    },
    { logger },
  );
  cleanups.push(g.close);
  const seen = async (path: string, headers: Record<string, string> = {}) => {
    const res = await rawRequest(g.base, { path, headers });
    return JSON.parse(res.body).headers as Record<string, string | undefined>;
  };
  return { up, g, lines, seen };
}

describe('trace context', () => {
  it('starts a trace when the caller has none, and logs its id', async () => {
    const { seen, lines } = await setup();
    const headers = await seen('/api/x');
    const parent = parseTraceparent(headers['traceparent']);
    expect(parent).toBeDefined();
    expect(parent?.flags).toBe('01');
    const logged = lines.find((l) => l['msg'] === 'request');
    expect(logged?.['traceId']).toBe(parent?.traceId);
  });

  it("continues the caller's trace, with the gateway's hop as the new parent", async () => {
    const { seen, lines } = await setup();
    const headers = await seen('/api/x', { traceparent: INCOMING, tracestate: 'congo=t61rcWkgMzE' });
    const parent = parseTraceparent(headers['traceparent']);
    expect(parent?.traceId).toBe(TRACE); // the same trace
    expect(parent?.parentId).not.toBe('00f067aa0ba902b7'); // a hop of ours in between
    expect(headers['tracestate']).toBe('congo=t61rcWkgMzE');
    expect(lines.find((l) => l['msg'] === 'request')?.['traceId']).toBe(TRACE);
  });

  it('replaces a malformed traceparent, and does not pass on a tracestate that belonged to it', async () => {
    const { seen } = await setup();
    const headers = await seen('/api/x', { traceparent: 'not-a-trace', tracestate: 'congo=t61rcWkgMzE' });
    expect(parseTraceparent(headers['traceparent'])).toBeDefined();
    expect(headers['tracestate']).toBeUndefined();
  });

  it('does not let an untrusted caller choose the trace when told not to', async () => {
    const { seen } = await setup({ trustIncoming: false });
    const headers = await seen('/api/x', { traceparent: INCOMING, tracestate: 'congo=t61rcWkgMzE' });
    expect(parseTraceparent(headers['traceparent'])?.traceId).not.toBe(TRACE);
    expect(headers['tracestate']).toBeUndefined();
  });

  it('leaves the headers alone when tracing is off', async () => {
    const { seen, lines } = await setup({ enabled: false });
    const passed = await seen('/api/x', { traceparent: INCOMING, tracestate: 'congo=t61rcWkgMzE' });
    expect(passed['traceparent']).toBe(INCOMING);
    expect(passed['tracestate']).toBe('congo=t61rcWkgMzE');
    expect((await seen('/api/y'))['traceparent']).toBeUndefined();
    expect(lines.find((l) => l['msg'] === 'request')?.['traceId']).toBeUndefined();
  });

  it('carries the trace on a cacheable request too, where only the keyed headers are forwarded', async () => {
    const { seen } = await setup();
    const headers = await seen('/cached/x', { traceparent: INCOMING });
    expect(parseTraceparent(headers['traceparent'])?.traceId).toBe(TRACE);
  });

  it('carries it on a WebSocket handshake', async () => {
    const ws = await startWsUpstream();
    cleanups.push(ws.close);
    const g = await startGateway({
      upstreams: { chat: { url: ws.url } },
      routes: [{ path: '/chat', upstream: 'chat', stripPrefix: false, websocket: { allowAnyOrigin: true } }],
    });
    cleanups.push(g.close);
    const attempt = await openWs(g.base, { path: '/chat', headers: { traceparent: INCOMING } });
    expect(attempt.status).toBe(101);
    attempt.ws?.destroy();
    expect(parseTraceparent(ws.hits[0]?.headers['traceparent'])?.traceId).toBe(TRACE);
  });
});
