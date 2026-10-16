# API Gateway & Rate Limiter

A small API gateway that sits in front of other HTTP services and handles the cross-cutting concerns:

- **Per-key rate limiting** with a token bucket, an exact sliding window or an approximate (O(1)-memory) sliding-window counter, implemented from scratch and backed by Redis so the limit is shared by every gateway instance
- **API keys with plans**, per-key overrides, and a per-address ceiling so rotating key values doesn't buy a fresh budget
- **Authentication per route**: registered API keys and signed JWTs (HS256 / RS256 / ES256), verified by the gateway, with a trusted identity passed to the upstream
- **Routing** by path prefix, with prefix stripping and per-route policy
- **Response caching** with HTTP-correct freshness rules, stampede protection and a defence against cache poisoning
- **Load balancing** across several targets per upstream, each with its own circuit breaker
- **Retries** with exponential backoff and full jitter
- **Circuit breaking** per target, so a failing instance gets room to recover and callers fail fast
- **Active health checks**, so traffic avoids a down target before any client request has to fail to find out

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
- **Cluster-safe.** Each script touches exactly one key.
- **Credentials aren't stored.** API keys are SHA-256 hashed before they become Redis keys.

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

- **Methods.** `api-key` needs a key from the registry (`rateLimit.apiKeys`); `jwt` needs a bearer token from a configured issuer. With `required: true` (the default) a request with neither gets a 401 and a `WWW-Authenticate` challenge; with `required: false` anonymous callers pass, but **a credential that is presented and wrong is always refused**, so an expired token never silently becomes "logged out" and a client can't probe tokens for free.
- **The authenticated identity is what gets rate limited.** A JWT subject has one budget however many tokens it mints, an issuer's `plan` scales it, and the same subject at two issuers is two identities. Failed attempts count against the per-address ceiling, which is checked *before* any credential is examined, so guessing keys or tokens is throttled at the price of one counter update.
- **The upstream is told who the caller is** in `X-Authenticated-Client`, `X-Authenticated-Method` and (for JWTs) `X-Authenticated-Issuer`. These headers are **always stripped from incoming requests**, on every route, and set only from a credential the gateway verified itself, so an upstream can trust them. Subjects are free text, so anything outside printable ASCII is percent-encoded rather than allowed to split the header block.
- **`forwardCredentials: false`** withholds only the credential the gateway consumed. Other schemes in `Authorization` (Basic, an opaque token meant for the upstream) pass through untouched, and routes without `auth` never have credentials touched.
- **Caching** an authenticated route keeps one entry per credential, and the token is verified on every request, hit or miss: an expired token gets nothing from the cache.

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

Startup prints a `security` log line for each risky-but-legal setting (header-keyed limits with no registry or ceiling, plaintext Redis off-box, a cache with no `varyHeaders`, an admin listener bound off loopback).

**Not covered, by design.** Authentication is credential checking, not an identity provider: there are no sessions, no OAuth flows or token introspection, no JWKS fetching, and no revocation list (keep `maxLifetimeSeconds` short instead). Routes without `auth` check nothing. There is no WAF or body inspection, and no DDoS protection beyond the caps above: volumetric attacks need to be absorbed upstream of this process.

## Behaviour at the edges

| Situation | What happens |
|---|---|
| `HEAD` | Upstream headers are relayed (including `Content-Length`) with no body. `HEAD` is retried like other idempotent methods, and never reads or fills the cache. |
| Chunked upload | The body is buffered and forwarded with an exact `Content-Length`, so it can be replayed on retry. Past `maxBodyBytes` the client gets a 413 with `Connection: close`, even with no `Content-Length` declared. |
| Upstream dies mid-body | The status line has already gone out, so the client's connection is cut rather than ended normally. A truncated body is never presented as complete, never cached, and is counted as a 502 in metrics and logs. |
| HTTPS upstream | Verified against Node's default CAs, or only the bundle in `tls.caFile`. There is deliberately no option to skip verification. TLS failures get a 502 and aren't retried, since a bad certificate won't fix itself. |
| Shutdown (`SIGTERM` / `SIGINT`) | The listener closes and idle keep-alive connections drop at once. In-flight requests finish, with `Connection: close`. Each connection closes as soon as its response completes, and anything still running after `shutdownGraceMs` is cut off. |

## Configuration

See [`gateway.config.json`](gateway.config.json) for a working example. The schema is strict: unknown keys are errors, so a typo fails at startup instead of being ignored, and cross-references (unknown plan, unknown route id, duplicate key, `requireKey` with no keys, an exposed admin listener with no token) are validated too. String values support `${VAR}` and `${VAR:-default}`; `PORT` and `REDIS_URL` override the file.

