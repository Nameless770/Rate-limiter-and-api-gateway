/**
 * Spans, and an exporter that sends them to an OpenTelemetry collector over OTLP/HTTP with a JSON body
 * (https://opentelemetry.io/docs/specs/otlp/). Hand-written so the gateway keeps its two runtime dependencies.
 *
 * Exporting never slows a request down or fails it: spans go into a bounded queue, a timer (or a full batch) sends
 * them in the background, and when the collector is slow, down or refusing, spans are dropped and counted rather
 * than piling up in memory.
 */
import http from 'node:http';
import https from 'node:https';

export type SpanKind = 'server' | 'client' | 'internal';
export type AttributeValue = string | number | boolean;

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** Wall-clock times in nanoseconds since the Unix epoch. */
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, AttributeValue | undefined>;
  /** Set when the operation failed: the span's status is then "error" with this as its message. */
  error?: string;
}

export interface OtlpExporterOptions {
  /** The collector's traces endpoint, e.g. http://otel-collector:4318/v1/traces. */
  endpoint: string;
  /** Extra request headers, e.g. a vendor's API key. */
  headers?: Record<string, string>;
  /** CA bundle for an https endpoint signed by a private CA. */
  ca?: Buffer;
  /** `service.name` on every span's resource. */
  serviceName: string;
  serviceVersion?: string;
  /** Most spans in one export request. */
  batchSize: number;
  /** How often queued spans are sent, at the latest. */
  flushIntervalMs: number;
  /** Most spans waiting to be sent; beyond it new spans are dropped. */
  maxQueueSpans: number;
  /** An export request that takes longer than this is abandoned (its spans are dropped). */
  timeoutMs: number;
  onExported?: (count: number) => void;
  onDropped?: (count: number, reason: 'queue_full' | 'export_failed') => void;
  onError?: (message: string) => void;
}

const KIND: Record<SpanKind, number> = { internal: 1, server: 2, client: 3 };
const STATUS_ERROR = 2;

/** A wall-clock time in nanoseconds, from the high-resolution timer (the same one `performance.now()` reads). */
export function nowNs(at = performance.now()): bigint {
  return BigInt(Math.round((performance.timeOrigin + at) * 1e6));
}

function anyValue(value: AttributeValue): Record<string, unknown> {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  return { stringValue: value };
}

function keyValues(attributes: Record<string, AttributeValue | undefined>): Array<Record<string, unknown>> {
  return Object.entries(attributes)
    .filter((entry): entry is [string, AttributeValue] => entry[1] !== undefined)
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

/** The OTLP/JSON request body for a batch of spans (ids hex-encoded, times as decimal strings, as the spec says). */
export function otlpBody(
  spans: readonly SpanData[],
  resource: { serviceName: string; serviceVersion?: string },
): string {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: keyValues({ 'service.name': resource.serviceName, 'service.version': resource.serviceVersion }),
        },
        scopeSpans: [
          {
            scope: { name: 'api-gateway' },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND[s.kind],
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: keyValues(s.attributes),
              status: s.error === undefined ? {} : { code: STATUS_ERROR, message: s.error },
            })),
          },
        ],
      },
    ],
  });
}

export class OtlpExporter {
  private queue: SpanData[] = [];
  private readonly timer: NodeJS.Timeout;
  private sending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly url: URL;
  private readonly agent: http.Agent;

  constructor(private readonly options: OtlpExporterOptions) {
    this.url = new URL(options.endpoint);
    const secure = this.url.protocol === 'https:';
    // One kept-alive connection is plenty for batches every few seconds.
    this.agent = secure
      ? new https.Agent({ keepAlive: true, maxSockets: 1, ca: options.ca })
      : new http.Agent({ keepAlive: true, maxSockets: 1 });
    this.timer = setInterval(() => void this.flush(), options.flushIntervalMs);
    this.timer.unref();
  }

  /** Queue a finished span. Never blocks and never throws: past the queue limit the span is dropped and counted. */
  add(span: SpanData): void {
    if (this.closed) return;
    if (this.queue.length >= this.options.maxQueueSpans) {
      this.options.onDropped?.(1, 'queue_full');
      return;
    }
    this.queue.push(span);
    if (this.queue.length >= this.options.batchSize) void this.flush();
  }

  /** Spans waiting to be sent. */
  get pending(): number {
    return this.queue.length;
  }

  /** Send everything queued so far, one batch at a time (export requests never overlap). */
  flush(): Promise<void> {
    this.sending = this.sending.then(async () => {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.options.batchSize);
        await this.send(batch);
      }
    });
    return this.sending;
  }

  /** Send what is queued (bounded by the export timeout) and stop. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
    this.closed = true;
    this.agent.destroy();
  }

  private async send(batch: SpanData[]): Promise<void> {
    const body = otlpBody(batch, this.options);
    const client = this.url.protocol === 'https:' ? https : http;
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (outcome: () => void): void => {
        if (settled) return; // an error after the response ended, say: the batch was already accounted for
        settled = true;
        outcome();
        resolve();
      };
      const failed = (message: string): void =>
        settle(() => {
          this.options.onDropped?.(batch.length, 'export_failed');
          this.options.onError?.(message);
        });
      const req = client.request(
        this.url,
        {
          method: 'POST',
          agent: this.agent,
          headers: {
            ...this.options.headers,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
          timeout: this.options.timeoutMs,
        },
        (res) => {
          res.resume();
          res.on('end', () => {
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) settle(() => this.options.onExported?.(batch.length));
            else failed(`collector answered ${status}`);
          });
          res.on('error', () => failed('the collector connection failed mid-response'));
        },
      );
      req.on('timeout', () => req.destroy(new Error(`no answer within ${this.options.timeoutMs}ms`)));
      req.on('error', (error) => failed(error.message));
      req.end(body);
    });
  }
}
