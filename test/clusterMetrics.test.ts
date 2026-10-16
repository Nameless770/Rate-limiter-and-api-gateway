import { describe, expect, it } from 'vitest';
import { mergeMetrics, withLabel } from '../src/cluster/metrics.js';
import { Registry } from '../src/observability/metrics.js';

describe('withLabel', () => {
  it('adds the label to a sample with labels, one without, and one with an empty set', () => {
    expect(withLabel('a_total{route="x"} 3', 'worker="0"')).toBe('a_total{worker="0",route="x"} 3');
    expect(withLabel('up 1', 'worker="0"')).toBe('up{worker="0"} 1');
    expect(withLabel('up{} 1', 'worker="0"')).toBe('up{worker="0"} 1');
  });

  it('is not confused by braces, spaces, quotes or commas inside a label value', () => {
    expect(withLabel('m{path="/a b}{c",x="\\"q\\""} 7', 'worker="1"')).toBe(
      'm{worker="1",path="/a b}{c",x="\\"q\\""} 7',
    );
  });

  it('leaves a line with no value alone rather than mangle it', () => {
    expect(withLabel('garbage', 'worker="0"')).toBe('garbage');
  });
});

/** A registry shaped like a gateway's: counters with labels, a histogram, and gauges with and without labels. */
function workerText(requests: number): string {
  const registry = new Registry();
  const total = registry.counter('gateway_requests_total', 'Requests handled, by route and status.');
  total.inc({ route: 'api', status: 200 }, requests);
  total.inc({ route: 'api', status: 429 }, 1);
  const latency = registry.histogram('gateway_request_duration_seconds', 'End-to-end request latency.', [0.1, 1]);
  latency.observe(0.05, { route: 'api' });
  latency.observe(0.5, { route: 'api' });
  registry.gauge('gateway_connections', 'Open client connections.', () => [{ labels: {}, value: requests }]);
  registry.gauge('gateway_circuit_state', 'Circuit state.', () => [
    { labels: { upstream: 'u', target: 'h:1' }, value: 0 },
  ]);
  return registry.render();
}

const samples = (text: string): string[] => text.split('\n').filter((l) => l && !l.startsWith('#'));

describe('mergeMetrics', () => {
  const merged = mergeMetrics([
    { worker: '0', text: workerText(10) },
    { worker: '1', text: workerText(20) },
  ]);

  it('keeps every series of every worker, each under its worker label', () => {
    const a = samples(workerText(10));
    const b = samples(workerText(20));
    expect(samples(merged)).toHaveLength(a.length + b.length);
    expect(merged).toContain('gateway_requests_total{worker="0",route="api",status="200"} 10');
    expect(merged).toContain('gateway_requests_total{worker="1",route="api",status="200"} 20');
    expect(merged).toContain('gateway_connections{worker="0"} 10');
    expect(merged).toContain('gateway_connections{worker="1"} 20');
    expect(merged).toContain('gateway_circuit_state{worker="1",target="h:1",upstream="u"} 0');
  });

  it('labels every bucket, sum and count of a histogram, and keeps the le label', () => {
    expect(merged).toContain('gateway_request_duration_seconds_bucket{worker="0",route="api",le="0.1"} 1');
    expect(merged).toContain('gateway_request_duration_seconds_bucket{worker="1",route="api",le="+Inf"} 2');
    expect(merged).toContain('gateway_request_duration_seconds_sum{worker="0",route="api"} 0.55');
    expect(merged).toContain('gateway_request_duration_seconds_count{worker="1",route="api"} 2');
  });

  it('declares each family once, with all of its series together', () => {
    const lines = merged.split('\n');
    for (const name of ['gateway_requests_total', 'gateway_request_duration_seconds', 'gateway_connections']) {
      expect(
        lines.filter(
          (l) =>
            l ===
            `# TYPE ${name} ${name.endsWith('seconds') ? 'histogram' : name.endsWith('total') ? 'counter' : 'gauge'}`,
        ),
      ).toHaveLength(1);
      expect(lines.filter((l) => l.startsWith(`# HELP ${name} `))).toHaveLength(1);
    }
    // a family's series are one contiguous block, as the exposition format requires
    const seen: string[] = [];
    for (const line of lines.filter((l) => l.startsWith('# TYPE '))) seen.push(line.split(' ')[2] as string);
    expect(new Set(seen).size).toBe(seen.length);
    const firstCounter = lines.findIndex((l) => l.startsWith('gateway_requests_total{'));
    const lastCounter = lines.findLastIndex((l) => l.startsWith('gateway_requests_total{'));
    expect(lines.slice(firstCounter, lastCounter + 1).every((l) => l.startsWith('gateway_requests_total{'))).toBe(true);
  });

  it('produces valid exposition text: every line is a comment or name{labels} value', () => {
    for (const line of merged.trimEnd().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) \S+ .+|[a-z_]+(\{.*\})? -?[0-9.e+]+)$/);
    }
    expect(merged.endsWith('\n')).toBe(true);
  });

  it('includes a family that only some workers have', () => {
    const only = new Registry();
    only.counter('gateway_only_here_total', 'Only on one.').inc();
    const text = mergeMetrics([
      { worker: 'primary', text: only.render() },
      { worker: '0', text: workerText(1) },
    ]);
    expect(text).toContain('gateway_only_here_total{worker="primary"} 1');
    expect(text).toContain('gateway_connections{worker="0"} 1');
  });

  it('copes with nothing, with blank lines, and with samples that have no header', () => {
    expect(mergeMetrics([])).toBe('');
    expect(mergeMetrics([{ worker: '0', text: '' }])).toBe('');
    expect(mergeMetrics([{ worker: '0', text: '\n\nloose_metric 5\n\n' }])).toBe('loose_metric{worker="0"} 5\n');
  });

  it('drops comments that are neither HELP nor TYPE, and escapes a worker name', () => {
    const text = mergeMetrics([{ worker: 'a"b\\c', text: '# a comment\n# HELP m Help text\n# TYPE m gauge\nm 1\n' }]);
    expect(text).toBe('# HELP m Help text\n# TYPE m gauge\nm{worker="a\\"b\\\\c"} 1\n');
  });
});
