/**
 * Payload — which API routes are live, derived from ONE classification.
 *
 * A-1: retire the general-purpose surface inherited from the base without
 * deleting it, so a commodity vertical can flip a route back on.
 *
 * WHY THE CLASSIFICATION LIVES HERE AND NOT IN A SECOND LIST. The supplied
 * design carried its own allowlist beside the disposition map that
 * `routeSurfacePolicy` already maintains. Measured against the tree, that
 * second enumeration was wrong on its first draft: 18 of 66 routes appeared
 * in NEITHER list, among them `osint/mac` and `osint/threats` — which A-0
 * deliberately KEPT, with the organisational-attribution constraint written
 * into their source — and `cctv/proxy`, `cctv/resolve`,
 * `cctv/stream-status`, the sub-routes that actually proxy the streams
 * `cctv` was being retired to stop.
 *
 * Two lists of one fact drift, and they drift silently because each reads
 * as internally consistent. So the disposition map moves HERE, into
 * production, enablement is DERIVED from it, and the policy test imports it
 * rather than holding a copy. Classifying a route and deciding whether it
 * is live become the same act, and the conservation check is structural:
 * every route on disk is classified, so every route lands in exactly one
 * bucket by construction.
 */

/** How a route relates to what Payload is for. There is no default. */
export type Disposition =
  /** Freight, commerce, or the physical-economy substrate. The instrument. */
  | 'freight'
  /** Infrastructure attributed to an ORGANISATION. Conditional: the route
   *  must state the constraint in its own source (see routeSurfacePolicy). */
  | 'infrastructure-conditional'
  /** Inert general-purpose feeds inherited from the base. Retired from the
   *  default surface by A-1; present in the tree, re-enablable per route. */
  | 'general-purpose'
  /** Operations: health, stats, tiles, webhooks, the app's own plumbing. */
  | 'ops';

export const ROUTE_DISPOSITION: Readonly<Record<string, Disposition>> = {
  'ai/analyze': 'general-purpose',
  'ai/briefing': 'general-purpose',
  'ai/overview': 'general-purpose',
  'air-quality': 'general-purpose',
  aircraft: 'general-purpose',
  arcgis: 'ops',
  astra: 'general-purpose',
  cctv: 'general-purpose',
  'cctv/proxy': 'general-purpose',
  'cctv/resolve': 'general-purpose',
  'cctv/stream-status': 'general-purpose',
  'chain/daily': 'freight',
  'cloudflare-radar': 'general-purpose',
  conflicts: 'general-purpose',
  'country-risk': 'general-purpose',
  crypto: 'general-purpose',
  'cyber-attacks': 'general-purpose',
  'cyber-threats': 'general-purpose',
  directions: 'freight',
  earthquakes: 'general-purpose',
  economy: 'freight',
  'economy/entity': 'freight',
  'economy/guards': 'freight',
  'economy/refusals': 'freight',
  'economy/scenario': 'freight',
  'economy/search': 'freight',
  'economy/table': 'freight',
  'economy/validate': 'freight',
  'entity/expand': 'freight',
  fires: 'general-purpose',
  'flight-route': 'general-purpose',
  flights: 'general-purpose',
  frontlines: 'general-purpose',
  gdelt: 'general-purpose',
  'gdelt-events': 'general-purpose',
  geo: 'freight',
  geosearch: 'freight',
  'github-webhook': 'ops',
  health: 'ops',
  infrastructure: 'freight',
  'live-news': 'general-purpose',
  malware: 'general-purpose',
  maritime: 'freight',
  markets: 'freight',
  'markets/history': 'freight',
  news: 'general-purpose',
  'osint/bgp': 'infrastructure-conditional',
  'osint/certs': 'infrastructure-conditional',
  'osint/dns': 'infrastructure-conditional',
  'osint/ip': 'infrastructure-conditional',
  'osint/mac': 'infrastructure-conditional',
  'osint/sanctions': 'infrastructure-conditional',
  'osint/threats': 'infrastructure-conditional',
  'osint/whois': 'infrastructure-conditional',
  'proxy-tiles': 'ops',
  radar: 'general-purpose',
  'region-dossier': 'general-purpose',
  satellites: 'general-purpose',
  'satellites/orbit': 'general-purpose',
  'scm-suppliers': 'general-purpose',
  'sdk/ingest': 'ops',
  'sdk/stream': 'ops',
  sentinel: 'general-purpose',
  'space-weather': 'general-purpose',
  stats: 'ops',
  weather: 'freight',
};

