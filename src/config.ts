import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isLoopbackHost } from './net/ip.js';

const positiveInt = z.number().int().positive();
const httpUrl = z.url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

export const rateLimitRuleSchema = z.discriminatedUnion('algorithm', [
  z.strictObject({
    algorithm: z.literal('token-bucket'),
    /** Burst size: the most requests that can be admitted back to back. */
    capacity: positiveInt,
    /** Sustained rate once the burst is spent. */
    refillPerSecond: z.number().positive(),
  }),
  z.strictObject({
    /** Exact: remembers every admitted request. O(limit) memory per key. */
    algorithm: z.literal('sliding-window'),
    limit: positiveInt,
    windowMs: positiveInt,
  }),
  z.strictObject({
    /** Approximate: two weighted fixed-window counters. O(1) memory per key, so suited to very high limits. */
    algorithm: z.literal('sliding-window-counter'),
    limit: positiveInt,
    windowMs: positiveInt,
  }),
]);

const breakerSchema = z.strictObject({
  failureRateThreshold: z.number().gt(0).max(1).default(0.5),
  minimumRequests: positiveInt.default(10),
  windowMs: positiveInt.default(10_000),
  openDurationMs: positiveInt.default(10_000),
  halfOpenMaxCalls: positiveInt.default(1),
  halfOpenSuccesses: positiveInt.default(2),
});

const retrySchema = z.strictObject({
  /** Total tries including the first. 1 disables retries. */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  baseDelayMs: z.number().int().min(0).default(100),
  maxDelayMs: positiveInt.default(2_000),
  retryOnStatus: z.array(z.number().int().min(100).max(599)).default([502, 503, 504]),
  /** POST/PATCH are not idempotent; retrying them can duplicate side effects. Opt in per upstream. */
  retryNonIdempotent: z.boolean().default(false),
});

/** Request headers a health probe may not set: they are about framing or routing, not about what to ask. */
const FORBIDDEN_PROBE_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection', 'upgrade']);

const healthCheckSchema = z.strictObject({
  /** Path to request on each target. Joined with the target's own base path. */
  path: z.string().startsWith('/'),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  intervalMs: positiveInt.default(5_000),
  /** A probe that takes longer than this counts as a failure. Keep it below intervalMs. */
  timeoutMs: positiveInt.default(2_000),
  /** Consecutive failed probes before a target is taken out of rotation. */
  unhealthyThreshold: positiveInt.default(2),
  /** Consecutive successful probes before it is put back. */
  healthyThreshold: positiveInt.default(2),
  /** Statuses that count as healthy. Default: any 2xx. */
  expectStatus: z.array(z.number().int().min(100).max(599)).min(1).optional(),
  /** Extra headers on every probe, e.g. a token the health endpoint expects. */
  headers: z
    .record(z.string().min(1), z.string())
    .default({})
    .superRefine((headers, ctx) => {
      for (const name of Object.keys(headers)) {
        if (FORBIDDEN_PROBE_HEADERS.has(name.toLowerCase())) {
          ctx.addIssue({ code: 'custom', path: [name], message: `"${name}" cannot be set on a health probe` });
        }
      }
    }),
});

