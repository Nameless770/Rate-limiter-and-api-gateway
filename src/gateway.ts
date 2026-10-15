import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Redis } from 'ioredis';
import { requestCacheInfo, requestIsCacheSafe, storeDecision } from './cache/policy.js';
import { type CachedResponse, ResponseCache } from './cache/responseCache.js';
import {
  ConfigError,
  type GatewayConfig,
  type RateLimitRuleConfig,
  type RouteConfig,
  type UpstreamConfig,
} from './config.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Registry } from './observability/metrics.js';
import { sanitizeRequestId, stripHopByHop } from './proxy/headers.js';
import { UpstreamClient, UpstreamError, type UpstreamResponse } from './proxy/upstream.js';
import { memorySlidingWindow, memoryTokenBucket } from './ratelimit/memory.js';
import { RedisSlidingWindow, RedisTokenBucket } from './ratelimit/redis.js';
import { ResilientRateLimiter } from './ratelimit/resilient.js';
import {
  algorithmTag,
  type Clock,
  type RateLimitDecision,
  type RateLimiter,
  RateLimiterUnavailableError,
} from './ratelimit/types.js';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from './resilience/circuitBreaker.js';
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

interface UpstreamRuntime {
  name: string;
  config: UpstreamConfig;
  client: UpstreamClient;
  breaker: CircuitBreaker;
}

interface RouteLimiter {
  limiter: RateLimiter;
  rule: RateLimitRuleConfig;
  tag: 'tb' | 'sw';
}

interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  route: string;
  cache?: 'HIT' | 'MISS' | 'BYPASS';
  attempts: number;
  rateLimited: boolean;
  degraded: boolean;
  started: number;
  /** The client disconnected before its response was complete. */
  clientGone: boolean;
  /** The upstream died mid-body, so the client got a truncated (deliberately broken) response. */
  upstreamTruncated: boolean;
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

export class Gateway {
  readonly server: http.Server;
  readonly metrics = new Registry();
  readonly cache: ResponseCache;

  private readonly router: Router;
  private readonly upstreams = new Map<string, UpstreamRuntime>();
  private readonly limiters = new Map<string, RouteLimiter>();
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly redis?: Redis;
  private readonly startedAt: number;
  private closing = false;
  /** Responses still in progress, so shutdown can ask them not to keep their connection alive. */
  private readonly active = new Set<ServerResponse>();

  private readonly mRequests = this.metrics.counter('gateway_requests_total', 'Requests handled, by route and status.');
  private readonly mRateLimited = this.metrics.counter('gateway_rate_limited_total', 'Requests rejected with 429.');
  private readonly mDegraded = this.metrics.counter(
    'gateway_ratelimit_degraded_total',
    'Rate-limit decisions made without the primary store.',
  );
  private readonly mCache = this.metrics.counter('gateway_cache_requests_total', 'Cache outcomes by route.');
  private readonly mAttempts = this.metrics.counter('gateway_upstream_attempts_total', 'Upstream attempts by outcome.');
  private readonly mTransitions = this.metrics.counter('gateway_circuit_transitions_total', 'Circuit state changes.');
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

    this.cache = new ResponseCache({ ...config.cache, clock: this.clock });
    this.router = new Router(config.routes);

    for (const [name, upstreamConfig] of Object.entries(config.upstreams)) {
      this.upstreams.set(name, {
        name,
        config: upstreamConfig,
        client: new UpstreamClient(upstreamConfig.url, {
          timeoutMs: upstreamConfig.timeoutMs,
          ca: upstreamConfig.tls ? readCaFile(name, upstreamConfig.tls.caFile) : undefined,
        }),
        breaker: new CircuitBreaker({
          ...upstreamConfig.breaker,
          clock: this.clock,
          onStateChange: (from, to) => {
            this.mTransitions.inc({ upstream: name, to });
            this.logger.warn('circuit state change', { upstream: name, from, to });
          },
        }),
      });
    }

    for (const route of config.routes) {
      const rule = route.rateLimit === undefined ? config.rateLimit.default : route.rateLimit || undefined;
      if (!rule) continue;
      const routeId = route.id ?? route.path;
      this.limiters.set(routeId, { limiter: this.buildLimiter(routeId, rule), rule, tag: algorithmTag(rule) });
    }

