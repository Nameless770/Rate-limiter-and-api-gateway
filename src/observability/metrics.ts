/**
 * A deliberately tiny Prometheus-compatible registry: counters, callback gauges and fixed-bucket histograms,
 * rendered in the text exposition format. Enough to scrape; no dependency.
 */
type Labels = Record<string, string | number>;

function labelKey(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabel(String(labels[k]))}"`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function line(name: string, key: string, value: number): string {
  return key ? `${name}{${key}} ${value}` : `${name} ${value}`;
}

export class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, amount = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + amount);
  }

  /** Current value for a label set (used by tests). */
  get(labels: Labels = {}): number {
    return this.values.get(labelKey(labels)) ?? 0;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, value] of this.values) out.push(line(this.name, key, value));
    return out;
  }
}

export class Gauge {
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly collect: () => Array<{ labels: Labels; value: number }>,
  ) {}

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.collect()) out.push(line(this.name, labelKey(labels), value));
    return out;
  }
}

export class Histogram {
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[],
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const key = labelKey(labels);
    let s = this.series.get(key);
    if (!s) {
      s = { counts: new Array<number>(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, s);
    }
    this.buckets.forEach((upper, i) => {
      if (value <= upper) (s as { counts: number[] }).counts[i]!++;
    });
    s.sum += value;
    s.count++;
  }

  render(): string[] {
    const out = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, s] of this.series) {
      const prefix = key ? `${key},` : '';
      this.buckets.forEach((upper, i) => out.push(line(`${this.name}_bucket`, `${prefix}le="${upper}"`, s.counts[i] ?? 0)));
      out.push(line(`${this.name}_bucket`, `${prefix}le="+Inf"`, s.count));
      out.push(line(`${this.name}_sum`, key, s.sum));
      out.push(line(`${this.name}_count`, key, s.count));
    }
    return out;
  }
}

export class Registry {
  private readonly metrics: Array<Counter | Gauge | Histogram> = [];

  counter(name: string, help: string): Counter {
    const c = new Counter(name, help);
    this.metrics.push(c);
    return c;
  }

  gauge(name: string, help: string, collect: () => Array<{ labels: Labels; value: number }>): Gauge {
    const g = new Gauge(name, help, collect);
    this.metrics.push(g);
    return g;
  }

  histogram(name: string, help: string, buckets: readonly number[]): Histogram {
    const h = new Histogram(name, help, buckets);
    this.metrics.push(h);
    return h;
  }

  render(): string {
    return `${this.metrics.flatMap((m) => m.render()).join('\n')}\n`;
  }
}