const upstreamSchema = z
  .strictObject({
    /** A single backend. Use `urls` instead to spread load across several. Exactly one of the two. */
    url: httpUrl.optional(),
    /** Several interchangeable backends. Each gets its own circuit breaker, so one bad instance is ejected alone. */
    urls: z.array(httpUrl).min(1).max(64).optional(),
    /**
     * How requests are spread across `urls`. `round-robin` rotates; `least-pending` prefers the target with the
     * fewest requests in flight, which copes better when some instances are slower than others.
     */
    balance: z.enum(['round-robin', 'least-pending']).default('round-robin'),
    /** Per-attempt time to first byte, and idle time afterwards. */
    timeoutMs: positiveInt.default(5_000),
    /**
     * Most connections the gateway holds open to each target. It is also how you cap the load one gateway
     * instance can put on a backend: requests beyond it queue for a free connection (and count against
     * `timeoutMs`).
     */
    maxConnections: positiveInt.default(256),
    /**
     * Overall deadline across all attempts and backoff sleeps. Without it a request can take
     * maxAttempts x timeoutMs, which is usually longer than the client will wait and multiplies the load
     * on an upstream that is already struggling. Unset means attempts are only bounded individually.
     */
    totalTimeoutMs: positiveInt.optional(),
    retry: retrySchema.prefault({}),
    breaker: breakerSchema.prefault({}),
    /**
     * Probe each target on a schedule and take unhealthy ones out of rotation, so traffic avoids a down target
     * before any client request has to fail to find out. If every target is unhealthy the gateway ignores the
     * verdict and tries them anyway (a wrong health path must not be able to take a service offline).
     */
    healthCheck: healthCheckSchema.optional(),
    tls: z
      .strictObject({
        /**
         * PEM bundle for an upstream signed by a private CA (path relative to the working directory). It
         * replaces the default trust store for this upstream only. There is deliberately no option to skip
         * verification.
         */
        caFile: z.string().min(1),
      })
      .optional(),
  })
  .superRefine((upstream, ctx) => {
    if ((upstream.url === undefined) === (upstream.urls === undefined)) {
      ctx.addIssue({ code: 'custom', path: [], message: 'set exactly one of "url" or "urls"' });
      return;
    }
    const targets = upstreamTargets(upstream);
    if (upstream.healthCheck && upstream.healthCheck.timeoutMs >= upstream.healthCheck.intervalMs) {
      ctx.addIssue({
        code: 'custom',
        path: ['healthCheck', 'timeoutMs'],
        message: 'must be shorter than intervalMs, or probes would overlap',
      });
    }
    if (new Set(targets).size !== targets.length) {
      ctx.addIssue({ code: 'custom', path: ['urls'], message: 'urls must not contain duplicates' });
    }
    if (upstream.tls && !targets.every((t) => t.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['tls'],
        message: 'tls options require every target to be an https:// url',
      });
    }
  });

const routeCacheSchema = z.strictObject({
  /** Freshness lifetime used when the upstream doesn't send Cache-Control max-age / s-maxage. */
  ttlMs: positiveInt,
  /**
   * Request headers that become part of the cache key. The default keeps entries per-credential so one
   * client's response is never served to another. Set to [] only for genuinely public data.
   */
  varyHeaders: z.array(z.string().toLowerCase()).default(['authorization', 'x-api-key']),
  /**
   * Request headers forwarded to the upstream on a cacheable request, in addition to `varyHeaders`. Every
   * header listed here is also part of the cache key, so a client that sends a hostile value can only
   * poison the entry for requests that carry that same value, never for anyone else. Everything not listed
   * (X-Forwarded-Host, X-Original-URL, User-Agent, ...) is withheld from cacheable requests.
   */
  forwardHeaders: z.array(z.string().toLowerCase()).default(['accept', 'accept-language']),
});

const routeSchema = z.strictObject({
  /** Used in metrics and rate-limit keys. Defaults to the path. */
  id: z.string().min(1).optional(),
  /** Prefix match on whole path segments: "/users" matches /users and /users/1 but not /usersX. */
  path: z.string().startsWith('/'),
  upstream: z.string().min(1),
  methods: z.array(z.string().toUpperCase()).min(1).optional(),
  /** Drop the matched prefix before forwarding (/users/1 -> /1). */
  stripPrefix: z.boolean().default(true),
  /** Omit to inherit the global default; `false` disables limiting for this route. */
  rateLimit: z.union([rateLimitRuleSchema, z.literal(false)]).optional(),
  cache: routeCacheSchema.optional(),
});

const apiKeySchema = z.strictObject({
  /** For logs and metrics. Never the key itself. */
  name: z.string().min(1).max(64),
  /** SHA-256 of the key as 64 hex characters, so the config file holds no secret: `printf %s "$KEY" | sha256sum`. */
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be a 64-character hex SHA-256 digest'),
  /** Name of an entry in `plans`; scales every route's rule for this key. */
  plan: z.string().min(1).optional(),
  /** Replacement rules by route id for this key. `false` makes the key unlimited on that route. */
  overrides: z.record(z.string().min(1), z.union([rateLimitRuleSchema, z.literal(false)])).optional(),
});

/** An empty string means "not set", so `"${ADMIN_TOKEN:-}"` works in a config file. */
const optionalSecret = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(16, 'must be at least 16 characters').optional(),
);

