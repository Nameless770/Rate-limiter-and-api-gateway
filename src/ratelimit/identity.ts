import { createHash } from 'node:crypto';
import type { GatewayConfig, RateLimitRuleConfig } from '../config.js';

/** Who a request is, for the purpose of picking a rate-limit budget. */
export interface Identity {
  /** Stable key fragment for limiter keys. Never contains a raw credential. */
  id: string;
  kind: 'key' | 'anonymous';
  /** Registered key name (safe to log). Absent for anonymous callers and for unregistered keys in open mode. */
  name?: string;
  /** Scales the route's rule (plans, or the anonymous multiplier). */
  multiplier: number;
  /** Per-route replacement rules for this key; `false` means unlimited on that route. */
  overrides?: Record<string, RateLimitRuleConfig | false>;
  /** How the caller proved who they are, when the gateway checked. */
  authMethod?: 'api-key' | 'jwt';
}

export type IdentityResult = { ok: true; identity: Identity } | { ok: false; reason: 'key_required' };

type RateLimitConfig = GatewayConfig['rateLimit'];

export function keyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Turns the credential header and client address into an {@link Identity}.
 *
 * Without a key registry ("open" mode) any header value is accepted as an identity. That is convenient but
 * means a client can mint a new budget by changing the header, so the per-IP ceiling is what bounds abuse.
 * With a registry, only registered keys get their own budget; everything else shares the budget of its
 * client address, so rotating key values buys nothing.
 */
export class IdentityResolver {
  private readonly registry = new Map<string, Identity>();
  readonly open: boolean;
  private readonly anonymousMultiplier: number;
  private readonly requireKey: boolean;

  constructor(config: RateLimitConfig) {
    this.anonymousMultiplier = config.anonymousMultiplier;
    this.requireKey = config.requireKey;
    for (const entry of config.apiKeys) {
      const plan = entry.plan === undefined ? undefined : config.plans[entry.plan];
      this.registry.set(entry.sha256.toLowerCase(), {
        id: `k:${entry.sha256.toLowerCase().slice(0, 32)}`,
        kind: 'key',
        name: entry.name,
        multiplier: plan?.multiplier ?? 1,
        overrides: entry.overrides,
        authMethod: 'api-key',
      });
    }
    this.open = this.registry.size === 0;
  }

  /** The identity of a *registered* key, or undefined for anything else. Never invents one. */
  lookupRegistered(presentedKey: string): Identity | undefined {
    return this.registry.get(keyDigest(presentedKey));
  }

  resolve(presentedKey: string | undefined, clientIp: string): IdentityResult {
    if (presentedKey) {
      const digest = keyDigest(presentedKey);
      const registered = this.registry.get(digest);
      if (registered) return { ok: true, identity: registered };
      if (this.open) {
        // Open mode: the value itself is the identity.
        return { ok: true, identity: { id: `k:${digest.slice(0, 32)}`, kind: 'key', multiplier: 1 } };
      }
    }
    if (this.requireKey) return { ok: false, reason: 'key_required' };
    return { ok: true, identity: { id: `ip:${clientIp}`, kind: 'anonymous', multiplier: this.anonymousMultiplier } };
  }
}

/** Scale a rule's allowance. Multiplier 1 returns the rule itself. */
export function scaleRule(rule: RateLimitRuleConfig, multiplier: number): RateLimitRuleConfig {
  if (multiplier === 1) return rule;
  if (rule.algorithm === 'token-bucket') {
    return {
      ...rule,
      capacity: Math.max(1, Math.ceil(rule.capacity * multiplier)),
      refillPerSecond: rule.refillPerSecond * multiplier,
    };
  }
  return { ...rule, limit: Math.max(1, Math.ceil(rule.limit * multiplier)) };
}

/** The most a single request could ever spend under this rule: its whole allowance. */
export function ruleAllowance(rule: RateLimitRuleConfig): number {
  return rule.algorithm === 'token-bucket' ? rule.capacity : rule.limit;
}

/** A stable identity for a rule's parameters, used to cache one limiter per distinct rule. */
export function ruleFingerprint(rule: RateLimitRuleConfig): string {
  return JSON.stringify(rule, Object.keys(rule).sort());
}
