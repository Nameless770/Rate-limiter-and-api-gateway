import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';

/**
 * Why an upstream call failed, which decides whether retrying it is safe:
 *  connect  we never reached the server (refused, DNS, unreachable): nothing was sent, safe for any method
 *  timeout  no response in time: the server may have acted, so only retry idempotent methods
 *  reset    the connection dropped mid-flight: same caveat as timeout
 *  tls      the TLS handshake or certificate check failed: deterministic, so retrying is pointless
 *  aborted  our own side gave up (the client went away): says nothing about upstream health
 *  protocol the upstream answered, but not the way the protocol requires (a bad WebSocket handshake): deterministic
 */
export type UpstreamErrorKind = 'connect' | 'timeout' | 'reset' | 'tls' | 'aborted' | 'protocol';

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

/** What an upgrade request came back as: a switched protocol (101), or an ordinary refusal to relay as-is. */
export type UpgradeOutcome =
  | { kind: 'upgraded'; headers: IncomingHttpHeaders; socket: Duplex; head: Buffer }
  | { kind: 'rejected'; response: UpstreamResponse };

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
  /**
   * Most connections held open to this target. Requests beyond it wait for one to free up. Idle connections
   * are kept up to the same number: a lower "free" cap makes every burst above it destroy and re-open sockets,
   * which burns CPU on handshakes and exhausts ephemeral ports (TIME_WAIT) under sustained load.
   */
  maxConnections?: number;
  /** Client certificate and key presented to an https upstream that requires mutual TLS. */
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
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
    const max = options.maxConnections ?? 256;
    const agentOptions = { keepAlive: true, maxSockets: max, maxFreeSockets: max };
    this.agent =
      this.target.protocol === 'https:'
        ? new https.Agent({
            ...agentOptions,
            ...(options.ca ? { ca: options.ca } : {}),
            ...(options.cert && options.key
              ? { cert: options.cert, key: options.key, passphrase: options.passphrase }
              : {}),
          })
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
    return this.exchange(req, false).then((outcome) => {
      if (outcome.kind === 'rejected') return outcome.response;
      // Unreachable: we only ask Node to surface 'upgrade' when the caller asked for an upgrade.
      outcome.socket.destroy();
      throw new UpstreamError('reset', 'unexpected protocol switch');
    });
  }

  /**
   * Send a WebSocket-style upgrade request. Resolves with the raw socket once the upstream answers 101, with the
   * bytes it already sent after its headers. If the upstream answers with anything else, that response is handed
   * back to be relayed. The per-attempt timeout covers connecting and the handshake only: once upgraded, how long
   * the connection may live or idle is the caller's business.
   */
  upgrade(req: Omit<UpstreamRequest, 'method' | 'body'>): Promise<UpgradeOutcome> {
    return this.exchange({ ...req, method: 'GET' }, true);
  }

  private exchange(req: UpstreamRequest, allowUpgrade: boolean): Promise<UpgradeOutcome> {
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
          resolve({ kind: 'rejected', response: { status: res.statusCode ?? 502, headers: res.headers, stream: res } });
        },
      );

      // Give up on the attempt. Destroying the request is not enough on its own: while the pool is full (maxSockets)
      // a request waits in the agent's queue with no socket, and destroying it then does nothing until a socket
      // frees up, which would let a saturated upstream hold callers far past their deadline. So settle the promise
      // here as well; the destroyed request is discarded when its turn comes.
      const giveUp = (error: UpstreamError): void => {
        clearTimeout(headerTimer);
        req.signal?.removeEventListener('abort', onAbort);
        outgoing.destroy(error);
        reject(error);
      };

      // Covers waiting for a connection, connecting, and time to first byte. The socket idle timeout below covers
      // the rest of the exchange.
      const timeoutMs = req.timeoutMs ?? this.timeoutMs;
      const headerTimer = setTimeout(
        () => giveUp(new UpstreamError('timeout', `no response within ${timeoutMs}ms`)),
        timeoutMs,
      );
      outgoing.setTimeout(timeoutMs, () => giveUp(new UpstreamError('timeout', `upstream idle for ${timeoutMs}ms`)));

      const onAbort = (): void => giveUp(new UpstreamError('aborted', 'client went away'));
      req.signal?.addEventListener('abort', onAbort, { once: true });

      if (allowUpgrade) {
        outgoing.on('upgrade', (res, socket, head) => {
          clearTimeout(headerTimer);
          req.signal?.removeEventListener('abort', onAbort);
          socket.setTimeout(0); // the request-level idle timeout must not outlive the handshake
          socket.on('error', () => {}); // the tunnel attaches its own handler; until then an error must not be fatal
          resolve({ kind: 'upgraded', headers: res.headers, socket, head });
        });
      }

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
