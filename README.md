# API Gateway & Rate Limiter

A small API gateway that sits in front of other HTTP services and handles the cross-cutting concerns:

- **Per-key rate limiting** with a token bucket, an exact sliding window or an approximate (O(1)-memory) sliding-window counter, implemented from scratch and backed by Redis (one server, Sentinel or Cluster) so the limit is shared by every gateway instance
- **API keys with plans**, per-key overrides, and a per-address ceiling so rotating key values doesn't buy a fresh budget
- **Authentication per route**: registered API keys, signed JWTs (HS256 / RS256 / ES256) and TLS client certificates, verified by the gateway, with a trusted identity passed to the upstream
- **Routing** by path prefix, with prefix stripping and per-route timeouts, retries, body limits, rate limits and caching
- **Response caching** with HTTP-correct freshness rules, stampede protection, a defence against cache poisoning, and stale copies served while revalidating or while the upstream is failing
- **Load balancing** across several targets per upstream, each with its own circuit breaker
- **Retries** with exponential backoff and full jitter
- **Circuit breaking** per target, so a failing instance gets room to recover and callers fail fast
- **Active health checks**, so traffic avoids a down target before any client request has to fail to find out
- **TLS** facing clients (renewals picked up without a restart, client certificates) and towards upstreams (private CAs, client certificates), and **HTTP/2** for clients that offer it
- **WebSocket proxying** with origin checks, authentication, connection limits and limits on each message a client sends
- **Cluster mode** to use every core of a machine, with the rate limits still shared through Redis
- **Configuration reloads** without a restart or a dropped request, all or nothing
- **Tracing**: W3C trace context on every forwarded request, and spans exported to an OpenTelemetry collector

Written in TypeScript on Node's built-in `http`. The only runtime dependencies are `ioredis` (the Redis client) and `zod` (config validation). The rate limiters, circuit breaker, retry loop, balancer and cache are hand-written.

## Request pipeline

```
client ─▶ limits ─▶ identify ─▶ rate limit ─▶ route ─▶ cache ─▶ pick target ─▶ breaker ─▶ retry ─▶ upstream
            │          │            │                    │          │            │          │
        conn / in-   key registry  address ceiling   HIT/MISS    round-robin   open?     5xx / timeout
        flight caps  or address    + route budget    coalesce    least-pending fail fast  connect error
                                   (Redis, Lua)
```

Rate limiting runs before the cache on purpose: a quota should count cache hits too, and rejecting early protects everything behind it.

## Quick start

No Redis needed to try it (limits are then per-process):

```bash
npm install
npm run demo:upstream          # terminal 1: a flaky demo service on :9001
npm run dev                    # terminal 2: the gateway on :8080, admin on 127.0.0.1:9090
```

```bash
curl -i localhost:8080/time                                          # X-Cache: MISS, then HIT
node demo/hammer.mjs http://localhost:8080/echo --n 30 --key alice   # ~10 x 200 (the burst), then 429s
curl "localhost:9001/_demo/failure?rate=1"                           # make the upstream fail...
node demo/hammer.mjs http://localhost:8080/slow --n 20               # ...and watch the breaker open (500s, then 503s)
curl localhost:9001/_demo/failure?rate=0                             # heal it; the breaker probes and closes
curl localhost:9090/_gateway/health                                  # circuit state per upstream target
curl localhost:9090/_gateway/metrics                                 # Prometheus text format
curl -X POST localhost:9090/_gateway/reload                          # apply edits to gateway.config.json, no restart
```

With Redis, and two gateway instances sharing one budget:

```bash
docker compose up --build
curl -i -H 'x-api-key: alice' localhost:8080/echo   # hit :8080 and :8081 alternately:
curl -i -H 'x-api-key: alice' localhost:8081/echo   # RateLimit-Remaining counts down across both
```

If those ports are taken, move them: `GATEWAY_A_PORT=18080 GATEWAY_B_PORT=18081 UPSTREAM_PORT=19001 docker compose up --build`. The admin listener binds to loopback inside each container and isn't published; read it with `docker compose exec gateway-a wget -qO- http://127.0.0.1:9090/_gateway/metrics`.

Or point a single instance at your own Redis: `REDIS_URL=redis://localhost:6379 npm run dev`.

## Rate limiting

Three algorithms, selected per route (or per key, see below):

| | Token bucket | Sliding window (log) | Sliding window counter |
|---|---|---|---|
| Idea | Bucket of `capacity` tokens refilling at `refillPerSecond`; a request spends one | Remember every admitted timestamp; admit if fewer than `limit` fall in the last `windowMs` | Two fixed-window counters; estimate the trailing window as `previous * (share still in view) + current` |
| Allows | Bursts up to `capacity`, long-run average of the refill rate | Exactly `limit` per any trailing window | About `limit`: an approximation, tested to stay within 5% of the exact log in aggregate |
| Boundary behaviour | Smooth | No fixed-window "double burst" at the window edge | The weighting removes most of the boundary burst; the estimate assumes traffic was even within a window |
| State per key | 2 numbers (O(1)) | One entry per admitted request (O(limit)) | 3 numbers (O(1)) |
| Use when | You want to permit bursts and cap the average | You need a hard, exact cap at modest limits | The limit is large (thousands per window) and exactness isn't worth the memory |

The algorithms are pure functions in [`src/ratelimit/algorithms.ts`](src/ratelimit/algorithms.ts) (state and `now` in, decision and state out). The in-memory limiter, the unit tests and the Redis Lua scripts all implement that one definition, and a test asserts the Lua and the pure function make identical decisions over randomized traffic on a real Redis. The counter uses integer arithmetic scaled by the window precisely so that parity can be exact rather than "within epsilon".

### Why it's safe across instances

- **Atomic.** Each check-and-update is a single Lua script ([`src/ratelimit/redis.ts`](src/ratelimit/redis.ts)). There is no read-then-write window for two instances to interleave in, so N concurrent requests against a limit of L admit exactly L (the Redis integration tests assert this from several independent clients).
- **One clock.** Scripts use Redis `TIME`, not the gateway's clock, so instances with skewed clocks still agree on when a window ends.
- **Bounded storage.** Every key gets a TTL; idle clients cost nothing. Denied requests do not write, so a flood of rejections can't amplify into Redis writes.
- **Cluster-safe.** Each script touches exactly one key, so it runs unchanged on a Redis Cluster, wherever the key's slot lives (see "Redis deployments").
- **Credentials aren't stored.** API keys are SHA-256 hashed before they become Redis keys.

### Redis deployments

`redis` takes exactly one of three ways to reach it:

```jsonc
"redis": { "url": "rediss://:secret@redis.internal:6380" }                                   // one server
"redis": { "sentinel": { "name": "gw", "nodes": ["s1:26379", "s2:26379", "s3:26379"] },     // a primary watched by Sentinel
           "password": "${REDIS_PASSWORD}", "tls": true }
"redis": { "cluster": { "nodes": ["n1:7000", "n2:7001", "n3:7002"] }, "password": "${REDIS_PASSWORD}" }  // a Redis Cluster
```

- **Sentinel.** The gateway asks the sentinels where the primary is, hears about a failover the moment they announce it, and reconnects when a demoted primary refuses writes (`READONLY`). While it switches, the failure mode below applies, so requests are still answered. The integration test forces a failover in the middle of traffic: every request is answered (never a 5xx), and decisions are back on the shared budget, on the new primary, within about two seconds. (`sentinel.password` is the sentinels' own password; `password` is the data nodes'.)
- **Cluster.** The gateway reads the slot map from any seed node it can reach and sends each key to the node that owns it. A flood of concurrent requests over keys spread across three nodes admits exactly the limit for each key, as on one server.
- With `sentinel` or `cluster`, `username`, `password` and `tls` apply to every node (with `url` they belong in the URL). The fail-fast settings are the same everywhere: no offline queue, no command retries, `commandTimeoutMs` per command. `REDIS_URL` in the environment names one server and replaces a Sentinel or Cluster setup. The health report says which mode is in use (`redisMode`).

### Who is a "client"? Keys, plans, and the address ceiling

A rate limiter keyed on a client-supplied header is only as good as the header. If any value is accepted, a client gets a fresh budget by changing it. The gateway has two defences, and uses both in the shipped config:

```jsonc
"rateLimit": {
  "default": { "algorithm": "sliding-window", "limit": 60, "windowMs": 60000 },

  // 1. A ceiling per client address, across every route, whatever key is presented.
  "ip": { "algorithm": "sliding-window-counter", "limit": 600, "windowMs": 60000 },

  // 2. A registry. Only these keys get their own budget; any other value (or none) shares the
  //    budget of its address, so rotating key values gains nothing.
  "apiKeys": [
    { "name": "alice", "sha256": "<printf %s \"$KEY\" | sha256sum>", "plan": "pro" },
    { "name": "batch-job", "sha256": "...", "overrides": { "export": { "algorithm": "token-bucket", "capacity": 5, "refillPerSecond": 0.1 },
                                                           "health": false } }
  ],
  "plans": { "pro": { "multiplier": 10 } },
  "requireKey": false,          // true: 401 for anything without a registered key
  "anonymousMultiplier": 0.25   // unregistered callers get a quarter of the route's quota
}
```

