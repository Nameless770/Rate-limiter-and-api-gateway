import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createSecureContext, type TLSSocket } from 'node:tls';
import { AdminListener } from './admin.js';
import { bearerToken, type JwtIssuer, JwtKeyError, JwtVerifier, loadIssuer } from './auth/jwt.js';
import {
  requestCacheInfo,
  requestIsCacheSafe,
  type StaleDefaults,
  type StoreDecision,
  storeDecision,
} from './cache/policy.js';
import { type CachedResponse, ResponseCache } from './cache/responseCache.js';
import {
  ConfigError,
  type GatewayConfig,
  type RateLimitRuleConfig,
  type RouteConfig,
  redisMode,
  type UpstreamConfig,
  upstreamTargets,
} from './config.js';
import { normalizeIp } from './net/ip.js';
import { listenOn } from './net/listen.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Registry } from './observability/metrics.js';
import { nowNs, OtlpExporter, type SpanData } from './observability/otlp.js';
import { registerProcessMetrics } from './observability/process.js';
import {
  childOf,
  formatTraceparent,
  isSampled,
  newSpanId,
  startOrContinue,
  type TraceContext,
} from './observability/trace.js';
import { sanitizeRequestId, stripHopByHop } from './proxy/headers.js';
import { UpstreamClient, UpstreamError, type UpstreamResponse } from './proxy/upstream.js';
import {
  acceptKey,
  checkUpstreamHandshake,
  openTunnel,
  originAllowed,
  type Tunnel,
  validateHandshake,
} from './proxy/websocket.js';
import { type Identity, IdentityResolver, ruleAllowance, ruleFingerprint, scaleRule } from './ratelimit/identity.js';
import { memorySlidingWindow, memorySlidingWindowCounter, memoryTokenBucket } from './ratelimit/memory.js';
import {
  type RedisConnection,
  RedisSlidingWindow,
  RedisSlidingWindowCounter,
  RedisTokenBucket,
} from './ratelimit/redis.js';
import { ResilientRateLimiter } from './ratelimit/resilient.js';
import {
  algorithmTag,
  type Clock,
  type RateLimitDecision,
  type RateLimiter,
  RateLimiterUnavailableError,
} from './ratelimit/types.js';
import { CircuitBreaker, CircuitOpenError, type CircuitState, type Permit } from './resilience/circuitBreaker.js';
import { HealthChecker, type ProbeResult } from './resilience/healthChecker.js';
import { retry } from './resilience/retry.js';
import { Router } from './router.js';

export interface GatewayDeps {
  logger?: Logger;
  clock?: Clock;
  /** Connected ioredis client. Without one, rate limiting is in-memory (single instance only). */
  redis?: RedisConnection;
  /** Don't start the background health-check timers; tests drive probes with checkHealthNow(). */
  manualHealthChecks?: boolean;
  /** Test seams for deterministic retry timing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  /**
   * Read the configuration again (from the file it came from). Enables reloading through SIGHUP and the admin
   * listener's POST /_gateway/reload; without it {@link Gateway.reloadFromSource} reports there is nothing to read.
   */
  loadConfig?: () => GatewayConfig;
}

export type ReloadResult =
  | {
      ok: true;
      /** Counts configurations applied: 1 at start-up, then one more per successful reload. */
      generation: number;
      /** Top-level sections that differed. */
      changed: string[];
      /** Settings that changed in the file but keep their old values until a restart. */
      restartRequired: string[];
    }
  | { ok: false; error: string };

interface Target {
  /** Stable label for metrics and health output (host:port). */
  id: string;
  client: UpstreamClient;
  breaker: CircuitBreaker;
  /** Requests sent to this target that have not yet received response headers. */
  pending: number;
  /** Verdict of the active health check; true until a probe says otherwise (and always, without a check). */
  healthy: boolean;
}

interface UpstreamRuntime {
  name: string;
  config: UpstreamConfig;
  targets: Target[];
  /** Rotates so equal-load targets take turns. */
  cursor: number;
  /** Present when the upstream configures a health check. */
  health?: {
    checker: HealthChecker;
    /** One dedicated client per target: probes must not queue behind (or be starved by) proxied traffic. */
    clients: Map<string, UpstreamClient>;
  };
  /** Its configuration plus the contents of any files it reads: a reload that leaves this unchanged keeps it. */
  fingerprint: string;
  /** Calls under way that use its connections, so a replaced upstream is closed only once they have finished. */
  users: number;
  /** Replaced by a reload: no new calls, and its connections close when the last user is done. */
  retired: boolean;
}

interface RouteLimiter {
  limiter: RateLimiter;
  tag: string;
}

/**
 * Everything derived from one version of the configuration. A reload builds a new one beside it and swaps it in;
 * a request keeps the runtime it started with, so it never sees half of one configuration and half of another.
 */
interface Runtime {
  generation: number;
  config: GatewayConfig;
  router: Router;
  upstreams: Map<string, UpstreamRuntime>;
  /** The rule each route applies before plans, overrides and multipliers. */
  routeRules: Map<string, RateLimitRuleConfig | undefined>;
  /** Each route's timeouts, retries and body limit: its own settings over its upstream's. */
  routePolicies: Map<string, RoutePolicy>;
  identities: IdentityResolver;
  jwt?: JwtVerifier;
  /** Rate-limit multiplier per JWT issuer name (from the issuer's plan). */
  jwtMultiplier: Map<string, number>;
  allowedMethods: Set<string>;
  ipCeiling?: RouteLimiter;
  /** The TLS certificate and key, read and checked while building (TLS only). */
  tls?: TlsMaterial;
  /** CA bundle for the trace collector's https endpoint, when one is configured. */
  otlpCa?: Buffer;
}

/** How calls for one route are made: its own settings where it has them, its upstream's where it does not. */
interface RoutePolicy {
  timeoutMs: number;
  totalTimeoutMs?: number;
  retry: UpstreamConfig['retry'];
  maxBodyBytes: number;
}

interface TlsMaterial {
  cert: Buffer;
  key: Buffer;
  passphrase?: string;
  notAfter: Date;
  /** The CA bundle callers' certificates must chain to, and its revocation list (client-certificate auth only). */
  clientCa?: Buffer;
  crl?: Buffer;
}

type AuthMethod = NonNullable<RouteConfig['auth']>['methods'][number];

/** What a caller's TLS certificate comes to, on a listener that asks for one. */
type PeerCertificate =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; name: string; issuer: string; sha256: string; id: string };

interface RequestContext {
  /** The configuration this request runs under, from start to finish. */
  rt: Runtime;
  requestId: string;
  method: string;
  path: string;
  route: string;
  upstream?: string;
  /** Name of the registered API key, when there is one (never the key itself). */
  client?: string;
  cache?: 'HIT' | 'STALE' | 'MISS' | 'BYPASS';
  attempts: number;
  rateLimited: boolean;
  degraded: boolean;
  started: number;
  /** The client disconnected before its response was complete. */
  clientGone: boolean;
  /** The upstream died mid-body, so the client got a truncated (deliberately broken) response. */
  upstreamTruncated: boolean;
  /** Request-body bytes this request is holding against the global buffer budget. */
  buffered: number;
  /** Set when the gateway itself verified the caller (a route with `auth`). Only then is the upstream told who. */
  auth?: { method: AuthMethod; client: string; issuer?: string; certSha256?: string };
  /** Why authentication failed. A short enumerated code, safe to log; never sent to the client. */
  authFailure?: string;
  /** The connection was upgraded to a WebSocket: the response is a 101 the gateway wrote itself. */
  switched?: boolean;
  /** The trace this request belongs to (unless tracing is off). */
  trace?: TraceContext;
  /** The path prefix of the route it matched, for span names (low-cardinality, unlike the request path). */
  routePath?: string;
}

/** What a WebSocket handshake attempt came to: a connection to join, or the upstream's own refusal to relay. */
type UpgradeResult =
  | { kind: 'upgraded'; socket: Duplex; head: Buffer; protocol?: string; extensions?: string }
  | { kind: 'rejected'; response: UpstreamResponse };

interface StoreOptions {
  key: string;
  /** Freshness lifetime when the upstream gives no explicit directive. */
  ttlMs: number;
  /** The route's stale windows, when the upstream gives none. */
  stale: StaleDefaults;
  requestHeaders: IncomingHttpHeaders;
  /** A stale entry still allowed to stand in for the upstream if it fails (stale-if-error). */
  fallback?: CachedResponse;
}

interface RelayOutcome {
  /** The cache entry stored from this response, if any. */
  entry?: CachedResponse;
  /** The upstream failed and this stale entry was served in its place. */
  stale?: CachedResponse;
  /** The client went away before the response was fully delivered. */
  clientGone: boolean;
}

/** What a coalesced cache fetch hands to the requests waiting on it. */
type FlightResult =
  /** Stored: waiters can be served the entry. */
  | { kind: 'stored'; entry: CachedResponse }
  /** The upstream failed and the stale entry stood in for it: waiters get the same. */
  | { kind: 'stale'; entry: CachedResponse }
  /** Complete but not storable (it may be private to the leader's client), or the upstream failed mid-body. */
  | { kind: 'not-stored' }
  /** The leading client left before the response was complete, so there is nothing to share. */
  | { kind: 'abandoned' };

class PayloadTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

/** The gateway is holding as much request data in memory as it is willing to. */
class OverloadedError extends Error {
  constructor(message = 'gateway is shedding load') {
    super(message);
  }
}

/** The client disconnected while we were still reading its request. */
class ClientAbortedError extends Error {
  constructor() {
    super('client went away');
  }
}

/** Headers the gateway sets to tell an upstream who it authenticated. Always stripped from incoming requests. */
const IDENTITY_HEADERS = [
  'x-authenticated-client',
  'x-authenticated-method',
  'x-authenticated-issuer',
  'x-client-cert-sha256',
];

/**
 * A value that is safe in an HTTP header. Subjects come from signed tokens but are still free text: one containing
 * CR/LF would otherwise split the header block (and Node refuses to send it). Printable ASCII passes through
 * unchanged; anything else is percent-encoded.
 */
function headerSafe(value: string): string {
  return /^[\x20-\x7E]*$/.test(value) ? value : encodeURIComponent(value);
}

/** Most a client may send before it has its 101. A well-behaved one sends nothing; this only bounds a bad one. */
const MAX_EARLY_WS_BYTES = 64 * 1024;

/** Cached bodies larger than this are written in pieces, so a client that stops reading can be noticed. */
const WRITE_SLICE_BYTES = 64 * 1024;

/** Longest request path written to an access-log line. */
const MAX_LOGGED_PATH = 512;

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE']);
/** An attempt with less budget than this left is not worth starting. */
const MIN_ATTEMPT_BUDGET_MS = 10;
const CIRCUIT_VALUE: Record<CircuitState, number> = { closed: 0, 'half-open': 1, open: 2 };
const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Request headers that tell frameworks to behave as if the request were something else: a different URL, host
 * or method. A client has no business setting them, and each has been used to bypass access rules or to poison
 * caches, so they are never forwarded.
 */
const REWRITE_HEADERS = [
  'x-original-url',
  'x-rewrite-url',
  'x-original-host',
  'x-host',
  'x-forwarded-server',
  'x-http-method-override',
  'x-http-method',
  'x-method-override',
];
/** Forwarding headers that are only meaningful when a trusted proxy set them. */
const PROXY_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-real-ip',
];

export class Gateway {
  readonly server: http.Server | https.Server;
  readonly metrics = new Registry();
  /** Where the admin listener is bound, once listen() has run (and the admin listener is enabled). */
  adminAddress?: AddressInfo;

  /** The current configuration and everything built from it. Requests capture it when they start. */
  private rt: Runtime;
  private responseCache: ResponseCache;
  /**
   * One limiter per distinct (route, rule, store settings). It outlives reloads, so a rule a reload leaves alone
   * keeps its counts (which matters when they are in memory); entries no configuration can reach any more are closed.
   */
  private readonly limiterCache = new Map<string, RouteLimiter>();
  /** Upstreams a reload replaced, kept until the calls still using their connections have finished. */
  private readonly retiring = new Set<UpstreamRuntime>();
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly redis?: RedisConnection;
  private readonly startedAt: number;
  private readonly admin: AdminListener;
  private readonly stopProcessMetrics: () => void;
  private listening = false;
  private closing = false;
  /** Where finished spans go, when `tracing.otlp` is configured. A reload that changes it replaces it. */
  private spans?: OtlpExporter;
  /** Expiry of the certificate currently being served (TLS only). */
  private certNotAfter?: Date;
  /** Responses still in progress, so shutdown can ask them not to keep their connection alive. */
  private readonly active = new Set<ServerResponse>();
  /** Joined WebSocket connections, so shutdown can end them (they would otherwise keep the server open forever). */
  private readonly tunnels = new Set<Tunnel>();
  /** Client sockets that have asked to upgrade, from the request until they close. */
  private readonly upgradeSockets = new Set<Duplex>();
  /** WebSockets open or being opened, per route. */
  private readonly wsOpen = new Map<string, number>();
  private readonly connectionsByIp = new Map<string, number>();
  private connections = 0;
  private bufferedBytes = 0;

