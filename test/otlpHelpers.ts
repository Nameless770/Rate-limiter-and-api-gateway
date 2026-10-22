/** A fake OpenTelemetry collector for the exporter and gateway tracing tests. */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeCollector {
  url: string;
  /** Every export request received, parsed. */
  requests: Array<{ headers: IncomingMessage['headers']; body: OtlpRequest }>;
  /** Every span received, in order. */
  spans(): OtlpSpan[];
  /** Answer exports with this status (default 200), or not at all (`hang`). */
  respond: { status: number; hang: boolean };
  close(): Promise<void>;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, unknown> }>;
  status: { code?: number; message?: string };
}

interface OtlpRequest {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
    scopeSpans: Array<{ scope: { name: string }; spans: OtlpSpan[] }>;
  }>;
}

/** An attribute's value, whatever its OTLP type. */
export const attr = (span: OtlpSpan, key: string): unknown => {
  const value = span.attributes.find((a) => a.key === key)?.value;
  if (!value) return undefined;
  if ('intValue' in value) return Number(value['intValue']);
  return Object.values(value)[0];
};

export async function startCollector(): Promise<FakeCollector> {
  const requests: FakeCollector['requests'] = [];
  const respond = { status: 200, hang: false };
  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) as OtlpRequest });
      if (respond.hang) return;
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`,
    requests,
    respond,
    spans: () => requests.flatMap((r) => r.body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((s) => s.spans))),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