export const configSchema = z
  .strictObject({
    port: z.number().int().min(0).max(65_535).default(8080),
    host: z.string().default('0.0.0.0'),
    maxBodyBytes: positiveInt.default(1_048_576),
    /** How long in-flight requests get to finish on SIGTERM before connections are cut. */
    shutdownGraceMs: positiveInt.default(10_000),
    /** Methods the gateway will proxy at all. Anything else is answered with 405. */
    allowedMethods: z
      .array(z.string().toUpperCase())
      .min(1)
      .default(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    /**
     * The X-Forwarded-Host sent upstream when the gateway is the edge. It is never derived from the client's
     * Host header, which an attacker controls and which upstreams commonly use to build absolute links.
     */
    forwardedHost: z.string().min(1).optional(),

    redis: z
      .strictObject({
        /** `redis://` or `rediss://` (TLS). A password goes in the URL: rediss://:secret@host:6380. */
        url: z.string().min(1),
        keyPrefix: z.string().default('gw:'),
        /** A slow limiter store must not make every request slow: cap each command. */
        commandTimeoutMs: positiveInt.default(100),
        /** PEM CA bundle for a Redis server signed by a private CA. Requires a rediss:// url. */
        caFile: z.string().min(1).optional(),
      })
      .superRefine((redis, ctx) => {
        if (!/^rediss?:\/\//.test(redis.url)) {
          ctx.addIssue({ code: 'custom', path: ['url'], message: 'must start with redis:// or rediss://' });
        } else if (redis.caFile && !redis.url.startsWith('rediss://')) {
          ctx.addIssue({ code: 'custom', path: ['caFile'], message: 'caFile requires a rediss:// url' });
        }
      })
      .optional(),

    rateLimit: z
      .strictObject({
        /** Header that carries the caller's API key; clients without a usable key are limited by address. */
        identityHeader: z.string().toLowerCase().default('x-api-key'),
        /**
         * Number of trusted reverse proxies in front of the gateway. 0 uses the socket address. N takes the
         * Nth entry from the right of X-Forwarded-For (the left side is client-controlled and spoofable).
         */
        trustedProxyHops: z.number().int().min(0).max(10).default(0),
        /** What to do when the limiter store (Redis) is unavailable. */
        failureMode: z.enum(['open', 'closed', 'local']).default('local'),
        default: rateLimitRuleSchema.optional(),
        /**
         * A ceiling applied to every request from one client address, across all routes and regardless of the
         * key presented. It is what stops a client from minting fresh budgets by rotating key values.
         */
        ip: rateLimitRuleSchema.optional(),
        /** IPv6 clients are grouped by this many leading bits (a /64 is one subscriber). */
        ipv6Prefix: z.number().int().min(32).max(128).default(64),
        /**
         * Registered API keys. When this is empty any header value is accepted as an identity (open mode); when
         * it is set, only these keys get their own budget and everything else shares its address's budget.
         */
        apiKeys: z.array(apiKeySchema).default([]),
        /** Named multipliers a key can reference, e.g. { "pro": { "multiplier": 10 } }. */
        plans: z
          .record(z.string().min(1), z.strictObject({ multiplier: z.number().positive().max(1_000) }))
          .default({}),
        /** Reject requests without a registered key (401) instead of limiting them by address. */
        requireKey: z.boolean().default(false),
        /** Scales the route rule for callers without a registered key, e.g. 0.1 for a tenth of the quota. */
        anonymousMultiplier: z.number().gt(0).max(1).default(1),
      })
      .prefault({}),

    cache: z
      .strictObject({
        maxEntries: positiveInt.default(1_000),
        maxBytes: positiveInt.default(50 * 1024 * 1024),
        maxEntryBytes: positiveInt.default(1024 * 1024),
      })
      .prefault({}),

    /**
     * Health and metrics are served on their own listener so they never share a port with proxied traffic.
     * The default is loopback-only; binding anywhere else requires a token.
     */
    admin: z
      .strictObject({
        enabled: z.boolean().default(true),
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(0).max(65_535).default(9090),
        /** Bearer token for /_gateway/health and /_gateway/metrics. /_gateway/live is always open. */
        token: optionalSecret,
      })
      .prefault({}),

    limits: z
      .strictObject({
        /** Hard cap on open client connections. */
        maxConnections: positiveInt.default(10_000),
        /**
         * Open connections allowed per client address; 0 (the default) means no per-address cap.
         *
         * It is off by default because a load balancer or CDN opens all of its connections from one address:
         * a cap that suits individual clients would throttle the whole deployment. Set it (a few hundred is
         * typical) only when clients connect to the gateway directly. `maxConnections` always applies.
         */
        maxConnectionsPerIp: z.number().int().min(0).default(0),
        /** Requests being processed at once; beyond this the gateway sheds load with 503. */
        maxInFlight: positiveInt.default(2_000),
        /** Total request-body bytes held in memory across all in-flight requests. */
        maxBufferedBytes: positiveInt.default(64 * 1024 * 1024),
        maxHeaderBytes: positiveInt.default(16 * 1024),
        /** Time a client gets to finish sending request headers (slowloris defence). */
        headersTimeoutMs: positiveInt.default(15_000),
        /** Time a client gets to finish sending a whole request. */
        requestTimeoutMs: positiveInt.default(60_000),
        keepAliveTimeoutMs: positiveInt.default(65_000),
      })
      .prefault({}),

    upstreams: z.record(z.string().min(1), upstreamSchema),
    routes: z.array(routeSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seenRoutes = new Set<string>();
    cfg.routes.forEach((route, i) => {
      if (!(route.upstream in cfg.upstreams)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'upstream'],
          message: `unknown upstream "${route.upstream}" (defined: ${Object.keys(cfg.upstreams).join(', ') || 'none'})`,
        });
      }
      const id = route.id ?? route.path;
      if (seenRoutes.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'id'], message: `duplicate route id "${id}"` });
      }
      seenRoutes.add(id);
      if (route.path.startsWith('/_gateway')) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'path'],
          message: '"/_gateway" is reserved for admin endpoints',
        });
      }
    });

    const rl = cfg.rateLimit;
    const names = new Set<string>();
    const digests = new Set<string>();
    rl.apiKeys.forEach((key, i) => {
      if (names.has(key.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rateLimit', 'apiKeys', i, 'name'],
          message: `duplicate key name "${key.name}"`,
        });
      }
      names.add(key.name);
      const digest = key.sha256.toLowerCase();
      if (digests.has(digest)) {
        ctx.addIssue({ code: 'custom', path: ['rateLimit', 'apiKeys', i, 'sha256'], message: 'duplicate key digest' });
      }
      digests.add(digest);
      if (key.plan !== undefined && !(key.plan in rl.plans)) {
        ctx.addIssue({
          code: 'custom',
          path: ['rateLimit', 'apiKeys', i, 'plan'],
          message: `unknown plan "${key.plan}" (defined: ${Object.keys(rl.plans).join(', ') || 'none'})`,
        });
      }
      for (const routeId of Object.keys(key.overrides ?? {})) {
        if (!seenRoutes.has(routeId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['rateLimit', 'apiKeys', i, 'overrides', routeId],
            message: `unknown route id "${routeId}"`,
          });
        }
      }
    });
    if (rl.requireKey && rl.apiKeys.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['rateLimit', 'requireKey'],
        message: 'requireKey needs at least one entry in apiKeys',
      });
    }

    if (cfg.admin.enabled) {
      if (!isLoopbackHost(cfg.admin.host) && cfg.admin.token === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['admin', 'token'],
          message: `admin.host "${cfg.admin.host}" is reachable beyond this machine, so admin.token (16+ characters) is required`,
        });
      }
      if (cfg.admin.port !== 0 && cfg.admin.port === cfg.port) {
        ctx.addIssue({ code: 'custom', path: ['admin', 'port'], message: 'admin.port must differ from port' });
      }
    }
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type RouteConfig = GatewayConfig['routes'][number];
export type UpstreamConfig = GatewayConfig['upstreams'][string];
export type RateLimitRuleConfig = z.infer<typeof rateLimitRuleSchema>;