  private readonly mRequests = this.metrics.counter('gateway_requests_total', 'Requests handled, by route and status.');
  private readonly mRateLimited = this.metrics.counter('gateway_rate_limited_total', 'Requests rejected with 429.');
  private readonly mDegraded = this.metrics.counter(
    'gateway_ratelimit_degraded_total',
    'Rate-limit decisions made without the primary store.',
  );
  private readonly mCache = this.metrics.counter('gateway_cache_requests_total', 'Cache outcomes by route.');
  private readonly mStaleServed = this.metrics.counter(
    'gateway_cache_stale_served_total',
    'Stale cache entries served, by route and why: revalidating (stale-while-revalidate) or upstream_error.',
  );
  private readonly mRefreshes = this.metrics.counter(
    'gateway_cache_refreshes_total',
    'Background refreshes of stale entries, by route and result.',
  );
  private readonly mAttempts = this.metrics.counter(
    'gateway_upstream_attempts_total',
    'Upstream attempts by target and outcome.',
  );
  private readonly mTransitions = this.metrics.counter('gateway_circuit_transitions_total', 'Circuit state changes.');
  private readonly mTlsFailures = this.metrics.counter(
    'gateway_tls_handshake_failures_total',
    'TLS handshakes that failed, by OpenSSL/Node error code.',
  );
  private readonly mHealthChecks = this.metrics.counter(
    'gateway_health_checks_total',
    'Active health-check probes by target and result.',
  );
  private readonly mHealthTransitions = this.metrics.counter(
    'gateway_health_transitions_total',
    'Targets taken out of, or returned to, rotation by health checks.',
  );
  private readonly mWsClosed = this.metrics.counter(
    'gateway_websocket_closed_total',
    'WebSocket connections closed, by route and why.',
  );
  private readonly mWsBytes = this.metrics.counter(
    'gateway_websocket_bytes_total',
    'Bytes relayed over WebSocket connections, by route and direction.',
  );
  private readonly mShed = this.metrics.counter(
    'gateway_requests_shed_total',
    'Requests refused to protect the gateway.',
  );
  private readonly mConnRejected = this.metrics.counter(
    'gateway_connections_rejected_total',
    'Connections dropped for exceeding a connection limit.',
  );
  private readonly mUnauthorized = this.metrics.counter(
    'gateway_unauthorized_total',
    'Requests rejected for lacking a registered API key.',
  );
  private readonly mAuth = this.metrics.counter(
    'gateway_auth_total',
    'Authentication outcomes by route, method and result.',
  );
  private readonly mReloads = this.metrics.counter(
    'gateway_config_reloads_total',
    'Configuration reloads, by result (ok, or error: the previous configuration stayed in force).',
  );
  private readonly mSpansExported = this.metrics.counter(
    'gateway_trace_spans_exported_total',
    'Spans the trace collector accepted.',
  );
  private readonly mSpansDropped = this.metrics.counter(
    'gateway_trace_spans_dropped_total',
    'Spans not delivered to the trace collector, by why (queue_full, export_failed).',
  );
  private readonly mLatency = this.metrics.histogram(
    'gateway_request_duration_seconds',
    'End-to-end request latency.',
    LATENCY_BUCKETS,
  );

