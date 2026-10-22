import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { isLoopbackHost } from './net/ip.js';

const positiveInt = z.number().int().positive();
const httpUrl = z.url().refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');
/** A node address: host:port, or [IPv6]:port. */
const hostPort = z
  .string()
  .regex(/^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):\d{1,5}$/, 'must be host:port, e.g. 10.0.0.5:26379')
  .refine((v) => Number(v.slice(v.lastIndexOf(':') + 1)) <= 65_535, 'port must be at most 65535');

/** Split a validated host:port (the brackets of an IPv6 address removed). */
export function splitHostPort(value: string): { host: string; port: number } {
  const colon = value.lastIndexOf(':');
  return { host: value.slice(0, colon).replace(/^\[(.*)\]$/, '$1'), port: Number(value.slice(colon + 1)) };
}

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

/** A route's changes to its upstream's retry settings: each setting given replaces the upstream's, the rest stand. */
const retryOverrideSchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(10).optional(),
  baseDelayMs: z.number().int().min(0).optional(),
  maxDelayMs: positiveInt.optional(),
  retryOnStatus: z.array(z.number().int().min(100).max(599)).optional(),
  retryNonIdempotent: z.boolean().optional(),
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
        caFile: z.string().min(1).optional(),
        /**
         * Client certificate and key the gateway presents to this upstream (mutual TLS), for upstreams that only
         * accept callers they can identify. The pair is checked at start-up and on every reload.
         */
        certFile: z.string().min(1).optional(),
        keyFile: z.string().min(1).optional(),
        /** For an encrypted `keyFile`. Use ${ENV_VAR}. */
        passphrase: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
      })
      .superRefine((tls, ctx) => {
        if (tls.caFile === undefined && tls.certFile === undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [],
            message:
              'set caFile (to trust a private CA), certFile and keyFile (to present a client certificate), or all three',
          });
        }
        if ((tls.certFile === undefined) !== (tls.keyFile === undefined)) {
          ctx.addIssue({ code: 'custom', path: [], message: 'certFile and keyFile go together' });
        }
        if (tls.passphrase !== undefined && tls.keyFile === undefined) {
          ctx.addIssue({ code: 'custom', path: ['passphrase'], message: 'a passphrase is for keyFile' });
        }
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
  /**
   * How long after an entry goes stale it may still be served at once while a fresh copy is fetched behind the scenes
   * (stale-while-revalidate, RFC 5861), when the upstream's Cache-Control does not say. 0, the default, means never.
   */
  staleWhileRevalidateMs: z.number().int().min(0).default(0),
  /**
   * How long after an entry goes stale it may stand in for an upstream that is failing (stale-if-error, RFC 5861):
   * a 5xx, a timeout, a refused connection, an open circuit. Used when the upstream does not say; 0 means never.
   */
  staleIfErrorMs: z.number().int().min(0).default(0),
});

const jwtIssuerSchema = z
  .strictObject({
    /** For logs, metrics and rate-limit identities. */
    name: z.string().min(1).max(64),
    /**
     * The one algorithm this key is for. A token's own `alg` header is only ever compared against it, so a token
     * cannot choose a different (weaker, or key-confusing) way to be verified.
     */
    alg: z.enum(['HS256', 'RS256', 'ES256']),
    /** HMAC secret for HS256, at least 32 bytes. Use ${ENV_VAR} rather than writing it in the file. */
    secret: z.string().min(1).optional(),
    /** PEM public key for RS256 (RSA, 2048 bits or more) or ES256 (P-256). Inline or from a file. */
    publicKey: z.string().min(1).optional(),
    publicKeyFile: z.string().min(1).optional(),
    /** If set, only tokens carrying this `kid` use this key. Several entries with different kids support rotation. */
    kid: z.string().min(1).max(128).optional(),
    /** Required `iss` claim. */
    issuer: z.string().min(1).optional(),
    /** Value that must appear in `aud`. */
    audience: z.string().min(1).optional(),
    /** Clock skew tolerated on exp / nbf / iat. */
    leewaySeconds: z.number().int().min(0).max(300).default(30),
    /** Reject tokens valid for longer than this. A cap on how long a stolen token stays useful. */
    maxLifetimeSeconds: positiveInt.optional(),
    /** Rate-limit plan (see rateLimit.plans) for every subject of this issuer. */
    plan: z.string().min(1).optional(),
  })
  .superRefine((issuer, ctx) => {
    if (issuer.alg === 'HS256') {
      if (!issuer.secret) ctx.addIssue({ code: 'custom', path: ['secret'], message: 'HS256 needs a "secret"' });
      if (issuer.publicKey || issuer.publicKeyFile) {
        ctx.addIssue({ code: 'custom', path: ['alg'], message: 'HS256 uses "secret", not a public key' });
      }
    } else {
      if (issuer.secret)
        ctx.addIssue({ code: 'custom', path: ['secret'], message: `${issuer.alg} uses a public key, not a "secret"` });
      if ((issuer.publicKey === undefined) === (issuer.publicKeyFile === undefined)) {
        ctx.addIssue({ code: 'custom', path: [], message: 'set exactly one of "publicKey" and "publicKeyFile"' });
      }
    }
  });

