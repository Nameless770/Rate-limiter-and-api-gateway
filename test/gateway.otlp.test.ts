/**
 * Spans the gateway records and exports over OTLP: one per request, one per upstream attempt, one per background
 * cache refresh, joined into the caller's trace and the upstream's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { parseTraceparent } from '../src/observability/trace.js';
import { securityNotes } from '../src/security.js';
import { json, type RunningGateway, rawRequest, sleep, startGateway, startUpstream } from './helpers.js';
import { attr, type FakeCollector, type OtlpSpan, startCollector } from './otlpHelpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const CALLER_SPAN = '00f067aa0ba902b7';

interface Setup {
  c: FakeCollector;
  g: RunningGateway;
  upstreamParents: string[];
  /** The sampled flag the upstream was given on each request. */
  upstreamFlags: string[];
  behaviour: { failFirst: number; cacheControl?: string };
  get(path: string, headers?: Record<string, string>): ReturnType<typeof rawRequest>;
  /** Wait until the collector has at least `n` spans, and return them. */
  spans(n: number): Promise<OtlpSpan[]>;
}

async function setup(tracing: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<Setup> {
  const c = await startCollector();
  cleanups.push(c.close);
  const upstreamParents: string[] = [];
  const upstreamFlags: string[] = [];
  const behaviour: Setup['behaviour'] = { failFirst: 0 };
  const up = await startUpstream((req, res) => {
    const parent = parseTraceparent(req.headers['traceparent']);
    upstreamParents.push(parent?.parentId ?? '');
    upstreamFlags.push(parent?.flags ?? '');
    if (behaviour.failFirst > 0) {
      behaviour.failFirst--;
      return json(res, 503, { busy: true });
    }
    json(res, 200, { ok: true }, behaviour.cacheControl ? { 'cache-control': behaviour.cacheControl } : {});
  });
  cleanups.push(up.close);
  const { otlp, ...rest } = tracing as { otlp?: Record<string, unknown> };
  const g = await startGateway({
    tracing: { otlp: { endpoint: c.url, flushIntervalMs: 20, ...otlp }, ...rest },
    upstreams: { u: { url: up.url, retry: { maxAttempts: 3, retryOnStatus: [503] } } },
    routes: [
      { id: 'api', path: '/api', upstream: 'u' },
      { id: 'cached', path: '/cached', upstream: 'u', cache: { ttlMs: 1_000, varyHeaders: [] } },
    ],
    ...extra,
  });
  cleanups.push(g.close);
  return {
    c,
    g,
    upstreamParents,
    upstreamFlags,
    behaviour,
    get: (path, headers = {}) => rawRequest(g.base, { path, headers }),
    spans: async (n) => {
      for (let i = 0; i < 300 && c.spans().length < n; i++) await sleep(10);
      return c.spans();
    },
  };
}

const byKind = (spans: OtlpSpan[], kind: number) => spans.filter((s) => s.kind === kind);
const SERVER = 2;
const CLIENT = 3;
const INTERNAL = 1;

describe('exporting spans', () => {
  it("records the request and its upstream attempt, joined to the caller's trace and the upstream's", async () => {
    const t = await setup();
    const res = await t.get('/api/users/7', { traceparent: `00-${TRACE}-${CALLER_SPAN}-01` });
    expect(res.status).toBe(200);
    const spans = await t.spans(2);
    const [server] = byKind(spans, SERVER);
    const [client] = byKind(spans, CLIENT);

    expect(server).toMatchObject({ traceId: TRACE, parentSpanId: CALLER_SPAN, name: 'GET /api' });
    expect(attr(server as OtlpSpan, 'http.response.status_code')).toBe(200);
    expect(attr(server as OtlpSpan, 'url.path')).toBe('/api/users/7');
    expect(attr(server as OtlpSpan, 'http.route')).toBe('/api');
    expect(attr(server as OtlpSpan, 'gateway.request_id')).toBe(res.headers['x-request-id']);

    expect(client).toMatchObject({ traceId: TRACE, parentSpanId: server?.spanId, name: 'GET u' });
    expect(attr(client as OtlpSpan, 'server.address')).toBe('127.0.0.1');
    expect(attr(client as OtlpSpan, 'http.response.status_code')).toBe(200);
    // The upstream was told the attempt is its parent, so its own spans hang off this one.
    expect(t.upstreamParents).toEqual([client?.spanId]);
    expect(BigInt(client?.startTimeUnixNano ?? 0)).toBeGreaterThanOrEqual(BigInt(server?.startTimeUnixNano ?? 0));
    expect(BigInt(client?.endTimeUnixNano ?? 0)).toBeLessThanOrEqual(BigInt(server?.endTimeUnixNano ?? 0));
  });

  it('records each retry as its own attempt, the failed one marked as an error', async () => {
    const t = await setup();
    t.behaviour.failFirst = 1;
    expect((await t.get('/api/x')).status).toBe(200);
    const spans = await t.spans(3);
    const attempts = byKind(spans, CLIENT);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.status).toEqual({ code: 2, message: 'status 503' });
    expect(attr(attempts[0] as OtlpSpan, 'error.type')).toBe('503');
    expect(attempts[1]?.status).toEqual({});
    expect(attr(attempts[1] as OtlpSpan, 'http.request.resend_count')).toBe(1);
    const [server] = byKind(spans, SERVER);
    expect(attempts.every((a) => a.parentSpanId === server?.spanId)).toBe(true);
    expect(t.upstreamParents).toEqual(attempts.map((a) => a.spanId));
  });

  it('marks a failed request as an error, down to the attempt that could not connect', async () => {
    const t = await setup({}, { upstreams: { u: { url: 'http://127.0.0.1:1', retry: { maxAttempts: 1 } } } });
    expect((await t.get('/api/x')).status).toBe(502);
    const spans = await t.spans(2);
    expect(byKind(spans, SERVER)[0]?.status).toEqual({ code: 2, message: 'status 502' });
    expect(byKind(spans, CLIENT)[0]?.status).toEqual({ code: 2, message: 'connect' });
  });

  it('records a background cache refresh beneath the request that set it off', async () => {
    const t = await setup();
    t.behaviour.cacheControl = 'max-age=1, stale-while-revalidate=60';
    await t.get('/cached/x');
    t.g.clock.advance(2_000);
    expect((await t.get('/cached/x')).headers['x-cache']).toBe('STALE');
    const spans = await t.spans(5); // two requests, two attempts, one refresh
    const [refresh] = byKind(spans, INTERNAL);
    expect(refresh?.name).toBe('cache refresh');
    expect(attr(refresh as OtlpSpan, 'gateway.refresh_result')).toBe('stored');
    const servers = byKind(spans, SERVER);
    expect(servers.map((s) => s.spanId)).toContain(refresh?.parentSpanId);
    expect(byKind(spans, CLIENT).some((a) => a.parentSpanId === refresh?.spanId)).toBe(true);
  });

  it('counts what it exported, and what it could not deliver', async () => {
    const t = await setup();
    await t.get('/api/x');
    await t.spans(2);
    for (let i = 0; i < 100; i++) {
      if (
        /gateway_trace_spans_exported_total 2/.test(
          (await rawRequest(t.g.adminBase, { path: '/_gateway/metrics' })).body,
        )
      )
        break;
      await sleep(10);
    }
    t.c.respond.status = 500;
    await t.get('/api/y');
    let metrics = '';
    for (let i = 0; i < 300; i++) {
      metrics = (await rawRequest(t.g.adminBase, { path: '/_gateway/metrics' })).body;
      if (/gateway_trace_spans_dropped_total\{reason="export_failed"\} 2/.test(metrics)) break;
      await sleep(10);
    }
    expect(metrics).toMatch(/gateway_trace_spans_exported_total 2/);
    expect(metrics).toMatch(/gateway_trace_spans_dropped_total\{reason="export_failed"\} 2/);
  });

  it('sends what it still holds when the gateway shuts down', async () => {
    const t = await setup({ otlp: { flushIntervalMs: 60_000 } });
    await t.get('/api/x');
    expect(t.c.spans()).toHaveLength(0);
    await t.g.close();
    expect(t.c.spans()).toHaveLength(2);
  });
});