  constructor(
    config: GatewayConfig,
    private readonly deps: GatewayDeps = {},
  ) {
    this.logger = deps.logger ?? createLogger('info');
    this.clock = deps.clock ?? Date.now;
    this.redis = deps.redis;
    this.startedAt = this.clock();
    this.responseCache = new ResponseCache({ ...config.cache, clock: this.clock });
    this.rt = this.buildRuntime(config, undefined, 1);
    this.spans = this.makeExporter(this.rt);

    this.registerGauges();
    this.stopProcessMetrics = registerProcessMetrics(this.metrics);

    const { limits } = config;
    const serverOptions = {
      maxHeaderSize: limits.maxHeaderBytes,
      // Node only enforces headersTimeout/requestTimeout when it sweeps connections; sweep often enough that
      // a slow client is cut off close to the configured time rather than up to 30s later.
      connectionsCheckingInterval: Math.min(1_000, limits.headersTimeoutMs),
    };
    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      void this.handle(req, res);
    };
    const material = this.rt.tls;
    if (config.tls && material) {
      this.certNotAfter = material.notAfter;
      this.warnIfExpiring(material.notAfter);
      this.server = https.createServer(
        {
          ...serverOptions,
          cert: material.cert,
          key: material.key,
          passphrase: material.passphrase,
          minVersion: config.tls.minVersion,
          // A client that connects and never completes the handshake would otherwise hold a socket for two minutes.
          handshakeTimeout: limits.headersTimeoutMs,
          // Callers' certificates: asked for when client-certificate auth is on. Unless every route needs one, a
          // connection without a (valid) certificate still gets through the handshake, and each route decides.
          ...(config.tls.clientAuth
            ? {
                requestCert: true,
                rejectUnauthorized: config.tls.clientAuth.required,
                ca: material.clientCa,
                crl: material.crl,
              }
            : {}),
        },
        onRequest,
      );
      this.server.on('tlsClientError', (error) => {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        this.mTlsFailures.inc({ reason: /^ERR_(SSL|TLS)_/.test(code) ? code : 'other' });
      });
    } else {
      this.server = http.createServer(serverOptions, onRequest);
    }
    this.applyServerLimits(limits);
    this.server.on('connection', (socket) => this.trackConnection(socket));
    this.server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });

    this.admin = new AdminListener(config.admin, {
      live: () => ({ status: 200, body: { status: 'ok' } }),
      ready: () =>
        this.closing ? { status: 503, body: { status: 'draining' } } : { status: 200, body: { status: 'ready' } },
      health: () => this.healthReport(),
      metrics: () => this.renderMetrics(),
      reload: deps.loadConfig
        ? () => {
            const result = this.reloadFromSource();
            return { status: result.ok ? 200 : 422, body: result };
          }
        : undefined,
    });
  }

  /**
   * Re-read the certificate and key and start using them for new connections. Connections already open keep the
   * old certificate until they close. If the new material is unreadable or invalid the old certificate stays in
   * service: a botched renewal must not take the listener down.
   */
  reloadTls(): { ok: true; notAfter: Date } | { ok: false; reason: string } {
    const tlsConfig = this.rt.config.tls;
    if (!tlsConfig || !(this.server instanceof https.Server)) return { ok: false, reason: 'TLS is not enabled' };
    try {
      const material = readTlsMaterial(tlsConfig); // validates the pair before anything is swapped
      this.applyTls(tlsConfig, material);
      return { ok: true, notAfter: material.notAfter };
    } catch (error) {
      const reason = (error as Error).message;
      this.logger.error('tls reload failed; still serving the previous certificate', { reason });
      return { ok: false, reason };
    }
  }

  /** Serve new connections with this certificate, key and minimum version. Open connections keep what they had. */
  private applyTls(tls: NonNullable<GatewayConfig['tls']>, material: TlsMaterial): void {
    if (!(this.server instanceof https.Server)) return;
    this.server.setSecureContext({
      cert: material.cert,
      key: material.key,
      passphrase: material.passphrase,
      minVersion: tls.minVersion,
      // A new CA bundle or revocation list applies to the next handshake, like a new certificate.
      ca: material.clientCa,
      crl: material.crl,
    });
    this.certNotAfter = material.notAfter;
    this.logger.info('tls certificate reloaded', { notAfter: material.notAfter.toISOString() });
    this.warnIfExpiring(material.notAfter);
  }

  private warnIfExpiring(notAfter: Date): void {
    const daysLeft = (notAfter.getTime() - this.clock()) / 86_400_000;
    if (daysLeft <= 0) this.logger.error('tls certificate has expired', { notAfter: notAfter.toISOString() });
    else if (daysLeft < 14) {
      this.logger.warn('tls certificate expires soon', {
        daysLeft: Math.floor(daysLeft),
        notAfter: notAfter.toISOString(),
      });
    }
  }

  async listen(port = this.rt.config.port, host = this.rt.config.host): Promise<AddressInfo> {
    const main = await listenOn(this.server, port, host);
    if (this.rt.config.admin.enabled) {
      try {
        this.adminAddress = await this.admin.listen();
      } catch (error) {
        this.server.close();
        throw error;
      }
    }
    this.listening = true;
    if (!this.deps.manualHealthChecks) {
      for (const u of this.rt.upstreams.values()) u.health?.checker.start();
    }
    return main;
  }

  /** The response cache (for tests and tooling). A reload that changes its size limits replaces it. */
  get cache(): ResponseCache {
    return this.responseCache;
  }

  /** The configuration in force. A reload replaces it; a request keeps the one it started with. */
  get config(): GatewayConfig {
    return this.rt.config;
  }

  /** Probe every target of every upstream (or one) right now and wait. Mainly for tests and operator tooling. */
  async checkHealthNow(upstream?: string): Promise<void> {
    const selected = upstream ? [this.rt.upstreams.get(upstream)] : [...this.rt.upstreams.values()];
    await Promise.all(selected.map((u) => u?.health?.checker.probeAll()));
  }

  /** Stop accepting connections, let in-flight requests finish (up to the grace period), then release resources. */
  async close(graceMs = this.rt.config.shutdownGraceMs): Promise<void> {
    this.closing = true;
    // An upgraded socket is no longer tracked as an HTTP connection, yet it still holds server.close() open, and a
    // WebSocket has no response to wait for. End them now; their clients reconnect (to another instance, in a fleet).
    for (const tunnel of [...this.tunnels]) tunnel.close('shutdown');
    for (const socket of this.upgradeSockets) socket.destroy();
    const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
    // Idle keep-alive connections go now. Busy ones are told not to be reused and are closed as soon as their
    // response completes (see finish()), so clients don't send new requests into a process that is exiting.
    this.server.closeIdleConnections();
    for (const res of this.active) {
      if (!res.headersSent) res.setHeader('connection', 'close');
    }
    const force = setTimeout(() => this.server.closeAllConnections(), graceMs);
    force.unref();
    await closed;
    clearTimeout(force);

    await this.admin.close();
    this.stopProcessMetrics();

    for (const upstream of new Set([...this.rt.upstreams.values(), ...this.retiring])) this.closeUpstream(upstream);
    this.retiring.clear();
    await Promise.all([...this.limiterCache.values()].map(({ limiter }) => limiter.close?.()));
    await this.spans?.close(); // the last requests' spans, bounded by the export timeout
  }

  /** Circuit breaker of an upstream's first target (the only one unless the upstream has several `urls`). */
  circuit(name: string): CircuitBreaker | undefined {
    return this.rt.upstreams.get(name)?.targets[0]?.breaker;
  }

  /** Circuit breakers by target id. */
  circuits(name: string): Record<string, CircuitBreaker> {
    const out: Record<string, CircuitBreaker> = {};
    for (const target of this.rt.upstreams.get(name)?.targets ?? []) out[target.id] = target.breaker;
    return out;
  }

  private closeUpstream(upstream: UpstreamRuntime): void {
    upstream.health?.checker.stop();
    for (const client of upstream.health?.clients.values() ?? []) client.close();
    for (const target of upstream.targets) target.client.close();
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Reloading the configuration
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * Re-read the configuration from where it came from (the file, via `deps.loadConfig`) and apply it. What SIGHUP and
   * the admin listener's reload endpoint do.
   */
  reloadFromSource(): ReloadResult {
    const load = this.deps.loadConfig;
    if (!load) return { ok: false, error: 'this gateway was not given a configuration source to reload from' };
    let next: GatewayConfig;
    try {
      next = load();
    } catch (error) {
      return this.reloadFailed((error as Error).message);
    }
    return this.reload(next);
  }

  /**
   * Apply a new configuration without dropping a connection. Everything it implies is built beside the configuration
   * in force, and if any of it fails (an unreadable key file, a certificate that does not match its key) nothing
   * changes. Requests already under way finish under the configuration they started with; new ones get the new one.
   *
   * A few settings cannot change in a running process: the listening address, whether it speaks TLS at all, the
   * Redis connection, the admin listener's address, the cluster's size and the header size limit. They keep their
   * old values, the rest of the reload goes ahead, and the result lists them under `restartRequired`.
   */
  reload(next: GatewayConfig): ReloadResult {
    if (this.closing) return { ok: false, error: 'the gateway is shutting down' };
    const previous = this.rt;
    const { config, restartRequired } = keepFixed(previous.config, next);
    let rt: Runtime;
    try {
      rt = this.buildRuntime(config, previous, previous.generation + 1);
    } catch (error) {
      return this.reloadFailed((error as Error).message);
    }
    const changed = changedSections(previous.config, config);

    this.rt = rt;
    this.applyRuntime(previous, rt);

    this.mReloads.inc({ result: 'ok' });
    this.logger.info('configuration reloaded', { generation: rt.generation, changed, restartRequired });
    if (restartRequired.length > 0) {
      this.logger.warn('these settings changed but need a restart to take effect', { settings: restartRequired });
    }
    return { ok: true, generation: rt.generation, changed, restartRequired };
  }

  private reloadFailed(error: string): ReloadResult {
    this.mReloads.inc({ result: 'error' });
    this.logger.error('configuration reload failed; still running the previous configuration', { error });
    return { ok: false, error };
  }

  /** Bring everything outside the runtime in line with a runtime that has just been swapped in. */
  private applyRuntime(previous: Runtime, rt: Runtime): void {
    const { config } = rt;
    this.applyServerLimits(config.limits);
    this.admin.setToken(config.admin.token);
    if (config.tls && rt.tls) this.applyTls(config.tls, rt.tls); // read and checked while building

    // A different collector (or different settings, or a new CA bundle for it): a new exporter. The old one sends
    // what it already holds on its way out.
    const caChanged = previous.otlpCa && rt.otlpCa ? !previous.otlpCa.equals(rt.otlpCa) : previous.otlpCa !== rt.otlpCa;
    const was = previous.config.tracing;
    if (!same(was.otlp, config.tracing.otlp) || was.enabled !== config.tracing.enabled || caChanged) {
      const old = this.spans;
      this.spans = this.makeExporter(rt);
      void old?.close();
    }

    // The cache: new size limits mean a new cache. Otherwise only entries from an upstream that changed or went
    // are dropped; they may have come from a backend that is no longer the one configured.
    if (!same(previous.config.cache, config.cache)) {
      this.responseCache = new ResponseCache({ ...config.cache, clock: this.clock });
    } else {
      for (const [name, upstream] of previous.upstreams) {
        if (rt.upstreams.get(name) !== upstream) {
          this.responseCache.deleteWhere((key) => key.startsWith(`${name}\u0000`));
        }
      }
    }

    // Upstreams: a kept one carries on as it was; a new one starts its health checks; a replaced one is retired.
    const kept = new Set(rt.upstreams.values());
    const before = new Set(previous.upstreams.values());
    for (const upstream of kept) {
      if (!before.has(upstream) && this.listening && !this.deps.manualHealthChecks) upstream.health?.checker.start();
    }
    for (const upstream of before) {
      if (!kept.has(upstream)) this.retire(upstream);
    }

    // Limiters that no route, plan or key override of the new configuration can reach.
    const reachable = reachableLimiterKeys(config);
    for (const [key, entry] of this.limiterCache) {
      if (reachable.has(key)) continue;
      this.limiterCache.delete(key);
      void entry.limiter.close?.();
    }
  }

  /**
   * An upstream a reload replaced: no new calls go to it (they use the new runtime) and its health checks stop. Its
   * connections close once the last call still using them has finished, so a response in flight is not cut off.
   */
  private retire(upstream: UpstreamRuntime): void {
    upstream.retired = true;
    upstream.health?.checker.stop();
    if (upstream.users === 0) this.closeUpstream(upstream);
    else this.retiring.add(upstream);
  }

  /** Run a call that uses an upstream's connections, so a reload knows when it may close them. */
  private async withUpstream<T>(upstream: UpstreamRuntime, call: () => Promise<T>): Promise<T> {
    upstream.users++;
    try {
      return await call();
    } finally {
      this.releaseUpstream(upstream);
    }
  }

  /** The end of a call that held `upstream` (see {@link withUpstream}): the last one out of a retired one closes it. */
  private releaseUpstream(upstream: UpstreamRuntime): void {
    upstream.users--;
    if (upstream.retired && upstream.users === 0 && this.retiring.delete(upstream)) this.closeUpstream(upstream);
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Construction helpers
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * Build everything a configuration implies. Whatever reads files or can be refused (JWT keys, certificates, CA
   * bundles) is done first, so a configuration that cannot work is rejected before anything is built from it. An
   * upstream whose definition and files are unchanged from `previous` is kept as it is, with its connections,
   * circuit breakers and health-check state.
   */
  private buildRuntime(config: GatewayConfig, previous: Runtime | undefined, generation: number): Runtime {
    const issuers = (config.auth.jwt?.issuers ?? []).map((source) => {
      try {
        return loadIssuer(source, (path) => readFileSync(path, 'utf8'));
      } catch (error) {
        throw error instanceof JwtKeyError ? new ConfigError(error.message) : error;
      }
    });
    const upstreamTls = new Map(
      Object.entries(config.upstreams).map(([name, upstream]) => [name, readUpstreamTls(name, upstream)] as const),
    );
    const tls = config.tls ? readTlsMaterial(config.tls) : undefined;
    const otlpCaFile = config.tracing.otlp?.caFile;
    const otlpCa = otlpCaFile ? readFileOrFail('tracing.otlp.caFile', otlpCaFile) : undefined;

    const upstreams = new Map<string, UpstreamRuntime>();
    for (const [name, upstreamConfig] of Object.entries(config.upstreams)) {
      const material = upstreamTls.get(name);
      const fingerprint = upstreamFingerprint(upstreamConfig, material);
      const kept = previous?.upstreams.get(name);
      upstreams.set(
        name,
        kept && kept.fingerprint === fingerprint
          ? kept
          : this.buildUpstream(name, upstreamConfig, material, fingerprint),
      );
    }

    const routeRules = new Map<string, RateLimitRuleConfig | undefined>();
    for (const route of config.routes) {
      const rule = route.rateLimit === undefined ? config.rateLimit.default : route.rateLimit || undefined;
      routeRules.set(route.id ?? route.path, rule);
    }
    const routePolicies = new Map<string, RoutePolicy>();
    for (const route of config.routes) {
      const upstream = config.upstreams[route.upstream] as UpstreamConfig;
      routePolicies.set(route.id ?? route.path, {
        timeoutMs: route.timeoutMs ?? upstream.timeoutMs,
        totalTimeoutMs: route.totalTimeoutMs ?? upstream.totalTimeoutMs,
        retry: { ...upstream.retry, ...definedOnly(route.retry ?? {}) },
        maxBodyBytes: route.maxBodyBytes ?? config.maxBodyBytes,
      });
    }
    const jwtMultiplier = new Map<string, number>();
    for (const issuer of issuers) {
      jwtMultiplier.set(issuer.name, issuer.plan ? (config.rateLimit.plans[issuer.plan]?.multiplier ?? 1) : 1);
    }

    return {
      generation,
      config,
      router: new Router(config.routes),
      upstreams,
      routeRules,
      routePolicies,
      identities: new IdentityResolver(config.rateLimit),
      jwt: issuers.length > 0 ? new JwtVerifier(issuers, this.clock) : undefined,
      jwtMultiplier,
      allowedMethods: new Set(config.allowedMethods),
      ipCeiling: config.rateLimit.ip ? this.limiterFor(config, IP_CEILING, config.rateLimit.ip) : undefined,
      tls,
      otlpCa,
    };
  }

  /** The span exporter a runtime asks for: none unless tracing is on and has somewhere to send spans. */
  private makeExporter(rt: Runtime): OtlpExporter | undefined {
    const { tracing } = rt.config;
    if (!tracing.enabled || !tracing.otlp) return undefined;
    return new OtlpExporter({
      ...tracing.otlp,
      ca: rt.otlpCa,
      onExported: (count) => this.mSpansExported.inc({}, count),
      onDropped: (count, reason) => this.mSpansDropped.inc({ reason }, count),
      onError: (error) => this.logger.warn('trace export failed; spans dropped', { error }),
    });
  }

  /**
   * One upstream attempt as a client span (OpenTelemetry's HTTP client conventions), from sending the request to
   * receiving the response headers or failing. A 5xx or a failure (other than the client leaving) is an error.
   */
  private recordAttempt(
    ctx: RequestContext,
    upstream: UpstreamRuntime,
    target: Target,
    span: { id: string; started: number; attempt: number },
    outcome: { status?: number; error?: string },
  ): void {
    if (!this.spans || !ctx.trace) return;
    const { status, error } = outcome;
    const failure =
      error !== undefined
        ? error === 'aborted'
          ? undefined
          : error
        : status !== undefined && status >= 500
          ? `status ${status}`
          : undefined;
    const { host, port } = target.client.address;
    this.recordSpan(ctx.trace, {
      spanId: span.id,
      parentSpanId: ctx.trace.spanId,
      name: `${ctx.method} ${upstream.name}`,
      kind: 'client',
      startNs: nowNs(span.started),
      endNs: nowNs(),
      attributes: {
        'http.request.method': ctx.method,
        'server.address': host,
        'server.port': port,
        'http.response.status_code': status,
        'http.request.resend_count': span.attempt > 1 ? span.attempt - 1 : undefined,
        'error.type': error ?? (status !== undefined && status >= 500 ? String(status) : undefined),
        'gateway.upstream': upstream.name,
        'gateway.target': target.id,
      },
      error: failure,
    });
  }

  /** Hand a finished span to the exporter, if there is one and the trace is sampled. */
  private recordSpan(trace: TraceContext | undefined, span: Omit<SpanData, 'traceId'>): void {
    if (!this.spans || !trace || !isSampled(trace)) return;
    this.spans.add({ traceId: trace.traceId, ...span });
  }

  private buildUpstream(
    name: string,
    upstreamConfig: UpstreamConfig,
    material: UpstreamTlsMaterial | undefined,
    fingerprint: string,
  ): UpstreamRuntime {
    const urls = upstreamTargets(upstreamConfig);
    const targets = urls.map((url, index): Target => {
      const host = new URL(url).host;
      // Two targets on one host:port (different base paths) still need distinct labels.
      const id = urls.some((other, j) => j !== index && new URL(other).host === host) ? `${host}#${index}` : host;
      return {
        id,
        pending: 0,
        healthy: true,
        client: new UpstreamClient(url, {
          timeoutMs: upstreamConfig.timeoutMs,
          maxConnections: upstreamConfig.maxConnections,
          ...material,
        }),
        breaker: new CircuitBreaker({
          ...upstreamConfig.breaker,
          clock: this.clock,
          onStateChange: (from, to) => {
            this.mTransitions.inc({ upstream: name, target: id, to });
            this.logger.warn('circuit state change', { upstream: name, target: id, from, to });
          },
        }),
      };
    });
    const runtime: UpstreamRuntime = {
      name,
      config: upstreamConfig,
      targets,
      cursor: 0,
      fingerprint,
      users: 0,
      retired: false,
    };
    if (upstreamConfig.healthCheck) {
      runtime.health = this.buildHealthCheck(runtime, upstreamConfig.healthCheck, material);
    }
    return runtime;
  }

  private applyServerLimits(limits: GatewayConfig['limits']): void {
    this.server.maxConnections = limits.maxConnections;
    this.server.headersTimeout = limits.headersTimeoutMs;
    this.server.requestTimeout = limits.requestTimeoutMs;
    this.server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  }

  private makeLimiter(label: string, rule: RateLimitRuleConfig, config: GatewayConfig): RouteLimiter {
    const mode = config.rateLimit.failureMode;
    const makeLocal = (): RateLimiter => {
      switch (rule.algorithm) {
        case 'token-bucket':
          return memoryTokenBucket(
            { capacity: rule.capacity, refillPerSecond: rule.refillPerSecond },
            { clock: this.clock },
          );
        case 'sliding-window':
          return memorySlidingWindow({ limit: rule.limit, windowMs: rule.windowMs }, { clock: this.clock });
        case 'sliding-window-counter':
          return memorySlidingWindowCounter({ limit: rule.limit, windowMs: rule.windowMs }, { clock: this.clock });
      }
    };
    const tag = algorithmTag(rule);
    if (!this.redis) return { limiter: makeLocal(), tag };

    const keyPrefix = config.redis?.keyPrefix ?? 'gw:';
    let primary: RateLimiter;
    let limit: number;
    switch (rule.algorithm) {
      case 'token-bucket':
        limit = rule.capacity;
        primary = new RedisTokenBucket(
          this.redis,
          { capacity: rule.capacity, refillPerSecond: rule.refillPerSecond },
          { keyPrefix },
        );
        break;
      case 'sliding-window':
        limit = rule.limit;
        primary = new RedisSlidingWindow(this.redis, { limit: rule.limit, windowMs: rule.windowMs }, { keyPrefix });
        break;
      case 'sliding-window-counter':
        limit = rule.limit;
        primary = new RedisSlidingWindowCounter(
          this.redis,
          { limit: rule.limit, windowMs: rule.windowMs },
          { keyPrefix },
        );
        break;
    }

    return {
      tag,
      limiter: new ResilientRateLimiter(primary, {
        mode,
        fallback: mode === 'local' ? makeLocal() : undefined,
        limit,
        breakerOptions: { clock: this.clock },
        onError: (error) =>
          this.logger.warn('rate limit store error', { scope: label, error: (error as Error).message }),
      }),
    };
  }

  /**
   * One limiter per distinct (route, rule, store settings), created on first use. Rules come only from config, so
   * this is bounded; see {@link reachableLimiterKeys} for how a reload trims it.
   */
  private limiterFor(config: GatewayConfig, routeId: string, rule: RateLimitRuleConfig): RouteLimiter {
    const cacheKey = limiterKey(config, routeId, rule);
    let entry = this.limiterCache.get(cacheKey);
    if (!entry) {
      entry = this.makeLimiter(routeId === IP_CEILING ? 'client address' : `route ${routeId}`, rule, config);
      this.limiterCache.set(cacheKey, entry);
    }
    return entry;
  }

  /** The rule that governs this caller on this route, or undefined if they are unlimited there. */
  private effectiveRule(rt: Runtime, routeId: string, identity: Identity): RateLimitRuleConfig | undefined {
    const override = identity.overrides?.[routeId];
    if (override === false) return undefined;
    if (override) return override;
    const base = rt.routeRules.get(routeId);
    return base ? scaleRule(base, identity.multiplier) : undefined;
  }

  /** Wire an upstream's health checker: a dedicated probe client per target and the effect of a verdict. */
  private buildHealthCheck(
    upstream: UpstreamRuntime,
    hc: NonNullable<UpstreamConfig['healthCheck']>,
    material: UpstreamTlsMaterial | undefined,
  ): NonNullable<UpstreamRuntime['health']> {
    const clients = new Map<string, UpstreamClient>();
    const urls = upstreamTargets(upstream.config);
    upstream.targets.forEach((target, index) => {
      clients.set(
        target.id,
        new UpstreamClient(urls[index] as string, { timeoutMs: hc.timeoutMs, maxConnections: 2, ...material }),
      );
    });
    const byId = new Map(upstream.targets.map((t) => [t.id, t]));
    const expected = hc.expectStatus ? new Set(hc.expectStatus) : undefined;
    const extraHeaders = Object.fromEntries(Object.entries(hc.headers).map(([k, v]) => [k.toLowerCase(), v]));

    const checker = new HealthChecker(
      upstream.targets.map((t) => t.id),
      {
        intervalMs: hc.intervalMs,
        unhealthyThreshold: hc.unhealthyThreshold,
        healthyThreshold: hc.healthyThreshold,
        probe: (id) => this.probe(clients.get(id) as UpstreamClient, hc, expected, extraHeaders),
        onResult: (id, result) => {
          if (upstream.retired) return; // a probe that was under way when a reload replaced this upstream
          this.mHealthChecks.inc({ upstream: upstream.name, target: id, result: result.ok ? 'ok' : 'fail' });
        },
        onChange: (id, healthy, reason) => {
          if (upstream.retired) return;
          const target = byId.get(id);
          if (target) {
            target.healthy = healthy;
            // The target was just shown to be back, so don't make real traffic wait out a cool-down that was set
            // when it was failing: let the breaker probe it now (it re-opens on the first failure, as ever).
            if (healthy) target.breaker.probeNow();
          }
          this.mHealthTransitions.inc({ upstream: upstream.name, target: id, to: healthy ? 'healthy' : 'unhealthy' });
          this.logger.warn('health check verdict changed', { upstream: upstream.name, target: id, healthy, reason });
        },
      },
      this.clock,
    );
    return { checker, clients };
  }

  private async probe(
    client: UpstreamClient,
    hc: NonNullable<UpstreamConfig['healthCheck']>,
    expected: Set<number> | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<ProbeResult> {
    try {
      const res = await client.request({
        method: hc.method,
        path: client.resolvePath(hc.path),
        headers: { accept: '*/*', 'user-agent': 'api-gateway-healthcheck', ...extraHeaders, host: client.host },
        timeoutMs: hc.timeoutMs,
      });
      // We only wanted the status. Drain what little a health endpoint sends so the connection can be reused, but
      // never trust it to stop: cut it off after the probe timeout.
      const cutoff = setTimeout(() => res.stream.destroy(), hc.timeoutMs);
      cutoff.unref();
      res.stream.once('close', () => clearTimeout(cutoff));
      res.stream.resume();
      const ok = expected ? expected.has(res.status) : res.status >= 200 && res.status < 300;
      return ok ? { ok, status: res.status } : { ok, status: res.status, reason: `status ${res.status}` };
    } catch (error) {
      // Only the failure *kind*: the message can carry addresses, and this ends up on the health page and in logs.
      return { ok: false, reason: error instanceof UpstreamError ? error.kind : 'error' };
    }
  }

  private registerGauges(): void {
    this.metrics.gauge(
      'gateway_circuit_state',
      'Circuit breaker state per upstream target (0 closed, 1 half-open, 2 open).',
      () =>
        [...this.rt.upstreams.values()].flatMap((u) =>
          u.targets.map((t) => ({
            labels: { upstream: u.name, target: t.id },
            value: CIRCUIT_VALUE[t.breaker.state],
          })),
        ),
    );
    this.metrics.gauge(
      'gateway_target_healthy',
      'Active health-check verdict per target (1 healthy, 0 unhealthy). Only upstreams with a health check.',
      () =>
        [...this.rt.upstreams.values()]
          .filter((u) => u.health)
          .flatMap((u) =>
            u.targets.map((t) => ({ labels: { upstream: u.name, target: t.id }, value: t.healthy ? 1 : 0 })),
          ),
    );
    this.metrics.gauge(
      'gateway_tls_certificate_expiry_seconds',
      'Seconds until the served TLS certificate expires (negative once it has). Only with TLS enabled.',
      () =>
        this.certNotAfter
          ? [{ labels: {}, value: Math.round((this.certNotAfter.getTime() - this.clock()) / 1000) }]
          : [],
    );
    this.metrics.gauge('gateway_websocket_connections', 'WebSocket connections open or being opened, per route.', () =>
      [...this.wsOpen].map(([route, value]) => ({ labels: { route }, value })),
    );
    this.metrics.gauge('gateway_config_generation', 'Configurations applied: 1 at start-up, +1 per reload.', () => [
      { labels: {}, value: this.rt.generation },
    ]);
    this.metrics.gauge('gateway_cache_entries', 'Entries held in the response cache.', () => [
      { labels: {}, value: this.cache.stats().entries },
    ]);
    this.metrics.gauge('gateway_cache_bytes', 'Bytes held in the response cache.', () => [
      { labels: {}, value: this.cache.stats().bytes },
    ]);
    this.metrics.gauge('gateway_connections', 'Open client connections.', () => [
      { labels: {}, value: this.connections },
    ]);
    this.metrics.gauge('gateway_inflight_requests', 'Requests currently being handled.', () => [
      { labels: {}, value: this.active.size },
    ]);
    this.metrics.gauge('gateway_buffered_request_bytes', 'Request-body bytes held in memory.', () => [
      { labels: {}, value: this.bufferedBytes },
    ]);
  }

  private trackConnection(socket: Socket): void {
    this.connections++;
    socket.once('close', () => {
      this.connections--;
    });

    const { limits, rateLimit } = this.rt.config;
    const max = limits.maxConnectionsPerIp;
    if (max === 0) return;
    const ip = normalizeIp(socket.remoteAddress, rateLimit.ipv6Prefix) ?? 'unknown';
    const count = (this.connectionsByIp.get(ip) ?? 0) + 1;
    if (count > max) {
      this.mConnRejected.inc({ reason: 'per_ip' });
      socket.destroy();
      return;
    }
    this.connectionsByIp.set(ip, count);
    socket.once('close', () => {
      const left = (this.connectionsByIp.get(ip) ?? 1) - 1;
      if (left <= 0) this.connectionsByIp.delete(ip);
      else this.connectionsByIp.set(ip, left);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Request pipeline
  // ------------------------------------------------------------------------------------------------------------------

  private newContext(req: IncomingMessage): RequestContext {
    const { tracing } = this.rt.config;
    return {
      rt: this.rt,
      trace: tracing.enabled ? startOrContinue(req.headers, tracing) : undefined,
      requestId: sanitizeRequestId(req.headers['x-request-id']) ?? randomUUID(),
      method: req.method ?? 'GET',
      path: '',
      route: '-',
      attempts: 0,
      rateLimited: false,
      degraded: false,
      started: performance.now(),
      clientGone: false,
      upstreamTruncated: false,
      buffered: 0,
    };
  }

  /** The headers every response carries, and the bookkeeping that runs when the response (or its connection) ends. */
  private trackResponse(res: ServerResponse, ctx: RequestContext): void {
    res.setHeader('x-request-id', ctx.requestId);
    const hsts = ctx.rt.config.tls?.hstsMaxAgeSeconds;
    if (hsts) res.setHeader('strict-transport-security', `max-age=${hsts}`);
    if (this.closing) res.setHeader('connection', 'close');

    this.active.add(res);
    res.once('close', () => {
      this.active.delete(res);
      this.bufferedBytes -= ctx.buffered;
      if (!res.writableFinished) ctx.clientGone = true;
      this.finish(res, ctx);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ctx = this.newContext(req);
    const shed = this.active.size >= ctx.rt.config.limits.maxInFlight;
    this.trackResponse(res, ctx);

    try {
      if (shed) throw new OverloadedError('too many requests in flight');
      await this.dispatch(req, res, ctx);
    } catch (error) {
      this.fail(res, ctx, error);
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
    if (!ctx.rt.allowedMethods.has(ctx.method)) {
      return this.sendError(res, ctx, 405, 'method_not_allowed', 'method not allowed', {
        allow: [...ctx.rt.allowedMethods].join(', '),
      });
    }

    // Parsing against a dummy base normalizes dot-segments, so "/users/../admin" can't dodge route matching,
    // and an absolute-form request target can't change where we send the request (only the path is used).
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid');
    } catch {
      return this.sendError(res, ctx, 400, 'bad_request', 'malformed request target');
    }
    ctx.path = url.pathname;

    // The admin endpoints live on their own listener. Never proxy this namespace either, so it is not
    // possible to mistake a catch-all route for them.
    if (url.pathname === '/_gateway' || url.pathname.startsWith('/_gateway/')) {
      return this.sendError(res, ctx, 404, 'route_not_found', 'no route matches this request');
    }

    const match = ctx.rt.router.match(url.pathname, ctx.method);
    if (!match) return this.sendError(res, ctx, 404, 'route_not_found', 'no route matches this request');
    ctx.route = match.routeId;
    ctx.routePath = match.route.path;

    if (!(await this.admitted(req, res, ctx, match.route, match.routeId))) return;

    const policy = ctx.rt.routePolicies.get(match.routeId) as RoutePolicy;
    const body = await this.readBody(req, ctx, policy.maxBodyBytes);
    const upstream = ctx.rt.upstreams.get(match.route.upstream) as UpstreamRuntime;
    ctx.upstream = upstream.name;
    const relativePath = match.upstreamPath + url.search;

    const cacheConfig = match.route.cache;
    if (cacheConfig && ctx.method === 'GET') {
      const info = requestCacheInfo(req.headers);
      const keyed = [...new Set([...cacheConfig.varyHeaders, ...cacheConfig.forwardHeaders])];
      if (!info.noStore && requestIsCacheSafe(req.headers, keyed)) {
        await this.cachedGet(req, res, ctx, match.route, upstream, policy, relativePath, url, keyed, info.noCache);
        return;
      }
      ctx.cache = 'BYPASS';
      res.setHeader('x-cache', 'BYPASS');
    }

    await this.forward(req, res, ctx, upstream, policy, relativePath, body);
  }

  /** Authentication and rate limiting. Returns false if the request was rejected (response already sent). */
  private async admitted(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    route: RouteConfig,
    routeId: string,
  ): Promise<boolean> {
    const { rt } = ctx;
    const ip = this.clientIp(req, rt);
    const header = req.headers[rt.config.rateLimit.identityHeader];
    const presented = Array.isArray(header) ? header[0] : header;

    // The address ceiling comes first, before any credential is looked at. It is what bounds a client that rotates
    // credentials, and it is also the brute-force limit: every request counts against it, including ones that fail
    // authentication, so a flood of guessed keys or bad tokens (each costing a lookup or a signature check) is
    // turned away for the price of one counter update.
    let decision: RateLimitDecision | undefined;
    if (rt.ipCeiling) {
      decision = await rt.ipCeiling.limiter.consume(`rlip:${rt.ipCeiling.tag}:${ip}`);
      if (!decision.allowed) return this.reject(res, ctx, routeId, decision);
    }

    let identity: Identity;
    if (route.auth) {
      const outcome = this.authenticate(req, rt, route.auth, presented || undefined, ip);
      this.mAuth.inc({ route: routeId, method: outcome.method, result: outcome.ok ? 'ok' : 'fail' });
      if (!outcome.ok) {
        ctx.authFailure = outcome.reason;
        this.mUnauthorized.inc({ route: routeId });
        // A certificate is asked for during the handshake, so HTTP has no challenge to send for it.
        this.sendError(
          res,
          ctx,
          401,
          'unauthorized',
          'a valid credential is required',
          outcome.challenge ? { 'www-authenticate': outcome.challenge } : {},
        );
        return false;
      }
      identity = outcome.identity;
      if (outcome.authenticated) {
        ctx.auth = {
          method: outcome.method as AuthMethod,
          client: outcome.client,
          issuer: outcome.issuer,
          certSha256: outcome.certSha256,
        };
      }
    } else {
      const resolved = rt.identities.resolve(presented || undefined, ip);
      if (!resolved.ok) {
        this.mUnauthorized.inc({ route: routeId });
        this.sendError(res, ctx, 401, 'unauthorized', 'a valid API key is required', { 'www-authenticate': 'ApiKey' });
        return false;
      }
      identity = resolved.identity;
    }
    ctx.client = identity.name;

    const rule = this.effectiveRule(rt, routeId, identity);
    if (rule) {
      const { limiter, tag } = this.limiterFor(rt.config, routeId, rule);
      // A caller scaled down (anonymous multiplier, a small override) may have less than the route costs: charge
      // their whole allowance rather than an amount no request could ever pay.
      const cost = Math.min(route.cost, ruleAllowance(rule));
      decision = await limiter.consume(`rl:${tag}:${routeId}:${identity.id}`, cost);
    }
    if (!decision) return true;

    if (decision.degraded) {
      ctx.degraded = true;
      this.mDegraded.inc({ route: routeId });
    } else {
      // Headers from a degraded decision would claim precision we don't have, so only advertise real ones.
      res.setHeader('ratelimit-limit', decision.limit);
      res.setHeader('ratelimit-remaining', decision.remaining);
      res.setHeader('ratelimit-reset', Math.ceil(decision.resetAfterMs / 1000));
    }
    if (decision.allowed) return true;
    return this.reject(res, ctx, routeId, decision);
  }

  /**
   * Check the credentials a route asks for.
   *
   * A credential that is *presented* and wrong is always refused, even where authentication is optional: letting a
   * bad token fall through to "anonymous" would make a typo or an expired token silently look like a logged-out
   * user, and would let a client probe tokens without consequence. Only the *absence* of a credential is allowed
   * to mean anonymous, and only where `required` is false.
   */
  private authenticate(
    req: IncomingMessage,
    rt: Runtime,
    auth: NonNullable<RouteConfig['auth']>,
    presentedKey: string | undefined,
    ip: string,
  ):
    | {
        ok: true;
        identity: Identity;
        method: string;
        authenticated: boolean;
        client: string;
        issuer?: string;
        certSha256?: string;
      }
    | { ok: false; method: string; reason: string; challenge: string } {
    const wantsJwt = auth.methods.includes('jwt');
    const wantsKey = auth.methods.includes('api-key');
    const wantsCert = auth.methods.includes('client-cert');
    const challenge = (invalidToken: boolean): string =>
      [
        wantsJwt ? (invalidToken ? 'Bearer error="invalid_token"' : 'Bearer') : undefined,
        wantsKey ? 'ApiKey' : undefined,
      ]
        .filter(Boolean)
        .join(', ');

    // A certificate is checked first: it was presented before any header was sent. One that was presented and does
    // not verify is refused here like any other bad credential, rather than falling back to a token or a key.
    if (wantsCert) {
      const cert = this.peerCertificate(req, rt);
      if (cert.kind === 'invalid') {
        return { ok: false, method: 'client-cert', reason: cert.reason, challenge: challenge(false) };
      }
      if (cert.kind === 'valid') {
        return {
          ok: true,
          method: 'client-cert',
          authenticated: true,
          client: cert.name,
          issuer: cert.issuer,
          certSha256: cert.sha256,
          identity: {
            id: cert.id,
            kind: 'key',
            name: cert.name.slice(0, 128),
            multiplier: 1,
            authMethod: 'client-cert',
          },
        };
      }
    }

    if (wantsJwt && rt.jwt) {
      const token = bearerToken(req.headers.authorization);
      if (token !== undefined) {
        const result = rt.jwt.verify(token);
        if (!result.ok) return { ok: false, method: 'jwt', reason: result.reason, challenge: challenge(true) };
        return {
          ok: true,
          method: 'jwt',
          authenticated: true,
          client: result.subject,
          issuer: result.issuer.name,
          identity: this.jwtIdentity(rt, result.issuer, result.subject),
        };
      }
    }

    if (wantsKey && presentedKey !== undefined) {
      const identity = rt.identities.lookupRegistered(presentedKey);
      if (!identity) return { ok: false, method: 'api-key', reason: 'unknown_api_key', challenge: challenge(false) };
      return { ok: true, method: 'api-key', authenticated: true, client: identity.name ?? '', identity };
    }

    if (auth.required) return { ok: false, method: 'none', reason: 'missing_credentials', challenge: challenge(false) };

    // Optional authentication and nothing presented: an ordinary anonymous caller, limited like any other.
    const anonymous = rt.identities.resolve(presentedKey, ip);
    const identity: Identity = anonymous.ok
      ? anonymous.identity
      : { id: `ip:${ip}`, kind: 'anonymous', multiplier: rt.config.rateLimit.anonymousMultiplier };
    return { ok: true, method: 'none', authenticated: false, client: '', identity };
  }

  /**
   * The certificate the caller presented in the TLS handshake. OpenSSL has already checked it against
   * `tls.clientAuth.caFile` and the revocation list; `authorized` says whether it passed. The caller is then named by
   * the certificate's subject common name, and identified (for rate limits) by its issuer and subject together, so a
   * renewed certificate keeps its budget while another CA cannot mint a lookalike.
   */
  private peerCertificate(req: IncomingMessage, rt: Runtime): PeerCertificate {
    const socket = req.socket as TLSSocket;
    if (!socket.encrypted || typeof socket.getPeerCertificate !== 'function') return { kind: 'none' };
    const peer = socket.getPeerCertificate();
    if (!peer || Object.keys(peer).length === 0) return { kind: 'none' };
    if (!socket.authorized) {
      const code = String(socket.authorizationError ?? 'unverified').replace(/[^A-Za-z0-9_]/g, '_');
      return { kind: 'invalid', reason: `client_cert_${code.toLowerCase()}`.slice(0, 64) };
    }
    const subject = peer.subject as unknown as Record<string, string | string[]> | undefined;
    const issuer = peer.issuer as unknown as Record<string, string | string[]> | undefined;
    const name = subject?.['CN'];
    // A certificate with no common name, or several, does not say who it is unambiguously.
    if (typeof name !== 'string' || name === '') return { kind: 'invalid', reason: 'client_cert_no_common_name' };
    const allowed = rt.config.tls?.clientAuth?.allowedNames;
    if (allowed && !allowed.includes(name)) return { kind: 'invalid', reason: 'client_cert_name_not_allowed' };
    const issuerName = issuer?.['CN'];
    const digest = createHash('sha256')
      .update(`${distinguishedName(issuer)}\u0000${distinguishedName(subject)}`)
      .digest('hex');
    return {
      kind: 'valid',
      name,
      issuer: typeof issuerName === 'string' ? issuerName : distinguishedName(issuer),
      sha256: (peer.fingerprint256 ?? '').replace(/:/g, '').toLowerCase(),
      id: `c:${digest.slice(0, 32)}`,
    };
  }

  private jwtIdentity(rt: Runtime, issuer: JwtIssuer, subject: string): Identity {
    const digest = createHash('sha256').update(`${issuer.name}\u0000${subject}`).digest('hex');
    return {
      id: `j:${digest.slice(0, 32)}`,
      kind: 'key',
      name: `${issuer.name}:${subject}`.slice(0, 128),
      multiplier: rt.jwtMultiplier.get(issuer.name) ?? 1,
      authMethod: 'jwt',
    };
  }

  private reject(res: ServerResponse, ctx: RequestContext, routeId: string, decision: RateLimitDecision): false {
    ctx.rateLimited = true;
    this.mRateLimited.inc({ route: routeId });
    const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    this.sendError(res, ctx, 429, 'rate_limited', 'rate limit exceeded', { 'retry-after': retryAfter });
    return false;
  }

  /**
   * The client's address as a rate-limit unit (see normalizeIp). Behind trusted proxies it is the entry the
   * outermost trusted proxy appended to X-Forwarded-For; anything that doesn't parse as an address falls back
   * to the socket, so attacker-chosen text is never used as a key.
   */
  private clientIp(req: IncomingMessage, rt: Runtime): string {
    const { trustedProxyHops: hops, ipv6Prefix } = rt.config.rateLimit;
    if (hops > 0) {
      const raw = req.headers['x-forwarded-for'];
      const parts = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const candidate = normalizeIp(parts[parts.length - hops], ipv6Prefix);
      if (candidate) return candidate;
    }
    return normalizeIp(req.socket.remoteAddress, ipv6Prefix) ?? 'unknown';
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Caching
  // ------------------------------------------------------------------------------------------------------------------

  private async cachedGet(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    route: RouteConfig,
    upstream: UpstreamRuntime,
    policy: RoutePolicy,
    relativePath: string,
    url: URL,
    keyedHeaders: string[],
    skipLookup: boolean,
  ): Promise<void> {
    const cacheConfig = route.cache as NonNullable<RouteConfig['cache']>;
    const varied = keyedHeaders.map((h) => String(req.headers[h] ?? '')).join('\u0000');
    const key = `${upstream.name}\u0000${url.pathname}${url.search}\u0000${varied}`;
    const store: StoreOptions = {
      key,
      ttlMs: cacheConfig.ttlMs,
      stale: { whileRevalidateMs: cacheConfig.staleWhileRevalidateMs, ifErrorMs: cacheConfig.staleIfErrorMs },
      requestHeaders: req.headers,
    };

    // A client that asked for a fresh copy (no-cache) gets one, or the error: neither a hit nor a stale stand-in.
    if (!skipLookup) {
      const found = this.responseCache.lookup(key, req.headers);
      if (found?.fresh) {
        await this.serveEntry(res, ctx, found.entry, 'HIT');
        return;
      }
      if (found) {
        const now = this.clock();
        if (now < (found.entry.staleWhileRevalidateUntil ?? 0)) {
          // Stale, but inside its stale-while-revalidate window: answer at once and fetch a fresh copy behind it.
          this.refreshInBackground(req, ctx, upstream, policy, relativePath, store, keyedHeaders);
          this.mStaleServed.inc({ route: ctx.route, reason: 'revalidating' });
          await this.serveEntry(res, ctx, found.entry, 'STALE');
          return;
        }
        // Past that window, but still allowed to stand in for the upstream if it fails.
        if (now < (found.entry.staleIfErrorUntil ?? 0)) store.fallback = found.entry;
      }
    }

    const fetchAndStore = async (): Promise<FlightResult> => {
      ctx.cache = 'MISS';
      res.setHeader('x-cache', 'MISS');
      try {
        const outcome = await this.forward(
          req,
          res,
          ctx,
          upstream,
          policy,
          relativePath,
          undefined,
          store,
          keyedHeaders,
        );
        if (outcome.stale) return { kind: 'stale', entry: outcome.stale };
        if (outcome.entry) return { kind: 'stored', entry: outcome.entry };
        return outcome.clientGone ? { kind: 'abandoned' } : { kind: 'not-stored' };
      } catch (error) {
        if (error instanceof UpstreamError && error.kind === 'aborted') return { kind: 'abandoned' };
        if (store.fallback && isUpstreamFailure(error)) {
          // The upstream failed (after its retries); the stale copy it allowed for exactly this is the better answer.
          this.servedStaleFor(ctx, error);
          await this.serveEntry(res, ctx, store.fallback, 'STALE');
          return { kind: 'stale', entry: store.fallback };
        }
        throw error; // shared with every waiter: a failing upstream gets one request, not one per waiter
      }
    };

    // Concurrent misses for one key share a single upstream fetch. The leader streams the response to its
    // own client while storing it; the rest wait for the stored entry (or the shared error).
    for (;;) {
      let led = false;
      let value: FlightResult;
      try {
        ({ value } = await this.responseCache.singleFlight(key, () => {
          led = true;
          return fetchAndStore();
        }));
      } catch (error) {
        // Waiting on someone else's fetch (a background refresh, say) that failed: our own stale copy may cover it.
        if (led || ctx.clientGone || !store.fallback || !isUpstreamFailure(error)) throw error;
        this.servedStaleFor(ctx, error);
        await this.serveEntry(res, ctx, store.fallback, 'STALE');
        return;
      }
      if (led || ctx.clientGone) return;

      if (value.kind === 'stored' || value.kind === 'stale') {
        if (value.kind === 'stale') this.mStaleServed.inc({ route: ctx.route, reason: 'upstream_error' });
        await this.serveEntry(res, ctx, value.entry, value.kind === 'stored' ? 'HIT' : 'STALE');
        return;
      }
      if (value.kind === 'not-stored') {
        // The leader's response can't be shared (it may be private to its client): fetch our own, alone.
        await fetchAndStore();
        return;
      }
      // 'abandoned': the leader's client left mid-fetch. Go round again so one waiter takes over as leader,
      // instead of every waiter hitting the upstream at once.
    }
  }

  /** Count and log a stale entry standing in for an upstream that failed. */
  private servedStaleFor(ctx: RequestContext, cause: unknown): void {
    this.mStaleServed.inc({ route: ctx.route, reason: 'upstream_error' });
    this.logger.warn('upstream failed; serving a stale copy', {
      requestId: ctx.requestId,
      route: ctx.route,
      upstream: ctx.upstream,
      cause:
        typeof cause === 'string'
          ? cause
          : cause instanceof UpstreamError
            ? cause.kind
            : cause instanceof CircuitOpenError
              ? 'circuit_open'
              : 'error',
    });
  }

  /**
   * Fetch a fresh copy of a stale entry while the stale one goes on being served. One fetch per key at a time; if it
   * fails, the stale copy stays in service until its windows close.
   */
  private refreshInBackground(
    req: IncomingMessage,
    ctx: RequestContext,
    upstream: UpstreamRuntime,
    policy: RoutePolicy,
    relativePath: string,
    store: StoreOptions,
    keyedHeaders: string[],
  ): void {
    if (this.responseCache.isInFlight(store.key)) return;
    const bg = this.backgroundContext(ctx);
    // Built now, from the request that set it off: by the time the fetch runs, that request may be long gone.
    const headers = this.upstreamHeaders(req, bg, undefined, true, keyedHeaders);
    void this.responseCache
      .singleFlight(store.key, () => this.fetchIntoCache(bg, upstream, policy, relativePath, headers, store))
      .then(
        ({ value }) => this.finishRefresh(bg, value.kind === 'stored' ? 'stored' : 'not_stored'),
        (error: unknown) => this.finishRefresh(bg, 'error', error),
      );
  }

  /** A context for work a request sets off but does not wait for: same route and caller, its own id, same trace. */
  private backgroundContext(ctx: RequestContext): RequestContext {
    return {
      rt: ctx.rt,
      trace: ctx.trace ? childOf(ctx.trace) : undefined,
      requestId: randomUUID(),
      method: 'GET',
      path: ctx.path,
      route: ctx.route,
      upstream: ctx.upstream,
      client: ctx.client,
      auth: ctx.auth,
      attempts: 0,
      rateLimited: false,
      degraded: false,
      started: performance.now(),
      clientGone: false,
      upstreamTruncated: false,
      buffered: 0,
    };
  }

  private async fetchIntoCache(
    bg: RequestContext,
    upstream: UpstreamRuntime,
    policy: RoutePolicy,
    relativePath: string,
    headers: Record<string, string | string[]>,
    store: StoreOptions,
  ): Promise<FlightResult> {
    return this.withUpstream(upstream, () =>
      this.fetchIntoCacheFrom(bg, upstream, policy, relativePath, headers, store),
    );
  }

  private async fetchIntoCacheFrom(
    bg: RequestContext,
    upstream: UpstreamRuntime,
    policy: RoutePolicy,
    relativePath: string,
    headers: Record<string, string | string[]>,
    store: StoreOptions,
  ): Promise<FlightResult> {
    const response = await this.callUpstream<UpstreamResponse>(upstream, bg, policy, NEVER_ABORTED, {
      send: (target, timeoutMs, hop) =>
        target.client.request({
          method: 'GET',
          path: target.client.resolvePath(relativePath),
          headers: { ...headers, ...hop, host: target.client.host },
          timeoutMs,
        }),
      status: (result) => result.status,
      headers: (result) => result.headers,
      discard: (result) => result.stream.resume(),
    });
    const entry = await this.readIntoCache(response, store);
    return entry ? { kind: 'stored', entry } : { kind: 'not-stored' };
  }

  /** Read a response with nobody waiting on it, and store it if it may be stored. */
  private async readIntoCache(up: UpstreamResponse, store: StoreOptions): Promise<CachedResponse | undefined> {
    const decision = storeDecision(up.status, up.headers, store.ttlMs, store.stale);
    const max = this.responseCache.maxEntryBytes;
    const declared = Number(up.headers['content-length']);
    if (!decision) {
      up.stream.resume();
      return undefined;
    }
    if (Number.isFinite(declared) && declared > max) {
      up.stream.destroy();
      return undefined;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of up.stream as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > max) {
        up.stream.destroy();
        return undefined;
      }
      chunks.push(chunk);
    }
    if (Number.isFinite(declared) && declared !== size) return undefined; // truncated
    return this.storeEntry(store, up, decision, Buffer.concat(chunks));
  }

  private finishRefresh(bg: RequestContext, result: 'stored' | 'not_stored' | 'error', error?: unknown): void {
    this.mRefreshes.inc({ route: bg.route, result });
    if (bg.trace) {
      const cause =
        error instanceof UpstreamError ? error.kind : error instanceof CircuitOpenError ? 'circuit_open' : 'error';
      this.recordSpan(bg.trace, {
        spanId: bg.trace.spanId,
        parentSpanId: bg.trace.parentId,
        name: 'cache refresh',
        kind: 'internal',
        startNs: nowNs(bg.started),
        endNs: nowNs(),
        attributes: {
          'gateway.route': bg.route,
          'gateway.upstream': bg.upstream,
          'gateway.refresh_result': result,
          'gateway.request_id': bg.requestId,
        },
        error: result === 'error' ? cause : undefined,
      });
    }
    const fields = {
      requestId: bg.requestId,
      route: bg.route,
      result,
      attempts: bg.attempts,
      durationMs: Math.round(performance.now() - bg.started),
    };
    if (result !== 'error') {
      this.logger.debug('cache entry refreshed in the background', fields);
      return;
    }
    this.logger.warn('background cache refresh failed; the stale copy stays in service', {
      ...fields,
      cause: error instanceof UpstreamError ? error.kind : error instanceof CircuitOpenError ? 'circuit_open' : 'error',
    });
  }

  private async serveEntry(
    res: ServerResponse,
    ctx: RequestContext,
    entry: CachedResponse,
    as: 'HIT' | 'STALE',
  ): Promise<void> {
    ctx.cache = as;
    const age = Math.max(0, Math.floor((this.clock() - entry.storedAt) / 1000));
    res.writeHead(entry.status, { ...entry.headers, age: String(age), 'x-cache': as });
    const body = entry.body;
    if (body.length <= WRITE_SLICE_BYTES) {
      res.end(body); // fits in the socket's buffers whatever the client does, so there is nothing to wait for
      return;
    }
    // A big entry goes out in slices so that a client which stops reading is noticed and dropped, not waited on.
    for (let offset = 0; offset < body.length; offset += WRITE_SLICE_BYTES) {
      if (res.destroyed) return;
      const slice = body.subarray(offset, offset + WRITE_SLICE_BYTES);
      if (!res.write(slice) && !(await this.drained(res, ctx))) return;
    }
    res.end();
  }

  /**
   * Wait for a client to take the data it has been sent. False if it has gone, or has stopped reading for longer
   * than `limits.responseStallTimeoutMs` (in which case it is dropped here).
   */
  private async drained(res: ServerResponse, ctx: RequestContext): Promise<boolean> {
    const stallMs = ctx.rt.config.limits.responseStallTimeoutMs;
    const outcome = await waitForDrain(res, stallMs);
    if (outcome === 'stalled') {
      this.mShed.inc({ reason: 'slow_reader' });
      this.logger.warn('dropping a client that stopped reading its response', {
        requestId: ctx.requestId,
        route: ctx.route,
        stalledMs: stallMs,
      });
      res.destroy();
    }
    return outcome === 'drained';
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Forwarding: target selection + breaker + retry + relay
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * Choose a target and take a breaker permit for it. Targets this request has not tried yet are preferred, so
   * a retry moves to a different instance; ones whose breaker is open are skipped.
   */
  private pickTarget(upstream: UpstreamRuntime, tried: Set<Target>): { target: Target; permit: Permit } | undefined {
    const n = upstream.targets.length;
    const start = upstream.cursor;
    upstream.cursor = (upstream.cursor + 1) % n;

    let order = upstream.targets.map((_, i) => upstream.targets[(start + i) % n] as Target);
    // Targets the health check has condemned are skipped, unless that would leave nothing: then the verdict is
    // ignored ("panic mode") and the circuit breakers alone decide, so a broken probe can't take a service offline.
    const inRotation = order.filter((t) => t.healthy);
    if (inRotation.length > 0) order = inRotation;
    if (upstream.config.balance === 'least-pending') order.sort((a, b) => a.pending - b.pending); // stable

    for (const pass of [false, true]) {
      for (const target of order) {
        if (tried.has(target) !== pass) continue;
        const permit = target.breaker.tryAcquire();
        if (permit) return { target, permit };
      }
    }
    return undefined;
  }

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    upstream: UpstreamRuntime,
    policy: RoutePolicy,
    relativePath: string,
    body: Buffer | undefined,
    store?: StoreOptions,
    forwardOnly?: string[],
  ): Promise<RelayOutcome> {
    // Abort in-flight work (including backoff sleeps) the moment the client goes away.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', onClose);

    const headers = this.upstreamHeaders(req, ctx, body, store !== undefined, forwardOnly);

    upstream.users++;
    try {
      const response = await this.callUpstream<UpstreamResponse>(upstream, ctx, policy, abort.signal, {
        send: (target, timeoutMs, hop) =>
          target.client.request({
            method: ctx.method,
            path: target.client.resolvePath(relativePath),
            headers: { ...headers, ...hop, host: target.client.host },
            body,
            signal: abort.signal,
            timeoutMs,
          }),
        status: (result) => result.status,
        headers: (result) => result.headers,
        discard: (result) => result.stream.resume(),
      });
      if (store?.fallback && response.status >= 500) {
        // Retries are spent and the upstream is still failing; it allowed this stale copy to stand in for it.
        response.stream.resume();
        this.servedStaleFor(ctx, `status ${response.status}`);
        await this.serveEntry(res, ctx, store.fallback, 'STALE');
        return { clientGone: false, stale: store.fallback };
      }
      return await this.relay(res, ctx, response, store);
    } finally {
      res.off('close', onClose);
      this.releaseUpstream(upstream);
    }
  }

  /**
   * One logical call to an upstream: choose a target, take its breaker permit, make an attempt, record how it
   * went, and retry per the upstream's policy (backoff with jitter, bounded by the overall deadline). The caller
   * supplies what a single attempt does and how to read its outcome, so plain requests and WebSocket handshakes
   * share one retry and circuit-breaking policy instead of two copies of it.
   */
  private async callUpstream<T>(
    upstream: UpstreamRuntime,
    ctx: RequestContext,
    policy: RoutePolicy,
    signal: AbortSignal,
    call: {
      /**
       * A single attempt against `target`, to finish within `timeoutMs`. `hop` holds the headers that name this
       * attempt in the trace (its own `traceparent`), to send along with the rest.
       */
      send(target: Target, timeoutMs: number, hop: Record<string, string>): Promise<T>;
      status(result: T): number;
      headers(result: T): IncomingHttpHeaders;
      /** Release a result that is being replaced by another attempt. */
      discard(result: T): void;
    },
  ): Promise<T> {
    const { retry: retryPolicy, timeoutMs, totalTimeoutMs } = policy;
    const retryStatuses = new Set(retryPolicy.retryOnStatus);
    const mayRetryUnsafe = IDEMPOTENT.has(ctx.method) || retryPolicy.retryNonIdempotent;
    const tried = new Set<Target>();

    // Overall deadline across attempts and backoff sleeps (real time: it bounds how long a client waits).
    const deadline = totalTimeoutMs === undefined ? undefined : performance.now() + totalTimeoutMs;
    const budgetLeftMs = (): number => (deadline === undefined ? Infinity : deadline - performance.now());

    return retry(
      async (attempt) => {
        // Re-check after any backoff sleep: no point starting an attempt that cannot finish in time.
        if (attempt > 1 && budgetLeftMs() < MIN_ATTEMPT_BUDGET_MS) {
          throw new UpstreamError('timeout', `overall deadline of ${totalTimeoutMs}ms exceeded`);
        }
        const picked = this.pickTarget(upstream, tried);
        if (!picked) throw new CircuitOpenError(this.retryAfterMs(upstream));
        const { target, permit } = picked;
        tried.add(target);
        ctx.attempts++;
        target.pending++;
        // Each attempt is a hop of its own in the trace, so the upstream's span hangs off the attempt that reached it.
        const span = { id: newSpanId(), started: performance.now(), attempt: ctx.attempts };
        const hop: Record<string, string> = ctx.trace
          ? { traceparent: formatTraceparent({ ...ctx.trace, spanId: span.id }) }
          : {};
        try {
          const result = await call.send(target, Math.max(1, Math.min(timeoutMs, budgetLeftMs())), hop);
          const status = call.status(result);
          const failed = status >= 500;
          if (failed) permit.failure();
          else permit.success();
          this.mAttempts.inc({ upstream: upstream.name, target: target.id, outcome: failed ? 'status_5xx' : 'ok' });
          this.recordAttempt(ctx, upstream, target, span, { status });
          return result;
        } catch (error) {
          const aborted = error instanceof UpstreamError && error.kind === 'aborted';
          if (aborted) permit.release();
          else permit.failure();
          const kind = error instanceof UpstreamError ? error.kind : 'error';
          this.mAttempts.inc({ upstream: upstream.name, target: target.id, outcome: kind });
          this.recordAttempt(ctx, upstream, target, span, { error: kind });
          throw error;
        } finally {
          target.pending--;
        }
      },
      {
        maxAttempts: retryPolicy.maxAttempts,
        backoff: { baseDelayMs: retryPolicy.baseDelayMs, maxDelayMs: retryPolicy.maxDelayMs },
        signal,
        sleep: this.deps.sleep,
        random: this.deps.random,
        shouldRetry: (outcome) => {
          if (budgetLeftMs() < MIN_ATTEMPT_BUDGET_MS) return false;
          if (outcome.ok) return retryStatuses.has(call.status(outcome.value)) && mayRetryUnsafe;
          const error = outcome.error;
          if (!(error instanceof UpstreamError)) return false;
          switch (error.kind) {
            case 'aborted': // the client left; nobody is waiting for the answer
            case 'tls': // a certificate problem won't fix itself between attempts
            case 'protocol': // an upstream that answers wrongly will answer wrongly again
              return false;
            case 'connect': // nothing was sent, so even POST is safe to retry
              return true;
            default:
              return mayRetryUnsafe;
          }
        },
        retryAfterMs: (outcome) =>
          outcome.ok ? parseRetryAfterMs(call.headers(outcome.value)['retry-after']) : undefined,
        discard: (result) => call.discard(result),
        onRetry: ({ attempt, delayMs, outcome }) =>
          this.logger.debug('retrying upstream call', {
            requestId: ctx.requestId,
            upstream: upstream.name,
            attempt,
            delayMs,
            reason: outcome.ok ? `status ${call.status(outcome.value)}` : (outcome.error as Error).message,
          }),
      },
    );
  }

  // ------------------------------------------------------------------------------------------------------------------
  // WebSocket
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * An Upgrade request. Once the server has an 'upgrade' listener Node hands every such request here and none to
   * the ordinary handler, so this refuses everything that is not a WebSocket handshake on a route that opted in.
   *
   * The checks are the ones an ordinary request gets (origin, address ceiling, authentication, the route's rate
   * limit), and a refusal is an ordinary HTTP response written on the raw socket. Only then is the upstream asked
   * to switch protocols; once it agrees the two sockets are joined and the gateway moves bytes without looking at
   * them.
   */
  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    socket.on('error', () => {}); // a reset before the tunnel exists must not be fatal
    this.upgradeSockets.add(socket);
    socket.once('close', () => this.upgradeSockets.delete(socket));

    const ctx = this.newContext(req);
    // Reuse the response machinery (error bodies, rate-limit headers, access log) by giving the socket a response
    // object, exactly as Node does for a normal request. A successful upgrade detaches it again.
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    const shed = this.active.size >= ctx.rt.config.limits.maxInFlight;
    this.trackResponse(res, ctx);
    res.setHeader('connection', 'close'); // this socket never goes back to the HTTP parser
    res.once('finish', () => closeSoon(socket));

    // While the handshake is in progress nothing reads this socket, so a client that hangs up would go unnoticed and
    // its upstream attempt would run to completion. Read it, keeping what arrives: a client is not supposed to send
    // before it has the 101, but if it does, those bytes belong to the upstream and must not be lost.
    const abort = new AbortController();
    const early: Buffer[] = head.length > 0 ? [head] : [];
    let earlyBytes = head.length;
    const onEarlyData = (chunk: Buffer): void => {
      earlyBytes += chunk.length;
      if (earlyBytes > MAX_EARLY_WS_BYTES) socket.destroy();
      else early.push(chunk);
    };
    const onHangUp = (): void => {
      abort.abort();
      socket.destroy();
    };
    socket.on('data', onEarlyData);
    socket.once('end', onHangUp);
    socket.once('close', () => abort.abort());

    let routeId: string | undefined;
    let tunneled = false;
    let held: UpstreamRuntime | undefined; // whose connections the handshake is using
    try {
      if (this.closing) {
        return this.sendError(res, ctx, 503, 'shutting_down', 'the gateway is shutting down', { 'retry-after': 1 });
      }
      if (shed) throw new OverloadedError('too many requests in flight');

      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://gateway.invalid');
      } catch {
        return this.sendError(res, ctx, 400, 'bad_request', 'malformed request target');
      }
      ctx.path = url.pathname;
      if (url.pathname === '/_gateway' || url.pathname.startsWith('/_gateway/')) {
        return this.sendError(res, ctx, 404, 'route_not_found', 'no route matches this request');
      }

      const match = ctx.rt.router.match(url.pathname, 'GET');
      const ws = match?.route.websocket;
      if (!match || !ws) return this.sendError(res, ctx, 404, 'route_not_found', 'no route matches this request');
      ctx.route = match.routeId;
      ctx.routePath = match.route.path;

      const handshake = validateHandshake(req);
      if (!handshake.ok) {
        return this.sendError(res, ctx, handshake.status, handshake.code, handshake.message, handshake.headers);
      }

      // Before anything that costs: a page on another site must not get as far as authentication.
      if (!originAllowed(req.headers.origin, ws.allowedOrigins, ws.allowAnyOrigin)) {
        this.logger.warn('websocket origin refused', {
          requestId: ctx.requestId,
          route: match.routeId,
          origin: String(req.headers.origin).slice(0, 200),
        });
        return this.sendError(res, ctx, 403, 'origin_not_allowed', 'this origin may not open a websocket here');
      }

      if (!(await this.admitted(req, res, ctx, match.route, match.routeId))) return;

      // Reserved before the first await below, so concurrent handshakes cannot all slip under the cap.
      const open = this.wsOpen.get(match.routeId) ?? 0;
      if (open >= ws.maxConnections) {
        this.mShed.inc({ reason: 'websocket_limit' });
        return this.sendError(res, ctx, 503, 'too_many_websockets', 'too many websocket connections; retry later', {
          'retry-after': 5,
        });
      }
      this.wsOpen.set(match.routeId, open + 1);
      routeId = match.routeId;

      const upstream = ctx.rt.upstreams.get(match.route.upstream) as UpstreamRuntime;
      ctx.upstream = upstream.name;
      const relativePath = match.upstreamPath + url.search;
      const headers = this.websocketHeaders(req, ctx, handshake);

      const policy = ctx.rt.routePolicies.get(match.routeId) as RoutePolicy;
      held = upstream;
      upstream.users++;
      const result = await this.callUpstream<UpgradeResult>(upstream, ctx, policy, abort.signal, {
        send: async (target, timeoutMs, hop) => {
          const outcome = await target.client.upgrade({
            path: target.client.resolvePath(relativePath),
            headers: { ...headers, ...hop, host: target.client.host },
            signal: abort.signal,
            timeoutMs,
          });
          if (outcome.kind === 'rejected') return outcome;
          // Trust nothing the upstream says until it checks out: a wrong accept key or a subprotocol the client
          // never offered means the two ends are not talking the protocol the client asked for.
          const verdict = checkUpstreamHandshake(outcome.headers, handshake);
          if (!verdict.ok) {
            outcome.socket.destroy();
            throw new UpstreamError('protocol', verdict.reason);
          }
          return {
            kind: 'upgraded',
            socket: outcome.socket,
            head: outcome.head,
            protocol: verdict.protocol,
            extensions: verdict.extensions,
          };
        },
        status: (outcome) => (outcome.kind === 'upgraded' ? 101 : outcome.response.status),
        headers: (outcome) => (outcome.kind === 'upgraded' ? {} : outcome.response.headers),
        discard: (outcome) => {
          if (outcome.kind === 'upgraded') outcome.socket.destroy();
          else outcome.response.stream.resume();
        },
      });

      if (result.kind === 'rejected') {
        // The upstream declined to upgrade (it wants a login, there is no such socket): pass its answer on.
        await this.relay(res, ctx, result.response);
        return;
      }
      if (socket.destroyed) {
        result.socket.destroy(); // the client gave up while we were waiting
        return;
      }

      // Hand-written 101: every value in it is either ours or was checked to be printable ASCII.
      const lines = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(handshake.key)}`,
        `X-Request-Id: ${ctx.requestId}`,
      ];
      if (result.protocol !== undefined) lines.push(`Sec-WebSocket-Protocol: ${result.protocol}`);
      if (result.extensions !== undefined) lines.push(`Sec-WebSocket-Extensions: ${result.extensions}`);

      ctx.switched = true;
      res.detachSocket(socket as Socket); // from here on the bytes are not HTTP
      this.active.delete(res);
      this.finish(res, ctx);

      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (result.head.length > 0) socket.write(result.head); // frames the upstream sent right behind its 101
      socket.off('data', onEarlyData); // the tunnel reads from here on, in this same tick
      socket.off('end', onHangUp);
      if (early.length > 0) result.socket.write(Buffer.concat(early)); // the client's, from behind its request

      const opened = performance.now();
      const route = ctx.route;
      const tunnel = openTunnel(socket, result.socket, {
        idleTimeoutMs: ws.idleTimeoutMs,
        maxDurationMs: ws.maxDurationMs,
        onClose: (reason, fromClient, fromUpstream) => {
          this.tunnels.delete(tunnel);
          this.releaseWebsocketSlot(route);
          this.mWsClosed.inc({ route, reason });
          this.mWsBytes.inc({ route, direction: 'client_to_upstream' }, fromClient);
          this.mWsBytes.inc({ route, direction: 'upstream_to_client' }, fromUpstream);
          this.logger.info('websocket closed', {
            requestId: ctx.requestId,
            route,
            client: ctx.client,
            reason,
            durationMs: Math.round(performance.now() - opened),
            bytesFromClient: fromClient,
            bytesFromUpstream: fromUpstream,
          });
        },
      });
      this.tunnels.add(tunnel);
      tunneled = true;
    } catch (error) {
      this.fail(res, ctx, error);
    } finally {
      if (routeId !== undefined && !tunneled) this.releaseWebsocketSlot(routeId);
      if (held) this.releaseUpstream(held); // a joined tunnel's socket has left the pool; it is not affected
    }
  }

  private releaseWebsocketSlot(routeId: string): void {
    const left = (this.wsOpen.get(routeId) ?? 1) - 1;
    if (left <= 0) this.wsOpen.delete(routeId);
    else this.wsOpen.set(routeId, left);
  }

  /**
   * Headers for the upstream's side of the handshake. Everything that is not the handshake itself is built the way
   * it is for any proxied request (forwarding headers, verified identity, no client-supplied identity headers); the
   * handshake headers are then set from what was validated, not copied, because the hop-by-hop stripping that keeps
   * a client's own `Connection` list out of an ordinary request also strips them.
   */
  private websocketHeaders(
    req: IncomingMessage,
    ctx: RequestContext,
    handshake: { key: string },
  ): Record<string, string | string[]> {
    const headers = this.upstreamHeaders(req, ctx, undefined, false);
    headers['connection'] = 'Upgrade';
    headers['upgrade'] = 'websocket';
    headers['sec-websocket-version'] = '13';
    headers['sec-websocket-key'] = handshake.key;
    for (const name of ['sec-websocket-protocol', 'sec-websocket-extensions']) {
      const value = req.headers[name];
      if (value === undefined) delete headers[name];
      else headers[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    return headers;
  }

  /** When an upstream with every target open will next let a probe through. */
  private retryAfterMs(upstream: UpstreamRuntime): number {
    return Math.min(...upstream.targets.map((t) => t.breaker.snapshot().retryAfterMs));
  }

  /**
   * Headers for the upstream request.
   *
   * What a client sends about itself and its route is not trusted: rewrite headers are dropped always, and the
   * forwarding headers (X-Forwarded-*, Forwarded, X-Real-IP) are rebuilt by the gateway unless it sits behind
   * trusted proxies that set them. On a cacheable request only the keyed headers are passed on at all, so a
   * header an upstream might reflect into a response can't be used to poison an entry other clients receive.
   */
  private upstreamHeaders(
    req: IncomingMessage,
    ctx: RequestContext,
    body: Buffer | undefined,
    cacheable: boolean,
    forwardOnly?: string[],
  ): Record<string, string | string[]> {
    const incoming = stripHopByHop(req.headers);
    let headers: Record<string, string | string[]> = {};
    if (forwardOnly) {
      for (const name of forwardOnly) {
        const value = incoming[name];
        if (value !== undefined) headers[name] = value;
      }
    } else {
      headers = incoming;
    }
    for (const name of REWRITE_HEADERS) delete headers[name];

    const { config } = ctx.rt;
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (config.rateLimit.trustedProxyHops > 0) {
      // Behind trusted proxies: they own the chain, we add the hop we actually saw.
      const prior = req.headers['x-forwarded-for'];
      headers['x-forwarded-for'] = [Array.isArray(prior) ? prior.join(', ') : prior, remote].filter(Boolean).join(', ');
      for (const name of ['x-forwarded-proto', 'x-forwarded-host']) {
        const value = req.headers[name];
        if (value !== undefined) headers[name] = value;
      }
    } else {
      for (const name of PROXY_HEADERS) delete headers[name];
      headers['x-forwarded-for'] = remote;
      // What this listener actually is. (Behind trusted proxies the proxy's own claim is kept instead.)
      headers['x-forwarded-proto'] = (req.socket as TLSSocket).encrypted ? 'https' : 'http';
      if (config.forwardedHost) headers['x-forwarded-host'] = config.forwardedHost;
    }
    headers['x-request-id'] = ctx.requestId;
    if (ctx.trace) {
      // Our hop as the parent. A caller's tracestate belongs to the caller's trace: it goes only where that continues.
      headers['traceparent'] = formatTraceparent(ctx.trace);
      if (ctx.trace.state) headers['tracestate'] = ctx.trace.state;
      else delete headers['tracestate'];
    }

    // Identity headers are the gateway's word about who the caller is, so a client must never be able to supply
    // them: strip whatever came in, then set them only from a credential the gateway verified itself.
    for (const name of IDENTITY_HEADERS) delete headers[name];
    if (ctx.auth) {
      if (config.auth.forwardIdentity) {
        headers['x-authenticated-method'] = ctx.auth.method;
        headers['x-authenticated-client'] = headerSafe(ctx.auth.client);
        if (ctx.auth.issuer) headers['x-authenticated-issuer'] = headerSafe(ctx.auth.issuer);
        if (ctx.auth.certSha256) headers['x-client-cert-sha256'] = ctx.auth.certSha256;
      }
      if (!config.auth.forwardCredentials) {
        // Only the credential the gateway consumed: other schemes in Authorization are the upstream's business.
        // (A certificate is not a header: there is nothing to withhold.)
        if (ctx.auth.method === 'jwt') delete headers['authorization'];
        else if (ctx.auth.method === 'api-key') delete headers[config.rateLimit.identityHeader];
      }
    }

    // We re-send a fully buffered body, so framing is ours to set.
    delete headers['content-length'];
    if (body && body.length > 0) headers['content-length'] = String(body.length);

    // Cacheable responses are stored once and replayed to everyone, so don't let clients negotiate encodings.
    if (cacheable) headers['accept-encoding'] = 'identity';
    return headers;
  }

  /** Stream the upstream response to the client, optionally keeping a copy for the cache. */
  private async relay(
    res: ServerResponse,
    ctx: RequestContext,
    up: UpstreamResponse,
    store?: StoreOptions,
  ): Promise<RelayOutcome> {
    const maxEntry = this.cache.maxEntryBytes;
    const decision = store ? storeDecision(up.status, up.headers, store.ttlMs, store.stale) : undefined;
    const declared = Number(up.headers['content-length']);
    let collecting = decision !== undefined && !(Number.isFinite(declared) && declared > maxEntry);
    const chunks: Buffer[] = [];
    let size = 0;

    const headers = stripHopByHop(up.headers);
    res.writeHead(up.status, headers);

    let clientGone = false;
    const onClose = (): void => {
      if (res.writableFinished) return;
      clientGone = true;
      up.stream.destroy(); // stop downloading a body nobody will read
    };
    res.once('close', onClose);

    try {
      for await (const chunk of up.stream as AsyncIterable<Buffer>) {
        if (collecting) {
          size += chunk.length;
          if (size > maxEntry) {
            collecting = false;
            chunks.length = 0;
          } else {
            chunks.push(chunk);
          }
        }
        if (clientGone || res.destroyed) return { clientGone: true };
        if (!res.write(chunk) && !(await this.drained(res, ctx))) {
          clientGone = true;
          up.stream.destroy(); // this listener is gone before 'close' fires, so release the upstream here
          return { clientGone: true };
        }
      }
    } catch {
      if (clientGone) return { clientGone: true };
      // The upstream died mid-body. Destroying the connection is the only honest signal left: the status
      // line already went out, and ending normally would hand the client a truncated body as if complete.
      ctx.upstreamTruncated = true;
      res.destroy();
      return { clientGone: false };
    } finally {
      res.off('close', onClose);
    }

    if (clientGone || res.destroyed) return { clientGone: true };
    res.end();

    if (!collecting || !decision || !store) return { clientGone: false };
    if (Number.isFinite(declared) && declared !== size) return { clientGone: false }; // truncated

    return { entry: this.storeEntry(store, up, decision, Buffer.concat(chunks)), clientGone: false };
  }

  /** Turn a complete response into a cache entry, with its freshness and stale windows, and store it. */
  private storeEntry(
    store: StoreOptions,
    up: UpstreamResponse,
    decision: StoreDecision,
    body: Buffer,
  ): CachedResponse | undefined {
    const entryHeaders = stripHopByHop(up.headers);
    delete entryHeaders['age']; // our own Age header is computed at serve time
    entryHeaders['content-length'] = String(body.length);

    // Remember the request values this variant was produced for; a later request that differs on any header
    // the upstream said it varies on must not be served this entry.
    const vary: Record<string, string | undefined> = {};
    for (const name of decision.vary) {
      const value = store.requestHeaders[name];
      vary[name] = Array.isArray(value) ? value.join(', ') : value;
    }
    const now = this.clock();
    const expiresAt = now + decision.ttlMs;
    const entry: CachedResponse = {
      status: up.status,
      headers: entryHeaders,
      body,
      storedAt: now,
      expiresAt,
      staleWhileRevalidateUntil:
        decision.staleWhileRevalidateMs > 0 ? expiresAt + decision.staleWhileRevalidateMs : undefined,
      staleIfErrorUntil: decision.staleIfErrorMs > 0 ? expiresAt + decision.staleIfErrorMs : undefined,
      vary,
    };
    return this.responseCache.set(store.key, entry) ? entry : undefined;
  }

  /**
   * Buffer the request body (so retries can replay it), enforcing maxBodyBytes even when the client sends no
   * Content-Length. Uses events rather than `for await`: breaking out of an async iterator destroys the
   * request, and with it the socket, before the 413 could be written.
   */
  private readBody(req: IncomingMessage, ctx: RequestContext, limit: number): Promise<Buffer | undefined> {
    const budget = ctx.rt.config.limits.maxBufferedBytes;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return Promise.reject(new PayloadTooLargeError(limit));
    if (Number.isFinite(declared) && this.bufferedBytes + declared > budget) {
      return Promise.reject(new OverloadedError('request buffer budget exhausted'));
    }
    if (req.readableEnded) return Promise.resolve(undefined);

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = (): void => {
        req.off('data', onData);
        req.off('end', onEnd);
        req.off('error', onError);
        req.off('close', onClose);
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > limit) {
          // Stop reading (the 413 carries Connection: close, so the rest of the upload is never processed).
          cleanup();
          req.pause();
          reject(new PayloadTooLargeError(limit));
          return;
        }
        this.bufferedBytes += chunk.length;
        ctx.buffered += chunk.length;
        if (this.bufferedBytes > budget) {
          cleanup();
          req.pause();
          reject(new OverloadedError('request buffer budget exhausted'));
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        cleanup();
        resolve(size === 0 ? undefined : Buffer.concat(chunks));
      };
      const onError = (): void => {
        cleanup();
        reject(new ClientAbortedError());
      };
      const onClose = (): void => {
        if (req.readableEnded) return;
        cleanup();
        reject(new ClientAbortedError());
      };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      req.on('close', onClose);
    });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Responses, errors, admin
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * Client-facing errors are deliberately generic: they carry a stable code and the request id, nothing about
   * upstream addresses, error codes or timings. The detail is logged against the same request id.
   */
  private sendError(
    res: ServerResponse,
    ctx: RequestContext,
    status: number,
    code: string,
    message: string,
    headers: Record<string, string | number> = {},
  ): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const payload = JSON.stringify({ error: { code, message, requestId: ctx.requestId } });
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      ...headers,
    });
    res.end(payload);
  }

  private fail(res: ServerResponse, ctx: RequestContext, error: unknown): void {
    if (error instanceof ClientAbortedError) return; // nobody left to answer
    if (error instanceof PayloadTooLargeError) {
      this.sendError(res, ctx, 413, 'payload_too_large', 'request body is too large', { connection: 'close' });
    } else if (error instanceof OverloadedError) {
      this.mShed.inc({ reason: 'overloaded' });
      this.sendError(res, ctx, 503, 'overloaded', 'the gateway is at capacity; retry shortly', {
        'retry-after': 1,
        connection: 'close',
      });
    } else if (error instanceof RateLimiterUnavailableError) {
      this.sendError(res, ctx, 503, 'rate_limiter_unavailable', 'rate limiting is temporarily unavailable', {
        'retry-after': 1,
      });
    } else if (error instanceof CircuitOpenError) {
      const retryAfter = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      this.sendError(res, ctx, 503, 'upstream_unavailable', 'the upstream is unavailable', {
        'retry-after': retryAfter,
      });
    } else if (error instanceof UpstreamError) {
      if (error.kind === 'aborted') return; // client is gone; nobody to answer
      this.logger.warn('upstream error', {
        requestId: ctx.requestId,
        upstream: ctx.upstream,
        kind: error.kind,
        detail: error.message,
      });
      if (error.kind === 'timeout') {
        this.sendError(res, ctx, 504, 'upstream_timeout', 'the upstream did not respond in time');
      } else {
        this.sendError(res, ctx, 502, 'bad_gateway', 'the upstream request failed');
      }
    } else {
      this.logger.error('unhandled error', {
        requestId: ctx.requestId,
        error: (error as Error)?.stack ?? String(error),
      });
      this.sendError(res, ctx, 500, 'internal_error', 'internal server error');
    }
  }

  /** Prometheus text for this process. */
  renderMetrics(): string {
    return this.metrics.render();
  }

  /** The state the health endpoint reports: circuit and health-check state per target, load, cache. */
  healthReport(): Record<string, unknown> {
    const upstreams: Record<string, unknown> = {};
    for (const u of this.rt.upstreams.values()) {
      const targets = u.targets.map((t) => ({
        id: t.id,
        pending: t.pending,
        healthy: t.healthy,
        ...(u.health ? { healthCheck: u.health.checker.snapshot(t.id) } : {}),
        ...t.breaker.snapshot(),
      }));
      const states = new Set(targets.map((t) => t.state));
      upstreams[u.name] = {
        // The upstream can serve while any target is closed; it is open only if every target is.
        state: states.has('closed') ? 'closed' : states.size === 1 && states.has('open') ? 'open' : 'half-open',
        failures: targets.reduce((sum, t) => sum + t.failures, 0),
        total: targets.reduce((sum, t) => sum + t.total, 0),
        targets,
      };
    }
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((this.clock() - this.startedAt) / 1000),
      configGeneration: this.rt.generation,
      redis: this.redis ? this.redis.status : 'disabled',
      ...(this.redis && this.rt.config.redis ? { redisMode: redisMode(this.rt.config.redis) } : {}),
      connections: this.connections,
      inFlight: this.active.size,
      upstreams,
      cache: this.cache.stats(),
    };
  }

  private finish(res: ServerResponse, ctx: RequestContext): void {
    // During shutdown, a connection whose response just completed is now idle: close it rather than wait.
    if (this.closing) this.server.closeIdleConnections();

    const durationMs = performance.now() - ctx.started;
    const completed = res.writableFinished;
    // An unfinished response is either a truncated upstream body (a gateway error) or the client leaving
    // (nginx's 499 "client closed request").
    const status = ctx.switched ? 101 : completed ? res.statusCode : ctx.upstreamTruncated ? 502 : 499;
    this.mRequests.inc({ route: ctx.route, status });
    this.mLatency.observe(durationMs / 1000, { route: ctx.route });
    if (ctx.cache) this.mCache.inc({ route: ctx.route, result: ctx.cache });
    // Bounded: the path is client-controlled, and an unbounded value is a log-amplification lever.
    const path = ctx.path.length > MAX_LOGGED_PATH ? `${ctx.path.slice(0, MAX_LOGGED_PATH)}…` : ctx.path;
    if (ctx.trace) {
      // OpenTelemetry's HTTP server conventions. The route's prefix names the span; the raw path is an attribute.
      this.recordSpan(ctx.trace, {
        spanId: ctx.trace.spanId,
        parentSpanId: ctx.trace.parentId,
        name: ctx.routePath ? `${ctx.method} ${ctx.routePath}` : ctx.method,
        kind: 'server',
        startNs: nowNs(ctx.started),
        endNs: nowNs(),
        attributes: {
          'http.request.method': ctx.method,
          'url.path': path,
          'http.route': ctx.routePath,
          'http.response.status_code': status,
          'gateway.route': ctx.route,
          'gateway.request_id': ctx.requestId,
          'gateway.upstream': ctx.upstream,
          'gateway.client': ctx.client,
          'gateway.cache': ctx.cache,
          'gateway.rate_limited': ctx.rateLimited || undefined,
          'gateway.auth_failure': ctx.authFailure,
        },
        error: status >= 500 ? `status ${status}` : undefined,
      });
    }
    this.logger.info('request', {
      requestId: ctx.requestId,
      traceId: ctx.trace?.traceId,
      method: ctx.method,
      path,
      route: ctx.route,
      status,
      durationMs: Math.round(durationMs * 10) / 10,
      client: ctx.client,
      cache: ctx.cache,
      attempts: ctx.attempts || undefined,
      rateLimited: ctx.rateLimited || undefined,
      degraded: ctx.degraded || undefined,
      truncated: ctx.upstreamTruncated || undefined,
      authFailure: ctx.authFailure,
    });
  }
}

/**
 * End a connection after its last response has been handed to the OS. Reading (and discarding) what the peer still
 * sends lets its FIN arrive so the close completes; closing with unread data would reset the connection and could
 * lose the response. A peer that never closes is cut off after a short wait.
 */
function closeSoon(socket: Duplex): void {
  socket.resume();
  socket.end();
  const timer = setTimeout(() => socket.destroy(), 2_000);
  timer.unref();
  socket.once('close', () => clearTimeout(timer));
}

/** Resolves when the client has taken what it was sent, has gone, or has taken nothing for `stallMs`. */
function waitForDrain(res: ServerResponse, stallMs: number): Promise<'drained' | 'closed' | 'stalled'> {
  return new Promise((resolve) => {
    const done = (outcome: 'drained' | 'closed' | 'stalled'): void => {
      clearTimeout(timer);
      res.off('drain', onDrain);
      res.off('close', onClose);
      resolve(outcome);
    };
    const onDrain = (): void => done('drained');
    const onClose = (): void => done('closed');
    const timer = setTimeout(() => done('stalled'), stallMs);
    res.once('drain', onDrain);
    res.once('close', onClose);
  });
}

function readFileOrFail(setting: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ConfigError(`${setting}: cannot read "${path}": ${(error as Error).message}`);
  }
}

/** Read the listener's certificate and key, and check they are a usable pair, before anything is swapped. */
function readTlsMaterial(tls: NonNullable<GatewayConfig['tls']>): TlsMaterial {
  const cert = readFileOrFail('tls.certFile', tls.certFile);
  const key = readFileOrFail('tls.keyFile', tls.keyFile);
  try {
    // Builds a context from the pair, which fails for a mismatched key, a bad passphrase or garbage PEM.
    createSecureContext({ cert, key, passphrase: tls.passphrase });
  } catch (error) {
    throw new ConfigError(`tls: the certificate and key are not a usable pair: ${(error as Error).message}`);
  }
  const material: TlsMaterial = {
    cert,
    key,
    passphrase: tls.passphrase,
    notAfter: new X509Certificate(cert).validToDate,
  };
  if (tls.clientAuth) {
    const ca = readFileOrFail('tls.clientAuth.caFile', tls.clientAuth.caFile);
    const crl = tls.clientAuth.crlFile ? readFileOrFail('tls.clientAuth.crlFile', tls.clientAuth.crlFile) : undefined;
    try {
      new X509Certificate(ca); // at least one certificate, not an empty or unrelated file
      createSecureContext({ ca, crl }); // and a revocation list OpenSSL can read
    } catch (error) {
      throw new ConfigError(
        `tls.clientAuth: the CA bundle or revocation list cannot be used: ${(error as Error).message}`,
      );
    }
    Object.assign(material, { clientCa: ca, crl });
  }
  return material;
}

/** The distinguished name of a certificate's subject or issuer, written out (for identities and logs). */
function distinguishedName(name: Record<string, string | string[]> | undefined): string {
  return Object.entries(name ?? {})
    .map(([attribute, value]) => `${attribute}=${[value].flat().join('+')}`)
    .join(',');
}

/** What an upstream's TLS settings point at, read once per configuration. */
interface UpstreamTlsMaterial {
  ca?: Buffer;
  /** The client certificate presented for mutual TLS, with its key. */
  cert?: Buffer;
  key?: Buffer;
  passphrase?: string;
}

function readUpstreamTls(name: string, upstream: UpstreamConfig): UpstreamTlsMaterial | undefined {
  const tls = upstream.tls;
  if (!tls) return undefined;
  const material: UpstreamTlsMaterial = {};
  if (tls.caFile) material.ca = readFileOrFail(`upstreams.${name}.tls.caFile`, tls.caFile);
  if (tls.certFile && tls.keyFile) {
    const cert = readFileOrFail(`upstreams.${name}.tls.certFile`, tls.certFile);
    const key = readFileOrFail(`upstreams.${name}.tls.keyFile`, tls.keyFile);
    try {
      // Fails for a key that does not match, a wrong or missing passphrase, or something that is not PEM at all.
      createSecureContext({ cert, key, passphrase: tls.passphrase });
    } catch (error) {
      throw new ConfigError(
        `upstreams.${name}.tls: the client certificate and key are not a usable pair: ${(error as Error).message}`,
      );
    }
    Object.assign(material, { cert, key, passphrase: tls.passphrase });
  }
  return material;
}

/** An upstream's definition plus the contents of the files it uses: equal fingerprints mean nothing changed. */
function upstreamFingerprint(upstream: UpstreamConfig, material: UpstreamTlsMaterial | undefined): string {
  const hash = createHash('sha256').update(JSON.stringify(upstream));
  for (const value of Object.values(material ?? {})) {
    if (value !== undefined) hash.update('\u0000').update(value);
  }
  return hash.digest('hex');
}

/** A failure of the upstream itself (as opposed to the client leaving), which a stale-if-error entry may cover. */
function isUpstreamFailure(error: unknown): boolean {
  return error instanceof CircuitOpenError || (error instanceof UpstreamError && error.kind !== 'aborted');
}

/** For calls nobody can cancel: a background refresh is bounded by its route's timeouts instead. */
const NEVER_ABORTED = new AbortController().signal;

/** The entries of `obj` that are set: optional settings a route leaves out must not erase its upstream's. */
function definedOnly<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The route id the per-address ceiling's limiter is filed under (a real route id is never empty). */
const IP_CEILING = '';

/** What identifies a limiter: its route, its rule, and the store settings it was built with. */
function limiterKey(config: GatewayConfig, routeId: string, rule: RateLimitRuleConfig): string {
  return [routeId, ruleFingerprint(rule), config.rateLimit.failureMode, config.redis?.keyPrefix ?? ''].join('\u0000');
}

/** `Retry-After` is either delta-seconds or an HTTP date. Returns ms, or undefined if absent/unparseable. */
export function parseRetryAfterMs(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** Deep equality for configuration values (plain JSON data, in schema order). */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Settings a running process cannot change: a reload keeps the values in force (and says which ones it kept), so the
 * runtime describes what is actually happening rather than what the file wishes.
 */
function keepFixed(current: GatewayConfig, next: GatewayConfig): { config: GatewayConfig; restartRequired: string[] } {
  const restartRequired: string[] = [];
  const config: GatewayConfig = { ...next };
  for (const key of ['port', 'host', 'redis', 'cluster'] as const) {
    if (!same(current[key], next[key])) {
      restartRequired.push(key);
      Object.assign(config, { [key]: current[key] });
    }
  }
  // The certificate, key, minimum version and HSTS can change; whether the listener speaks TLS at all cannot.
  if ((current.tls === undefined) !== (next.tls === undefined)) {
    restartRequired.push('tls');
    config.tls = current.tls;
  }
  // Whether the listener asks for client certificates, and refuses connections without one, is settled when it is
  // created; the CA bundle, revocation list and allowed names can change.
  const was = current.tls?.clientAuth;
  const will = config.tls?.clientAuth;
  if (config.tls && ((was === undefined) !== (will === undefined) || (was && will && was.required !== will.required))) {
    restartRequired.push('tls.clientAuth');
    config.tls = { ...config.tls, clientAuth: was && (will ? { ...will, required: was.required } : was) };
  }
  // The admin listener is bound once; its token can change.
  const { admin } = current;
  if (admin.enabled !== next.admin.enabled || admin.host !== next.admin.host || admin.port !== next.admin.port) {
    restartRequired.push('admin');
    config.admin = { ...next.admin, enabled: admin.enabled, host: admin.host, port: admin.port };
  }
  if (current.limits.maxHeaderBytes !== next.limits.maxHeaderBytes) {
    restartRequired.push('limits.maxHeaderBytes');
    config.limits = { ...next.limits, maxHeaderBytes: current.limits.maxHeaderBytes };
  }
  return { config, restartRequired };
}

/** The top-level sections that differ between two configurations, for the reload log. */
function changedSections(before: GatewayConfig, after: GatewayConfig): string[] {
  return (Object.keys(after) as Array<keyof GatewayConfig>).filter((key) => !same(before[key], after[key]));
}

/**
 * Every limiter a configuration can reach: each route's rule under every multiplier a caller can have (1, the
 * anonymous multiplier, each plan's), each key's per-route overrides, and the per-address ceiling. Anything else in
 * the limiter cache belongs to a configuration that is gone.
 */
function reachableLimiterKeys(config: GatewayConfig): Set<string> {
  const rl = config.rateLimit;
  const multipliers = new Set([1, rl.anonymousMultiplier, ...Object.values(rl.plans).map((plan) => plan.multiplier)]);
  const keys = new Set<string>();
  for (const route of config.routes) {
    const routeId = route.id ?? route.path;
    const base = route.rateLimit === undefined ? rl.default : route.rateLimit || undefined;
    if (base) for (const multiplier of multipliers) keys.add(limiterKey(config, routeId, scaleRule(base, multiplier)));
    for (const key of rl.apiKeys) {
      const override = key.overrides?.[routeId];
      if (override) keys.add(limiterKey(config, routeId, override));
    }
  }
  if (rl.ip) keys.add(limiterKey(config, IP_CEILING, rl.ip));
  return keys;
}