const websocketSchema = z.strictObject({
  /**
   * Origins (scheme://host[:port]) whose pages may open a WebSocket here. A browser always sends Origin and a page
   * cannot forge it, so this is the defence against cross-site WebSocket hijacking: any website can ask the
   * browser to open a socket to your host with your users' cookies attached. Clients that send no Origin (scripts,
   * native apps) are not browsers and are not affected by this list. Empty means no browser may connect.
   */
  allowedOrigins: z
    .array(
      z
        .string()
        .regex(
          /^https?:\/\/[^/\s?#]+$/i,
          'must be an origin such as https://app.example.com (scheme and host, no path)',
        )
        .transform((origin) => origin.toLowerCase()),
    )
    .default([]),
  /** Accept any Origin. Only safe if the socket does not authenticate with cookies. */
  allowAnyOrigin: z.boolean().default(false),
  /** Close a connection with no traffic in either direction for this long. Ping/pong keeps one alive. */
  idleTimeoutMs: positiveInt.default(60_000),
  /** Close a connection after this long regardless of activity. Unset means no limit. */
  maxDurationMs: positiveInt.optional(),
  /** Most simultaneous WebSockets on this route. */
  maxConnections: positiveInt.default(1_000),
  /**
   * Largest message a client may send, in bytes (a fragmented message counts all its frames). A client over it is
   * sent close code 1009 and the offending message never reaches the upstream. With permessage-deflate negotiated
   * this is the compressed size: the upstream must still bound what a message inflates to.
   */
  maxMessageBytes: positiveInt.optional(),
  /**
   * Messages (pings included) a client may send on one connection: `perSecond` on average, `burst` at once. A client
   * over it is sent close code 1008. The connection rate limit (the route's `rateLimit`) still governs opening them.
   */
  messageRate: z
    .strictObject({
      perSecond: z.number().positive().max(100_000),
      burst: positiveInt.max(100_000).optional(),
    })
    .transform((rate) => ({ perSecond: rate.perSecond, burst: rate.burst ?? Math.max(1, Math.ceil(rate.perSecond)) }))
    .optional(),
});

const routeAuthSchema = z.strictObject({
  /** How a caller may prove who they are on this route. `client-cert` needs `tls.clientAuth`. */
  methods: z.array(z.enum(['api-key', 'jwt', 'client-cert'])).min(1),
  /**
   * true: a request with no credential is refused (401). false: anonymous callers are allowed, but a credential
   * that is *presented* and invalid is still refused, so a bad token never silently downgrades to anonymous.
   */
  required: z.boolean().default(true),
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
  /**
   * What one request to this route spends from the caller's rate-limit budget. A route that does ten times the
   * work (an export, a search, a report) can cost 10, so one limit protects expensive and cheap endpoints alike.
   * Capped at the caller's whole allowance, so a request is never impossible: a caller scaled down to a tiny
   * budget can still make one such request per refill.
   */
  cost: positiveInt.default(1),
  /**
   * Proxy WebSocket upgrades on this route. Without it an Upgrade request gets a 404: the upgrade mechanism also
   * carries other protocols, so it is opt-in per route. Authentication and rate limits apply to opening the
   * connection; the gateway does not look inside the frames that follow.
   */
  websocket: websocketSchema.optional(),
  /** Authenticate callers on this route. Without it the gateway checks no credentials (it only rate limits). */
  auth: routeAuthSchema.optional(),
  /**
   * Per-attempt timeout for this route, instead of its upstream's `timeoutMs`. One upstream often serves a lookup
   * that should take 200 ms and a report that takes 30 s; neither is well served by the same number.
   */
  timeoutMs: positiveInt.optional(),
  /** Overall deadline for this route, across attempts and backoff, instead of its upstream's `totalTimeoutMs`. */
  totalTimeoutMs: positiveInt.optional(),
  /**
   * Retry settings for this route. Each one given replaces its upstream's; the others stand. `{ "maxAttempts": 1 }`
   * turns retries off for, say, a slow endpoint where a retry would only double the load.
   */
  retry: retryOverrideSchema.optional(),
  /** Largest request body this route accepts, instead of the global `maxBodyBytes` (an upload endpoint, say). */
  maxBodyBytes: positiveInt.optional(),
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

    /**
     * Terminate TLS on the proxy listener, so the gateway can face clients directly. Without it the listener is
     * plain HTTP and is meant to sit behind something that terminates TLS. Send SIGHUP to reload the certificate
     * without a restart (POSIX), which is how renewals from ACME clients are picked up.
     */
    tls: z
      .strictObject({
        certFile: z.string().min(1),
        keyFile: z.string().min(1),
        /** For an encrypted private key. Use ${ENV_VAR}. */
        passphrase: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
        /** Oldest protocol version accepted. TLS 1.0 and 1.1 are not offered at all. */
        minVersion: z.enum(['TLSv1.2', 'TLSv1.3']).default('TLSv1.2'),
        /** Send `Strict-Transport-Security: max-age=N` on every response. Leave unset until you are sure. */
        hstsMaxAgeSeconds: z.number().int().min(1).max(63_072_000).optional(),
        /**
         * Ask clients for a certificate (mutual TLS), so routes can authenticate callers with `client-cert`. Only a
         * certificate issued by `caFile`, unexpired and not on `crlFile`, counts.
         */
        clientAuth: z
          .strictObject({
            /** PEM bundle of the CA(s) that issue callers' certificates. Only these are trusted, never the system's. */
            caFile: z.string().min(1),
            /** PEM certificate revocation list(s) from those CAs. Re-read on every reload. */
            crlFile: z.string().min(1).optional(),
            /**
             * true: a connection without a valid certificate is refused during the handshake, on every route. false
             * (the default): the certificate is asked for, and routes decide; one without `client-cert` ignores it.
             */
            required: z.boolean().default(false),
            /** Accept only certificates with one of these subject common names. Unset: any the CA issued. */
            allowedNames: z.array(z.string().min(1)).min(1).optional(),
          })
          .optional(),
      })
      .optional(),

    /**
     * Where the shared rate-limit state lives: one server (`url`), a primary watched by Sentinel (`sentinel`), or a
     * Redis Cluster (`cluster`). Exactly one of the three.
     */
    redis: z
      .strictObject({
        /** One server. `redis://` or `rediss://` (TLS). A password goes in the URL: rediss://:secret@host:6380. */
        url: z.string().min(1).optional(),
        /**
         * A primary and its replicas watched by Redis Sentinel. The gateway asks the sentinels where the primary is,
         * and follows a failover to the replica they promote.
         */
        sentinel: z
          .strictObject({
            /** The name the sentinels monitor the primary under (`sentinel monitor <name> ...`). */
            name: z.string().min(1),
            /** Sentinels as host:port. One is enough to find the primary; list several so one being down is not. */
            nodes: z.array(hostPort).min(1).max(16),
            /** For sentinels that require AUTH (`requirepass` in sentinel.conf). Use ${ENV_VAR}. */
            password: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
          })
          .optional(),
        /**
         * A Redis Cluster. The gateway reads the slot map from these nodes (any reachable one will do) and sends each
         * key to the node that owns it. Every limiter script touches one key, so no hash tags are needed.
         */
        cluster: z.strictObject({ nodes: z.array(hostPort).min(1).max(64) }).optional(),
        /** With `sentinel` or `cluster`: the data nodes' ACL user and password (with `url`, put them in the URL). */
        username: z.string().min(1).optional(),
        password: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),
        /** With `sentinel` or `cluster`: speak TLS to every node, sentinels included (with `url`, use rediss://). */
        tls: z.boolean().default(false),
        keyPrefix: z.string().default('gw:'),
        /** A slow limiter store must not make every request slow: cap each command. */
        commandTimeoutMs: positiveInt.default(100),
        /** PEM CA bundle for a Redis server signed by a private CA. Requires TLS (a rediss:// url, or `tls`). */
        caFile: z.string().min(1).optional(),
      })
      .superRefine((redis, ctx) => {
        const modes = [redis.url, redis.sentinel, redis.cluster].filter((m) => m !== undefined).length;
        if (modes !== 1) {
          ctx.addIssue({ code: 'custom', path: [], message: 'set exactly one of "url", "sentinel" or "cluster"' });
          return;
        }
        if (redis.url !== undefined) {
          if (!/^rediss?:\/\//.test(redis.url)) {
            ctx.addIssue({ code: 'custom', path: ['url'], message: 'must start with redis:// or rediss://' });
          } else if (redis.caFile && !redis.url.startsWith('rediss://')) {
            ctx.addIssue({ code: 'custom', path: ['caFile'], message: 'caFile requires a rediss:// url' });
          }
          for (const key of ['username', 'password', 'tls'] as const) {
            if (key === 'tls' ? redis.tls : redis[key] !== undefined) {
              ctx.addIssue({
                code: 'custom',
                path: [key],
                message: `with "url", put this in the URL (${key === 'tls' ? 'rediss://' : 'redis://user:password@host'})`,
              });
            }
          }
        } else if (redis.caFile && !redis.tls) {
          ctx.addIssue({ code: 'custom', path: ['caFile'], message: 'caFile requires tls: true' });
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

    auth: z
      .strictObject({
        /** Verify `Authorization: Bearer <jwt>` on routes whose auth methods include "jwt". */
        jwt: z.strictObject({ issuers: z.array(jwtIssuerSchema).min(1).max(32) }).optional(),
        /**
         * Tell the upstream who the gateway authenticated, in X-Authenticated-Client and X-Authenticated-Method.
         * Those headers are always stripped from incoming requests, so an upstream can trust them.
         */
        forwardIdentity: z.boolean().default(true),
        /**
         * Pass the credential the gateway verified (the API key, or the bearer token) on to the upstream. Set false
         * when the upstream trusts the identity headers and has no use for the secret.
         */
        forwardCredentials: z.boolean().default(true),
      })
      .prefault({}),

    /**
     * W3C Trace Context. Every forwarded request carries a `traceparent` (continuing the caller's trace, or starting
     * one), with the gateway's hop as the parent, and the access log records the trace id, so one request can be
     * followed from the gateway into the services behind it. With `enabled: false` the headers pass through as sent.
     */
    tracing: z
      .strictObject({
        enabled: z.boolean().default(true),
        /**
         * Continue a trace the caller started. At an edge facing clients you do not trust, false starts a new trace
         * for every request, so a client cannot attach its requests to your traces (or flood one of them).
         */
        trustIncoming: z.boolean().default(true),
        /**
         * Share of traces started here that are sampled (recorded), from 0 to 1. A trace continued from a caller keeps
         * the caller's decision. The decision travels downstream in `traceparent`, so services record the same ones.
         */
        sampleRatio: z.number().min(0).max(1).default(1),
        /**
         * Record spans (one per request, one per upstream attempt, one per background cache refresh) and send them to
         * an OpenTelemetry collector over OTLP/HTTP (JSON). Without it the gateway passes trace context on but records
         * nothing itself.
         */
        otlp: z
          .strictObject({
            /** The collector's traces endpoint, e.g. http://otel-collector:4318/v1/traces. */
            endpoint: httpUrl,
            /** Extra headers on every export, e.g. a vendor's API key: use ${ENV_VAR}. */
            headers: z.record(z.string().min(1), z.string()).default({}),
            /** PEM bundle for an https endpoint signed by a private CA. */
            caFile: z.string().min(1).optional(),
            serviceName: z.string().min(1).default('api-gateway'),
            /** Most spans per export request. */
            batchSize: positiveInt.max(10_000).default(512),
            /** Queued spans are sent at least this often. */
            flushIntervalMs: positiveInt.default(5_000),
            /** Most spans waiting to be sent. Beyond it new ones are dropped (and counted), never buffered without bound. */
            maxQueueSpans: positiveInt.default(4_096),
            /** An export taking longer than this is abandoned and its spans dropped. */
            timeoutMs: positiveInt.default(10_000),
          })
          .superRefine((otlp, ctx) => {
            if (otlp.caFile && !otlp.endpoint.startsWith('https://')) {
              ctx.addIssue({ code: 'custom', path: ['caFile'], message: 'caFile requires an https:// endpoint' });
            }
          })
          .optional(),
      })
      .prefault({}),

    /**
     * Run several worker processes, one per core, behind the same port. 1 (the default) keeps everything in this
     * process. Rate limits are shared between workers through Redis, which is why more than one worker requires
     * it; everything else (cache, circuit breakers, health checks, connection and memory limits) is per worker.
     */
    cluster: z
      .strictObject({
        workers: z.union([z.literal('auto'), z.number().int().min(1).max(256)]).default(1),
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
        /**
         * A client that accepts none of a response for this long is dropped. Without it a client that asks for a
         * large response and never reads it holds an upstream connection (and a cache fetch other clients may be
         * waiting on) for as long as it likes. A slow client that keeps reading is never affected: the clock
         * restarts every time it takes some data.
         */
        responseStallTimeoutMs: positiveInt.default(30_000),
      })
      .prefault({}),

    upstreams: z.record(z.string().min(1), upstreamSchema),
    routes: z.array(routeSchema).min(1),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.cluster.workers !== 1 && !cfg.redis) {
      ctx.addIssue({
        code: 'custom',
        path: ['cluster', 'workers'],
        message:
          'more than one worker requires a redis section: in-memory rate limits are per process, so each worker would ' +
          'grant a client the full limit and N workers would allow N times it',
      });
    }

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
    cfg.routes.forEach((route, i) => {
      const rule = route.rateLimit === undefined ? cfg.rateLimit.default : route.rateLimit || undefined;
      const allowance = rule ? (rule.algorithm === 'token-bucket' ? rule.capacity : rule.limit) : undefined;
      if (allowance !== undefined && route.cost > allowance) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'cost'],
          message: `cost ${route.cost} exceeds the route's whole allowance of ${allowance}, so no request could ever succeed`,
        });
      }
    });

    cfg.routes.forEach((route, i) => {
      const ws = route.websocket;
      if (!ws) return;
      if (route.cache) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'websocket'],
          message: 'a websocket route cannot also be cached',
        });
      }
      if (route.methods && !route.methods.includes('GET')) {
        ctx.addIssue({ code: 'custom', path: ['routes', i, 'methods'], message: 'a websocket route must allow GET' });
      }
      if (ws.allowAnyOrigin && ws.allowedOrigins.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'websocket'],
          message: 'allowAnyOrigin makes allowedOrigins meaningless: set one or the other',
        });
      }
    });

    const issuerNames = new Set<string>();
    (cfg.auth.jwt?.issuers ?? []).forEach((issuer, i) => {
      if (issuerNames.has(issuer.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'jwt', 'issuers', i, 'name'],
          message: `duplicate issuer name "${issuer.name}"`,
        });
      }
      issuerNames.add(issuer.name);
      if (issuer.plan !== undefined && !(issuer.plan in rl.plans)) {
        ctx.addIssue({
          code: 'custom',
          path: ['auth', 'jwt', 'issuers', i, 'plan'],
          message: `unknown plan "${issuer.plan}" (defined: ${Object.keys(rl.plans).join(', ') || 'none'})`,
        });
      }
    });
    cfg.routes.forEach((route, i) => {
      if (route.auth?.methods.includes('jwt') && !cfg.auth.jwt) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'auth', 'methods'],
          message: 'the "jwt" method needs auth.jwt.issuers to be configured',
        });
      }
      if (route.auth?.methods.includes('client-cert') && !cfg.tls?.clientAuth) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'auth', 'methods'],
          message: 'the "client-cert" method needs tls.clientAuth to be configured',
        });
      }
      if (route.auth?.methods.includes('api-key') && rl.apiKeys.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['routes', i, 'auth', 'methods'],
          message: 'the "api-key" method needs rateLimit.apiKeys to be configured',
        });
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

/** How the configuration reaches Redis, for logs and the health report. */
export function redisMode(redis: NonNullable<GatewayConfig['redis']>): 'standalone' | 'sentinel' | 'cluster' {
  return redis.cluster ? 'cluster' : redis.sentinel ? 'sentinel' : 'standalone';
}

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
    if (env['ADMIN_PORT']) {
      obj['admin'] = { ...(obj['admin'] as object | undefined), port: Number(env['ADMIN_PORT']) };
    }
    if (env['WORKERS']) {
      obj['cluster'] = {
        ...(obj['cluster'] as object | undefined),
        workers: env['WORKERS'] === 'auto' ? 'auto' : Number(env['WORKERS']),
      };
    }
    if (env['REDIS_URL']) {
      // One server named in the environment replaces whatever the file says about where Redis is (a sentinel or
      // cluster setup included); the other settings (key prefix, timeouts) are kept.
      const { sentinel, cluster, username, password, tls, ...rest } = (obj['redis'] ?? {}) as Record<string, unknown>;
      obj['redis'] = { ...rest, url: env['REDIS_URL'] };
    }
  }
  return parseConfig(raw);
}
