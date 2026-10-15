# API Gateway & Rate Limiter

A small API gateway that sits in front of other HTTP services and handles the cross-cutting concerns:

- **Per-key rate limiting** with a token bucket or a sliding window, implemented from scratch and backed by Redis so the limit is shared by every gateway instance
- **Routing** by path prefix, with prefix stripping and per-route policy
- **Response caching** with HTTP-correct freshness rules and stampede protection
- **Retries** with exponential backoff and full jitter
- **Circuit breaking** per upstream, so a failing service gets room to recover and callers fail fast

Written in TypeScript on Node's built-in `http`. The only runtime dependencies are `ioredis` (the Redis client) and `zod` (config validation). The rate limiters, circuit breaker, retry loop and cache are hand-written.

## Request pipeline

```
client ─▶ identify ─▶ rate limit ─▶ route ─▶ cache ─▶ breaker ─▶ retry/backoff ─▶ upstream
            │            │                    │         │             │
         API key       Redis (Lua)         HIT/MISS    open?       5xx / timeout
         or IP         429 + Retry-After   coalesce   fail fast    connect error
```

Rate limiting runs before the cache on purpose: a quota should count cache hits too, and rejecting early protects everything behind it.

## Quick start

No Redis needed to try it (limits are then per-process):

```bash
npm install
npm run demo:upstream          # terminal 1: a flaky demo service on :9001
npm run dev                    # terminal 2: the gateway on :8080
```

```bash
curl -i localhost:8080/time                                # X-Cache: MISS, then HIT
node demo/hammer.mjs http://localhost:8080/echo --n 30 --key alice   # ~10 x 200 (the burst), then 429s
curl "localhost:9001/_demo/failure?rate=1"                 # make the upstream fail...
node demo/hammer.mjs http://localhost:8080/slow --n 20     # ...and watch the breaker open (500s, then 503s)
curl localhost:9001/_demo/failure?rate=0                   # heal it; the breaker probes and closes
curl localhost:8080/_gateway/health                        # circuit state per upstream
curl localhost:8080/_gateway/metrics                       # Prometheus text format
```

With Redis, and two gateway instances sharing one budget:

```bash
docker compose up --build
curl -i -H 'x-api-key: alice' localhost:8080/echo   # hit :8080 and :8081 alternately:
curl -i -H 'x-api-key: alice' localhost:8081/echo   # RateLimit-Remaining counts down across both
```

If those ports are taken, move them: `GATEWAY_A_PORT=18080 GATEWAY_B_PORT=18081 UPSTREAM_PORT=19001 docker compose up --build`.

Or point a single instance at your own Redis: `REDIS_URL=redis://localhost:6379 npm run dev`.

## Rate limiting

Two algorithms, selected per route:

| | Token bucket | Sliding window (log) |
|---|---|---|
| Idea | Bucket of `capacity` tokens refilling at `refillPerSecond`; a request spends one | Remember every admitted timestamp; admit if fewer than `limit` fall in the last `windowMs` |
| Allows | Bursts up to `capacity`, long-run average of the refill rate | Exactly `limit` per any trailing window |
| Boundary behaviour | Smooth | No fixed-window "double burst" at the window edge |
| State per key | 2 numbers (O(1)) | One entry per admitted request (O(limit)) |
| Use when | You want to permit bursts and cap the average | You need a hard, exact cap |

The algorithms are pure functions in [`src/ratelimit/algorithms.ts`](src/ratelimit/algorithms.ts) (state and `now` in, decision and state out). The in-memory limiter, the unit tests and the Redis Lua scripts all implement that one definition.

### Why it's safe across instances

- **Atomic.** Each check-and-update is a single Lua script ([`src/ratelimit/redis.ts`](src/ratelimit/redis.ts)). There is no read-then-write window for two instances to interleave in, so N concurrent requests against a limit of L admit exactly L (the Redis integration test asserts this from several independent clients).
- **One clock.** Scripts use Redis `TIME`, not the gateway's clock, so instances with skewed clocks still agree on when a window ends.
- **Bounded storage.** Every key gets a TTL; idle clients cost nothing. Denied requests do not write, so a flood of rejections can't amplify into Redis writes.
- **Cluster-safe.** Each script touches exactly one key.
- **Credentials aren't stored.** API keys are SHA-256 hashed before they become Redis keys.

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

## Retries and the circuit breaker

