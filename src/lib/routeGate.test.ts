import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROUTE_DISPOSITION, RETIRED_ROUTES, KEPT_DESPITE_GENERAL_PURPOSE,
  routesEnabled, isRouteEnabled, requireRouteEnabled, ROUTE_RETIRED, ROUTE_RETIRED_STATUS,
} from './routeGate';

const API_ROOT = join(process.cwd(), 'src/app/api');

function routeIds(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, prefix ? `${prefix}/${entry}` : entry);
      else if (entry === 'route.ts') out.push(prefix);
    }
  };
  walk(API_ROOT, '');
  return out.sort();
}

afterEach(() => { delete process.env.PAYLOAD_ROUTES_ENABLED; });

/**
 * CONSERVATION IS THE POINT.
 *
 * The design this replaces carried its own allowlist beside the disposition
 * map. Measured against the tree, 18 of 66 routes were in NEITHER list —
 * including `osint/mac` and `osint/threats`, which A-0 deliberately kept
 * with a written constraint, and the three `cctv/*` sub-routes that do the
 * actual stream proxying `cctv`'s retirement was meant to stop. A route in
 * neither bucket is not disabled and not deliberately enabled; it is simply
 * outside the mechanism, which is the worst of the three states because it
 * looks handled.
 */
describe('every route lands in exactly one bucket', () => {
  const ROUTES = routeIds();

  it('the tree has routes to account for', () => {
    expect(ROUTES.length).toBeGreaterThan(40);
  });

  it('every route on disk is classified', () => {
    const unclassified = ROUTES.filter((r) => !(r in ROUTE_DISPOSITION));
    expect(unclassified, 'unclassified routes are outside the gate entirely').toEqual([]);
  });

  it('enabled + retired conserves over the whole surface', () => {
    const enabled = routesEnabled();
    const retired = new Set(RETIRED_ROUTES);
    const both = ROUTES.filter((r) => enabled.has(r) && retired.has(r));
    const neither = ROUTES.filter((r) => !enabled.has(r) && !retired.has(r));
    expect(both, 'a route cannot be both live and retired').toEqual([]);
    expect(neither, 'a route in neither bucket is outside the mechanism').toEqual([]);
    expect(enabled.size + retired.size).toBe(ROUTES.length);
  });

  it('the sub-routes of a retired parent are retired too', () => {
    // cctv retired while cctv/proxy stayed live was the leak in the first draft:
    // the parent is a listing, the sub-routes are what actually proxy the stream.
    const retired = new Set(RETIRED_ROUTES);
    const leaks: string[] = [];
    for (const route of ROUTES) {
      const parent = route.includes('/') ? route.slice(0, route.lastIndexOf('/')) : null;
      if (parent && retired.has(parent) && !retired.has(route)) leaks.push(route);
    }
    expect(leaks, 'these sub-routes survive their retired parent').toEqual([]);
  });
});

/**
 * The gate must not contradict A-0's collection-policy disposition.
 */
describe('retirement does not silently undo the collection policy', () => {
  it('every infrastructure-conditional route stays live', () => {
    // A-0 KEPT these, and wrote the organisational-attribution constraint into
    // each one's source. Retiring them here would be a second, contradictory
    // disposition of the same routes.
    const conditional = Object.entries(ROUTE_DISPOSITION)
      .filter(([, d]) => d === 'infrastructure-conditional')
      .map(([r]) => r);
    expect(conditional.length).toBeGreaterThan(0);
    for (const route of conditional) {
      expect(isRouteEnabled(route), `${route} was kept by A-0 and must stay live`).toBe(true);
    }
  });

  it('no freight or ops route is retired', () => {
    const retired = new Set(RETIRED_ROUTES);
    const wrong = Object.entries(ROUTE_DISPOSITION)
      .filter(([r, d]) => (d === 'freight' || d === 'ops') && retired.has(r))
      .map(([r]) => r);
    expect(wrong).toEqual([]);
  });

  it('only general-purpose routes are retired', () => {
    for (const route of RETIRED_ROUTES) {
      expect(ROUTE_DISPOSITION[route]).toBe('general-purpose');
    }
  });

  it('the keep-list names only general-purpose routes, or it is doing nothing', () => {
    for (const route of KEPT_DESPITE_GENERAL_PURPOSE) {
      expect(ROUTE_DISPOSITION[route], `${route} is kept-despite but not general-purpose`)
        .toBe('general-purpose');
      expect(isRouteEnabled(route)).toBe(true);
    }
  });

  it('retirement is not vacuous — it actually retires something', () => {
    expect(RETIRED_ROUTES.length).toBeGreaterThan(10);
  });
});