/** The URLs of an upstream's targets, whether it was written with `url` or `urls`. */
export function upstreamTargets(upstream: { url?: string | undefined; urls?: string[] | undefined }): string[] {
  return upstream.urls ?? (upstream.url ? [upstream.url] : []);
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseConfig(input: unknown): GatewayConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new ConfigError(`Invalid gateway configuration:\n${lines.join('\n')}`);
  }
  return result.data;
}

/**
 * Expand `${NAME}` and `${NAME:-fallback}` inside string values, so one config file can serve several
 * environments. A reference to an unset variable without a fallback is an error rather than an empty string.
 */
export function expandEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
      const found = env[name];
      if (found !== undefined && found !== '') return found;
      if (fallback !== undefined) return fallback;
      throw new ConfigError(`environment variable ${name} is referenced in the config but not set`);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => expandEnv(v, env)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v, env)])) as T;
  }
  return value;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Could not read config "${path}": ${(error as Error).message}`);
  }
  raw = expandEnv(raw, env);

  // A few deployment-time overrides so one config file works across environments.
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (env['PORT']) obj['port'] = Number(env['PORT']);
    if (env['REDIS_URL']) {
      obj['redis'] = { ...(obj['redis'] as object | undefined), url: env['REDIS_URL'] };
    }
  }
  return parseConfig(raw);
}