| Section | Key | Default | Meaning |
|---|---|---|---|
| root | `port`, `host` | `8080`, `0.0.0.0` | Proxy listen address |
| root | `maxBodyBytes` | 1 MiB | Larger bodies get 413 |
| root | `shutdownGraceMs` | `10000` | How long in-flight requests get to finish on shutdown |
| root | `allowedMethods` | `GET HEAD POST PUT PATCH DELETE OPTIONS` | Anything else gets 405 |
| root | `forwardedHost` | unset | The `X-Forwarded-Host` sent upstream when the gateway is the edge |
| `admin` | `enabled`, `host`, `port`, `token` | `true`, `127.0.0.1`, `9090`, unset | Health/metrics listener. A non-loopback `host` requires a `token` (16+ chars) |
| `redis` | `url`, `keyPrefix`, `commandTimeoutMs`, `caFile` | `-`, `gw:`, `100`, unset | Omit the section for in-memory limiting. `rediss://` for TLS; `caFile` for a private CA |
| `rateLimit` | `identityHeader` | `x-api-key` | Header carrying the API key |
| `rateLimit` | `trustedProxyHops` | `0` | Take the Nth-from-right `X-Forwarded-For` entry |
| `rateLimit` | `failureMode` | `local` | `local`, `open` or `closed` |
| `rateLimit` | `default`, `ip` | none | Default rule for routes; per-address ceiling across routes |
| `rateLimit` | `apiKeys`, `plans`, `requireKey`, `anonymousMultiplier` | `[]`, `{}`, `false`, `1` | Key registry (see above) |
| `auth` | `jwt.issuers[]`, `forwardIdentity`, `forwardCredentials` | none, `true`, `true` | Token verification and what the upstream is told. Issuer: `name`, `alg`, `secret` / `publicKey` / `publicKeyFile`, `kid`, `issuer`, `audience`, `leewaySeconds` (30), `maxLifetimeSeconds`, `plan` |
| `routes[].auth` | `methods`, `required` | none, `true` | `["jwt"]`, `["api-key"]` or both; see "Authentication" |
| `rateLimit` | `ipv6Prefix` | `64` | IPv6 grouping |
| `limits` | `maxConnections`, `maxConnectionsPerIp` | `10000`, `0` (off) | Connection caps. The per-address cap is off by default because a load balancer opens every connection from one address; set it when clients connect to the gateway directly |
| `limits` | `maxInFlight`, `maxBufferedBytes` | `2000`, 64 MiB | Load shedding (503) |
| `limits` | `maxHeaderBytes`, `headersTimeoutMs`, `requestTimeoutMs`, `keepAliveTimeoutMs` | `16384`, `15000`, `60000`, `65000` | Protocol limits |
| `upstreams.*` | `url` **or** `urls`, `balance` | `-`, `round-robin` | One backend, or several |
| `upstreams.*` | `timeoutMs`, `totalTimeoutMs` | `5000`, unset | Per-attempt and overall timeouts |
| `upstreams.*.tls` | `caFile` | unset | PEM bundle for a privately signed `https://` upstream; replaces the default trust store for that upstream |
| `upstreams.*.healthCheck` | `path`, `method`, `intervalMs`, `timeoutMs`, `unhealthyThreshold`, `healthyThreshold`, `expectStatus`, `headers` | off; `GET`, `5000`, `2000`, `2`, `2`, any 2xx, none | Active probing. `timeoutMs` must be below `intervalMs`; probes may not set `Host`, framing or `Upgrade` headers |
| `upstreams.*.retry` | `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `retryOnStatus`, `retryNonIdempotent` | `3`, `100`, `2000`, `[502,503,504]`, `false` | |
| `upstreams.*.breaker` | `failureRateThreshold`, `minimumRequests`, `windowMs`, `openDurationMs`, `halfOpenMaxCalls`, `halfOpenSuccesses` | `0.5`, `10`, `10000`, `10000`, `1`, `2` | Applied per target |
| `routes[]` | `path`, `upstream`, `id`, `methods`, `stripPrefix`, `rateLimit`, `cost`, `cache` | `cost`: `1` | Longest whole-segment prefix wins; `rateLimit: false` disables limiting; `cost` is what a request spends of the budget |
| `routes[].cache` | `ttlMs`, `varyHeaders`, `forwardHeaders` | `-`, `[authorization, x-api-key]`, `[accept, accept-language]` | See "Cache poisoning" |

## Observability

Served by the **admin listener** (default `127.0.0.1:9090`), not the proxy port:

- `GET /_gateway/live`: always open, says only `{"status":"ok"}`. Use it for container/orchestrator probes.
- `GET /_gateway/health`: circuit state per upstream and per target, in-flight and connection counts, Redis status, cache stats (token-gated when one is set)
- `GET /_gateway/metrics`: Prometheus text (token-gated when one is set):
  - requests by route/status, latency histogram, rate-limited/degraded/unauthorized/shed counts, authentication outcomes by route and method;
  - cache outcomes and size; upstream attempts by target and outcome; circuit state and transitions per target; health-check verdict (`gateway_target_healthy`), probe results and verdict changes;
  - connections, in-flight requests, buffered request bytes;
  - process RSS, heap, external memory, CPU seconds, and event-loop delay.
- One JSON access-log line per request with `requestId`, route, status, duration, cache result, attempt count and the registered key *name* (never the key). `X-Request-Id` is propagated upstream (client-supplied ids are accepted only if they're safe to log).

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

- **One gateway process is one core.** It saturates at roughly 6,000 proxied requests per second on this machine (Linux). That is about two thirds of what a bare Node proxy manages here (9,200/s). In single-thread time that is roughly 160 µs per request against 108 µs: routing, identity, limiting, metrics, retry and breaker bookkeeping and body buffering cost about 50 µs on top of Node's own HTTP floor, most of which is socket writes and parsing that any proxy pays. To go faster, run more instances; the limiter state is in Redis precisely so that works.
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
docker compose run --rm tests   # the whole suite on Linux, against the Compose Redis
```

