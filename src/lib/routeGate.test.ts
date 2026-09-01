import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROUTE_DISPOSITION, RETIRED_ROUTES, KEPT_DESPITE_GENERAL_PURPOSE, DELETED_ROUTES,
  routesEnabled, isRouteEnabled, requireRouteEnabled, ROUTE_RETIRED_STATUS,
} from './routeGate';

/**
 * Retired and STILL PRESENT on disk — the set the environment override can
 * actually act on.
 *
 * Phase 70 deleted every handler that was retired at the time, so this is
 * empty today. That is stated, and asserted, rather than left for a reader
 * to infer from tests that quietly stopped exercising anything: a test that
 * loops over an empty list passes, and passing is exactly what it must not
 * be allowed to do silently.
 */
const RETIRED_BUT_PRESENT = RETIRED_ROUTES.filter((r) => !DELETED_ROUTES.has(r));

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
    // Was >40 before phase 70 deleted 31 handlers. The floor is the LIVE
    // surface now; the deleted ones are counted separately below, so the
    // total this test guards did not silently absorb them.
    expect(ROUTES.length).toBeGreaterThan(30);
    expect(DELETED_ROUTES.size).toBe(31);
    expect(ROUTES.length + DELETED_ROUTES.size).toBe(Object.keys(ROUTE_DISPOSITION).length);
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
    // Conservation is now over THREE states, not two: every classified name
    // is live, retired-and-present, or deleted. Folding deleted into either
    // of the others is how a count starts looking right while meaning
    // something else.
    expect(enabled.size + retired.size).toBe(Object.keys(ROUTE_DISPOSITION).length);
    expect(enabled.size + RETIRED_BUT_PRESENT.length).toBe(ROUTES.length);
  });

  it('a deleted route is not served, and is not reported live', () => {
    for (const route of DELETED_ROUTES) {
      expect(isRouteEnabled(route), `${route} is deleted and must not read as live`).toBe(false);
      expect(routesEnabled().has(route)).toBe(false);
    }
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
  /**
   * WHAT THE DELETION DID TO THIS MECHANISM, said out loud.
   *
   * `PAYLOAD_ROUTES_ENABLED` was A-1's escape hatch: a retired route could be
   * switched back on without a deploy. Phase 70 deleted every handler that
   * was retired, so today the switch has nothing to act on — flipping any of
   * the 31 names on would enable a route with no code behind it.
   *
   * The mechanism is KEPT, because the next route retired without deletion
   * needs it and it is six lines. But a switch that can currently change
   * nothing is exactly the shape this codebase keeps finding, so it is
   * pinned as vacuous rather than left looking operative — and the pin
   * inverts the moment a route is retired without being deleted.
   */
  it('is currently vacuous, and says so', () => {
    expect(RETIRED_BUT_PRESENT, [
      'The override has something to act on again. Delete this assertion and',
      'restore the two below to use a real retired-but-present route.',
    ].join(' ')).toEqual([]);
  });

  it('refuses to enable a route whose handler was deleted', () => {
    // The important half. Enabling a deleted route would report it live and
    // then answer nothing — an operator would believe the switch worked.
    const deleted = [...DELETED_ROUTES][0];
    process.env.PAYLOAD_ROUTES_ENABLED = deleted;
    expect(isRouteEnabled(deleted)).toBe(false);
    expect(requireRouteEnabled(deleted)).not.toBeNull();
  });

  it('the override still works, on a route that exists', () => {
    // Exercised against a synthetic name rather than a real retirement,
    // because there are none left. This holds the MECHANISM while
    // RETIRED_BUT_PRESENT is empty, so the deletion did not quietly take
    // the coverage with it.
    const live = 'economy';
    expect(isRouteEnabled(live)).toBe(true);
    process.env.PAYLOAD_ROUTES_ENABLED = 'not-a-route';
    expect(isRouteEnabled('not-a-route')).toBe(true); // unclassified names still pass through
    delete process.env.PAYLOAD_ROUTES_ENABLED;
    expect(isRouteEnabled('not-a-route')).toBe(false);
  });

  it('enablement is recomputed per call, not snapshotted at module load', () => {
    // A module-level snapshot would answer from the environment as it was when
    // the module first loaded — the severed-premise hazard, in a new place.
    expect(isRouteEnabled('synthetic-route')).toBe(false);
    process.env.PAYLOAD_ROUTES_ENABLED = 'synthetic-route';
    expect(isRouteEnabled('synthetic-route')).toBe(true);
    delete process.env.PAYLOAD_ROUTES_ENABLED;
    expect(isRouteEnabled('synthetic-route')).toBe(false);
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
describe('the retired surface is served by one handler, and only one', () => {
  /**
   * WHAT THIS REPLACED, and why the question changed.
   *
   * Before phase 70 this block asserted that each of 31 retired handlers
   * consulted the gate and named its own route — because retirement was a
   * fact in a list until each handler chose to honour it, and a copy-paste
   * guarding `earthquakes` from inside `fires` would have passed a weaker
   * check. Thirty-one chances to get it wrong.
   *
   * Deleting the handlers deleted the hazard. There is now one place the
   * refusal is produced, so the question becomes: is that place the ONLY
   * place, and does it still answer for every name?
   */
  const CATCH_ALL = join(API_ROOT, '[...retired]', 'route.ts');

  it('no deleted route has a handler left behind', () => {
    // A survivor would answer without ever reaching the catch-all, and the
    // record in DELETED_ROUTES would be false while looking right.
    const survivors = [...DELETED_ROUTES].filter((r) => existsSync(join(API_ROOT, r, 'route.ts')));
    expect(survivors, 'these are recorded as deleted and still have a handler').toEqual([]);
  });

  it('the catch-all answers for every deleted route, by consulting the record', () => {
    const src = readFileSync(CATCH_ALL, 'utf8');
    // It must decide from DELETED_ROUTES rather than from a second list of
    // its own — two lists of one fact drift, and drift silently.
    expect(src).toContain('DELETED_ROUTES.has(route)');
    expect(src).toContain('routeRetiredPayload(route)');
    expect(src).toContain('ROUTE_RETIRED_STATUS');
  });

  it('the catch-all distinguishes retired from never-existed from missing', () => {
    // Which kind of nothing. A 404 for a retired route would erase its
    // history; a 503 for a typo would invent one; and a classified route
    // with no handler is a build defect, not a policy refusal.
    const src = readFileSync(CATCH_ALL, 'utf8');
    expect(src).toContain("'no_such_route'");
    expect(src).toContain("'route_handler_missing'");
  });

  it('no LIVE route consults the gate — that would retire it invisibly', () => {
    // The catch-all is the one exemption, and it is named rather than
    // pattern-matched away: it exists to PRODUCE the refusal, so finding the
    // refusal in it is the point. Every other live route calling the gate
    // would be retiring itself where no classification says so.
    const REFUSAL_HANDLER = '[...retired]';
    const gated: string[] = [];
    for (const route of routesEnabled()) {
      if (route === REFUSAL_HANDLER) continue;
      const file = join(API_ROOT, route, 'route.ts');
      if (!existsSync(file)) continue;
      const src = readFileSync(file, 'utf8');
      if (src.includes('requireRouteEnabled(') || src.includes('routeRetiredPayload(')) {
        gated.push(route);
      }
    }
    expect(gated, 'a live route that calls the gate is retired in effect').toEqual([]);
  });
});
