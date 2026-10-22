/**
 * The OTLP/HTTP exporter on its own, against a fake collector: the request it sends, batching, and what happens
 * when the collector is slow, failing or gone (spans are dropped and counted, never piled up).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { OtlpExporter, type OtlpExporterOptions, otlpBody, type SpanData } from '../src/observability/otlp.js';
import { closedPort, sleep } from './helpers.js';
import { type FakeCollector, startCollector } from './otlpHelpers.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

const span = (n: number, extra: Partial<SpanData> = {}): SpanData => ({
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: `00f067aa0ba902${String(n).padStart(2, '0')}`,
  name: `span ${n}`,
  kind: 'server',
  startNs: 1_700_000_000_000_000_000n + BigInt(n),
  endNs: 1_700_000_000_500_000_000n + BigInt(n),
  attributes: {},
  ...extra,
});

function exporter(endpoint: string, options: Partial<OtlpExporterOptions> = {}) {
  const counts = { exported: 0, dropped: { queue_full: 0, export_failed: 0 }, errors: [] as string[] };
  const e = new OtlpExporter({
    endpoint,
    serviceName: 'gw-test',
    batchSize: 100,
    flushIntervalMs: 60_000,
    maxQueueSpans: 1_000,
    timeoutMs: 2_000,
    onExported: (n) => {
      counts.exported += n;
    },
    onDropped: (n, reason) => {
      counts.dropped[reason] += n;
    },
    onError: (message) => void counts.errors.push(message),
    ...options,
  });
  cleanups.push(() => e.close());
  return { e, counts };
}

async function collector(): Promise<FakeCollector> {
  const c = await startCollector();
  cleanups.push(c.close);
  return c;
}

describe('the OTLP/JSON body', () => {
  it('follows the spec: hex ids, numeric kinds, times as decimal strings, typed attributes', () => {
    const body = JSON.parse(
      otlpBody(
        [
          span(1, {
            parentSpanId: 'aaaaaaaaaaaaaaaa',
            kind: 'client',
            attributes: { 'http.response.status_code': 200, ratio: 0.5, ok: true, name: 'x', missing: undefined },
          }),
          span(2, { kind: 'internal', error: 'timeout' }),
        ],
        { serviceName: 'gw-test', serviceVersion: '1.2.3' },
      ),
    );
    const [resourceSpans] = body.resourceSpans;
    expect(resourceSpans.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: 'gw-test' } },
      { key: 'service.version', value: { stringValue: '1.2.3' } },
    ]);
    const [first, second] = resourceSpans.scopeSpans[0].spans;
    expect(first).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba90201',
      parentSpanId: 'aaaaaaaaaaaaaaaa',
      name: 'span 1',
      kind: 3,
      startTimeUnixNano: '1700000000000000001',
      endTimeUnixNano: '1700000000500000001',
      attributes: [
        { key: 'http.response.status_code', value: { intValue: '200' } },
        { key: 'ratio', value: { doubleValue: 0.5 } },
        { key: 'ok', value: { boolValue: true } },
        { key: 'name', value: { stringValue: 'x' } },
      ],
      status: {},
    });
    expect(second.kind).toBe(1);
    expect(second.parentSpanId).toBeUndefined();
    expect(second.status).toEqual({ code: 2, message: 'timeout' });
  });
});

describe('the exporter', () => {
  it('sends a full batch at once and the rest on flush, with its headers', async () => {
    const c = await collector();
    const { e, counts } = exporter(c.url, { batchSize: 2, headers: { authorization: 'Bearer vendor-key' } });
    for (let i = 1; i <= 5; i++) e.add(span(i));
    await e.flush();
    expect(c.requests.map((r) => r.body.resourceSpans[0]?.scopeSpans[0]?.spans.length)).toEqual([2, 2, 1]);
    expect(c.spans().map((s) => s.name)).toEqual(['span 1', 'span 2', 'span 3', 'span 4', 'span 5']);
    expect(c.requests[0]?.headers['authorization']).toBe('Bearer vendor-key');
    expect(c.requests[0]?.headers['content-type']).toBe('application/json');
    expect(counts.exported).toBe(5);
  });

  it('sends a batch as soon as it is full, without waiting for the timer', async () => {
    const c = await collector();
    const { e } = exporter(c.url, { batchSize: 2 }); // the timer is a minute away
    e.add(span(1));
    await sleep(50);
    expect(c.spans()).toHaveLength(0);
    e.add(span(2));
    for (let i = 0; i < 100 && c.spans().length < 2; i++) await sleep(10);
    expect(c.spans()).toHaveLength(2);
  });

  it('sends on its own schedule without being asked', async () => {
    const c = await collector();
    const { e } = exporter(c.url, { flushIntervalMs: 30 });
    e.add(span(1));
    for (let i = 0; i < 100 && c.spans().length === 0; i++) await sleep(10);
    expect(c.spans()).toHaveLength(1);
  });

  it('drops (and counts) spans beyond the queue limit instead of holding them', async () => {
    const c = await collector();
    const { e, counts } = exporter(c.url, { maxQueueSpans: 3 });
    for (let i = 1; i <= 5; i++) e.add(span(i));
    expect(e.pending).toBe(3);
    expect(counts.dropped.queue_full).toBe(2);
    await e.flush();
    expect(c.spans()).toHaveLength(3);
  });

  it('drops a batch the collector refuses, and says why', async () => {
    const c = await collector();
    c.respond.status = 503;
    const { e, counts } = exporter(c.url);
    e.add(span(1));
    e.add(span(2));
    await e.flush();
    expect(counts).toMatchObject({ exported: 0, dropped: { export_failed: 2 } });
    expect(counts.errors).toEqual(['collector answered 503']);
    expect(e.pending).toBe(0); // not kept for a retry that would only grow the queue
  });

  it('drops a batch when the collector is unreachable or never answers', async () => {
    const down = exporter(`http://127.0.0.1:${await closedPort()}/v1/traces`);
    down.e.add(span(1));
    await down.e.flush();
    expect(down.counts.dropped.export_failed).toBe(1);

    const c = await collector();
    c.respond.hang = true;
    const slow = exporter(c.url, { timeoutMs: 100 });
    slow.e.add(span(2));
    const started = Date.now();
    await slow.e.flush();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(slow.counts.dropped.export_failed).toBe(1);
    expect(slow.counts.errors[0]).toMatch(/no answer within 100ms/);
  });

  it('sends what it holds when closed, and accepts nothing after', async () => {
    const c = await collector();
    const { e, counts } = exporter(c.url);
    e.add(span(1));
    await e.close();
    expect(c.spans()).toHaveLength(1);
    e.add(span(2));
    expect(e.pending).toBe(0);
    expect(counts.exported).toBe(1);
  });
});