- The registry stores **SHA-256 digests**, never keys, so the config file holds no secret. A raw key pasted where a digest belongs is rejected at startup.
- A **plan** scales every route's rule for the keys on it. An **override** replaces the rule on one route for one key, in either direction, and `false` lifts the limit entirely.
- IPv6 clients are grouped by **/64** (`ipv6Prefix`): a single subscriber is delegated 2^64 addresses and would otherwise mint a fresh identity per request. IPv4-mapped IPv6 is unified with plain IPv4.
- Behind a proxy, set `trustedProxyHops`: the client address is the entry the outermost trusted proxy appended to `X-Forwarded-For`. The left side is client-controlled and is never used, and anything that doesn't parse as an address falls back to the socket, so attacker-chosen text is never a key.

### Request cost

A route can say what one request costs: `"cost": 10` on an export or a search lets one limit protect cheap and expensive endpoints alike, instead of forcing a single number that is too tight for one and too loose for the other.

- It is charged against the caller's budget for that route, whether the response is served from the upstream or from the cache (the limiter runs first).
- The cost is capped at the caller's *whole allowance*. An anonymous caller scaled down to a tenth of the quota might have an allowance of 1 against a route costing 10; capping means they can still make one request per refill instead of being locked out for ever.
- A cost larger than the route's own limit is a startup error: no request could ever succeed.
- The per-address ceiling always counts a request as 1. It exists to bound request volume, not work.

### When Redis is down

A limiter on the hot path makes "what if the store is unavailable?" a policy decision. `rateLimit.failureMode`:

| Mode | Behaviour | Trade-off |
|---|---|---|
| `local` (default) | Keep limiting with a per-instance in-memory limiter | With N instances the effective limit degrades to about N x limit, but abuse stays bounded |
| `open` | Let traffic through | Availability over protection |
| `closed` | Reject with 503 | Protection over availability |

Commands are capped at `commandTimeoutMs` (default 100 ms), the client doesn't queue offline commands, and a circuit breaker around the store stops paying that timeout on every request once Redis is clearly unhealthy. Responses made without the store omit `RateLimit-*` headers rather than claim precision they don't have.

At start-up the gateway waits up to 2.5 s for Redis to connect before it accepts traffic, so a freshly started instance (every rolling deploy) counts its first requests in the shared budget rather than in the per-process fallback. If Redis is slow or down it starts anyway, and the failure mode above applies until the client connects.

Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on a 429.

## Caching

Only `GET`, only `200`, and only when it's safe to share:

- `Cache-Control: no-store | no-cache | private`, `Set-Cookie`, and `Vary: *` are never stored; `s-maxage` beats `max-age` beats the route's `ttlMs`
- Entries are keyed on path, query string **and the values of `varyHeaders`** (default `authorization`, `x-api-key`), so one client's response is never served to another
- A credentialed request whose credential isn't in the key bypasses the cache (`X-Cache: BYPASS`)
- The upstream's own `Vary` is honoured
- **Stampede protection:** concurrent misses for the same key are coalesced into one upstream request.
  - If that response turns out uncacheable (it may be private to its requester), waiters make their own request rather than share it.
  - If it fails (timeout, breaker open), every waiter gets the same error instead of retrying the failing upstream one by one.
  - If the leading client disconnects mid-fetch, one waiter takes over as the new leader, rather than all of them hitting the upstream at once.
- LRU eviction with a byte budget; entries over `maxEntryBytes` are streamed but not stored

### Serving stale

An entry past its freshness lifetime can still be useful, in the two cases RFC 5861 defines:

