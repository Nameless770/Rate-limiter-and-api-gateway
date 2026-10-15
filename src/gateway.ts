import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Redis } from 'ioredis';
import { requestCacheInfo, requestIsCacheSafe, storeDecision } from './cache/policy.js';
import { type CachedResponse, ResponseCache } from './cache/responseCache.js';
import {
  ConfigError,
  type GatewayConfig,
  type RateLimitRuleConfig,
  type RouteConfig,
  type UpstreamConfig,
  upstreamTargets,
} from './config.js';
import { normalizeIp } from './net/ip.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Registry } from './observability/metrics.js';
import { registerProcessMetrics } from './observability/process.js';
import { sanitizeRequestId, stripHopByHop } from './proxy/headers.js';
import { UpstreamClient, UpstreamError, type UpstreamResponse } from './proxy/upstream.js';
import { type Identity, IdentityResolver, ruleFingerprint, scaleRule } from './ratelimit/identity.js';
import { memorySlidingWindow, memorySlidingWindowCounter, memoryTokenBucket } from './ratelimit/memory.js';
import { RedisSlidingWindow, RedisSlidingWindowCounter, RedisTokenBucket } from './ratelimit/redis.js';
import { ResilientRateLimiter } from './ratelimit/resilient.js';
import {
  algorithmTag,
  type Clock,
  type RateLimitDecision,
  type RateLimiter,
  RateLimiterUnavailableError,
} from './ratelimit/types.js';
import { CircuitBreaker, CircuitOpenError, type CircuitState, type Permit } from './resilience/circuitBreaker.js';
import { retry } from './resilience/retry.js';
import { Router } from './router.js';

export interface GatewayDeps {
  logger?: Logger;
  clock?: Clock;
  /** Connected ioredis client. Without one, rate limiting is in-memory (single instance only). */
  redis?: Redis;
  /** Test seams for deterministic retry timing. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

interface Target {
  /** Stable label for metrics and health output (host:port). */
  id: string;
  client: UpstreamClient;
  breaker: CircuitBreaker;
  /** Requests sent to this target that have not yet received response headers. */
  pending: number;
}

interface UpstreamRuntime {
  name: string;
  config: UpstreamConfig;
  targets: Target[];
  /** Rotates so equal-load targets take turns. */
  cursor: number;
}

interface RouteLimiter {
  limiter: RateLimiter;
  tag: string;
}

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  route: string;
  upstream?: string;
  /** Name of the registered API key, when there is one (never the key itself). */
  client?: string;
  cache?: 'HIT' | 'MISS' | 'BYPASS';
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
}

interface StoreOptions {
  key: string;
  /** Freshness lifetime when the upstream gives no explicit directive. */
  ttlMs: number;
  requestHeaders: IncomingHttpHeaders;
}

interface RelayOutcome {
  /** The cache entry stored from this response, if any. */
  entry?: CachedResponse;
  /** The client went away before the response was fully delivered. */
  clientGone: boolean;
}