**Retries** use exponential backoff with *full jitter* (delay uniform in `[0, min(max, base * 2^n)]`), which avoids synchronized retry storms. What gets retried is deliberate:

- 5xx statuses in `retryOnStatus`, timeouts and resets: **idempotent methods only** (a POST may already have taken effect), unless `retryNonIdempotent` is set
- Connection failures (refused, DNS): retried for **any** method, since nothing was sent
- `Retry-After` is honoured as a floor; a hint longer than `maxDelayMs` means "stop retrying"
- `totalTimeoutMs` bounds the whole exchange, so a request can't take `attempts x timeout`
- When retries are exhausted the upstream's last response is returned unchanged

**Circuit breaker**, one per upstream:

```
CLOSED ── failure rate >= threshold (with minimumRequests) ──▶ OPEN ── openDurationMs ──▶ HALF-OPEN
   ▲                                                            ▲                            │
   └────────────── halfOpenSuccesses probe successes ───────────┴──────── a probe fails ──────┘
```

Outcomes are counted over a rolling window. While open, requests get an immediate 503 with `Retry-After` and put zero load on the upstream. Results from calls admitted before a state change are ignored, so a slow request started while closed can't be mistaken for a probe. A client hanging up is not counted as an upstream failure.

## Behaviour at the edges

| Situation | What happens |
|---|---|
| `HEAD` | Upstream headers are relayed (including `Content-Length`) with no body. `HEAD` is retried like other idempotent methods, and never reads or fills the cache. |
| Chunked upload | The body is buffered and forwarded with an exact `Content-Length`, so it can be replayed on retry. Past `maxBodyBytes` the client gets a 413 with `Connection: close`, even with no `Content-Length` declared. |
| Upstream dies mid-body | The status line has already gone out, so the client's connection is cut rather than ended normally. A truncated body is never presented as complete, never cached, and is counted as a 502 in metrics and logs. |
| HTTPS upstream | Verified against Node's default CAs, or only the bundle in `tls.caFile`. There is deliberately no option to skip verification. TLS failures get a 502 and aren't retried, since a bad certificate won't fix itself. |
| Shutdown (`SIGTERM` / `SIGINT`) | The listener closes and idle keep-alive connections drop at once. In-flight requests finish, with `Connection: close`. Each connection closes as soon as its response completes, and anything still running after `shutdownGraceMs` is cut off. |

## Configuration

See [`gateway.config.json`](gateway.config.json) for a working example. The schema is strict: unknown keys are errors, so a typo fails at startup instead of being ignored. String values support `${VAR}` and `${VAR:-default}`; `PORT` and `REDIS_URL` override the file.