describe('sampling', () => {
  it('samples traces started here at sampleRatio, and tells the upstream so', async () => {
    const t = await setup({ sampleRatio: 0 });
    await t.get('/api/x');
    await sleep(80);
    expect(t.c.spans()).toHaveLength(0);
    expect(t.upstreamFlags).toEqual(['00']); // so the services behind leave it unrecorded too

    const all = await setup({ sampleRatio: 1 });
    await all.get('/api/x');
    expect(await all.spans(2)).toHaveLength(2);
    expect(all.upstreamFlags).toEqual(['01']);
  });

  it("keeps the caller's decision for a trace it continues, either way", async () => {
    const t = await setup({ sampleRatio: 0 });
    await t.get('/api/x', { traceparent: `00-${TRACE}-${CALLER_SPAN}-01` });
    expect((await t.spans(2)).every((s) => s.traceId === TRACE)).toBe(true);

    const u = await setup({ sampleRatio: 1 });
    await u.get('/api/x', { traceparent: `00-${TRACE}-${CALLER_SPAN}-00` });
    await sleep(80);
    expect(u.c.spans()).toHaveLength(0);
  });
});

describe('tracing configuration', () => {
  it('exports nothing when tracing is off, whatever otlp says', async () => {
    const t = await setup({ enabled: false });
    await t.get('/api/x');
    await sleep(80);
    expect(t.c.requests).toHaveLength(0);
  });

  it('moves to a new collector on reload, and stops exporting when otlp is removed', async () => {
    const t = await setup();
    const other = await startCollector();
    cleanups.push(other.close);
    const config = t.g.gateway.config;
    t.g.gateway.reload(
      parseConfig({ ...config, tracing: { ...config.tracing, otlp: { endpoint: other.url, flushIntervalMs: 20 } } }),
    );
    await t.get('/api/x');
    for (let i = 0; i < 300 && other.spans().length < 2; i++) await sleep(10);
    expect(other.spans()).toHaveLength(2);
    expect(t.c.spans()).toHaveLength(0);

    t.g.gateway.reload(parseConfig({ ...config, tracing: { ...config.tracing, otlp: undefined } }));
    await t.get('/api/y');
    await sleep(80);
    expect(other.spans()).toHaveLength(2);
  });

  it('warns at start-up about spans sent in plaintext off this machine', () => {
    const base = { upstreams: { u: { url: 'http://a:1' } }, routes: [{ path: '/', upstream: 'u' }] };
    const note = (endpoint: string) =>
      securityNotes(parseConfig({ ...base, tracing: { otlp: { endpoint } } })).find((n) => n.startsWith('trace spans'));
    expect(note('http://otel.internal:4318/v1/traces')).toMatch(/trace spans go to "otel.internal" over plain HTTP/);
    expect(note('https://otel.internal:4318/v1/traces')).toBeUndefined();
    expect(note('http://127.0.0.1:4318/v1/traces')).toBeUndefined();
    expect(note('http://[::1]:4318/v1/traces')).toBeUndefined();
  });

  it('wants an https endpoint before a CA bundle means anything, and a readable bundle', () => {
    const base = { upstreams: { u: { url: 'http://a:1' } }, routes: [{ path: '/', upstream: 'u' }] };
    expect(() =>
      parseConfig({ ...base, tracing: { otlp: { endpoint: 'http://c:4318/v1/traces', caFile: 'ca.pem' } } }),
    ).toThrow(/caFile requires an https:\/\/ endpoint/);
    expect(() => parseConfig({ ...base, tracing: { otlp: { endpoint: 'not a url' } } })).toThrow(/endpoint/);
    expect(() => parseConfig({ ...base, tracing: { sampleRatio: 1.5 } })).toThrow(/sampleRatio/);
  });
});
