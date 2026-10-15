import { readFileSync } from 'node:fs';
import { z } from 'zod';

const positiveInt = z.number().int().positive();

export const rateLimitRuleSchema = z.discriminatedUnion('algorithm', [
  z.strictObject({
    algorithm: z.literal('token-bucket'),
    /** Burst size: the most requests that can be admitted back to back. */
    capacity: positiveInt,
    /** Sustained rate once the burst is spent. */
    refillPerSecond: z.number().positive(),
  }),
  z.strictObject({
    algorithm: z.literal('sliding-window'),
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

const upstreamSchema = z.strictObject({
  url: z
    .url()
    .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL'),
  /** Per-attempt time to first byte, and idle time afterwards. */
  timeoutMs: positiveInt.default(5_000),
  /**
   * Overall deadline across all attempts and backoff sleeps. Without it a request can take
   * maxAttempts x timeoutMs, which is usually longer than the client will wait and multiplies the load
   * on an upstream that is already struggling. Unset means attempts are only bounded individually.
   */
  totalTimeoutMs: positiveInt.optional(),
  retry: retrySchema.prefault({}),
  breaker: breakerSchema.prefault({}),
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
}).superRefine((upstream, ctx) => {
  if (upstream.tls && !upstream.url.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['tls'], message: 'tls options require an https:// url' });
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

export const configSchema = z
  .strictObject({
    port: z.number().int().min(0).max(65_535).default(8080),
    host: z.string().default('0.0.0.0'),
    maxBodyBytes: positiveInt.default(1_048_576),
    /** How long in-flight requests get to finish on SIGTERM before connections are cut. */
    shutdownGraceMs: positiveInt.default(10_000),

    redis: z
      .strictObject({
        url: z.string().min(1),
        keyPrefix: z.string().default('gw:'),
        /** A slow limiter store must not make every request slow: cap each command. */
        commandTimeoutMs: positiveInt.default(100),
      })
      .optional(),

    rateLimit: z
      .strictObject({
        /** Header that identifies the caller; falls back to the client IP when absent. */
        identityHeader: z.string().toLowerCase().default('x-api-key'),
        /**
         * Number of trusted reverse proxies in front of the gateway. 0 uses the socket address. N takes the
         * Nth entry from the right of X-Forwarded-For (the left side is client-controlled and spoofable).
         */
        trustedProxyHops: z.number().int().min(0).max(10).default(0),
        /** What to do when the limiter store (Redis) is unavailable. */
        failureMode: z.enum(['open', 'closed', 'local']).default('local'),
        default: rateLimitRuleSchema.optional(),
      })
      .prefault({}),

    cache: z
      .strictObject({
        maxEntries: positiveInt.default(1_000),
        maxBytes: positiveInt.default(50 * 1024 * 1024),
        maxEntryBytes: positiveInt.default(1024 * 1024),
      })
      .prefault({}),

    upstreams: z.record(z.string().min(1), upstreamSchema),
    routes: z.array(routeSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    const seen = new Set<string>();
    cfg.routes.forEach((route, i) => {
      if (!(route.upstream in cfg.upstreams)) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'upstream'],
          message: `unknown upstream "${route.upstream}" (defined: ${Object.keys(cfg.upstreams).join(', ') || 'none'})`,
        });
      }
      const id = route.id ?? route.path;
      if (seen.has(id)) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'id'], message: `duplicate route id "${id}"` });
      }
      seen.add(id);
      if (route.path.startsWith('/_gateway')) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'path'], message: '"/_gateway" is reserved for admin endpoints' });
      }
    });
  });

export type GatewayConfig = z.infer<typeof configSchema>;
export type RouteConfig = GatewayConfig['routes'][number];
export type UpstreamConfig = GatewayConfig['upstreams'][string];
export type RateLimitRuleConfig = z.infer<typeof rateLimitRuleSchema>;

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