| Section | Key | Default | Meaning |
|---|---|---|---|
| root | `port`, `host` | `8080`, `0.0.0.0` | Listen address |
| root | `maxBodyBytes` | 1 MiB | Larger bodies get 413 |
| root | `shutdownGraceMs` | `10000` | How long in-flight requests get to finish on shutdown |
| `redis` | `url`, `keyPrefix`, `commandTimeoutMs` | `-`, `gw:`, `100` | Omit the section for in-memory limiting |
| `rateLimit` | `identityHeader` | `x-api-key` | Caller identity; falls back to client IP |
| `rateLimit` | `trustedProxyHops` | `0` | Take the Nth-from-right `X-Forwarded-For` entry (the left side is spoofable) |
| `rateLimit` | `failureMode` | `local` | `local`, `open` or `closed` |
| `rateLimit` | `default` | none | Rule for routes without their own |
| `upstreams.*` | `url`, `timeoutMs`, `totalTimeoutMs` | `-`, `5000`, unset | Per-attempt and overall timeouts |
| `upstreams.*.tls` | `caFile` | unset | PEM bundle for a privately signed `https://` upstream; replaces the default trust store for that upstream |
| `upstreams.*.retry` | `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `retryOnStatus`, `retryNonIdempotent` | `3`, `100`, `2000`, `[502,503,504]`, `false` | |
| `upstreams.*.breaker` | `failureRateThreshold`, `minimumRequests`, `windowMs`, `openDurationMs`, `halfOpenMaxCalls`, `halfOpenSuccesses` | `0.5`, `10`, `10000`, `10000`, `1`, `2` | |
| `routes[]` | `path`, `upstream`, `id`, `methods`, `stripPrefix`, `rateLimit`, `cache` | | Longest whole-segment prefix wins; `rateLimit: false` disables limiting |

## Observability

- `GET /_gateway/health`: circuit state per upstream, Redis status, cache stats
- `GET /_gateway/metrics`: Prometheus text: requests by route/status, latency histogram, rate-limited and degraded counts, cache outcomes, upstream attempts by outcome, circuit state and transitions
- One JSON access-log line per request with `requestId`, route, status, duration, cache result and attempt count. `X-Request-Id` is propagated upstream (client-supplied ids are accepted only if they're safe to log)

## Testing

```bash
npm test                        # 159 tests (the POSIX-signal test is skipped on Windows)
npm run typecheck
docker compose run --rm tests   # the whole suite on Linux, against the Compose Redis
```

- **Unit tests** drive the algorithms, breaker and retry loop with injected clocks, so boundary conditions are exact rather than timing-dependent.
- **End-to-end tests** run the real gateway against real HTTP servers acting as upstreams. They cover proxying, headers, limits, caching, coalescing, retries, timeouts, breaker lifecycle, per-upstream isolation, path normalization, and the Redis failure modes (via a stub client).
- **Edge-case tests** ([`test/gateway.edge.test.ts`](test/gateway.edge.test.ts)) cover everything in the table above. That includes HTTPS upstreams with a test-only certificate in [`test/fixtures/tls`](test/fixtures/tls).
- **Redis integration tests** ([`test/redis.integration.test.ts`](test/redis.integration.test.ts)) run the Lua scripts against a real Redis. They check exact parity with the in-memory implementation over randomized sequences, and exactly-`limit` admission under a concurrent flood from several clients. They are skipped unless `REDIS_URL` is set:

  ```bash
  docker run --rm -p 127.0.0.1:6379:6379 redis:7-alpine
  REDIS_URL=redis://127.0.0.1:6379 npm test
  ```

- **Process test** ([`test/process.test.ts`](test/process.test.ts)) starts the real entrypoint and sends it `SIGTERM` mid-request (Linux/macOS).

**What was verified:**

- The full suite passes on Windows (Node 24) against `redis:7-alpine` (Redis 7.4.11), and in the Linux test container.
- The Compose deployment was run end to end:
  - two instances share one budget;
  - stopping Redis falls back to local limiting without slowing requests;
  - `docker compose stop` drains an in-flight request and exits 0.
- The suites were mutation-checked. Deliberately introduced bugs, such as an off-by-one in the sliding-window Lua, retried TLS failures, or a missing shutdown step, each make a test fail.

## Layout

```
src/
  gateway.ts              request pipeline: identify, limit, route, cache, breaker, retry, relay
  config.ts               zod schema, env expansion, cross-field validation
  router.ts               longest-prefix routing on path-segment boundaries
  ratelimit/
    algorithms.ts         pure token bucket + sliding window
    memory.ts             in-process limiters (bounded key space)
    redis.ts              Lua scripts + Redis limiters
    resilient.ts          failure modes + breaker around the store
  resilience/
    circuitBreaker.ts     rolling-window breaker with probe permits
    retry.ts              backoff, jitter, Retry-After
  cache/
    policy.ts             what may be stored, and for how long
    responseCache.ts      LRU + byte budget + single-flight
  proxy/                  upstream HTTP client, hop-by-hop header handling
  observability/          logger, Prometheus registry
test/                     unit, end-to-end, edge cases, Redis integration, process signals
demo/                     flaky upstream and load script
```

## Limitations and next steps

Deliberate scope limits rather than oversights:

- **HTTP/1.1 only.** No WebSocket or `Upgrade` proxying, no TLS termination (put a load balancer in front).
- **Request bodies are buffered** (up to `maxBodyBytes`) so retries can replay them; responses are streamed.
- **Cache and breaker state are per instance.** That's usually what you want for a breaker (each instance protects itself) but a shared Redis-backed cache would raise hit rates across a fleet.
- **Admin endpoints are on the public port.** Block `/_gateway/*` at the edge, or bind them separately, in production.
- **No authentication.** `X-API-Key` identifies a caller for limiting; it does not authenticate one. Anyone can mint a new key to get a fresh budget, so pair this with real auth in front.
- **Sliding window log memory is O(limit) per key.** For very high limits, an approximate sliding-window counter (two weighted fixed windows) would be the natural addition.
- Per-key limit overrides (plans/tiers), request-weighted costs per route, and load balancing across several upstream targets are natural extensions.