describe('the refusal says which kind of nothing it is', () => {
  it('answers 503 with a remedy, not 404', async () => {
    const retired = RETIRED_ROUTES[0];
    const res = requireRouteEnabled(retired);
    expect(res).not.toBeNull();
    // 404 would say the route was never there. It exists and is off by design.
    expect(res!.status).toBe(ROUTE_RETIRED_STATUS);
    const body = await res!.json();
    expect(body.error).toBe('route_retired'); // the supplied wire value
    expect(body.detail).toContain('not missing');
    expect(body.remedy).toContain('PAYLOAD_ROUTES_ENABLED');
    expect(body.remedy).toContain(retired);
  });

  it('returns null — no refusal — for a live route', () => {
    expect(requireRouteEnabled('economy')).toBeNull();
  });
});

describe('a vertical can flip a route back on', () => {
  it('the env override enables a retired route', () => {
    const retired = RETIRED_ROUTES[0];
    expect(isRouteEnabled(retired)).toBe(false);
    process.env.PAYLOAD_ROUTES_ENABLED = retired;
    expect(isRouteEnabled(retired)).toBe(true);
    expect(requireRouteEnabled(retired)).toBeNull();
  });

  it('enablement is recomputed per call, not snapshotted at module load', () => {
    // A module-level snapshot would answer from the environment as it was when
    // the module first loaded — the severed-premise hazard, in a new place.
    const retired = RETIRED_ROUTES[1];
    expect(isRouteEnabled(retired)).toBe(false);
    process.env.PAYLOAD_ROUTES_ENABLED = retired;
    expect(isRouteEnabled(retired)).toBe(true);
    delete process.env.PAYLOAD_ROUTES_ENABLED;
    expect(isRouteEnabled(retired)).toBe(false);
  });
});

/**
 * THE GATE ONLY WORKS WHERE IT IS WIRED.
 *
 * A route can be classified `general-purpose`, appear in RETIRED_ROUTES, and
 * still answer every request — because retirement is a fact in a list until
 * the handler actually consults it. That gap is invisible: the list looks
 * right, the test on the list passes, and the feed keeps serving. So the
 * wiring is asserted over the source, not assumed from the classification.
 */
describe('every retired route actually consults the gate', () => {
  it('each retired handler calls the gate', () => {
    const unwired: string[] = [];
    for (const route of RETIRED_ROUTES) {
      const src = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      const consults = src.includes('requireRouteEnabled(') || src.includes('isRouteEnabled(');
      if (!consults) unwired.push(route);
    }
    expect(unwired, [
      'These routes are retired in the classification and still answer every request.',
      'Retirement is a fact in a list until the handler consults it.',
    ].join(' ')).toEqual([]);
  });

  it('each retired handler names ITS OWN route in the call', () => {
    // A copy-paste that guards `earthquakes` from inside `fires` would pass
    // the check above while gating the wrong feed.
    const wrong: string[] = [];
    for (const route of RETIRED_ROUTES) {
      const src = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      if (!src.includes(`('${route}')`)) wrong.push(route);
    }
    expect(wrong, 'these guard a route other than themselves').toEqual([]);
  });

  it('no LIVE route consults the gate — that would retire it invisibly', () => {
    const enabled = [...routesEnabled()];
    const gated: string[] = [];
    for (const route of enabled) {
      const src = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      if (src.includes('requireRouteEnabled(') || src.includes('routeRetiredPayload(')) {
        gated.push(route);
      }
    }
    expect(gated, 'a live route that calls the gate is retired in effect').toEqual([]);
  });
});

/**
 * The supplied suite's cases, kept — they assert things worth asserting and
 * two of them were not covered above.
 */
describe('supplied route-allowlist expectations', () => {
  it('keeps the economy substrate live', () => {
    for (const r of ['economy', 'economy/search', 'economy/table']) {
      expect(isRouteEnabled(r)).toBe(true);
    }
  });

  it('retires every general-purpose route by default', () => {
    for (const r of RETIRED_ROUTES) expect(isRouteEnabled(r)).toBe(false);
  });

  it('an enabled route passes through (null = proceed)', () => {
    expect(requireRouteEnabled('economy')).toBeNull();
  });

  it('retired and enabled do not overlap, and retirement is not vacuous', () => {
    const enabled = routesEnabled();
    for (const r of RETIRED_ROUTES) expect(enabled.has(r)).toBe(false);
    expect(RETIRED_ROUTES.length).toBeGreaterThan(15);
  });

  it('the remedy names the route that would re-enable it', async () => {
    const res = requireRouteEnabled('cctv');
    expect(res).not.toBeNull();
    const body = await res!.json();
    expect(body.remedy).toContain('cctv');
  });
});
