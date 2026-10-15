import type { RouteConfig } from './config.js';

export interface MatchedRoute {
  route: RouteConfig;
  routeId: string;
  /** Path to request from the upstream (before the upstream base path is applied). Always starts with "/". */
  upstreamPath: string;
}

interface CompiledRoute {
  route: RouteConfig;
  routeId: string;
  /** Path without a trailing slash; "" for the root route. */
  prefix: string;
  methods?: Set<string>;
}

/**
 * Longest-prefix router. A route matches on whole path segments, so "/users" matches "/users" and
 * "/users/42" but not "/usersettings". Among matches the most specific (longest) prefix wins; ties keep
 * config order.
 */
export class Router {
  private readonly routes: CompiledRoute[];

  constructor(routes: readonly RouteConfig[]) {
    this.routes = routes
      .map((route) => ({
        route,
        routeId: route.id ?? route.path,
        prefix: route.path === '/' ? '' : route.path.replace(/\/+$/, ''),
        methods: route.methods ? new Set(route.methods) : undefined,
      }))
      .sort((a, b) => b.prefix.length - a.prefix.length); // Array.prototype.sort is stable
  }

  match(pathname: string, method: string): MatchedRoute | undefined {
    for (const candidate of this.routes) {
      const { prefix } = candidate;
      const onSegmentBoundary =
        prefix === '' || pathname === prefix || (pathname.startsWith(prefix) && pathname[prefix.length] === '/');
      if (!onSegmentBoundary) continue;
      if (candidate.methods && !candidate.methods.has(method)) continue;

      const rest = candidate.route.stripPrefix ? pathname.slice(prefix.length) : pathname;
      return {
        route: candidate.route,
        routeId: candidate.routeId,
        upstreamPath: rest.startsWith('/') ? rest : `/${rest}`,
      };
    }
    return undefined;
  }
}