    this.registerGauges();

    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.server.headersTimeout = 15_000;
    this.server.requestTimeout = 60_000;
    this.server.keepAliveTimeout = 65_000;
  }

  listen(port = this.config.port, host = this.config.host): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address() as AddressInfo);
      });
    });
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

    for (const { client } of this.upstreams.values()) client.close();
    await Promise.all([...this.limiters.values()].map(({ limiter }) => limiter.close?.()));
  }

  /** Circuit state per upstream (used by /_gateway/health and tests). */
  circuit(name: string): CircuitBreaker | undefined {
    return this.upstreams.get(name)?.breaker;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Construction helpers
  // ------------------------------------------------------------------------------------------------------------------

  private buildLimiter(routeId: string, rule: RateLimitRuleConfig): RateLimiter {
    const mode = this.config.rateLimit.failureMode;
    const makeLocal = (): RateLimiter =>
      rule.algorithm === 'token-bucket'
        ? memoryTokenBucket({ capacity: rule.capacity, refillPerSecond: rule.refillPerSecond }, { clock: this.clock })
        : memorySlidingWindow({ limit: rule.limit, windowMs: rule.windowMs }, { clock: this.clock });

    if (!this.redis) return makeLocal();

    const keyPrefix = this.config.redis?.keyPrefix ?? 'gw:';
    const primary =
      rule.algorithm === 'token-bucket'
        ? new RedisTokenBucket(
            this.redis,
            { capacity: rule.capacity, refillPerSecond: rule.refillPerSecond },
            { keyPrefix },
          )
        : new RedisSlidingWindow(this.redis, { limit: rule.limit, windowMs: rule.windowMs }, { keyPrefix });

    return new ResilientRateLimiter(primary, {
      mode,
      fallback: mode === 'local' ? makeLocal() : undefined,
      limit: rule.algorithm === 'token-bucket' ? rule.capacity : rule.limit,
      breakerOptions: { clock: this.clock },
      onError: (error) =>
        this.logger.warn('rate limit store error', { route: routeId, error: (error as Error).message }),
    });
  }

  private registerGauges(): void {
    this.metrics.gauge(
      'gateway_circuit_state',
      'Circuit breaker state per upstream (0 closed, 1 half-open, 2 open).',
      () =>
        [...this.upstreams.values()].map((u) => ({
          labels: { upstream: u.name },
          value: CIRCUIT_VALUE[u.breaker.state],
        })),
    );
    this.metrics.gauge('gateway_cache_entries', 'Entries held in the response cache.', () => [
      { labels: {}, value: this.cache.stats().entries },
    ]);
    this.metrics.gauge('gateway_cache_bytes', 'Bytes held in the response cache.', () => [
      { labels: {}, value: this.cache.stats().bytes },
    ]);
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
    };
    res.setHeader('x-request-id', requestId);
    if (this.closing) res.setHeader('connection', 'close');
    this.active.add(res);
    res.once('close', () => {
      this.active.delete(res);
      if (!res.writableFinished) ctx.clientGone = true;
      this.finish(res, ctx);
    });

    try {
      await this.dispatch(req, res, ctx);
    } catch (error) {
      this.fail(res, ctx, error);
    }
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, ctx: RequestContext): Promise<void> {
    // Parsing against a dummy base normalizes dot-segments, so "/users/../admin" can't dodge route matching,
    // and an absolute-form request target can't change where we send the request (only the path is used).
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://gateway.invalid');
    } catch {
      return this.sendError(res, ctx, 400, 'bad_request', 'malformed request target');
    }
    ctx.path = url.pathname;

    if (url.pathname.startsWith('/_gateway/')) return this.admin(url.pathname, res, ctx);

    const match = this.router.match(url.pathname, ctx.method);
    if (!match) return this.sendError(res, ctx, 404, 'route_not_found', `no route for ${ctx.method} ${url.pathname}`);
    ctx.route = match.routeId;

    if (!(await this.admitted(req, res, ctx, match.routeId))) return;

    const body = await this.readBody(req);
    const upstream = this.upstreams.get(match.route.upstream) as UpstreamRuntime;
    const upstreamPath = upstream.client.resolvePath(match.upstreamPath + url.search);

    const cacheConfig = match.route.cache;
    if (cacheConfig && ctx.method === 'GET') {
      const info = requestCacheInfo(req.headers);
      if (!info.noStore && requestIsCacheSafe(req.headers, cacheConfig.varyHeaders)) {
        await this.cachedGet(req, res, ctx, match.route, upstream, upstreamPath, url, info.noCache);
        return;
      }
      ctx.cache = 'BYPASS';
      res.setHeader('x-cache', 'BYPASS');
    }

    await this.forward(req, res, ctx, upstream, upstreamPath, body);
  }

  /** Rate limiting. Returns false if the request was rejected (response already sent). */
  private async admitted(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    routeId: string,
  ): Promise<boolean> {
    const entry = this.limiters.get(routeId);
    if (!entry) return true;

    const key = `rl:${entry.tag}:${routeId}:${this.identify(req)}`;
    const decision: RateLimitDecision = await entry.limiter.consume(key);

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

    ctx.rateLimited = true;
    this.mRateLimited.inc({ route: routeId });
    const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
    this.sendError(res, ctx, 429, 'rate_limited', 'rate limit exceeded', { 'retry-after': retryAfter });
    return false;
  }

  private identify(req: IncomingMessage): string {
    const header = req.headers[this.config.rateLimit.identityHeader];
    const apiKey = Array.isArray(header) ? header[0] : header;
    // Hash so raw credentials never become Redis keys (visible via KEYS/MONITOR) and key length stays bounded.
    if (apiKey) return `k:${createHash('sha256').update(apiKey).digest('hex').slice(0, 32)}`;
    return `ip:${this.clientIp(req)}`;
  }

  private clientIp(req: IncomingMessage): string {
    const hops = this.config.rateLimit.trustedProxyHops;
    if (hops > 0) {
      const raw = req.headers['x-forwarded-for'];
      const parts = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const candidate = parts[parts.length - hops];
      if (candidate) return candidate;
    }
    return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
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
    upstreamPath: string,
    url: URL,
    skipLookup: boolean,
  ): Promise<void> {
    const cacheConfig = route.cache as NonNullable<RouteConfig['cache']>;
    const varied = cacheConfig.varyHeaders.map((h) => String(req.headers[h] ?? '')).join('\u0000');
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
        const outcome = await this.forward(req, res, ctx, upstream, upstreamPath, undefined, store);
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
  // Forwarding: breaker + retry + relay
  // ------------------------------------------------------------------------------------------------------------------

  private async forward(
    req: IncomingMessage,
    res: ServerResponse,
    ctx: RequestContext,
    upstream: UpstreamRuntime,
    upstreamPath: string,
    body: Buffer | undefined,
    store?: StoreOptions,
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

    const headers = this.upstreamHeaders(req, ctx, upstream, body, store !== undefined);

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
          const permit = upstream.breaker.tryAcquire();
          if (!permit) throw new CircuitOpenError(upstream.breaker.snapshot().retryAfterMs);
          ctx.attempts++;
          try {
            const result = await upstream.client.request({
              method: ctx.method,
              path: upstreamPath,
              headers,
              body,
              signal: abort.signal,
              timeoutMs: Math.max(1, Math.min(upstream.config.timeoutMs, budgetLeftMs())),
            });
            const failed = result.status >= 500;
            if (failed) permit.failure();
            else permit.success();
            this.mAttempts.inc({ upstream: upstream.name, outcome: failed ? 'status_5xx' : 'ok' });
            return result;
          } catch (error) {
            const aborted = error instanceof UpstreamError && error.kind === 'aborted';
            if (aborted) permit.release();
            else permit.failure();
            this.mAttempts.inc({
              upstream: upstream.name,
              outcome: error instanceof UpstreamError ? error.kind : 'error',
            });
            throw error;
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

  private upstreamHeaders(
    req: IncomingMessage,
    ctx: RequestContext,
    upstream: UpstreamRuntime,
    body: Buffer | undefined,
    cacheable: boolean,
  ): Record<string, string | string[]> {
    const headers = stripHopByHop(req.headers);
    headers['host'] = upstream.client.host;
    headers['x-request-id'] = ctx.requestId;

    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    const priorFor = req.headers['x-forwarded-for'];
    headers['x-forwarded-for'] = [Array.isArray(priorFor) ? priorFor.join(', ') : priorFor, remote]
      .filter(Boolean)
      .join(', ');
    if (req.headers['host']) headers['x-forwarded-host'] = String(req.headers['host']);
    headers['x-forwarded-proto'] ??= 'http';

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
    delete entryHeaders['age'];
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
  private readBody(req: IncomingMessage): Promise<Buffer | undefined> {
    const limit = this.config.maxBodyBytes;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) return Promise.reject(new PayloadTooLargeError(limit));
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
        if (size <= limit) {
          chunks.push(chunk);
          return;
        }
        // Stop reading (the 413 carries Connection: close, so the rest of the upload is never processed).
        cleanup();
        req.pause();
        reject(new PayloadTooLargeError(limit));
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
      ...headers,
    });
    res.end(payload);
  }

  private fail(res: ServerResponse, ctx: RequestContext, error: unknown): void {
    if (error instanceof ClientAbortedError) return; // nobody left to answer
    if (error instanceof PayloadTooLargeError) {
      this.sendError(res, ctx, 413, 'payload_too_large', error.message, { connection: 'close' });
    } else if (error instanceof RateLimiterUnavailableError) {
      this.sendError(res, ctx, 503, 'rate_limiter_unavailable', 'rate limiting is temporarily unavailable', {
        'retry-after': 1,
      });
    } else if (error instanceof CircuitOpenError) {
      const retryAfter = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
      this.sendError(res, ctx, 503, 'upstream_unavailable', 'upstream is failing; circuit breaker is open', {
        'retry-after': retryAfter,
      });
    } else if (error instanceof UpstreamError) {
      if (error.kind === 'aborted') return; // client is gone; nobody to answer
      if (error.kind === 'timeout') this.sendError(res, ctx, 504, 'upstream_timeout', error.message);
      else this.sendError(res, ctx, 502, 'bad_gateway', error.message);
    } else {
      this.logger.error('unhandled error', {
        requestId: ctx.requestId,
        error: (error as Error)?.stack ?? String(error),
      });
      this.sendError(res, ctx, 500, 'internal_error', 'internal server error');
    }
  }

  private admin(pathname: string, res: ServerResponse, ctx: RequestContext): void {
    ctx.route = 'admin';
    if (pathname === '/_gateway/metrics') {
      const body = this.metrics.render();
      res.writeHead(200, {
        'content-type': 'text/plain; version=0.0.4; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (pathname === '/_gateway/health') {
      const upstreams: Record<string, unknown> = {};
      for (const u of this.upstreams.values()) upstreams[u.name] = u.breaker.snapshot();
      const payload = JSON.stringify({
        status: 'ok',
        uptimeSeconds: Math.floor((this.clock() - this.startedAt) / 1000),
        redis: this.redis ? this.redis.status : 'disabled',
        upstreams,
        cache: this.cache.stats(),
      });
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
      return;
    }
    this.sendError(res, ctx, 404, 'route_not_found', 'unknown admin endpoint');
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
      cache: ctx.cache,
      attempts: ctx.attempts || undefined,
      rateLimited: ctx.rateLimited || undefined,
      degraded: ctx.degraded || undefined,
      truncated: ctx.upstreamTruncated || undefined,
    });
  }
}

function readCaFile(upstream: string, path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new ConfigError(`upstreams.${upstream}.tls.caFile: cannot read "${path}": ${(error as Error).message}`);
  }
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

/** `Retry-After` is either delta-seconds or an HTTP date. Returns ms, or undefined if absent/unparseable. */
export function parseRetryAfterMs(value: string | string[] | undefined, now = Date.now()): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  if (/^\d+$/.test(raw.trim())) return Number(raw) * 1000;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
