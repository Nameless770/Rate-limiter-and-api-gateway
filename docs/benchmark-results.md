# Benchmark results

Raw output of `bench/run.mjs` and `bench/soak.mjs`. Read [Performance in the README](../README.md#performance) first: these numbers come from one laptop on which the load generator, gateway, upstream and Redis all compete for the same cores, so they show relative costs, not capacity.

## Linux (container on WSL2)

2026-10-15, Node v24.22.0, linux 6.18.33.2-microsoft-standard-WSL2, 16 x 11th Gen Intel(R) Core(TM) i7-11800H @ 2.30GHz, 4 GiB RAM visible to the OS (inside the container this is the WSL2 VM); 64 connections, 8s measured after 3s warm-up, median of 3 runs, Redis 7 in Docker

| Scenario | conn | req/s (min-max of 3) | p50 ms | p99 ms | p99.9 ms | max ms | gateway CPU µs/req | upstream CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| direct to upstream | 1 | 7,320 (7,199-7,480) | 0.10 | 0.33 | 0.46 | 1.53 | - | 42% |
| proxy only | 1 | 2,504 (2,457-2,632) | 0.33 | 0.95 | 1.29 | 2.26 | 307 | 17% |
| proxy + token bucket (memory) | 1 | 2,429 (2,369-2,495) | 0.35 | 0.95 | 1.37 | 2.63 | 324 | 17% |
| proxy + token bucket (Redis) | 1 | 1,589 (1,576-1,610) | 0.56 | 1.23 | 2.41 | 4.32 | 488 | 12% |
| direct to upstream | 64 | 49,040 (47,953-49,475) | 1.18 | 2.99 | 3.97 | 6.81 | - | 99% |
| proxy only | 64 | 6,300 (6,263-6,317) | 9.85 | 16.56 | 19.27 | 25.54 | 189 | 25% |
| proxy + access log (info) | 64 | 5,811 (5,782-5,845) | 10.74 | 17.67 | 21.48 | 28.46 | 205 | 22% |
| proxy + token bucket (memory) | 64 | 5,901 (5,847-5,901) | 10.51 | 18.46 | 22.92 | 30.38 | 203 | 24% |
| proxy + sliding window log (memory) | 64 | 5,917 (5,875-5,986) | 10.51 | 17.67 | 22.43 | 27.85 | 202 | 24% |
| proxy + sliding window counter (memory) | 64 | 5,920 (5,907-5,969) | 10.51 | 17.30 | 21.02 | 29.09 | 202 | 24% |
| proxy + token bucket + address ceiling | 64 | 5,421 (5,420-5,442) | 11.46 | 18.86 | 21.95 | 27.26 | 222 | 24% |
| proxy + token bucket (Redis) | 64 | 5,615 (5,458-5,721) | 10.97 | 18.86 | 22.92 | 24.46 | 222 | 13% |
| proxy + sliding window log (Redis) | 64 | 5,696 (5,475-5,809) | 10.74 | 19.27 | 21.02 | 23.42 | 216 | 13% |
| proxy + sliding window counter (Redis) | 64 | 5,184 (4,498-5,672) | 10.97 | 27.85 | 34.59 | 37.72 | 233 | 13% |
| proxy + cache hit | 64 | 15,585 (13,154-17,420) | 3.33 | 15.19 | 31.04 | 62.08 | 72 | 0% |
| proxy, every request rate limited (429) | 64 | 16,866 (12,456-16,877) | 3.41 | 7.59 | 10.74 | 18.86 | 65 | 0% |
| proxy, 64 KiB response | 64 | 3,474 (2,553-3,527) | 17.67 | 35.35 | 44.86 | 60.75 | 419 | 29% |
| proxy, 16 KiB POST body | 64 | 3,986 (3,913-4,242) | 14.54 | 45.84 | 67.70 | 87.80 | 331 | 31% |

## Windows host

2026-10-15, Node v24.14.0, win32 10.0.26200, 16 x 11th Gen Intel(R) Core(TM) i7-11800H @ 2.30GHz, 16 GiB RAM visible to the OS (inside the container this is the WSL2 VM); 64 connections, 8s measured after 3s warm-up, median of 3 runs, Redis 7 in Docker

| Scenario | conn | req/s (min-max of 3) | p50 ms | p99 ms | p99.9 ms | max ms | gateway CPU µs/req | upstream CPU |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| direct to upstream | 1 | 5,075 (4,836-5,560) | 0.14 | 0.47 | 0.64 | 2.31 | - | 46% |
| proxy only | 1 | 1,984 (1,972-1,990) | 0.41 | 1.29 | 1.63 | 1.98 | 319 | 22% |
| proxy + token bucket (memory) | 1 | 1,730 (1,728-1,814) | 0.44 | 1.50 | 1.82 | 2.21 | 404 | 19% |
| proxy + token bucket (Redis) | 1 | 901 (871-905) | 1.04 | 1.67 | 2.57 | 3.72 | 535 | 8% |
| direct to upstream | 64 | 28,249 (28,213-28,502) | 2.31 | 4.32 | 5.86 | 11.46 | - | 99% |
| proxy only | 64 | 4,493 (4,375-4,509) | 13.63 | 23.42 | 29.09 | 31.04 | 220 | 38% |
| proxy + access log (info) | 64 | 3,983 (3,941-3,987) | 15.52 | 25.54 | 34.59 | 36.91 | 254 | 36% |
| proxy + token bucket (memory) | 64 | 3,980 (3,127-4,154) | 15.52 | 26.67 | 33.12 | 36.91 | 264 | 40% |
| proxy + sliding window log (memory) | 64 | 4,098 (4,080-4,156) | 14.86 | 28.46 | 36.12 | 39.39 | 243 | 36% |
| proxy + sliding window counter (memory) | 64 | 4,045 (3,956-4,067) | 15.19 | 26.10 | 32.42 | 34.59 | 244 | 41% |
| proxy + token bucket + address ceiling | 64 | 3,756 (3,738-3,879) | 16.21 | 33.12 | 43.90 | 45.84 | 272 | 37% |
| proxy + token bucket (Redis) | 64 | 3,938 (3,922-4,040) | 15.86 | 22.43 | 41.14 | 44.86 | 262 | 21% |
| proxy + sliding window log (Redis) | 64 | 3,923 (3,814-3,953) | 16.21 | 21.95 | 26.67 | 27.85 | 269 | 20% |
| proxy + sliding window counter (Redis) | 64 | 3,826 (3,808-3,950) | 16.21 | 25.00 | 34.59 | 36.12 | 286 | 20% |
| proxy + cache hit | 64 | 12,744 (12,554-12,781) | 4.82 | 8.65 | 10.97 | 12.50 | 71 | 0% |
| proxy, every request rate limited (429) | 64 | 10,869 (10,612-11,066) | 5.61 | 10.51 | 13.63 | 15.52 | 84 | 0% |
| proxy, 64 KiB response | 64 | 2,628 (2,566-2,689) | 23.42 | 42.04 | 48.92 | 49.99 | 461 | 45% |
| proxy, 16 KiB POST body | 64 | 3,875 (3,821-3,954) | 16.21 | 26.67 | 30.38 | 33.12 | 304 | 45% |

## Soak runs

Traffic: three concurrent streams, 48 connections in total. `/api` is rate limited per key drawn from 200,000 distinct values; `/cached` is a GET with one of 5,000 ids and a 3 s TTL; `/flaky` has an upstream that fails 2% of requests (3 attempts). Sampled from the gateway's own `/_gateway/metrics` every 5 s. Linux container on WSL2, same machine as above.

| Run | Requests | Req/s | Errors | RSS (second half) | Redis | Event loop, worst per-interval p99 |
|---|---:|---:|---|---|---|---:|
| 5 min, Redis limiter | 1,205,875 | 4,020 | 0 transport, 1 × 503 | 234.0–234.7 MiB flat over the last 2 min (215 MiB at 25 s) | 17 → 27 MiB, plateau at about 145k keys (TTL-bounded) | 27 ms |
| 2 min, in-memory, **before** the eviction fix | 390,073 | 3,251 | 0 transport, 1 × 503 | still climbing | – | **112 ms** (single delay 134 ms) |
| 2 min, in-memory, after the fix | 442,685 | 3,689 | 0 | still filling the 100k-key table | – | 21 ms (single delay 39 ms) |
| 6 min, in-memory, after the fix | 1,243,176 | 3,453 | 0 transport, 1 × 503 | 285 MiB, flat for the last 3 min (trend −0.22 MiB/min) | – | 50 ms |

- The single 503 per run is expected: with a 2% upstream failure rate and 3 attempts, about one request in 125,000 to that route fails all three (the route is a fifth of the traffic, so roughly one per million requests overall is expected; one per run is in line). The upstream's last response is returned unchanged.
- The cache sat at its 1,000-entry cap throughout; connections peaked at 48; nothing was in flight at the end; the circuit was closed at the end.
- Event-loop delay is high in every run because the gateway is CPU-saturated by a closed-loop load; it measures queueing, not a stall. The "before the fix" row is the exception: those delays were a full scan of the limiter's key table on every new key.

Reproduce: `npm run bench -- --repeat 3 --redis redis://127.0.0.1:6379` and `npm run bench:soak -- --minutes 5`.
