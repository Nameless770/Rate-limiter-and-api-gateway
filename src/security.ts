import type { GatewayConfig } from './config.js';
import { isLoopbackHost } from './net/ip.js';

/**
 * Things that are legal but weaken the gateway's defences, worded for an operator reading startup logs.
 * Nothing here is an error: a deployment behind a private network or an authenticating proxy can reasonably
 * accept each of them. The point is that they are chosen rather than stumbled into.
 */
export function securityNotes(config: GatewayConfig): string[] {
  const notes: string[] = [];
  const rl = config.rateLimit;

  const limited = config.routes.some((r) =>
    r.rateLimit === undefined ? rl.default !== undefined : r.rateLimit !== false,
  );
  if (limited && rl.apiKeys.length === 0 && rl.ip === undefined) {
    notes.push(
      `rate limits are keyed on the "${rl.identityHeader}" header and no key registry or per-address ceiling is ` +
        'configured, so a client can obtain a fresh budget by changing the header value. Set rateLimit.apiKeys ' +
        'and/or rateLimit.ip.',
    );
  }

  if (rl.trustedProxyHops === 0 && config.host !== '127.0.0.1' && config.host !== '::1') {
    notes.push(
      'trustedProxyHops is 0, so X-Forwarded-* from clients is ignored and the socket address identifies each ' +
        'client. If a load balancer or CDN fronts this gateway, set trustedProxyHops or every client will share ' +
        "that proxy's budget.",
    );
  }

  for (const route of config.routes) {
    if (route.cache && route.cache.varyHeaders.length === 0) {
      notes.push(
        `route "${route.id ?? route.path}" caches with no varyHeaders, so every client is served the same ` +
          'cached response. Use that only for public data.',
      );
    }
  }

  if (config.redis) {
    let host = '';
    try {
      host = new URL(config.redis.url).hostname;
    } catch {
      // schema validation has already vetted the scheme; an unparsable host just skips this note
    }
    if (config.redis.url.startsWith('redis://') && host && !isLoopbackHost(host)) {
      notes.push(
        `redis connection to "${host}" is not encrypted (redis://). Rate-limit keys and counters cross the ` +
          'network in plaintext; use rediss:// outside a trusted private network.',
      );
    }
  }

  for (const issuer of config.auth.jwt?.issuers ?? []) {
    if (issuer.audience === undefined) {
      notes.push(
        `JWT issuer "${issuer.name}" has no audience, so it accepts any token its key signed, including ones minted ` +
          'for other services. Set audience.',
      );
    }
  }

  if (config.admin.enabled && !isLoopbackHost(config.admin.host)) {
    notes.push(
      `the admin listener is bound to ${config.admin.host}:${config.admin.port}. It requires a bearer token, ` +
        'but should still not be reachable from the public internet.',
    );
  }

  return notes;
}
