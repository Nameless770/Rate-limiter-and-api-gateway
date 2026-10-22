import { type GatewayConfig, splitHostPort } from './config.js';
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

  const redis = config.redis;
  if (redis?.url !== undefined) {
    let host = '';
    try {
      host = new URL(redis.url).hostname;
    } catch {
      // schema validation has already vetted the scheme; an unparsable host just skips this note
    }
    if (redis.url.startsWith('redis://') && host && !isLoopbackHost(host)) {
      notes.push(
        `redis connection to "${host}" is not encrypted (redis://). Rate-limit keys and counters cross the ` +
          'network in plaintext; use rediss:// outside a trusted private network.',
      );
    }
  } else if (redis && !redis.tls) {
    const nodes = (redis.sentinel?.nodes ?? redis.cluster?.nodes ?? []).map((n) => splitHostPort(n).host);
    const remote = nodes.find((host) => !isLoopbackHost(host));
    if (remote !== undefined) {
      notes.push(
        `redis ${redis.sentinel ? 'sentinel' : 'cluster'} connections (to "${remote}" and others) are not encrypted. ` +
          'Rate-limit keys and counters cross the network in plaintext; set redis.tls outside a trusted private network.',
      );
    }
  }

  const otlp = config.tracing.enabled ? config.tracing.otlp : undefined;
  if (otlp?.endpoint.startsWith('http://')) {
    const host = new URL(otlp.endpoint).hostname.replace(/^\[(.*)\]$/, '$1');
    if (!isLoopbackHost(host)) {
      notes.push(
        `trace spans go to "${host}" over plain HTTP. They carry request paths, route names and the names of ` +
          'authenticated callers; use an https:// collector endpoint outside a trusted private network.',
      );
    }
  }

  for (const route of config.routes) {
    const ws = route.websocket;
    if (!ws) continue;
    const id = route.id ?? route.path;
    if (ws.allowAnyOrigin) {
      notes.push(
        `websocket route "${id}" accepts any Origin. If it authenticates with cookies, any website can open a ` +
          'socket as your logged-in users (cross-site WebSocket hijacking). List allowedOrigins instead.',
      );
    } else if (ws.allowedOrigins.length === 0) {
      notes.push(
        `websocket route "${id}" lists no allowedOrigins, so browsers cannot connect (only clients that send no ` +
          'Origin header, such as scripts and native apps). Set allowedOrigins to let your web app in.',
      );
    }
    if (!route.auth) {
      notes.push(`websocket route "${id}" has no auth: anyone who can reach it can open a connection.`);
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
        'but it is plain HTTP, so that token crosses the network unencrypted. Keep it on a private network or ' +
        'reach it through a TLS-terminating proxy.',
    );
  }

  if (!config.tls && config.host !== '127.0.0.1' && config.host !== '::1' && config.rateLimit.trustedProxyHops === 0) {
    notes.push(
      'the proxy listener is plain HTTP and no trusted proxy is configured, so credentials cross the network ' +
        'unencrypted. Set tls, or put a TLS-terminating proxy in front and set rateLimit.trustedProxyHops.',
    );
  }

  return notes;
}

/**
 * Settings that are legal but cannot do what they appear to: not a security matter, just a configuration that will
 * surprise someone. Logged at start-up (and by `--check`) next to the security notes.
 */
export function configNotes(config: GatewayConfig): string[] {
  const notes: string[] = [];
  // A body is held in memory whole (so a retry can replay it), against one budget shared by every request in flight.
  const budget = config.limits.maxBufferedBytes;
  const tooBig = (limit: number, where: string): void => {
    if (limit <= budget) return;
    notes.push(
      `${where} (${limit} bytes) is larger than limits.maxBufferedBytes (${budget}), so a body bigger than ${budget} ` +
        'bytes is always refused with 503 however idle the gateway is. Raise maxBufferedBytes or lower the limit.',
    );
  };
  tooBig(config.maxBodyBytes, 'maxBodyBytes');
  for (const route of config.routes) {
    if (route.maxBodyBytes !== undefined) tooBig(route.maxBodyBytes, `route "${route.id ?? route.path}" maxBodyBytes`);
  }
  return notes;
}