/**
 * The only two general-purpose routes kept live: A-1's keep-list named them
 * as having genuine freight use — disruption events, and transit risk /
 * seasonal detention. Listed explicitly rather than reclassified, so the
 * reason they survive retirement stays legible.
 *
 * Deliberately short. An earlier draft listed maritime, weather,
 * infrastructure and markets here too; the test rejected them because they
 * are already classified `freight` and stay live on their own. A keep-list
 * entry that keeps something already kept reads as load-bearing and is not.
 */
export const KEPT_DESPITE_GENERAL_PURPOSE: ReadonlySet<string> = new Set([
  'air-quality',
  'news',
]);

/** Routes retired from the default surface: general-purpose, minus the keeps. */
export const RETIRED_ROUTES: readonly string[] = Object.entries(ROUTE_DISPOSITION)
  .filter(([route, d]) => d === 'general-purpose' && !KEPT_DESPITE_GENERAL_PURPOSE.has(route))
  .map(([route]) => route)
  .sort();

function envEnabled(): ReadonlySet<string> {
  const raw = process.env.PAYLOAD_ROUTES_ENABLED;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * Live routes. Read through `isRouteEnabled` rather than directly: this is
 * recomputed per call so a test (or a deployment) can change the environment
 * without a stale module-level snapshot deciding the answer — the
 * severed-premise hazard this codebase keeps finding.
 */
export function routesEnabled(): ReadonlySet<string> {
  const retired = new Set(RETIRED_ROUTES);
  const on = new Set<string>();
  for (const route of Object.keys(ROUTE_DISPOSITION)) {
    if (!retired.has(route)) on.add(route);
  }
  for (const route of envEnabled()) on.add(route);
  return on;
}

export function isRouteEnabled(route: string): boolean {
  return routesEnabled().has(route);
}

export const ROUTE_RETIRED = 'ROUTE_RETIRED';

export interface RouteRetiredPayload {
  readonly error: typeof ROUTE_RETIRED;
  readonly route: string;
  readonly detail: string;
  readonly remedy: string;
}

/**
 * The refusal body, separate from the Response.
 *
 * Some handlers declare a narrowed return type (`NextResponse<T>`) that a
 * bare `Response` does not satisfy, so they need to build their own envelope
 * around the same payload. Exposing the body rather than making them cast
 * keeps ONE refusal shape across every retired route — a cast would let two
 * routes drift into answering differently for the same condition.
 */
export function routeRetiredPayload(route: string): RouteRetiredPayload {
  return {
    error: ROUTE_RETIRED,
    route,
    detail:
      'This general-purpose feed is retired from the default surface. It is present in the ' +
      'tree and off by design — not missing.',
    remedy: `Set PAYLOAD_ROUTES_ENABLED to include "${route}" if a vertical needs it.`,
  };
}

/**
 * Call at the top of a retired route's handler.
 *
 * Answers 503, not 404. The route EXISTS and is deliberately off; 404 would
 * say it was never there, which is a different fact and the kind of
 * which-kind-of-nothing collapse the rest of this tree refuses. The body
 * names the remedy so an operator can act without reading the source.
 */
export function requireRouteEnabled(route: string): Response | null {
  if (isRouteEnabled(route)) return null;
  return new Response(JSON.stringify(routeRetiredPayload(route)),
    { status: 503, headers: { 'content-type': 'application/json' } });
}