- **Unit tests** drive the algorithms, breaker and retry loop with injected clocks, so boundary conditions are exact rather than timing-dependent.
- **End-to-end tests** run the real gateway against real HTTP servers acting as upstreams: proxying, headers, limits, caching, coalescing, retries, timeouts, breaker lifecycle, balancing, per-target ejection, and the Redis failure modes (via a stub client).
- **Security and hardening tests** ([`gateway.security.test.ts`](test/gateway.security.test.ts), [`hardening.test.ts`](test/hardening.test.ts)) attack the gateway: key rotation, cache poisoning, header spoofing, smuggling-shaped framing, slowloris, resource exhaustion.
- **Edge-case tests** ([`gateway.edge.test.ts`](test/gateway.edge.test.ts)): `HEAD`, chunked uploads, upstreams dying mid-body, HTTPS upstreams, clients leaving during coalesced fetches, graceful shutdown.
- **Redis integration tests** run the Lua scripts against a real Redis. They check exact parity with the in-memory implementation over randomized sequences, and exactly-`limit` admission under a concurrent flood from several clients. They are skipped unless `REDIS_URL` is set:

  ```bash
  docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine
  REDIS_URL=redis://127.0.0.1:6379 npm test
  ```

- **Process test** ([`test/process.test.ts`](test/process.test.ts)) starts the real entrypoint and sends it `SIGTERM` mid-request (Linux/macOS).

The security-critical lines were **mutation-checked**: with each defence deliberately removed (address ceiling, admin isolation, header allowlist, forwarding-header rebuild, method allowlist, in-flight cap, admin token check, buffer budget, error redaction, IPv6 masking, registry lookup, target selection, and the Lua off-by-ones), a test fails.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, the suite against a Redis service container on Node 22 and 24, a production-dependency audit, and a Docker image smoke test. Lint and format are [Biome](https://biomejs.dev) (`npm run lint`, `npm run lint:fix`).

## Layout

```
src/
  gateway.ts              request pipeline: limits, identify, limit, route, cache, balance, breaker, retry, relay; admin listener
  config.ts               zod schema, env expansion, cross-field validation
  router.ts               longest-prefix routing on path-segment boundaries
  security.ts             startup notes for risky-but-legal settings
  net/ip.ts               address normalization (IPv4-mapped, IPv6 /64)
  ratelimit/
    algorithms.ts         pure token bucket, sliding window log, sliding window counter
    identity.ts           key registry, plans, overrides, rule scaling
  auth/jwt.ts             JWT verification (HS256/RS256/ES256) and key loading
    memory.ts             in-process limiters (bounded key space)
    redis.ts              Lua scripts + Redis limiters
    resilient.ts          failure modes + breaker around the store
  resilience/
    circuitBreaker.ts     rolling-window breaker with probe permits
    healthChecker.ts      active-probe state machine (thresholds, jittered schedule)
    retry.ts              backoff, jitter, Retry-After
  cache/
    policy.ts             what may be stored, and for how long
    responseCache.ts      LRU + byte budget + single-flight
  proxy/                  upstream HTTP client, hop-by-hop header handling
  observability/          logger, Prometheus registry, process metrics
test/                     unit, end-to-end, security, protocol hardening, Redis integration, process signals
bench/                    load generator, benchmark, soak test, CPU profiler
demo/                     flaky upstream and load script
```

## Limitations and next steps

Deliberate scope limits rather than oversights:

- **HTTP/1.1 only.** No WebSocket or `Upgrade` proxying, no TLS termination (put a load balancer in front).
- **One process, one core.** Node runs the request path on a single thread. Scale by running more instances: the design (shared limiter state in Redis) assumes it. See "Performance" for what one instance does on one core.
- **Request bodies are buffered** (up to `maxBodyBytes`) so retries can replay them; responses are streamed.
- **Cache and breaker state are per instance.** That's usually what you want for a breaker (each instance protects itself) but a shared Redis-backed cache would raise hit rates across a fleet.
- **Authentication is credential checking, not an identity provider** (see "Authentication"): no sessions, OAuth flows, token introspection, JWKS or revocation.
- **Sliding window log memory is O(limit) per key.** Use `sliding-window-counter` where the limit is large.
- Weighted/zone-aware balancing and DNS-based service discovery are natural extensions.
