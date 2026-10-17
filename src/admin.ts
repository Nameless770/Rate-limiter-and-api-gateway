/**
 * The admin listener: liveness, readiness, health and metrics, on its own port and apart from proxied traffic.
 *
 * It knows nothing about the gateway. Where its answers come from is passed in, so one gateway process serves its
 * own state and a cluster's primary process serves the combined state of its workers through the same code (and
 * the same token check).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { listenOn } from './net/listen.js';

export interface AdminAnswer {
  status: number;
  body: unknown;
  contentType?: string;
  headers?: Record<string, string>;
}

export interface AdminSources {
  /** Liveness: is the process working at all? Served without the token, so an orchestrator can probe it. */
  live(): AdminAnswer;
  /**
   * Readiness: should new traffic be sent here? Also served without the token. It is what a load balancer should
   * watch: it turns to "no" the moment shutdown begins, while the process is still alive and still finishing the
   * requests it has, so traffic is steered away before connections start being refused.
   */
  ready(): AdminAnswer;
  health(): unknown | Promise<unknown>;
  metrics(): string | Promise<string>;
}

export interface AdminOptions {
  host: string;
  port: number;
  /** When set, everything except liveness needs `Authorization: Bearer <token>`. */
  token?: string;
}

export class AdminListener {
  readonly server: http.Server;
  address?: AddressInfo;
  private readonly tokenDigest?: Buffer;

  constructor(
    private readonly options: AdminOptions,
    private readonly sources: AdminSources,
  ) {
    if (options.token !== undefined) this.tokenDigest = createHash('sha256').update(options.token).digest();
    this.server = http.createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => void this.handle(req, res));
    this.server.headersTimeout = 5_000;
    this.server.requestTimeout = 10_000;
  }

  async listen(): Promise<AddressInfo> {
    this.address = await listenOn(this.server, this.options.port, this.options.host);
    return this.address;
  }

  async close(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let answer: AdminAnswer;
    try {
      answer = await this.route(req);
    } catch {
      // A source that fails must not take the listener down or leak why.
      answer = { status: 500, body: { error: { code: 'internal_error' } } };
    }
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body);
    res.writeHead(answer.status, {
      'content-type': answer.contentType ?? 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...answer.headers,
    });
    res.end(req.method === 'HEAD' ? undefined : text);
  }

  private async route(req: IncomingMessage): Promise<AdminAnswer> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return { status: 405, body: { error: { code: 'method_not_allowed' } }, headers: { allow: 'GET, HEAD' } };
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://admin.invalid').pathname;
    } catch {
      return { status: 400, body: { error: { code: 'bad_request' } } };
    }

    if (pathname === '/_gateway/live') return this.sources.live();
    if (pathname === '/_gateway/ready') return this.sources.ready();

    if (this.tokenDigest && !this.authorized(req)) {
      return { status: 401, body: { error: { code: 'unauthorized' } }, headers: { 'www-authenticate': 'Bearer' } };
    }

    if (pathname === '/_gateway/metrics') {
      return {
        status: 200,
        body: await this.sources.metrics(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      };
    }
    if (pathname === '/_gateway/health') return { status: 200, body: await this.sources.health() };
    return { status: 404, body: { error: { code: 'route_not_found' } } };
  }

  private authorized(req: IncomingMessage): boolean {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    if (!match || !this.tokenDigest) return false;
    const presented = createHash('sha256')
      .update(match[1] as string)
      .digest();
    return timingSafeEqual(presented, this.tokenDigest);
  }
}