/** What a coalesced cache fetch hands to the requests waiting on it. */
type FlightResult =
  /** Stored: waiters can be served the entry. */
  | { kind: 'stored'; entry: CachedResponse }
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
  readonly server: http.Server;
  readonly adminServer: http.Server;
  readonly metrics = new Registry();
  readonly cache: ResponseCache;
  /** Where the admin listener is bound, once listen() has run (and the admin listener is enabled). */
  adminAddress?: AddressInfo;

  private readonly router: Router;
  private readonly upstreams = new Map<string, UpstreamRuntime>();
  private readonly routeRules = new Map<string, RateLimitRuleConfig | undefined>();
  private readonly limiterCache = new Map<string, RouteLimiter>();
  private readonly ipCeiling?: RouteLimiter;
  private readonly identities: IdentityResolver;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly redis?: Redis;
  private readonly startedAt: number;
  private readonly allowedMethods: Set<string>;
  private readonly maxConnectionsPerIp: number;
  private readonly adminTokenDigest?: Buffer;
  private readonly stopProcessMetrics: () => void;
  private closing = false;
  /** Responses still in progress, so shutdown can ask them not to keep their connection alive. */
  private readonly active = new Set<ServerResponse>();
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
  private readonly mAttempts = this.metrics.counter(
    'gateway_upstream_attempts_total',
    'Upstream attempts by target and outcome.',
  );
  private readonly mTransitions = this.metrics.counter('gateway_circuit_transitions_total', 'Circuit state changes.');
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
  private readonly mLatency = this.metrics.histogram(
    'gateway_request_duration_seconds',
    'End-to-end request latency.',
    LATENCY_BUCKETS,
  );

  constructor(
    private readonly config: GatewayConfig,
    private readonly deps: GatewayDeps = {},
  ) {
    this.logger = deps.logger ?? createLogger('info');
    this.clock = deps.clock ?? Date.now;
    this.redis = deps.redis;
    this.startedAt = this.clock();
    this.allowedMethods = new Set(config.allowedMethods);
    this.identities = new IdentityResolver(config.rateLimit);
    this.maxConnectionsPerIp = config.limits.maxConnectionsPerIp ?? (config.rateLimit.trustedProxyHops === 0 ? 256 : 0);
    if (config.admin.token !== undefined) {
      this.adminTokenDigest = createHash('sha256').update(config.admin.token).digest();
    }

    this.cache = new ResponseCache({ ...config.cache, clock: this.clock });
    this.router = new Router(config.routes);

    for (const [name, upstreamConfig] of Object.entries(config.upstreams)) {
      const ca = upstreamConfig.tls ? readCaFile(`upstreams.${name}.tls.caFile`, upstreamConfig.tls.caFile) : undefined;
      const urls = upstreamTargets(upstreamConfig);
      const targets = urls.map((url, index): Target => {
        const host = new URL(url).host;
        // Two targets on one host:port (different base paths) still need distinct labels.
        const id = urls.some((other, j) => j !== index && new URL(other).host === host) ? `${host}#${index}` : host;
        return {
          id,
          pending: 0,
          client: new UpstreamClient(url, {
            timeoutMs: upstreamConfig.timeoutMs,
            maxConnections: upstreamConfig.maxConnections,
            ca,
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
      this.upstreams.set(name, { name, config: upstreamConfig, targets, cursor: 0 });
    }

    for (const route of config.routes) {
      const rule = route.rateLimit === undefined ? config.rateLimit.default : route.rateLimit || undefined;
      this.routeRules.set(route.id ?? route.path, rule);
    }
    if (config.rateLimit.ip) {
      this.ipCeiling = this.makeLimiter('client address', config.rateLimit.ip);
    }

    this.registerGauges();
    this.stopProcessMetrics = registerProcessMetrics(this.metrics);

    const { limits } = config;
    this.server = http.createServer(
      {
        maxHeaderSize: limits.maxHeaderBytes,
        // Node only enforces headersTimeout/requestTimeout when it sweeps connections; sweep often enough that
        // a slow client is cut off close to the configured time rather than up to 30s later.
        connectionsCheckingInterval: Math.min(1_000, limits.headersTimeoutMs),
      },
      (req, res) => {
        void this.handle(req, res);
      },
    );
    this.server.maxConnections = limits.maxConnections;
    this.server.headersTimeout = limits.headersTimeoutMs;
    this.server.requestTimeout = limits.requestTimeoutMs;
    this.server.keepAliveTimeout = limits.keepAliveTimeoutMs;
    this.server.on('connection', (socket) => this.trackConnection(socket));

    this.adminServer = http.createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => this.handleAdmin(req, res));
    this.adminServer.headersTimeout = 5_000;
    this.adminServer.requestTimeout = 10_000;
  }

  async listen(port = this.config.port, host = this.config.host): Promise<AddressInfo> {
    const main = await listenOn(this.server, port, host);
    if (this.config.admin.enabled) {
      try {
        this.adminAddress = await listenOn(this.adminServer, this.config.admin.port, this.config.admin.host);
      } catch (error) {
        this.server.close();
        throw error;
      }
    }
    return main;
  }

  /** Stop accepting connections, let in-flight requests finish (up to the grace period), then release resources. */
  async close(graceMs = this.config.shutdownGraceMs): Promise<void> {
    this.closing = true;
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

    if (this.adminServer.listening) {
      await new Promise<void>((resolve) => {
        this.adminServer.close(() => resolve());
        this.adminServer.closeAllConnections();
      });
    }
    this.stopProcessMetrics();

    for (const { targets } of this.upstreams.values()) for (const target of targets) target.client.close();
    const limiters = [...this.limiterCache.values(), ...(this.ipCeiling ? [this.ipCeiling] : [])];
    await Promise.all(limiters.map(({ limiter }) => limiter.close?.()));
  }

  /** Circuit breaker of an upstream's first target (the only one unless the upstream has several `urls`). */
  circuit(name: string): CircuitBreaker | undefined {
    return this.upstreams.get(name)?.targets[0]?.breaker;
  }

  /** Circuit breakers by target id. */
  circuits(name: string): Record<string, CircuitBreaker> {
    const out: Record<string, CircuitBreaker> = {};
    for (const target of this.upstreams.get(name)?.targets ?? []) out[target.id] = target.breaker;
    return out;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Construction helpers
  // ------------------------------------------------------------------------------------------------------------------

  private makeLimiter(label: string, rule: RateLimitRuleConfig): RouteLimiter {
    const mode = this.config.rateLimit.failureMode;
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

    const keyPrefix = this.config.redis?.keyPrefix ?? 'gw:';
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

  /** One limiter per distinct (route, rule), created on first use. Rules come only from config, so this is bounded. */
  private limiterFor(routeId: string, rule: RateLimitRuleConfig): RouteLimiter {
    const cacheKey = `${routeId}\u0000${ruleFingerprint(rule)}`;
    let entry = this.limiterCache.get(cacheKey);
    if (!entry) {
      entry = this.makeLimiter(`route ${routeId}`, rule);
      this.limiterCache.set(cacheKey, entry);
    }
    return entry;
  }

  /** The rule that governs this caller on this route, or undefined if they are unlimited there. */
  private effectiveRule(routeId: string, identity: Identity): RateLimitRuleConfig | undefined {
    const override = identity.overrides?.[routeId];
    if (override === false) return undefined;
    if (override) return override;
    const base = this.routeRules.get(routeId);
    return base ? scaleRule(base, identity.multiplier) : undefined;
  }

  private registerGauges(): void {
    this.metrics.gauge(
      'gateway_circuit_state',
      'Circuit breaker state per upstream target (0 closed, 1 half-open, 2 open).',
      () =>
        [...this.upstreams.values()].flatMap((u) =>
          u.targets.map((t) => ({
            labels: { upstream: u.name, target: t.id },
            value: CIRCUIT_VALUE[t.breaker.state],
          })),
        ),
    );
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

    const max = this.maxConnectionsPerIp;
    if (max === 0) return;
    const ip = normalizeIp(socket.remoteAddress, this.config.rateLimit.ipv6Prefix) ?? 'unknown';
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = sanitizeRequestId(req.headers['x-request-id']) ?? randomUUID();
    const ctx: RequestContext = {
      requestId,
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
    res.setHeader('x-request-id', requestId);
    if (this.closing) res.setHeader('connection', 'close');

    const shed = this.active.size >= this.config.limits.maxInFlight;
    this.active.add(res);
    res.once('close', () => {
      this.active.delete(res);
      this.bufferedBytes -= ctx.buffered;
      if (!res.writableFinished) ctx.clientGone = true;
      this.finish(res, ctx);
    });

    try {
      if (shed) throw new OverloadedError('too many requests in flight');
      await this.dispatch(req, res, ctx);
    } catch (error) {
      this.fail(res, ctx, error);
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
    if (!this.allowedMethods.has(ctx.method)) {
      return this.sendError(res, ctx, 405, 'method_not_allowed', 'method not allowed', {
        allow: [...this.allowedMethods].join(', '),
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

    const match = this.router.match(url.pathname, ctx.method);
    if (!match) return this.sendError(res, ctx, 404, 'route_not_found', 'no route matches this request');
    ctx.route = match.routeId;

    if (!(await this.admitted(req, res, ctx, match.routeId))) return;

    const body = await this.readBody(req, ctx);
    const upstream = this.upstreams.get(match.route.upstream) as UpstreamRuntime;
    ctx.upstream = upstream.name;
    const relativePath = match.upstreamPath + url.search;

    const cacheConfig = match.route.cache;
    if (cacheConfig && ctx.method === 'GET') {
      const info = requestCacheInfo(req.headers);
      const keyed = [...new Set([...cacheConfig.varyHeaders, ...cacheConfig.forwardHeaders])];
      if (!info.noStore && requestIsCacheSafe(req.headers, keyed)) {
        await this.cachedGet(req, res, ctx, match.route, upstream, relativePath, url, keyed, info.noCache);
        return;
      }
      ctx.cache = 'BYPASS';
      res.setHeader('x-cache', 'BYPASS');
    }

    await this.forward(req, res, ctx, upstream, relativePath, body);
  }

  /** Authentication and rate limiting. Returns false if the request was rejected (response already sent). */
  private async admitted(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    routeId: string,
  ): Promise<boolean> {
    const ip = this.clientIp(req);
    const header = req.headers[this.config.rateLimit.identityHeader];
    const presented = Array.isArray(header) ? header[0] : header;

    const resolved = this.identities.resolve(presented || undefined, ip);
    if (!resolved.ok) {
      this.mUnauthorized.inc({ route: routeId });
      this.sendError(res, ctx, 401, 'unauthorized', 'a valid API key is required', { 'www-authenticate': 'ApiKey' });
      return false;
    }
    const { identity } = resolved;
    ctx.client = identity.name;

    // The address ceiling comes first: it is what bounds a client that rotates credentials, and a flood
    // should be turned away before it costs more than one counter update.
    let decision: RateLimitDecision | undefined;
    if (this.ipCeiling) {
      decision = await this.ipCeiling.limiter.consume(`rlip:${this.ipCeiling.tag}:${ip}`);
      if (!decision.allowed) return this.reject(res, ctx, routeId, decision);
    }

    const rule = this.effectiveRule(routeId, identity);
    if (rule) {
      const { limiter, tag } = this.limiterFor(routeId, rule);
      decision = await limiter.consume(`rl:${tag}:${routeId}:${identity.id}`);
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
  private clientIp(req: IncomingMessage): string {
    const { trustedProxyHops: hops, ipv6Prefix } = this.config.rateLimit;
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
    relativePath: string,
    url: URL,
    keyedHeaders: string[],
    skipLookup: boolean,
  ): Promise<void> {
    const cacheConfig = route.cache as NonNullable<RouteConfig['cache']>;
    const varied = keyedHeaders.map((h) => String(req.headers[h] ?? '')).join('\u0000');
    const key = `${upstream.name}\u0000${url.pathname}${url.search}\u0000${varied}`;

    if (!skipLookup) {
      const hit = this.cache.get(key, req.headers);
      if (hit) {
        this.serveEntry(res, ctx, hit);
        return;
      }
    }

    const store: StoreOptions = { key, ttlMs: cacheConfig.ttlMs, requestHeaders: req.headers };
    const fetchAndStore = async (): Promise<FlightResult> => {
      ctx.cache = 'MISS';
      res.setHeader('x-cache', 'MISS');
      try {
        const outcome = await this.forward(req, res, ctx, upstream, relativePath, undefined, store, keyedHeaders);
        if (outcome.entry) return { kind: 'stored', entry: outcome.entry };
        return outcome.clientGone ? { kind: 'abandoned' } : { kind: 'not-stored' };
      } catch (error) {
        if (error instanceof UpstreamError && error.kind === 'aborted') return { kind: 'abandoned' };
        throw error; // shared with every waiter: a failing upstream gets one request, not one per waiter
      }
    };

    // Concurrent misses for one key share a single upstream fetch. The leader streams the response to its
    // own client while storing it; the rest wait for the stored entry (or the shared error).
    for (;;) {
      let led = false;
      const { value } = await this.cache.singleFlight(key, () => {
        led = true;
        return fetchAndStore();
      });
      if (led || ctx.clientGone) return;

      if (value.kind === 'stored') {
        this.serveEntry(res, ctx, value.entry);
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

  private serveEntry(res: ServerResponse, ctx: RequestContext, entry: CachedResponse): void {
    ctx.cache = 'HIT';
    const age = Math.max(0, Math.floor((this.clock() - entry.storedAt) / 1000));
    res.writeHead(entry.status, { ...entry.headers, age: String(age), 'x-cache': 'HIT' });
    res.end(entry.body);
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

    const order = upstream.targets.map((_, i) => upstream.targets[(start + i) % n] as Target);
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
    relativePath: string,
    body: Buffer | undefined,
    store?: StoreOptions,
    forwardOnly?: string[],
  ): Promise<RelayOutcome> {
    const { retry: policy } = upstream.config;
    const retryStatuses = new Set(policy.retryOnStatus);
    const mayRetryUnsafe = IDEMPOTENT.has(ctx.method) || policy.retryNonIdempotent;

    // Abort in-flight work (including backoff sleeps) the moment the client goes away.
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableFinished) abort.abort();
    };
    res.once('close', onClose);

    const headers = this.upstreamHeaders(req, ctx, body, store !== undefined, forwardOnly);
    const tried = new Set<Target>();

    // Overall deadline across attempts and backoff sleeps (real time: it bounds how long a client waits).
    const { totalTimeoutMs } = upstream.config;
    const deadline = totalTimeoutMs === undefined ? undefined : performance.now() + totalTimeoutMs;
    const budgetLeftMs = (): number => (deadline === undefined ? Infinity : deadline - performance.now());

    try {
      const response = await retry(
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
          try {
            const result = await target.client.request({
              method: ctx.method,
              path: target.client.resolvePath(relativePath),
              headers: { ...headers, host: target.client.host },
              body,
              signal: abort.signal,
              timeoutMs: Math.max(1, Math.min(upstream.config.timeoutMs, budgetLeftMs())),
            });
            const failed = result.status >= 500;
            if (failed) permit.failure();
            else permit.success();
            this.mAttempts.inc({ upstream: upstream.name, target: target.id, outcome: failed ? 'status_5xx' : 'ok' });
            return result;
          } catch (error) {
            const aborted = error instanceof UpstreamError && error.kind === 'aborted';
            if (aborted) permit.release();
            else permit.failure();
            this.mAttempts.inc({
              upstream: upstream.name,
              target: target.id,
              outcome: error instanceof UpstreamError ? error.kind : 'error',
            });
            throw error;
          } finally {
            target.pending--;
          }
        },
        {
          maxAttempts: policy.maxAttempts,
          backoff: { baseDelayMs: policy.baseDelayMs, maxDelayMs: policy.maxDelayMs },
          signal: abort.signal,
          sleep: this.deps.sleep,
          random: this.deps.random,
          shouldRetry: (outcome) => {
            if (budgetLeftMs() < MIN_ATTEMPT_BUDGET_MS) return false;
            if (outcome.ok) return retryStatuses.has(outcome.value.status) && mayRetryUnsafe;
            const error = outcome.error;
            if (!(error instanceof UpstreamError)) return false;
            switch (error.kind) {
              case 'aborted': // the client left; nobody is waiting for the answer
              case 'tls': // a certificate problem won't fix itself between attempts
                return false;
              case 'connect': // nothing was sent, so even POST is safe to retry
                return true;
              default:
                return mayRetryUnsafe;
            }
          },
          retryAfterMs: (outcome) => (outcome.ok ? parseRetryAfterMs(outcome.value.headers['retry-after']) : undefined),
          discard: (value) => value.stream.resume(),
          onRetry: ({ attempt, delayMs, outcome }) =>
            this.logger.debug('retrying upstream call', {
              requestId: ctx.requestId,
              upstream: upstream.name,
              attempt,
              delayMs,
              reason: outcome.ok ? `status ${outcome.value.status}` : (outcome.error as Error).message,
            }),
        },
      );
      return await this.relay(res, ctx, response, store);
    } finally {
      res.off('close', onClose);
    }
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

    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (this.config.rateLimit.trustedProxyHops > 0) {
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
      headers['x-forwarded-proto'] = 'http'; // this listener is plain HTTP; TLS is terminated in front of it
      if (this.config.forwardedHost) headers['x-forwarded-host'] = this.config.forwardedHost;
    }
    headers['x-request-id'] = ctx.requestId;

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
    const decision = store ? storeDecision(up.status, up.headers, store.ttlMs) : undefined;
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
        if (!res.write(chunk)) await waitForDrain(res);
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

    const body = Buffer.concat(chunks);
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
    const entry: CachedResponse = {
      status: up.status,
      headers: entryHeaders,
      body,
      storedAt: now,
      expiresAt: now + decision.ttlMs,
      vary,
    };
    return { entry: this.cache.set(store.key, entry) ? entry : undefined, clientGone: false };
  }

  /**
   * Buffer the request body (so retries can replay it), enforcing maxBodyBytes even when the client sends no
   * Content-Length. Uses events rather than `for await`: breaking out of an async iterator destroys the
   * request, and with it the socket, before the 413 could be written.
   */
  private readBody(req: IncomingMessage, ctx: RequestContext): Promise<Buffer | undefined> {
    const limit = this.config.maxBodyBytes;
    const budget = this.config.limits.maxBufferedBytes;
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

  /** Admin listener: liveness is open, everything that exposes internals needs the token when one is set. */
  private handleAdmin(req: IncomingMessage, res: ServerResponse): void {
    const answer = this.routeAdmin(req);
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

  private routeAdmin(req: IncomingMessage): {
    status: number;
    body: unknown;
    contentType?: string;
    headers?: Record<string, string>;
  } {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return { status: 405, body: { error: { code: 'method_not_allowed' } }, headers: { allow: 'GET, HEAD' } };
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://admin.invalid').pathname;
    } catch {
      return { status: 400, body: { error: { code: 'bad_request' } } };
    }

    if (pathname === '/_gateway/live') return { status: 200, body: { status: 'ok' } };

    if (this.adminTokenDigest && !this.adminAuthorized(req)) {
      return { status: 401, body: { error: { code: 'unauthorized' } }, headers: { 'www-authenticate': 'Bearer' } };
    }

    if (pathname === '/_gateway/metrics') {
      return { status: 200, body: this.metrics.render(), contentType: 'text/plain; version=0.0.4; charset=utf-8' };
    }
    if (pathname === '/_gateway/health') {
      const upstreams: Record<string, unknown> = {};
      for (const u of this.upstreams.values()) {
        const targets = u.targets.map((t) => ({ id: t.id, pending: t.pending, ...t.breaker.snapshot() }));
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
        status: 200,
        body: {
          status: 'ok',
          uptimeSeconds: Math.floor((this.clock() - this.startedAt) / 1000),
          redis: this.redis ? this.redis.status : 'disabled',
          connections: this.connections,
          inFlight: this.active.size,
          upstreams,
          cache: this.cache.stats(),
        },
      };
    }
    return { status: 404, body: { error: { code: 'route_not_found' } } };
  }

  private adminAuthorized(req: IncomingMessage): boolean {
    const match = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '');
    if (!match || !this.adminTokenDigest) return false;
    const presented = createHash('sha256')
      .update(match[1] as string)
      .digest();
    return timingSafeEqual(presented, this.adminTokenDigest);
  }

  private finish(res: ServerResponse, ctx: RequestContext): void {
    // During shutdown, a connection whose response just completed is now idle: close it rather than wait.
    if (this.closing) this.server.closeIdleConnections();

    const durationMs = performance.now() - ctx.started;
    const completed = res.writableFinished;
    // An unfinished response is either a truncated upstream body (a gateway error) or the client leaving
    // (nginx's 499 "client closed request").
    const status = completed ? res.statusCode : ctx.upstreamTruncated ? 502 : 499;
    this.mRequests.inc({ route: ctx.route, status });
    this.mLatency.observe(durationMs / 1000, { route: ctx.route });
    if (ctx.cache) this.mCache.inc({ route: ctx.route, result: ctx.cache });
    this.logger.info('request', {
      requestId: ctx.requestId,
      method: ctx.method,
      path: ctx.path,
      route: ctx.route,
      status,
      durationMs: Math.round(durationMs * 10) / 10,
      client: ctx.client,
      cache: ctx.cache,
      attempts: ctx.attempts || undefined,
      rateLimited: ctx.rateLimited || undefined,
      degraded: ctx.degraded || undefined,
      truncated: ctx.upstreamTruncated || undefined,
    });
  }
}

function listenOn(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
}

function waitForDrain(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

function readCaFile(setting: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ConfigError(`${setting}: cannot read "${path}": ${(error as Error).message}`);
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. Returns ms, or undefined if absent/unparseable. */
export function parseRetryAfterMs(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
