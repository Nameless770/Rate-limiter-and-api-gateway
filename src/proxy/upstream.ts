import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';

/**
 * Why an upstream call failed, which decides whether retrying it is safe:
 *  connect  we never reached the server (refused, DNS, unreachable): nothing was sent, safe for any method
 *  timeout  no response in time: the server may have acted, so only retry idempotent methods
 *  reset    the connection dropped mid-flight: same caveat as timeout
 *  tls      the TLS handshake or certificate check failed: deterministic, so retrying is pointless
 *  aborted  our own side gave up (the client went away): says nothing about upstream health
 */
export type UpstreamErrorKind = 'connect' | 'timeout' | 'reset' | 'tls' | 'aborted';

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'UpstreamError';
  }
}

export interface UpstreamRequest {
  method: string;
  /** Path plus query string, already joined with the upstream base path. */
  path: string;
  headers: Record<string, string | string[]>;
  body?: Buffer;
  signal?: AbortSignal;
  /** Overrides the client's default per-attempt timeout (used to respect an overall deadline). */
  timeoutMs?: number;
}

export interface UpstreamResponse {
  status: number;
  headers: IncomingHttpHeaders;
  /** Unread body. The caller must consume or destroy it, or the socket is never released. */
  stream: IncomingMessage;
}

export interface UpstreamClientOptions {
  /** Default per-attempt timeout: connect + time to first byte, then idle time. */
  timeoutMs: number;
  /**
   * PEM CA bundle for an https upstream signed by a private CA. It replaces Node's default trust store for
   * this upstream only, so the upstream must chain to one of these certificates.
   */
  ca?: string | Buffer;
}

const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
/** OpenSSL verification failures (CERT_HAS_EXPIRED, DEPTH_ZERO_SELF_SIGNED_CERT, ...) and Node's TLS/SSL errors. */
const TLS_CODE = /^ERR_(TLS|SSL)_|CERT|SELF_SIGNED|^UNABLE_TO_/;

export class UpstreamClient {
  private readonly target: URL;
  private readonly agent: http.Agent;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, options: UpstreamClientOptions) {
    this.target = new URL(baseUrl);
    this.timeoutMs = options.timeoutMs;
    const agentOptions = { keepAlive: true, maxSockets: 256, maxFreeSockets: 32 };
    this.agent =
      this.target.protocol === 'https:'
        ? new https.Agent({ ...agentOptions, ...(options.ca ? { ca: options.ca } : {}) })
        : new http.Agent(agentOptions);
  }

  get host(): string {
    return this.target.host;
  }

  /** The upstream's own base path joined with the request path: base "/api/v1" + "/users" -> "/api/v1/users". */
  resolvePath(pathWithQuery: string): string {
    const base = this.target.pathname.replace(/\/+$/, '');
    return `${base}${pathWithQuery}`;
  }

  request(req: UpstreamRequest): Promise<UpstreamResponse> {
    return new Promise((resolve, reject) => {
      if (req.signal?.aborted) return reject(new UpstreamError('aborted', 'client went away'));

      const lib = this.target.protocol === 'https:' ? https : http;
      const hostname = this.target.hostname.replace(/^\[|\]$/g, ''); // URL keeps the brackets on IPv6 literals

      const outgoing = lib.request(
        {
          agent: this.agent,
          hostname,
          port: this.target.port || undefined,
          method: req.method,
          path: req.path,
          headers: req.headers,
        },
        (res) => {
          clearTimeout(headerTimer);
          req.signal?.removeEventListener('abort', onAbort);
          resolve({ status: res.statusCode ?? 502, headers: res.headers, stream: res });
        },
      );

      // Covers connect + time to first byte. The socket idle timeout below covers the rest of the exchange.
      const timeoutMs = req.timeoutMs ?? this.timeoutMs;
      const headerTimer = setTimeout(() => {
        outgoing.destroy(new UpstreamError('timeout', `no response within ${timeoutMs}ms`));
      }, timeoutMs);
      outgoing.setTimeout(timeoutMs, () => {
        outgoing.destroy(new UpstreamError('timeout', `upstream idle for ${timeoutMs}ms`));
      });

      const onAbort = (): void => {
        outgoing.destroy(new UpstreamError('aborted', 'client went away'));
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });

      outgoing.on('error', (error) => {
        clearTimeout(headerTimer);
        req.signal?.removeEventListener('abort', onAbort);
        reject(classify(error));
      });

      outgoing.end(req.body);
    });
  }

  close(): void {
    this.agent.destroy();
  }
}

function classify(error: unknown): UpstreamError {
  if (error instanceof UpstreamError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code && CONNECT_CODES.has(code))
    return new UpstreamError('connect', `cannot connect to upstream (${code})`, { cause: error });
  if (code && TLS_CODE.test(code)) return new UpstreamError('tls', `upstream TLS failed (${code})`, { cause: error });
  return new UpstreamError('reset', `upstream connection failed (${code ?? (error as Error).message})`, {
    cause: error,
  });
}
