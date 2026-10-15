/**
 * Redis-backed rate limiters. Each check-and-update runs as a single Lua script, so it is atomic across any
 * number of gateway instances: there is no read-then-write race between concurrent requests.
 *
 * Design notes
 *  - Time comes from Redis (`TIME`) unless a clock is injected, so instances with skewed clocks still agree.
 *  - Every script touches exactly one key, which keeps it valid under Redis Cluster without hash tags.
 *  - Keys always carry a TTL, so idle clients cost nothing once their window or bucket has refilled.
 *  - Scripts return integers only (Redis truncates Lua floats), so all times are whole milliseconds.
 *  - Denied requests do not write, so a flood of rejected traffic cannot amplify into Redis writes.
 *
 * The Lua below is a line-for-line port of algorithms.ts; test/redis.integration.test.ts asserts parity.
 */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SlidingWindowParams, TokenBucketParams } from './algorithms.js';
import type { Clock, RateLimitDecision, RateLimiter } from './types.js';

const NOW_FROM_REDIS = `
if now == 0 then
  -- Redis < 5 forbids writes after a non-deterministic command unless effects replication is on (no-op on 7+).
  pcall(redis.replicate_commands)
  local t = redis.call('TIME')
  now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`;

/**
 * KEYS[1] bucket key
 * ARGV    capacity, refill tokens/ms, cost, now (ms; 0 = ask Redis)
 * returns {allowed, remaining, retryAfterMs, resetAfterMs}
 */
export const TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_ms = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
${NOW_FROM_REDIS}
local EPSILON = 1e-9

local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])

if tokens == nil or ts == nil then
  tokens = capacity
  ts = now
else
  local elapsed = math.max(0, now - ts)
  tokens = math.min(capacity, tokens + elapsed * refill_per_ms)
  ts = math.max(ts, now)
end

local allowed = 0
if tokens + EPSILON >= cost then
  allowed = 1
  tokens = tokens - cost
  redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(ts))
  -- Once the bucket would be full again the key is equivalent to a missing one, so let it expire then.
  local ttl = math.max(1, math.ceil((capacity - tokens) / refill_per_ms))
  redis.call('PEXPIRE', key, ttl + 1000)
end

local retry_after = 0
if allowed == 0 then
  retry_after = math.ceil((cost - tokens) / refill_per_ms)
end
local reset_after = math.ceil((capacity - tokens) / refill_per_ms)
return {allowed, math.max(0, math.floor(tokens + EPSILON)), retry_after, reset_after}
`;

/**
 * KEYS[1] sorted set of admitted request timestamps (score = ms, member = unique id)
 * ARGV    limit, window ms, cost, now (ms; 0 = ask Redis), unique member prefix
 * returns {allowed, remaining, retryAfterMs, resetAfterMs}
 */
export const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local member = ARGV[5]
${NOW_FROM_REDIS}

-- Evict everything that has aged out of the window: score <= now - window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count + cost <= limit then
  for i = 1, cost do
    redis.call('ZADD', key, now, member .. ':' .. i)
  end
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - cost, 0, window}
end

-- Denied: the (count + cost - limit)-th oldest entry must age out before this request would fit.
local need = count + cost - limit
local blocking = redis.call('ZRANGE', key, need - 1, need - 1, 'WITHSCORES')
local newest = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
local retry_after = tonumber(blocking[2]) + window - now
local reset_after = tonumber(newest[2]) + window - now
return {0, 0, retry_after, reset_after}
`;

type ScriptResult = [allowed: number, remaining: number, retryAfterMs: number, resetAfterMs: number];

interface ScriptCommands {
  gwTokenBucket(key: string, ...args: (string | number)[]): Promise<ScriptResult>;
  gwSlidingWindow(key: string, ...args: (string | number)[]): Promise<ScriptResult>;
}

type ScriptedRedis = Redis & ScriptCommands;

function withScripts(redis: Redis): ScriptedRedis {
  // defineCommand is idempotent per connection; ioredis uses EVALSHA and falls back to EVAL on NOSCRIPT.
  redis.defineCommand('gwTokenBucket', { numberOfKeys: 1, lua: TOKEN_BUCKET_LUA });
  redis.defineCommand('gwSlidingWindow', { numberOfKeys: 1, lua: SLIDING_WINDOW_LUA });
  return redis as ScriptedRedis;
}

export interface RedisLimiterOptions {
  /** Prepended to every key, e.g. "gw:". */
  keyPrefix?: string;
  /**
   * Override the time source. Leave unset in production so Redis' own clock is used; tests inject a
   * deterministic clock to compare against the in-memory implementation.
   */
  clock?: Clock;
}

function toDecision(limit: number, [allowed, remaining, retryAfterMs, resetAfterMs]: ScriptResult): RateLimitDecision {
  return {
    allowed: allowed === 1,
    limit,
    remaining: Number(remaining),
    retryAfterMs: Number(retryAfterMs),
    resetAfterMs: Number(resetAfterMs),
  };
}

function assertCost(cost: number, max: number): void {
  if (!Number.isInteger(cost) || cost < 1 || cost > max) {
    throw new RangeError(`cost must be an integer in [1, ${max}], got ${cost}`);
  }
}

export class RedisTokenBucket implements RateLimiter {
  private readonly redis: ScriptedRedis;
  private readonly prefix: string;
  private readonly clock?: Clock;

  constructor(
    redis: Redis,
    private readonly params: TokenBucketParams,
    options: RedisLimiterOptions = {},
  ) {
    this.redis = withScripts(redis);
    this.prefix = options.keyPrefix ?? '';
    this.clock = options.clock;
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    assertCost(cost, this.params.capacity);
    const result = await this.redis.gwTokenBucket(
      this.prefix + key,
      this.params.capacity,
      this.params.refillPerSecond / 1000,
      cost,
      this.clock ? this.clock() : 0,
    );
    return toDecision(this.params.capacity, result);
  }
}

export class RedisSlidingWindow implements RateLimiter {
  private readonly redis: ScriptedRedis;
  private readonly prefix: string;
  private readonly clock?: Clock;
  /** Sorted-set members must be unique or two requests in the same millisecond would collapse into one. */
  private readonly instanceId = randomBytes(6).toString('hex');
  private sequence = 0;

  constructor(
    redis: Redis,
    private readonly params: SlidingWindowParams,
    options: RedisLimiterOptions = {},
  ) {
    this.redis = withScripts(redis);
    this.prefix = options.keyPrefix ?? '';
    this.clock = options.clock;
  }

  async consume(key: string, cost = 1): Promise<RateLimitDecision> {
    assertCost(cost, this.params.limit);
    const member = `${this.instanceId}-${(this.sequence++).toString(36)}`;
    const result = await this.redis.gwSlidingWindow(
      this.prefix + key,
      this.params.limit,
      this.params.windowMs,
      cost,
      this.clock ? this.clock() : 0,
      member,
    );
    return toDecision(this.params.limit, result);
  }
}