- **While revalidating** (`stale-while-revalidate`): the client gets the stale copy at once (`X-Cache: STALE`, with its `Age`), and one background request fetches a fresh copy for whoever comes next. However many requests arrive meanwhile, the upstream sees one refresh; if it fails, the stale copy stays in service until its window closes.
- **Instead of an error** (`stale-if-error`): when fetching a fresh copy fails (a 5xx once the route's retries are spent, a timeout, a refused connection, an open circuit), the stale copy is served in place of the error, to every request coalesced on that fetch.

The upstream decides with its `Cache-Control` (`max-age=60, stale-while-revalidate=30, stale-if-error=86400`). A route can set windows for upstreams that say nothing:

```json
"cache": { "ttlMs": 60000, "staleWhileRevalidateMs": 30000, "staleIfErrorMs": 86400000 }
```

Both default to `0`: nothing is served stale unless someone asked for it. A stale copy is never served against `must-revalidate` or `proxy-revalidate`, a route's windows don't apply over `s-maxage` (which carries `proxy-revalidate`'s meaning for a shared cache), and a client that sends `Cache-Control: no-cache` gets a fresh copy or the error. `gateway_cache_stale_served_total{reason}` (`revalidating` or `upstream_error`) and `gateway_cache_refreshes_total{result}` show it at work.

### Cache poisoning

Many frameworks build absolute links or error pages from headers like `X-Forwarded-Host`. If the gateway forwarded whatever a client sent and cached the result, one request could plant an attacker's value in a response every later client receives. So on a cacheable fetch:

- Only the headers in the route's `forwardHeaders` (default `accept`, `accept-language`) and `varyHeaders` reach the upstream. `User-Agent`, `X-Forwarded-Host`, `X-Original-URL` and everything else are withheld.
- **Every forwarded header is part of the cache key.** A hostile value can only ever be served back to requests that carry that same value.
- Rewrite headers (`X-Original-URL`, `X-Rewrite-URL`, `X-HTTP-Method-Override`, ...) are dropped on every route, cached or not: a client has no business telling an upstream to treat a request as a different URL or method.

## Retries, balancing and the circuit breaker

**Retries** use exponential backoff with *full jitter* (delay uniform in `[0, min(max, base * 2^n)]`), which avoids synchronized retry storms. What gets retried is deliberate:

- 5xx statuses in `retryOnStatus`, timeouts and resets: **idempotent methods only** (a POST may already have taken effect), unless `retryNonIdempotent` is set
- Connection failures (refused, DNS): retried for **any** method, since nothing was sent
- `Retry-After` is honoured as a floor; a hint longer than `maxDelayMs` means "stop retrying"
- `totalTimeoutMs` bounds the whole exchange, so a request can't take `attempts x timeout`
- When retries are exhausted the upstream's last response is returned unchanged

**Per route.** One upstream often serves a lookup that should take 200 ms and an export that takes 30 s, and no single timeout suits both. A route can set its own `timeoutMs` and `totalTimeoutMs`, change any of its upstream's `retry` settings (the rest are inherited; `{ "maxAttempts": 1 }` turns retries off), and take bodies larger than the global `maxBodyBytes`:

```json
"routes": [
  { "path": "/users", "upstream": "users" },
  { "path": "/users/export", "upstream": "users", "timeoutMs": 30000, "retry": { "maxAttempts": 1 } },
  { "path": "/users/avatars", "upstream": "users", "maxBodyBytes": 10485760 }
]
```

Bodies are held in memory against `limits.maxBufferedBytes`, so a body limit larger than that budget could never be met; start-up says so in a `config` log line.

**Load balancing.** An upstream may list several interchangeable backends:

```json
"users": { "urls": ["http://10.0.0.5:8080", "http://10.0.0.6:8080", "http://10.0.0.7:8080"], "balance": "least-pending" }
```

`round-robin` rotates; `least-pending` prefers the target with the fewest requests awaiting response headers, which copes better when instances differ in speed. A retry goes to a **different** target when one is available, even if other traffic has rotated the cursor back onto the one that just failed.

**Health checks.** The breaker is *passive*: it learns a target is bad only by sending it real requests that fail, so some clients always pay for the discovery. A health check is *active*:

```json
"users": {
  "urls": ["http://10.0.0.5:8080", "http://10.0.0.6:8080"],
  "healthCheck": { "path": "/healthz", "intervalMs": 5000, "timeoutMs": 2000, "unhealthyThreshold": 2, "healthyThreshold": 2 }
}
```

- Each target is probed on its own schedule (±10% jitter, so a fleet of gateways doesn't probe in lockstep), over a **dedicated connection** that doesn't queue behind proxied traffic.
- `unhealthyThreshold` consecutive failures take a target out of rotation; `healthyThreshold` consecutive successes put it back. A failure (timeout, refused, TLS error, unexpected status) in the middle of a recovery resets the count.
- **Re-admission also fast-forwards the circuit breaker.** A target that failed under traffic usually has its breaker open, with a cool-down set while it was failing. When the health check shows the target is back, an open breaker moves straight to half-open, so real requests probe it at once (and a failed probe re-opens it as usual) instead of a healthy instance sitting idle for the rest of `openDurationMs`. An unhealthy verdict never does this.
- **If every target is unhealthy, the verdict is ignored** and the breakers alone decide ("panic mode"): a wrong health path or a flapping probe must not be able to take a service offline.
- A target is trusted until proven otherwise, so startup doesn't black-hole traffic during the first interval.
- Probes are not requests: they don't touch the breaker, the rate limiter or the cache. They can carry extra headers (`headers`), use `HEAD`, and accept specific statuses (`expectStatus`; default any 2xx). The two mechanisms complement each other: the breaker still catches failures a probe misses (a healthy `/healthz` over a broken endpoint).

**Circuit breaker**, one per *target*, so one bad instance is ejected while the rest keep serving:

```
CLOSED ── failure rate >= threshold (with minimumRequests) ──▶ OPEN ── openDurationMs ──▶ HALF-OPEN
   ▲                                                            ▲                            │
   └────────────── halfOpenSuccesses probe successes ───────────┴──────── a probe fails ──────┘
```

Outcomes are counted over a rolling window. While every target of an upstream is open, requests get an immediate 503 with `Retry-After` and put zero load on it. Results from calls admitted before a state change are ignored, so a slow request started while closed can't be mistaken for a probe. A client hanging up is not counted as an upstream failure.

## Authentication

By default the gateway checks no credentials: an API key only picks a rate-limit budget. A route opts in to real authentication with `auth`:

```jsonc
"auth": {
  "jwt": { "issuers": [
    { "name": "partner", "alg": "RS256", "publicKeyFile": "/etc/gateway/partner.pem",
      "issuer": "https://idp.example.com", "audience": "orders-api", "maxLifetimeSeconds": 3600, "plan": "pro" },
    { "name": "internal", "alg": "HS256", "secret": "${INTERNAL_JWT_SECRET}", "audience": "orders-api" }
  ] },
  "forwardIdentity": true,      // tell the upstream who the caller is (X-Authenticated-*)
  "forwardCredentials": false   // ...and don't hand it the token/key it doesn't need
},
"routes": [
  { "path": "/orders", "upstream": "orders", "auth": { "methods": ["jwt", "api-key"] } },
  { "path": "/catalog", "upstream": "catalog", "auth": { "methods": ["jwt"], "required": false } }
]
```

- **Methods.** `api-key` needs a key from the registry (`rateLimit.apiKeys`); `jwt` needs a bearer token from a configured issuer; `client-cert` needs a TLS client certificate (see "Client certificates" below). With `required: true` (the default) a request with none gets a 401 and a `WWW-Authenticate` challenge; with `required: false` anonymous callers pass, but **a credential that is presented and wrong is always refused**, so an expired token never silently becomes "logged out" and a client can't probe tokens for free.
- **The authenticated identity is what gets rate limited.** A JWT subject has one budget however many tokens it mints, an issuer's `plan` scales it, and the same subject at two issuers is two identities. Failed attempts count against the per-address ceiling, which is checked *before* any credential is examined, so guessing keys or tokens is throttled at the price of one counter update.
- **The upstream is told who the caller is** in `X-Authenticated-Client`, `X-Authenticated-Method` and (for JWTs) `X-Authenticated-Issuer`. These headers are **always stripped from incoming requests**, on every route, and set only from a credential the gateway verified itself, so an upstream can trust them. Subjects are free text, so anything outside printable ASCII is percent-encoded rather than allowed to split the header block.
- **`forwardCredentials: false`** withholds only the credential the gateway consumed. Other schemes in `Authorization` (Basic, an opaque token meant for the upstream) pass through untouched, and routes without `auth` never have credentials touched.
- **Caching** an authenticated route keeps one entry per credential, and the token is verified on every request, hit or miss: an expired token gets nothing from the cache.

### Client certificates

With TLS on, the listener can ask callers for a certificate (mutual TLS), and routes can accept it as a credential:

```jsonc
"tls": {
  "certFile": "...", "keyFile": "...",
  "clientAuth": {
    "caFile": "/etc/gateway/callers-ca.pem",   // only certificates this CA issued count (never the system's CAs)
    "crlFile": "/etc/gateway/callers-crl.pem", // optional: revoked ones don't
    "allowedNames": ["billing", "reports"],    // optional: only these subject common names
    "required": false                          // true: no valid certificate, no TLS handshake, on any route
  }
},
"routes": [{ "path": "/internal", "upstream": "internal", "auth": { "methods": ["client-cert"] } }]
```

- OpenSSL checks the certificate against `caFile` and the revocation list during the handshake; the route then asks whether it passed. A certificate that was presented and did not (revoked, expired, issued by another CA, a name not in `allowedNames`, no single common name) is refused with 401, even on a route where a valid API key would also do, and the reason (`client_cert_cert_revoked`, ...) is logged.
- The caller is named by the certificate's subject common name, and its **rate-limit identity is the issuer and subject together**: a renewed certificate keeps its budget, and another trusted CA issuing the same name is a different caller.
- The upstream is told `X-Authenticated-Method: client-cert`, the name, the issuer's name, and the certificate's SHA-256 fingerprint in `X-Client-Cert-Sha256` (stripped from incoming requests, like the rest).
- With `required: false` the certificate is asked for but optional at the TLS level, so routes without `client-cert` are unaffected. Browsers with client certificates installed may then offer one; a `required: true` listener is for service-to-service traffic.
- The CA bundle and revocation list are read and checked at start-up and on every reload, and a reload applies them to new connections (a new CRL is how you revoke without a restart). Turning `clientAuth` on or off, or changing `required`, needs a restart.

### How JWTs are verified

Every classic JWT vulnerability is a case of letting the *token* decide how it is checked, so none of those decisions are left to it:

| Attack | Why it fails |
|---|---|
| `alg: none` (any capitalisation, with or without a signature) | The algorithm is taken from configuration. A token's `alg` is only *compared* against it, and `none` is not an algorithm any key is configured for |
| RS256 public key used as an HMAC secret | A token claiming HS256 is never checked against an RS256 key; the algorithm must match the one the key was provisioned for |
| Signature stripped, truncated, or from another key | Verified (HMAC with a constant-time compare, RSA, or ECDSA over the raw R\|\|S encoding a JWS requires) before any claim is read |
| Tampered claims | The signature covers them |
| Replayed after expiry; not-yet-valid; wrong audience or issuer | `exp` is mandatory and must be a number (not the string `"9999999999"`), `nbf`/`iat` are checked, `audience` and `issuer` are matched exactly, and `maxLifetimeSeconds` caps how long a stolen token stays useful |
| Duplicate member names (`{"sub":"a","sub":"admin"}`), which different parsers read differently | Rejected. The upstream may receive the very same token and parse it differently |
| `crit` extensions, `b64: false` | Rejected: we implement none, and RFC 7515 says to refuse what you don't understand |
| Weak keys | HMAC secrets under 32 bytes, RSA under 2048 bits and EC other than P-256 are refused **at startup**, naming the issuer |
| Oversized tokens | Rejected at 8 KB before any parsing or cryptography |

Keys are static configuration. To rotate, list the old and new key as two entries (with distinct `kid`s, or the same `issuer`) and remove the old one later. There is deliberately **no JWKS fetching**: it adds an outbound request, a cache with its own staleness rules, and an SSRF surface. Failure reasons (`expired`, `bad_signature`, ...) go to the log, keyed by request id, and never to the client; tokens are never logged.

## Security model

What the gateway defends, and how. Everything here has a test; the table points at them.

| Threat | Defence | Test |
|---|---|---|
| Forged identity headers (`X-Authenticated-*`) | Stripped from every incoming request; set only from a credential the gateway verified | `gateway.auth.test.ts` |
| Forged, replayed or confused JWTs | Algorithm and key come from configuration, strict claim checks, duplicate-member and `crit` rejection, weak keys refused at startup | `jwt.test.ts` |
| Guessing API keys or tokens | The per-address ceiling is consumed before any credential is examined, failures included | `gateway.auth.test.ts` |
| Dodging limits by rotating `X-API-Key` | Key registry (digests), unregistered keys share their address's budget, per-address ceiling | `gateway.security.test.ts` |
| Reaching health/metrics through the proxy | Admin is a separate listener, loopback by default, never proxied (even with a catch-all route); any other bind requires a bearer token (constant-time compare) | `gateway.security.test.ts`, `config.security.test.ts` |
| Cache poisoning via reflected headers | Header allowlist on cacheable fetches, all keyed; rewrite headers dropped | `gateway.security.test.ts` |
| Spoofed `X-Forwarded-*` / `Forwarded` / `X-Real-IP` | Rebuilt by the gateway unless behind trusted proxies; `X-Forwarded-Host` comes from config, never the client's `Host` | `gateway.security.test.ts` |
| Many addresses from one IPv6 allocation | Grouped by /64 | `ip.test.ts`, `gateway.security.test.ts` |
| Request smuggling / ambiguous framing | Node's strict parser rejects conflicting lengths, obfuscated `Transfer-Encoding`, folding, bare LF, control chars; nothing ambiguous is forwarded | `hardening.test.ts` |
| Header injection via path/query | Encoded CR/LF stays inert data | `hardening.test.ts` |
| SSRF through an absolute-form request target | Only the path is used; the gateway never connects where the client points | `hardening.test.ts`, `gateway.e2e.test.ts` |
| Slowloris, connection floods | `headersTimeoutMs`, `requestTimeoutMs`, `maxConnections`, and an opt-in per-address connection cap (off by default: a load balancer shares one address) | `gateway.security.test.ts`, `hardening.test.ts` |
| Memory exhaustion | `maxInFlight` (503 when exceeded), `maxBufferedBytes` across all in-flight bodies, `maxBodyBytes`, bounded limiter key space, bounded cache | `gateway.security.test.ts`, soak test |
| Information disclosure in errors | Generic client-facing errors with a request id; detail logged against that id | `gateway.security.test.ts` |
| Unsafe methods | Allowlist (default excludes `TRACE`/`CONNECT`) with `405` + `Allow` | `gateway.security.test.ts` |
| Plaintext Redis, secrets in config | `rediss://` + private CA support; startup notes when Redis is plaintext to a non-loopback host; keys held as digests | `config.security.test.ts` |
| A web page making a browser reconfigure the gateway (`POST 127.0.0.1:9090/_gateway/reload`) | Reload is `POST` only, behind the admin token, and refused when the request carries a browser's `Origin` or `Sec-Fetch-Site` | `gateway.reload.test.ts` |
| A broken file taking the gateway down on reload | Reloads are all or nothing: the whole configuration and every file it names are checked before anything is swapped | `gateway.reload.test.ts`, `reload.e2e.test.ts` |
| Clients steering or flooding your traces | Strict `traceparent` validation; `tracestate` length-capped and forwarded only with its own trace; `trustIncoming: false` at an untrusted edge | `trace.test.ts`, `gateway.trace.test.ts` |
| Lookalike or revoked client certificates | Only `tls.clientAuth.caFile` is trusted, revocation list honoured, a bad certificate refused even beside a valid key; identity is issuer and subject together | `gateway.clientCert.test.ts` |
| Oversized, floods of, or malformed WebSocket messages | `maxMessageBytes` and `messageRate` per connection, checked on each frame header before the frame is relayed; protocol violations closed with 1002 | `wsFrames.test.ts`, `gateway.wsLimits.test.ts` |
| One HTTP/2 connection taking everything; stalled streams | `maxConcurrentStreams` per connection with every stream under `maxInFlight`; a deadline per stream; a stalled reader's stream reset, not its connection | `gateway.http2.test.ts` |

Startup prints a `security` log line for each risky-but-legal setting (header-keyed limits with no registry or ceiling, plaintext Redis off-box, a cache with no `varyHeaders`, an admin listener bound off loopback).

**Not covered, by design.** Authentication is credential checking, not an identity provider: there are no sessions, no OAuth flows or token introspection, no JWKS fetching, and no revocation list (keep `maxLifetimeSeconds` short instead). Routes without `auth` check nothing. There is no WAF or body inspection, and no DDoS protection beyond the caps above: volumetric attacks need to be absorbed upstream of this process.

## TLS

The proxy listener can terminate TLS itself, so the gateway can face clients directly (otherwise it is plain HTTP, meant to sit behind a load balancer that terminates TLS):

```json
"tls": { "certFile": "/etc/gateway/tls/fullchain.pem", "keyFile": "/etc/gateway/tls/privkey.pem", "minVersion": "TLSv1.2", "hstsMaxAgeSeconds": 31536000 }
```

- **TLS 1.2 or 1.3 only.** `minVersion` can raise the floor to 1.3; TLS 1.0 and 1.1 cannot be configured at all.
- **Renewals without a restart.** A configuration reload (`kill -HUP <pid>` on POSIX, or `POST /_gateway/reload`; see "Reloading without a restart") re-reads the files and uses the new certificate for new connections; open connections keep the old one until they close. The new pair is validated *before* anything is swapped, so a half-finished renewal (a new certificate with the old key, a truncated file, a missing file) is logged as an error and **the previous certificate stays in service**. `minVersion` and `hstsMaxAgeSeconds` change the same way; turning TLS on or off takes a restart.
- **Bad material fails fast at startup**, naming the setting: a missing file, a key that doesn't match the certificate, a wrong or missing passphrase (`passphrase` takes `${ENV_VAR}`). Errors never contain key material.
- **Handshake timeout.** A client that connects and never completes the TLS handshake is dropped after `limits.headersTimeoutMs`, not Node's default two minutes. Failed handshakes are counted by cause in `gateway_tls_handshake_failures_total`.
- **Expiry is visible.** `gateway_tls_certificate_expiry_seconds` goes negative when the certificate has lapsed (alert on it); the gateway logs a warning under 14 days and an error once expired, at startup and on every reload.
- **`X-Forwarded-Proto`** tells the upstream the truth: `https` for clients on this listener. `hstsMaxAgeSeconds` adds `Strict-Transport-Security`; leave it unset until you are certain every client can use HTTPS.
- The admin listener stays plain HTTP on loopback; its bearer token is not meant to cross a network.
- **Client certificates** can be asked for and used to authenticate callers (`clientAuth`; see "Authentication").

**HTTP/2.** With `"http2": true` the listener speaks HTTP/2 to clients that offer it during the TLS handshake (ALPN) and HTTP/1.1, WebSocket upgrades included, on the same port to the rest. Every request takes the same pipeline whichever protocol it came in on; upstreams are still called over HTTP/1.1. Where the protocols differ:

- One connection carries many requests at once, up to `limits.maxConcurrentStreams` (100), announced in its SETTINGS; each request still counts toward `maxInFlight`. A reload applies a new limit to new connections.
- HTTP/2 has no `Connection` header. Where HTTP/1.1 would close the connection after refusing an upload, the stream is reset once the response is complete (NO_ERROR, which tells the client to stop sending); the connection and its other requests carry on.
- A response abandoned part-way resets its stream with an error code: `CANCEL` for a client that stopped reading, `INTERNAL_ERROR` for an upstream that died mid-body. Never `NO_ERROR`, which a client reads as a normal end: a truncated body must not pass for a whole one.
- `limits.requestTimeoutMs` cancels a request not finished in time (just that stream). An idle connection is closed with GOAWAY after `keepAliveTimeoutMs`; shutdown sends GOAWAY to every connection, lets the requests in progress finish, and cuts what is left after `shutdownGraceMs`.
- The access log has `protocol` (`h2` or `http/1.1`), and `gateway_http2_connections` counts HTTP/2 connections. Turning `http2` on or off needs a restart.

**Towards upstreams.** An `https://` upstream is verified against Node's default CAs, or only against `tls.caFile` for one signed by a private CA; there is deliberately no option to skip verification. For an upstream that only accepts callers it can identify, the gateway presents a client certificate (mutual TLS):

```json
"payments": {
  "url": "https://payments.internal:8443",
  "tls": { "caFile": "/etc/gateway/internal-ca.pem", "certFile": "/etc/gateway/client.pem", "keyFile": "/etc/gateway/client-key.pem" }
}
```

It is presented on every connection to that upstream, health probes included. The pair is checked like the listener's, at start-up and on every reload (a key that doesn't match, a wrong passphrase or an unreadable file is refused, naming the setting), and a reload after the files change moves the upstream onto the new certificate.

## WebSockets

A route proxies WebSocket connections only if it asks to:

```json
{
  "path": "/chat", "upstream": "chat",
  "auth": { "methods": ["api-key", "jwt"] },
  "websocket": {
    "allowedOrigins": ["https://app.example.com"],
    "idleTimeoutMs": 60000,
    "maxDurationMs": 3600000,
    "maxConnections": 1000,
    "maxMessageBytes": 65536,
    "messageRate": { "perSecond": 20, "burst": 50 }
  }
}
```

**What is checked, in order, before the upstream is bothered.** Opening a connection is an ordinary request as far as the gateway's defences go:

1. **Shape.** `GET`, `Upgrade: websocket` (and nothing else: `h2c` and every other protocol upgrade is refused, because they would let a client talk to the upstream in ways none of these checks saw), version 13, a well-formed key, no body. Anything else is a `400`/`405`/`426` and never reaches the upstream. A route without `websocket` answers `404` to an upgrade.
2. **Origin.** A browser attaches the user's cookies to a WebSocket opened by *any* page on *any* site, and the `Origin` header is the only thing that says which site that was (a page cannot forge it). Without a check, a page on `evil.example` can open a socket to your service as your logged-in user: cross-site WebSocket hijacking. The `Origin` must be in `allowedOrigins` (exact match, case-insensitive; `Origin: null` and a repeated header are refused). Clients that send no `Origin` are scripts and native apps, not browsers, and are admitted. `allowAnyOrigin` opts out and the startup log says so. This runs *before* authentication and rate limiting, so a hostile page can neither burn a user's quota nor probe credentials.
3. **Address ceiling, authentication, route rate limit** (with the route's `cost`), exactly as for HTTP. Opening a connection spends from the budget; messages on an open connection do not (they have `messageRate` instead; see below).
4. **Capacity.** `maxConnections` per route and the global in-flight limit answer `503` rather than queueing.

Browsers cannot set `Authorization` or `X-API-Key` on a `new WebSocket(...)`, so header credentials suit servers and native clients. For a browser page, authenticate with a cookie at the upstream (a route without `auth`, or `required: false`), and rely on `allowedOrigins` to keep other sites out.

**The upstream's side.** The handshake is sent with the gateway's own forwarding headers and verified identity (client-supplied `X-Authenticated-*` are stripped, as always), and balanced, retried and circuit-broken like a `GET`: a refused connection moves to the next target, a `503` is retried per the retry policy, an upstream that answers with an ordinary refusal (a `401`, a `404`) has its status, headers and body relayed. The upstream's `101` is not taken on trust: the `Sec-WebSocket-Accept` must match the client's key, and it may only select a subprotocol the client offered and an extension the client asked for; otherwise the connection is refused with `502`, counted as an upstream failure and not retried.

**After the `101`, frames are relayed byte for byte.** The gateway reads each frame's header as it passes (where frames begin and end, how big each message is), never its payload, which is neither decoded nor altered. Subprotocols and extensions such as `permessage-deflate` are negotiated end to end. What it enforces:

- **Per-message limits on the client** (the upstream's messages are not held to them):
  - `maxMessageBytes`: the largest message, in payload bytes, all frames of a fragmented message counted. With `permessage-deflate` negotiated this is the compressed size; the upstream must still bound what a message inflates to.
  - `messageRate`: messages (pings included) per connection, `perSecond` on average and `burst` at once.
  - The RFC's rules for client frames: masked, a known opcode, control frames whole and at most 125 bytes, continuations only inside a message, a sane 64-bit length.
  - A client that breaks one is stopped **before any byte of the offending frame reaches the upstream**. The upstream gets a close frame with the code: `1009` message too big, `1008` too many messages, `1002` protocol error. The client gets the upstream's remaining replies to its earlier messages, then the gateway's close frame with the same code in place of the upstream's own (or at the next frame boundary after a second, if the upstream does not answer).
- **Connections:** who may open one, how many at once (`maxConnections`), how long a quiet one lives (`idleTimeoutMs`: no traffic in either direction, so ping/pong keeps a healthy one alive) and how long any lives (`maxDurationMs`).
- A peer that hangs up and never finishes closing is cut off after a second; neither the HTTP header and request timeouts nor keep-alive settings apply to an upgraded connection.
- **Shutdown does not drain** them (there is no response to wait for): open connections are closed immediately and their clients reconnect, to another instance in a fleet.

Observability: the handshake is one access-log line with status `101`; when the connection ends, a `websocket closed` line has the reason (`client`, `upstream`, `idle`, `max_duration`, `shutdown`, `error`, `message_too_large`, `message_rate`, `protocol_error`), lifetime and bytes each way. Metrics: `gateway_websocket_connections`, `gateway_websocket_closed_total{reason}` and `gateway_websocket_bytes_total{direction}`.

## Scaling across cores

One gateway process runs the request path on one thread. To use every core of a machine, turn on cluster mode:

```json
"cluster": { "workers": 4 }     // or "auto" for one per core; WORKERS=4 in the environment overrides the file
```

The entrypoint then becomes a **primary** that runs no gateway of its own and starts that many **workers**, each a complete gateway sharing the same port (`node:cluster`; on Linux the primary hands each new connection to the next worker in turn, and a keep-alive connection stays with the worker it landed on).

- **It requires Redis.** In-memory limits are per process, so N workers would each give a client the full limit and allow N times it. A config with more than one worker and no `redis` section is rejected at startup. With Redis the limit holds across workers: the integration test sends 20 requests on fresh connections through 3 workers against a limit of 5 and sees exactly 5 admitted.
- **Workers are kept alive.** A worker that dies is replaced after 0.5 s, and the wait doubles (up to 30 s) while it keeps dying young, so a crash loop cannot spin the machine. If a worker cannot start at all (three attempts), start-up is abandoned and the process exits 1 where a deploy will see it. Workers also exit if the primary goes away.
- **The admin listener lives in the primary and speaks for all workers.** `/_gateway/metrics` has every worker's series under a `worker` label (counters are not pre-summed; use `sum without (worker) (...)`) plus the primary's own (`worker="primary"`: `gateway_cluster_workers`, `gateway_cluster_worker_ready{slot}`, `gateway_cluster_worker_restarts_total{slot}` and its process metrics). `/_gateway/health` has a `cluster` summary and each worker's full report, and says `degraded` if one does not answer. `/_gateway/live` is 200 while at least one worker is ready. The token applies as before. Log lines from workers carry a `worker` field.
- **Some state is per worker, and should be sized for one worker:** the response cache (so N copies, and a lower hit rate), circuit breakers and active health checks (each worker probes each target), and the `limits` (connections, in-flight requests, buffered bytes) and WebSocket `maxConnections`.
- **Shutdown and reloads.** `SIGTERM`/`SIGINT` to the primary has every worker finish its in-flight requests (up to `shutdownGraceMs`), and it exits 0 once they are gone. `SIGHUP` to the primary (POSIX), or `POST /_gateway/reload`, reloads the configuration in every worker: the primary checks the file first, then each worker applies it all or nothing, and the answer lists how each one fared (see "Reloading without a restart").

Measured on the machine described under "Performance" (Linux container, Redis limiter, 128 connections, median of 3):

| Workers | req/s | vs one | p50 / p99 ms |
|---:|---:|---:|---:|
| 1 (no cluster) | 5,665 | 1.0x | 21.5 / 34.6 |
| 2 | 10,073 | 1.8x | 11.7 / 22.4 |
| 4 | 14,709 | 2.6x | 8.1 / 18.9 |
| 8 | 15,593 | 2.8x | 7.3 / 22.4 |

Scaling is near-linear to two workers, then limited by the machine rather than the design: the load generator (6 threads), the upstream, Redis and the gateway share 16 hardware threads (8 cores), so the gateway's CPU per request climbs from 219 µs to 569 µs at 8 workers as they contend with everything else, and throughput stops following. On a machine where the load comes from elsewhere, expect to get closer to one core's worth per worker until Redis (one thread) becomes the limit.

## Behaviour at the edges

| Situation | What happens |
|---|---|
| `HEAD` | Upstream headers are relayed (including `Content-Length`) with no body. `HEAD` is retried like other idempotent methods, and never reads or fills the cache. |
| Chunked upload | The body is buffered and forwarded with an exact `Content-Length`, so it can be replayed on retry. Past `maxBodyBytes` the client gets a 413 with `Connection: close`, even with no `Content-Length` declared. |
| Upstream dies mid-body | The status line has already gone out, so the client's connection is cut rather than ended normally. A truncated body is never presented as complete, never cached, and is counted as a 502 in metrics and logs. |
| HTTPS upstream | Verified against Node's default CAs, or only the bundle in `tls.caFile`. There is deliberately no option to skip verification. TLS failures get a 502 and aren't retried, since a bad certificate won't fix itself. |
| Every upstream connection busy | Waiting for a free connection to an upstream (`upstreams.*.maxConnections`) counts against the attempt timeout like connecting does, so a saturated upstream gives callers a 504 on time instead of leaving them queued behind other requests. |
| Client stops reading its response | A client that accepts none of a response for `limits.responseStallTimeoutMs` (30 s) is dropped (`gateway_requests_shed_total{reason="slow_reader"}`, status 499 in the log), freeing the upstream connection. A client that is merely slow keeps its connection: the clock restarts whenever it takes data. The same holds for large cached entries, which are written in slices. If the dropped client was the one fetching a cache entry, the clients coalesced behind it wait at most that long before one of them takes over. |
| Shutdown (`SIGTERM` / `SIGINT`) | The listener closes and idle keep-alive connections drop at once. In-flight requests finish, with `Connection: close`. Each connection closes as soon as its response completes, and anything still running after `shutdownGraceMs` is cut off. |
| Configuration reloaded mid-request | The request finishes under the configuration it started with (route, upstream, timeouts, limits). An upstream the reload replaced closes its connections only once its last request has finished. |

## Configuration

See [`gateway.config.json`](gateway.config.json) for a working example. The schema is strict: unknown keys are errors, so a typo fails at startup instead of being ignored, and cross-references (unknown plan, unknown route id, duplicate key, `requireKey` with no keys, an exposed admin listener with no token) are validated too. String values support `${VAR}` and `${VAR:-default}`; `PORT`, `ADMIN_PORT`, `REDIS_URL` and `WORKERS` override the file.

To try a configuration before deploying it, `node dist/index.js gateway.config.json --check` checks it and every file it names (certificates and keys, CA bundles, JWT keys), prints the warnings start-up would print, and exits 0 if the gateway would start or 1 if not, without binding a port or contacting anything. `--help` lists the options.

| Section | Key | Default | Meaning |
|---|---|---|---|
| root | `port`, `host` | `8080`, `0.0.0.0` | Proxy listen address |
| root | `maxBodyBytes` | 1 MiB | Larger bodies get 413 |
| root | `shutdownGraceMs` | `10000` | How long in-flight requests get to finish on shutdown |
| root | `allowedMethods` | `GET HEAD POST PUT PATCH DELETE OPTIONS` | Anything else gets 405 |
| root | `forwardedHost` | unset | The `X-Forwarded-Host` sent upstream when the gateway is the edge |
| `admin` | `enabled`, `host`, `port`, `token` | `true`, `127.0.0.1`, `9090`, unset | Health, metrics and reload listener. A non-loopback `host` requires a `token` (16+ chars) |
| `cluster` | `workers` | `1` | Worker processes (a number, or `"auto"` for one per core; `WORKERS` overrides). More than one requires `redis`; see "Scaling across cores" |
| `tls` | `certFile`, `keyFile`, `passphrase`, `minVersion`, `hstsMaxAgeSeconds`, `http2` | off; `TLSv1.2`; unset; `false` | Terminate TLS on the proxy listener, and optionally speak HTTP/2 (see "TLS") |
| `tls.clientAuth` | `caFile`, `crlFile`, `allowedNames`, `required` | off; unset; any; `false` | Ask callers for certificates, for routes using `client-cert` (see "Client certificates") |
| `redis` | `url` **or** `sentinel` (`name`, `nodes`, `password`) **or** `cluster` (`nodes`) | `-` | Omit the section for in-memory limiting. See "Redis deployments" |
| `redis` | `username`, `password`, `tls`, `keyPrefix`, `commandTimeoutMs`, `caFile` | unset, unset, `false`, `gw:`, `100`, unset | Credentials and TLS for sentinel/cluster nodes (with `url`, put them in the URL: `rediss://`); `caFile` for a private CA |
| `rateLimit` | `identityHeader` | `x-api-key` | Header carrying the API key |
| `rateLimit` | `trustedProxyHops` | `0` | Take the Nth-from-right `X-Forwarded-For` entry |
| `rateLimit` | `failureMode` | `local` | `local`, `open` or `closed` |
| `rateLimit` | `default`, `ip` | none | Default rule for routes; per-address ceiling across routes |
| `rateLimit` | `apiKeys`, `plans`, `requireKey`, `anonymousMultiplier` | `[]`, `{}`, `false`, `1` | Key registry (see above) |
| `auth` | `jwt.issuers[]`, `forwardIdentity`, `forwardCredentials` | none, `true`, `true` | Token verification and what the upstream is told. Issuer: `name`, `alg`, `secret` / `publicKey` / `publicKeyFile`, `kid`, `issuer`, `audience`, `leewaySeconds` (30), `maxLifetimeSeconds`, `plan` |
| `routes[].auth` | `methods`, `required` | none, `true` | Any of `"jwt"`, `"api-key"`, `"client-cert"`; see "Authentication" |
| `rateLimit` | `ipv6Prefix` | `64` | IPv6 grouping |
| `limits` | `maxConnections`, `maxConnectionsPerIp` | `10000`, `0` (off) | Connection caps. The per-address cap is off by default because a load balancer opens every connection from one address; set it when clients connect to the gateway directly |
| `limits` | `maxInFlight`, `maxBufferedBytes` | `2000`, 64 MiB | Load shedding (503) |
| `limits` | `maxHeaderBytes`, `headersTimeoutMs`, `requestTimeoutMs`, `keepAliveTimeoutMs` | `16384`, `15000`, `60000`, `65000` | Protocol limits (on HTTP/2 too: header block size, per-stream request deadline, idle connection) |
| `limits` | `maxConcurrentStreams` | `100` | HTTP/2 only: requests one connection may have in progress at once |
| `limits` | `responseStallTimeoutMs` | `30000` | Drop a client that has taken none of its response for this long (see "Behaviour at the edges") |
| `tracing` | `enabled`, `trustIncoming`, `sampleRatio` | `true`, `true`, `1` | W3C trace context (see "Observability"). `trustIncoming: false` starts a new trace for every request, for an edge facing clients you don't trust |
| `tracing.otlp` | `endpoint`, `headers`, `caFile`, `serviceName`, `batchSize`, `flushIntervalMs`, `maxQueueSpans`, `timeoutMs` | off; `{}`; unset; `api-gateway`; `512`; `5000`; `4096`; `10000` | Export spans to an OpenTelemetry collector (OTLP/HTTP, JSON) |
| `upstreams.*` | `url` **or** `urls`, `balance` | `-`, `round-robin` | One backend, or several |
| `upstreams.*` | `timeoutMs`, `totalTimeoutMs` | `5000`, unset | Per-attempt and overall timeouts |
| `upstreams.*.tls` | `caFile`, `certFile`, `keyFile`, `passphrase` | unset | `caFile`: PEM bundle for a privately signed `https://` upstream, replacing the default trust store for that upstream. `certFile` and `keyFile`: a client certificate to present to it (mutual TLS; see "TLS") |
| `upstreams.*.healthCheck` | `path`, `method`, `intervalMs`, `timeoutMs`, `unhealthyThreshold`, `healthyThreshold`, `expectStatus`, `headers` | off; `GET`, `5000`, `2000`, `2`, `2`, any 2xx, none | Active probing. `timeoutMs` must be below `intervalMs`; probes may not set `Host`, framing or `Upgrade` headers |
| `upstreams.*.retry` | `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `retryOnStatus`, `retryNonIdempotent` | `3`, `100`, `2000`, `[502,503,504]`, `false` | |
| `upstreams.*.breaker` | `failureRateThreshold`, `minimumRequests`, `windowMs`, `openDurationMs`, `halfOpenMaxCalls`, `halfOpenSuccesses` | `0.5`, `10`, `10000`, `10000`, `1`, `2` | Applied per target |
| `routes[]` | `path`, `upstream`, `id`, `methods`, `stripPrefix`, `rateLimit`, `cost`, `cache` | `cost`: `1` | Longest whole-segment prefix wins; `rateLimit: false` disables limiting; `cost` is what a request spends of the budget |
| `routes[]` | `timeoutMs`, `totalTimeoutMs`, `retry`, `maxBodyBytes` | the upstream's, or the global `maxBodyBytes` | Per-route policy (see "Retries, balancing and the circuit breaker"). `retry` takes any of the upstream's retry settings; each one given replaces the upstream's |
| `routes[].websocket` | `allowedOrigins`, `allowAnyOrigin`, `idleTimeoutMs`, `maxDurationMs`, `maxConnections` | `[]`, `false`, `60000`, unset, `1000` | Proxy WebSocket upgrades on this route (see "WebSockets"). Off unless present; cannot be combined with `cache` |
| `routes[].websocket` | `maxMessageBytes`, `messageRate` (`perSecond`, `burst`) | unset (no limit) | Limits on each message a client sends; `burst` defaults to `perSecond` rounded up |
| `routes[].cache` | `ttlMs`, `varyHeaders`, `forwardHeaders`, `staleWhileRevalidateMs`, `staleIfErrorMs` | `-`, `[authorization, x-api-key]`, `[accept, accept-language]`, `0`, `0` | See "Serving stale" and "Cache poisoning" |

### Reloading without a restart

Edit the file, then send `SIGHUP` (POSIX), or ask the admin listener, which works everywhere:

```bash
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" localhost:9090/_gateway/reload
```

The file is read again exactly as at start-up, environment overrides included, and checked in full, every file it names included (certificates, keys, CA bundles, JWT keys). **All or nothing:** if anything is wrong, nothing changes, the previous configuration stays in force, and the reason is logged and returned (`422 {"ok":false,"error":"..."}`). Otherwise it takes effect at once, and the answer says what changed: `200 {"ok":true,"generation":2,"changed":["rateLimit","routes"],"restartRequired":[]}`.

- **Requests in flight don't notice.** Each one finishes under the configuration it started with; new requests get the new one. Open WebSockets are left alone.
- **Upstreams** whose settings and certificate files didn't change are kept as they are, with their connections, circuit breakers and health verdicts. One that changed is replaced: its requests in flight finish on the old connections, which close after the last one; its cached responses are dropped; its health checks stop as the new one's start.
- **Rate limits.** API keys, plans and overrides apply from the next request (a withdrawn key stops working at once). A rule that didn't change keeps its counts. A changed rule starts afresh in memory; in Redis its counts carry over and are read under the new rule (as during a rolling deploy), unless the algorithm itself changed.
- **The cache** is kept, unless its size limits changed.
- **Some settings need a restart**, because they belong to something bound once: `port`, `host`, `redis`, `cluster`, the admin listener's address (its `token` does change), turning TLS on or off (the certificate, `minVersion` and HSTS do change), turning `tls.http2` on or off, turning `tls.clientAuth` on or off or changing its `required` (its CA bundle, revocation list and allowed names do change) and `limits.maxHeaderBytes`. A reload keeps their running values, applies everything else, and lists them under `restartRequired` and in the log.
- **In cluster mode** the primary checks the file once, then every worker reloads on its own; the answer has each worker's result, and is `200` only if every one succeeded.
- **The endpoint takes `POST` only**, needs the admin token when one is set, and refuses any request a browser sent (one carrying `Origin` or `Sec-Fetch-Site`): otherwise any web page could make its visitor's browser post to `127.0.0.1:9090`.

`gateway_config_reloads_total{result}` counts reloads, and `gateway_config_generation` (also `configGeneration` in `/_gateway/health`) says which configuration is running: 1 at start-up, plus one per successful reload. To try a file before reloading it, use `--check`.

## Observability

Served by the **admin listener** (default `127.0.0.1:9090`), not the proxy port:

- `GET /_gateway/live`: always open, says only `{"status":"ok"}`. Liveness: is the process working? Point a container health check or a Kubernetes `livenessProbe` here.
- `GET /_gateway/ready`: always open. Readiness: should traffic be sent here? `200 {"status":"ready"}` while serving; `503 {"status":"draining"}` from the moment shutdown begins, while the process is still alive and finishing the requests it has. Point a load balancer or `readinessProbe` here and the instance is taken out of rotation before it starts refusing connections, which `live` (rightly) never does. In cluster mode it is also 503 when no worker is ready.
- `GET /_gateway/health`: circuit state per upstream and per target, in-flight and connection counts, Redis status, cache stats, the configuration generation in force (token-gated when one is set)
- `POST /_gateway/reload`: re-read and apply the configuration (see "Reloading without a restart")
- `GET /_gateway/metrics`: Prometheus text (token-gated when one is set):
  - requests by route/status, latency histogram, rate-limited/degraded/unauthorized/shed counts, authentication outcomes by route and method;
  - TLS handshake failures by cause and certificate expiry;
  - open WebSockets per route, closes by reason, bytes relayed each way;
  - in cluster mode, every series per worker under a `worker` label, plus worker readiness and restarts;
  - cache outcomes and size, stale copies served and background refreshes; upstream attempts by target and outcome; circuit state and transitions per target; health-check verdict (`gateway_target_healthy`), probe results and verdict changes;
  - connections, in-flight requests, buffered request bytes;
  - configuration reloads by result, and the generation in force;
  - HTTP/2 connections; spans exported to, and dropped on the way to, the trace collector;
  - process RSS, heap, external memory, CPU seconds, and event-loop delay.
- One JSON access-log line per request with `requestId`, `traceId`, `protocol` (`h2` or `http/1.1`), route, status, duration, cache result, attempt count and the registered key *name* (never the key). `X-Request-Id` is propagated upstream (client-supplied ids are accepted only if they're safe to log).
- **Trace context** ([W3C](https://www.w3.org/TR/trace-context/)). Every forwarded request, WebSocket handshakes and background cache refreshes included, carries a `traceparent` naming the gateway's hop as the parent: the caller's trace continued if it sent a valid one, otherwise a new one. The caller's `tracestate` travels only with its own trace. With the trace id in the access log, a request can be followed from the gateway into the services behind it. At an edge facing clients you don't trust, `tracing.trustIncoming: false` starts a new trace for every request, so a client can't attach its requests to your traces; `tracing.enabled: false` passes the headers through untouched.
- **Spans, exported to OpenTelemetry** (`tracing.otlp`), over OTLP/HTTP with a JSON body (no extra dependency):

  ```json
  "tracing": { "sampleRatio": 0.1, "otlp": { "endpoint": "http://otel-collector:4318/v1/traces", "headers": { "x-api-key": "${OTEL_KEY}" } } }
  ```

  - One **server** span per request, named by method and route prefix (`GET /orders`), with OpenTelemetry's HTTP attributes plus the gateway's own (route, request id, upstream, cache result, caller name, rate-limited, auth failure); a 5xx makes it an error.
  - One **client** span per upstream attempt, from sending the request to its response headers. Each attempt is its own hop in `traceparent`, so the upstream's spans hang off the attempt that reached it, and a retried request shows each try (`http.request.resend_count`), the failed ones marked as errors.
  - One **internal** span per background cache refresh, beneath the request that set it off.
  - `sampleRatio` keeps that share of the traces started here (by trace id, so the same answer every time for a trace); a trace continued from a caller keeps the caller's decision. The decision goes downstream in the flags, so the services behind record the same traces.
  - **Exporting never slows or fails a request.** Spans wait in a bounded queue (`maxQueueSpans`) and go out in batches (`batchSize`, at least every `flushIntervalMs`). A collector that is slow, refusing or down costs dropped spans, counted in `gateway_trace_spans_dropped_total{reason}` (`queue_full`, `export_failed`), never memory or latency. Shutdown sends what is still queued; a reload that changes the collector moves to it.
  - Spans carry request paths and the names of authenticated callers, so start-up warns about a plain-HTTP collector off the machine.

## Performance

Measured on one laptop (16 logical cores, i7-11800H, Node 24) running everything at once: load generator, gateway, upstream and Redis. The Linux numbers are from a `node:24-alpine` container on WSL2, which is the realistic deployment shape; Windows host numbers are alongside. Each figure is the median of three 8-second runs after a warm-up, at 64 connections. Full tables with ranges, tail latency and CPU are in [`docs/benchmark-results.md`](docs/benchmark-results.md).

**Read these as relative costs on this machine, not as capacity planning.** The same build varied by nearly 2x between runs when other work was active on the host. Throughput comparisons below were taken back to back; absolute figures will differ on yours.

| Scenario (one gateway process, 64 connections) | Linux req/s | gateway CPU µs/req | Windows req/s | gateway CPU µs/req |
|---|---:|---:|---:|---:|
| Upstream directly, no gateway | 49,040 | – | 28,249 | – |
| *Reference: a bare Node proxy (`http.request` + `pipe`)* | *9,243* | – | *5,968* | – |
| Gateway, no policy | 6,300 | 189 | 4,493 | 220 |
| + access log (JSON line per request) | 5,811 | 205 | 3,983 | 254 |
| + limiter, in memory: token bucket / sliding log / sliding counter | 5,901 / 5,917 / 5,920 | ~202 | 3,980 / 4,098 / 4,045 | ~245 |
| + limiter + per-address ceiling | 5,421 | 222 | 3,756 | 272 |
| + limiter in Redis: token bucket / sliding log / sliding counter | 5,615 / 5,696 / 5,184 | 216–233 | 3,938 / 3,923 / 3,826 | 262–286 |
| Cache hit | 15,585 | 72 | 12,744 | 71 |
| Request rejected with 429 | 16,866 | 65 | 10,869 | 84 |
| 64 KiB response body | 3,474 | 419 | 2,628 | 461 |

Latency of a single request with no queueing (1 connection, Linux): direct **0.10 ms** p50 / 0.33 ms p99; through the gateway **0.33 ms** / 0.95 ms; with an in-memory limiter 0.35 ms / 0.95 ms; with the limiter in Redis 0.56 ms / 1.23 ms. At 64 connections the p50 is 10 ms, but that is queueing in a closed loop at saturation, not what a single request costs.

What the numbers say:

- **One gateway process is one core.** It saturates at roughly 6,000 proxied requests per second on this machine (Linux). That is about two thirds of what a bare Node proxy manages here (9,200/s). In single-thread time that is roughly 160 µs per request against 108 µs: routing, identity, limiting, metrics, retry and breaker bookkeeping and body buffering cost about 50 µs on top of Node's own HTTP floor, most of which is socket writes and parsing that any proxy pays. To go faster, use cluster mode or run more instances; the limiter state is in Redis precisely so that works (measurements under "Scaling across cores").
- **The limiter is cheap; which algorithm you pick doesn't matter for speed.** In memory it adds about 13 µs of CPU (7%) on Linux, and the three algorithms are indistinguishable at saturation. Redis adds roughly 30–60 µs of gateway CPU for the command and reply handling, and about 0.2 ms to a single request here (Docker over WSL2; a Redis on a real network will differ).
- **The cost of "no" is small.** A request rejected with 429 never reaches the upstream and costs about a third of a proxied one, so shedding abusive traffic is cheaper than serving it.
- **Cache hits are the big lever**: about 2.5x the proxied throughput.
- **Access logging costs about 8% on Linux** (15% on this Windows host). It is on at `info`; raise `LOG_LEVEL` if you ship metrics instead.
- **Large bodies are bound by copying and syscalls**, not by policy: a 64 KiB response is about 225 MB/s through one core.

### Soak

A 5-minute and a 6-minute run of mixed traffic (200,000 distinct API keys, cache turnover, a 2%-failing upstream; 1.2 million requests each) check that every bounded structure stays bounded:

- **Memory plateaus.** RSS rose during warm-up and then held flat: 234.0–234.7 MiB for the last two minutes with the Redis limiter; 285 MiB for the last three minutes with the in-memory limiter, once its 100,000-key table was full.
- **Redis stays bounded** by key TTLs: about 145,000 keys / 27 MiB at steady state with 200,000 keys cycling.
- **The cache stayed at its entry cap**, nothing was left in flight, and there were no transport errors. The only non-200s were the occasional 503 when all three attempts hit the failing upstream, which is the designed behaviour.

### What benchmarking found

Running these tools turned up three real defects, each now fixed and covered by a regression test:

1. **Connection churn to the upstream.** The upstream agent allowed 256 sockets but kept only 32 idle, so any concurrency above 32 destroyed and re-opened the surplus on every request. Under sustained load that exhausted ephemeral ports (`EADDRINUSE` on connect). Idle connections are now kept up to a configurable cap (`maxConnections`).
2. **An O(n) scan per new rate-limit key.** When the in-memory limiter's table was full, each *new* key scanned the whole table before evicting. Because keys are client-supplied, a client sending a fresh key per request could force that scan on every request: 40,000 inserts took 47.6 s. Eviction is now O(1).
3. **Cache keys weren't charged to the cache's byte budget**, so long client-chosen URLs with tiny responses could grow it past the limit.

### Reproduce

```bash
npm run bench -- --repeat 3 --redis redis://127.0.0.1:6379   # throughput, latency, CPU per request
npm run bench:soak -- --minutes 5                             # memory/connection trend under churn
npm run bench:profile                                         # V8 CPU profile of the gateway under load
node bench/floor.mjs                                          # the bare-proxy reference
# the same, on Linux, from Windows:
docker run --rm -v "$PWD:/app" -w /app node:24-alpine node bench/run.mjs --repeat 3
```

## Testing

```bash
npm test                        # unit, end-to-end, protocol hardening (POSIX-signal test skipped on Windows)
npm run check                   # typecheck + lint + tests
docker compose run --rm tests   # the whole suite on Linux, against the Compose Redis, Sentinel group and Cluster
```

- **Two phases.** `npm test` runs the in-process tests first, in parallel, and then the tests that start real processes and race real clocks (`test/e2e/`, the cluster integration test, the process test) one file at a time (see `vitest.config.ts`). They are heavy and sensitive to a starved CPU, and they would otherwise starve tests such as the Redis parity checks, where Redis expires keys in real time while the test drives an injected clock.
- **Unit tests** drive the algorithms, breaker and retry loop with injected clocks, so boundary conditions are exact rather than timing-dependent.
- **End-to-end tests** run the real gateway against real HTTP servers acting as upstreams: proxying, headers, limits, caching, coalescing, retries, timeouts, breaker lifecycle, balancing, per-target ejection, and the Redis failure modes (via a stub client).
- **Security and hardening tests** ([`gateway.security.test.ts`](test/gateway.security.test.ts), [`hardening.test.ts`](test/hardening.test.ts)) attack the gateway: key rotation, cache poisoning, header spoofing, smuggling-shaped framing, slowloris, resource exhaustion.
- **WebSocket tests** ([`gateway.websocket.test.ts`](test/gateway.websocket.test.ts), [`websocket.test.ts`](test/websocket.test.ts)) speak the protocol to the gateway with a hand-written client and an echo upstream, so no library helps the gateway pass: handshake validation, origin checks, h2c refusal, authentication and limits, the upstream handshake, idle and lifetime limits, half-closed peers, shutdown, `wss://` on both sides.
- **Edge-case tests** ([`gateway.edge.test.ts`](test/gateway.edge.test.ts)): `HEAD`, chunked uploads, upstreams dying mid-body, HTTPS upstreams, clients leaving during coalesced fetches, graceful shutdown.
- **Reload tests** ([`gateway.reload.test.ts`](test/gateway.reload.test.ts)) change the configuration under a running gateway: routes, keys and upstreams coming and going, a request in flight finishing on an upstream that was replaced under it, unchanged upstreams keeping their connections and circuit state, limits keeping or restarting their counts, a broken file changing nothing, settings that need a restart, TLS, the cache, health checks, open WebSockets, and the endpoint's guards.
- **Feature tests** for per-route policies ([`gateway.routePolicy.test.ts`](test/gateway.routePolicy.test.ts)), serving stale ([`gateway.stale.test.ts`](test/gateway.stale.test.ts)), trace context ([`trace.test.ts`](test/trace.test.ts), [`gateway.trace.test.ts`](test/gateway.trace.test.ts)) and client certificates towards upstreams ([`gateway.upstreamMtls.test.ts`](test/gateway.upstreamMtls.test.ts)).
- **HTTP/2 tests** ([`gateway.http2.test.ts`](test/gateway.http2.test.ts)) use Node's own HTTP/2 client: ALPN with HTTP/1.1 on the same port, many requests on one connection, the stream limit, uploads refused without ending the connection, the request deadline per stream, a client that stops reading and an upstream that dies mid-body (each must reset with an error code, never `NO_ERROR`), GOAWAY on idle and on shutdown, WebSockets and client certificates on an HTTP/2 listener.
- **Client-certificate tests** ([`gateway.clientCert.test.ts`](test/gateway.clientCert.test.ts)) against a test CA (`test/fixtures/tls/callers/`): valid, revoked, expired and impostor certificates, two CAs issuing the same name, allowed names, `required`, a new revocation list on reload.
- **WebSocket message tests** ([`wsFrames.test.ts`](test/wsFrames.test.ts), [`gateway.wsLimits.test.ts`](test/gateway.wsLimits.test.ts)): frames passed byte for byte however the bytes are split, size and rate limits, protocol violations, close frames at frame boundaries, and the upstream's replies delivered before the gateway's close.
- **Tracing export tests** ([`otlp.test.ts`](test/otlp.test.ts), [`gateway.otlp.test.ts`](test/gateway.otlp.test.ts)) against a fake collector: the OTLP/JSON body, batching, a full queue, a refusing, unreachable or silent collector, spans joined to the caller's trace and the upstream's, retries, sampling, reload and shutdown.
- **Redis topology tests** ([`redis.topologies.integration.test.ts`](test/redis.topologies.integration.test.ts)) run in the Compose test profile against a three-node Redis Cluster and a primary, replica and sentinel: exact admission across nodes, two gateways sharing a budget, and a failover forced mid-traffic. Skipped without `REDIS_CLUSTER_NODES` / `REDIS_SENTINEL_NODES`.
- **Redis integration tests** run the Lua scripts against a real Redis. They check exact parity with the in-memory implementation over randomized sequences, and exactly-`limit` admission under a concurrent flood from several clients. They are skipped unless `REDIS_URL` is set:

  ```bash
  docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine
  REDIS_URL=redis://127.0.0.1:6379 npm test
  ```

- **End-to-end tests** (`test/e2e/`) run everything as separate processes over real sockets and judge only what a client or operator could see: the shipped config driven exactly as the quick start says (cache, token bucket and refill, deadline, breaker open and recovery, upstream crash), then the whole product together (TLS, API keys and JWTs, a pool of two upstream instances with health checks while one is killed and restarted under load, request coalescing, WebSockets, two gateway processes sharing a budget, a cluster, shutdown) with a real Redis behind a proxy the test can freeze or sever mid-run, and clients that stop reading. Two more files drive the command line (`--check` on good and broken configurations, `--help`) and reloads from outside: an edited file applied through the admin endpoint and on `SIGHUP`, a broken one refused, and a cluster reloading every worker. `cluster`/`full` and the cluster reload need `REDIS_URL`.
- **Process test** ([`test/process.test.ts`](test/process.test.ts)) starts the real entrypoint and sends it `SIGTERM` mid-request (Linux/macOS).
- **Cluster tests**: the supervisor (restart and backoff, crash loops, start-up failure, shutdown, the questions it asks workers) runs against fake workers and a fake clock ([`supervisor.test.ts`](test/supervisor.test.ts)), metrics merging and config are unit tests, and [`cluster.integration.test.ts`](test/cluster.integration.test.ts) starts the real entrypoint with several workers against Redis (shared limits, one scrape for all workers, a killed worker replaced, start-up refused when workers cannot start, `SIGTERM` draining on POSIX). Skipped without `REDIS_URL`.

The security-critical lines were **mutation-checked**: with each defence deliberately removed (address ceiling, admin isolation, header allowlist, forwarding-header rebuild, method allowlist, in-flight cap, admin token check, buffer budget, error redaction, IPv6 masking, registry lookup, target selection, the Lua off-by-ones; for WebSockets the origin check, handshake validation, upstream accept-key, subprotocol and extension checks, connection cap, and shutdown; for the cluster the restart backoff, stale-worker handling, reply validation, start-up give-up and the shared limits; for reloads the settings held until a restart, replaced upstreams draining before they close, limiter pruning and the endpoint's guards; the stale-serving windows, trace-context validation, per-route policies and client certificates towards upstreams; and for the newest features, the Sentinel and Cluster client settings, client-certificate verification, revocation and identity, every WebSocket frame rule and limit, HTTP/2's stream resets, limits and shutdown, and the span exporter's queue, batching and timeouts), a test fails.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, the suite against a Redis service container on Node 22 and 24, the Sentinel and Cluster tests in the Compose test profile, a production-dependency audit, and a Docker image smoke test. Lint and format are [Biome](https://biomejs.dev) (`npm run lint`, `npm run lint:fix`).

## Layout

```
src/
  index.ts                entrypoint: command line, signals, one process or a cluster
  gateway.ts              request pipeline: limits, identify, limit, route, cache, balance, breaker, retry, relay; live reconfiguration
  config.ts               zod schema, env expansion, cross-field validation
  router.ts               longest-prefix routing on path-segment boundaries
  security.ts             startup notes for risky-but-legal settings
  admin.ts                the admin listener (token, liveness, readiness, health, metrics, reload), fed by whoever hosts it
  cluster/                multi-core mode: supervisor (keeps workers alive), primary, worker side, IPC protocol, metrics merge
  net/ip.ts               address normalization (IPv4-mapped, IPv6 /64)
  auth/jwt.ts             JWT verification (HS256/RS256/ES256) and key loading
  ratelimit/
    algorithms.ts         pure token bucket, sliding window log, sliding window counter
    identity.ts           key registry, plans, overrides, rule scaling
    memory.ts             in-process limiters (bounded key space)
    redis.ts              Lua scripts + Redis limiters
    resilient.ts          failure modes + breaker around the store
  resilience/
    circuitBreaker.ts     rolling-window breaker with probe permits
    healthChecker.ts      active-probe state machine (thresholds, jittered schedule)
    retry.ts              backoff, jitter, Retry-After
  cache/
    policy.ts             what may be stored, for how long, and how long it may be served stale
    responseCache.ts      LRU + byte budget + single-flight
  redisClient.ts          one Redis server, a Sentinel group or a Cluster, with fail-fast settings
  proxy/                  upstream HTTP client (requests and upgrades), hop-by-hop headers, WebSocket handshake rules,
                          tunnel, and the frame reader that enforces per-message limits (wsFrames.ts)
  observability/          logger, Prometheus registry, process metrics, W3C trace context, OTLP span exporter
test/                     unit, end-to-end, security, protocol hardening, Redis integration, process signals
bench/                    load generator, benchmark, soak test, CPU profiler
demo/                     flaky upstream and load script
```

## Limitations and next steps

Deliberate scope limits rather than oversights:

- **HTTP/2 towards clients only, and only over TLS.** Upstreams are called over HTTP/1.1; there is no cleartext HTTP/2 (h2c), no HTTP/3, and no WebSockets over HTTP/2 (RFC 8441), so browsers open those over HTTP/1.1, which the same port serves.
- **One core per worker.** Node runs the request path on a single thread. Cluster mode uses every core of one machine ("Scaling across cores"); beyond a machine, run more instances: the shared limiter state in Redis assumes it. See "Performance" for what one core does.
- **Request bodies are buffered** (up to `maxBodyBytes`) so retries can replay them; responses are streamed.
- **Cache and breaker state are per instance.** That's usually what you want for a breaker (each instance protects itself) but a shared Redis-backed cache would raise hit rates across a fleet.
- **Authentication is credential checking, not an identity provider** (see "Authentication"): no sessions, OAuth flows, token introspection, JWKS or JWT revocation. Client certificates are revoked with a CRL file, not checked online (no OCSP).
- **WebSocket payloads are not inspected.** Message size and rate are limited; what a message says, and what a compressed one inflates to, is the upstream's to check.
- **Spans are exported over OTLP/HTTP with JSON only** (no gRPC or protobuf encoding), and only traces and correlation: metrics stay Prometheus and logs stay JSON lines.
- **A reload can't rebind.** The ports, host, Redis connection, number of workers, admin address, TLS, HTTP/2 and client-certificate on or off need a restart (see "Reloading without a restart").
- **Sliding window log memory is O(limit) per key.** Use `sliding-window-counter` where the limit is large.
- Weighted/zone-aware balancing and DNS-based service discovery are natural extensions.
