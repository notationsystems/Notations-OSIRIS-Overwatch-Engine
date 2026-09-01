// src/lib/spatial/registry.test.ts
//
// The central test is A1: the ACTUAL MEASURED response — 3.00m and 4.11m
// returning byte-identical routes — planted as a probe, and asserted to yield
// `refuted` rather than `assured`. If that assertion ever passes as assured, the
// abstraction has stopped doing the one thing it exists for.

import { describe, it, expect } from 'vitest';
import {
  SpatialRegistry, arbitrate, shortfallOf, renderRoute, spatialClaim,
  NO_BACKEND_CAPABILITIES,
} from './registry';
import { isDiscriminating } from './engine.types';
import type {
  BackendCapabilities, SpatialEngine, RestrictionVerification, SpatialOperation,
  RouteRequest, VehicleProfile, SpatialResult, Route, RestrictionKind,
  SpatialProvenance,
} from './engine.types';

const AT = '2026-08-31T00:00:00.000Z';

const TRUCK: VehicleProfile = {
  profileId: 'truck_53ft@1.0.0', mode: 'truck',
  heightMm: 4110, widthMm: 2600, lengthMm: 16150,
  grossWeightKg: 36287, hosRuleset: 'ca_nsc',
};

/**
 * The measured failure: endpoint accepted a height, applied nothing.
 *
 * Declared `assured` DELIBERATELY. The whole point is that the backend's own
 * claim is not what decides — the probe is. A fixture that declared `refuted`
 * would be testing that we can read a label.
 */
const REFUTED_HEIGHT = (operation: SpatialOperation): RestrictionVerification => ({
  restriction: 'height', operation, status: 'assured',
  probe: {
    description: '3.00m vs 4.11m, urban lane',
    belowThreshold: { distanceM: 18261, durationS: 1102 },
    aboveThreshold: { distanceM: 18261, durationS: 1102 },   // identical — measured
    durationDeltaPct: 0, verifiedAt: AT,
  },
  note: 'endpoint accepted the parameter',
});

/** The measured success: crossing 4.60m moved duration +68%, distance -0.3%. */
const ASSURED_HEIGHT = (operation: SpatialOperation): RestrictionVerification => ({
  restriction: 'height', operation, status: 'assured',
  probe: {
    description: '4.11m vs 4.60m, lane with a binding low bridge',
    belowThreshold: { distanceM: 18261, durationS: 1102 },
    aboveThreshold: { distanceM: 18202, durationS: 1851 },
    durationDeltaPct: 67.97, verifiedAt: AT,
  },
  note: 'restriction applied — pushed onto surface streets',
});

/**
 * THE FIXTURE THAT ACTUALLY SEPARATES THE TWO IMPLEMENTATIONS.
 *
 * Distance moved -0.3% — exactly what the REAL honoured restriction did to
 * distance — while duration stayed flat. Under the original `isDiscriminating`,
 * which returned true when EITHER axis moved, this probe reads as
 * discriminating and promotes the capability to `assured`.
 *
 * Verified by planting that implementation: the byte-identical A1 fixture above
 * still passed, because it is identical on BOTH axes and so returns false under
 * either version. A1 is the right story and could not, by itself, catch the
 * inversion. This is the one that does.
 */
const DISTANCE_ONLY_HEIGHT = (operation: SpatialOperation): RestrictionVerification => ({
  restriction: 'height', operation, status: 'assured',
  probe: {
    description: '4.11m vs 4.60m — distance moved, duration did not',
    belowThreshold: { distanceM: 18261, durationS: 1102 },
    aboveThreshold: { distanceM: 18202, durationS: 1102 },
    durationDeltaPct: 0, verifiedAt: AT,
  },
  note: 'distance wobble only — not evidence the restriction binds',
});

const OPS: SpatialOperation[] = ['route', 'matrix', 'nearest'];

const caps = (
  id: string,
  honoured: RestrictionKind[],
  verification: RestrictionVerification[],
  ops: SpatialOperation[] = OPS,
): BackendCapabilities => ({
  ...NO_BACKEND_CAPABILITIES,
  backendId: id,
  operations: new Set(ops),
  restrictionsHonoured: new Map(ops.map(o => [o, new Set(honoured)])),
  verification,
  maxMatrixDimension: 100,
  supportsIsochrone: false,
  coverage: { regions: ['CA-ON', 'CA-QC', 'US-MI'], note: 'regional extract' },
});

function fakeEngine(c: BackendCapabilities, route: Route): SpatialEngine {
  const nyi = async (): Promise<never> => { throw new Error('nyi'); };
  return {
    capabilities: c,
    async route(req: RouteRequest): Promise<SpatialResult<Route>> {
      const a = arbitrate(c, 'route', req.require);
      return {
        status: 'ok',
        claim: spatialClaim(route, {
          backendId: c.backendId, backendVersion: '3.4', operation: 'route',
          mode: req.profile.mode,
          restrictionsRequested: [...req.require],
          restrictionsHonoured: a.assured,
          // Only ASSURED counts. `honoured` as "the backend accepted it" is the
          // exact conflation the probe exists to break.
          legalityAssured: req.require.length > 0 && shortfallOf(a).length === 0,
          networkVintage: '2026-08-01', computedAt: AT, computeMs: 12,
        }, renderRoute),
      };
    },
    matrix: nyi, isochrone: nyi, nearest: nyi,
    serviceArea: nyi, mapMatch: nyi, networkAnalysis: nyi,
  };
}

const ROUTE: Route = { distanceM: 545960, durationS: 19800, geometry: [], legs: [] };

// ─── the finding this abstraction exists for ─────────────────────────────────
describe('a backend that accepts a restriction and applies nothing is REFUTED', () => {
  it('identical probe sides are not discriminating', () => {
    expect(isDiscriminating(REFUTED_HEIGHT('route'))).toBe(false);
  });

  it('a discriminating probe IS discriminating', () => {
    expect(isDiscriminating(ASSURED_HEIGHT('route'))).toBe(true);
  });

  it('the measured case yields refuted, never assured', () => {
    const a = arbitrate(
      caps('endpoint-only', ['height'], [REFUTED_HEIGHT('route')]), 'route', ['height']);
    expect(a.refuted).toContain('height');
    expect(a.assured).not.toContain('height');
  });

  it('the backend declaring itself assured does not make it so', () => {
    // REFUTED_HEIGHT carries status:'assured'. The probe overrules the label.
    expect(REFUTED_HEIGHT('route').status).toBe('assured');
    expect(arbitrate(caps('x', ['height'], [REFUTED_HEIGHT('route')]), 'route', ['height']).assured)
      .toEqual([]);
  });

  it('DISTANCE ALONE IS NOT DISCRIMINATING — the case A1 cannot catch', () => {
    // Duration is the axis. The measured honoured restriction moved distance
    // only 0.3%, so a distance-only change is consistent with the restriction
    // being ignored, and `isDiscriminating` is what promotes a capability to
    // assured — which sets legalityAssured, which decides whether a driver goes.
    expect(isDiscriminating(DISTANCE_ONLY_HEIGHT('route'))).toBe(false);
    const a = arbitrate(
      caps('distance-wobble', ['height'], [DISTANCE_ONLY_HEIGHT('route')]), 'route', ['height']);
    expect(a.refuted).toContain('height');
    expect(a.assured).toEqual([]);
  });

  it('and it refuses end to end, not merely in the arbiter', async () => {
    const reg = new SpatialRegistry().register(
      fakeEngine(caps('distance-wobble', ['height'], [DISTANCE_ONLY_HEIGHT('route')]), ROUTE));
    const r = await reg.route(
      { from: [-79.38, 43.65], to: [-73.57, 45.50], profile: TRUCK, require: ['height'] });
    expect(r.status).toBe('refused');
  });

  it('a genuinely applied restriction is assured', () => {
    const a = arbitrate(
      caps('verified', ['height'], [ASSURED_HEIGHT('route')]), 'route', ['height']);
    expect(a.assured).toContain('height');
    expect(a.refuted).toHaveLength(0);
  });

  it('claimed-but-never-probed is unverified, not assured', () => {
    const c = caps('x', ['height', 'weight'], [ASSURED_HEIGHT('route')]);
    const a = arbitrate(c, 'route', ['height', 'weight']);
    expect(a.assured).toEqual(['height']);
    expect(a.unverified).toEqual(['weight']);
  });

  it('a restriction not honoured at all is unhonoured', () => {
    const a = arbitrate(caps('x', ['height'], [ASSURED_HEIGHT('route')]), 'route', ['hos']);
    expect(a.unhonoured).toEqual(['hos']);
  });
});

// ─── a backend is not uniform across its endpoints ───────────────────────────
describe('arbitration is per operation, so a matrix cannot borrow a route verdict', () => {
  // Measured: honours the restriction on directions, discards it on matrix.
  const ASYMMETRIC = caps('asymmetric', ['height'],
    [ASSURED_HEIGHT('route'), REFUTED_HEIGHT('matrix')]);

  it('the same restriction is assured on route and refuted on matrix', () => {
    expect(arbitrate(ASYMMETRIC, 'route', ['height']).assured).toEqual(['height']);
    expect(arbitrate(ASYMMETRIC, 'matrix', ['height']).refuted).toEqual(['height']);
  });

  it('select() for matrix does not inherit the route assurance', () => {
    const reg = new SpatialRegistry().register(fakeEngine(ASYMMETRIC, ROUTE));
    expect(shortfallOf(reg.select('route', ['height']).arbitration!)).toEqual([]);
    expect(shortfallOf(reg.select('matrix', ['height']).arbitration!)).toEqual(['height']);
  });

  it('an operation with no verdict at all is unverified, never assured', () => {
    expect(arbitrate(ASYMMETRIC, 'nearest', ['height']).unverified).toEqual(['height']);
  });
});

// ─── strict is the freight default ───────────────────────────────────────────
describe('strict mode refuses rather than returning a possibly-illegal route', () => {
  const req: RouteRequest = {
    from: [-79.38, 43.65], to: [-73.57, 45.50], profile: TRUCK, require: ['height'],
  };
  const refuting = () => new SpatialRegistry().register(
    fakeEngine(caps('endpoint-only', ['height'], [REFUTED_HEIGHT('route')]), ROUTE));
  const assuring = () => new SpatialRegistry().register(
    fakeEngine(caps('verified', ['height'], [ASSURED_HEIGHT('route')]), ROUTE));

  it('refuses when the only backend refutes the restriction', async () => {
    const r = await refuting().route(req);
    expect(r.status).toBe('refused');
    if (r.status === 'refused') {
      expect(r.unhonoured).toContain('height');
      expect(r.reason).toBe('restriction_not_honoured');
      expect(r.remedy).toContain('is not evidence it applies it');
    }
  });

  it('succeeds when a backend assures it', async () => {
    const r = await assuring().route(req);
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.claim.provenance.legalityAssured).toBe(true);
  });

  /**
   * THE BRANCH THAT COULD NOT BE REACHED.
   *
   * This assertion previously read `expect(r.status).toBe('refused')` under the
   * title "planning mode degrades", with a comment explaining that the registry
   * refuses at selection. The title and the assertion contradicted each other,
   * because the assertion was written to match observed behaviour: `select()`
   * returned engine:null whenever anything was unassured, so route() refused
   * before it could build the degraded response, and `strict:false` was the
   * same function as `strict:true`.
   *
   * Ratifying that would have locked the dead branch in permanently — a test
   * asserting the absence of the feature it is named for.
   */
  it('planning mode DEGRADES and names the shortfall — never silently', async () => {
    const r = await refuting().route(req, { strict: false });
    expect(r.status).toBe('degraded');
    if (r.status === 'degraded') {
      expect(r.unhonoured).toContain('height');
      expect(r.warning).toContain('do not send a driver');
      expect(r.warning).toContain('Not legality-assured');
    }
  });

  it('the two modes genuinely differ — the pin against them collapsing again', async () => {
    const strict = await refuting().route(req, { strict: true });
    const loose = await refuting().route(req, { strict: false });
    expect(strict.status).toBe('refused');
    expect(loose.status).toBe('degraded');
    expect(strict.status).not.toBe(loose.status);
  });

  it('an assured request is plain ok under either mode', async () => {
    expect((await assuring().route(req, { strict: true })).status).toBe('ok');
    expect((await assuring().route(req, { strict: false })).status).toBe('ok');
  });

  it('strict refuses WITHOUT calling the backend', async () => {
    // Otherwise the refusal depends on whether the backend happened to be up,
    // and a request is spent only to discard its answer.
    let called = 0;
    const base = fakeEngine(caps('endpoint-only', ['height'], [REFUTED_HEIGHT('route')]), ROUTE);
    const counting: SpatialEngine = { ...base, route: async (r) => { called++; return base.route(r); } };
    const out = await new SpatialRegistry().register(counting).route(req, { strict: true });
    expect(out.status).toBe('refused');
    expect(called).toBe(0);
  });

  it('refuses an unsupported operation with the registered set named', async () => {
    const r = await new SpatialRegistry().route(req);
    expect(r.status).toBe('refused');
    if (r.status === 'refused') {
      expect(r.reason).toBe('operation_unsupported');
      expect(r.remedy).toContain('none');
    }
  });
});

// ─── the claim never overstates ──────────────────────────────────────────────
describe('rendered spatial claims', () => {
  const prov = (over: Partial<SpatialProvenance>): SpatialProvenance => ({
    backendId: 'b', backendVersion: '1', operation: 'route', mode: 'truck',
    restrictionsRequested: [], restrictionsHonoured: [], legalityAssured: false,
    networkVintage: null, computedAt: AT, computeMs: 1, ...over,
  });

  it('an assured route says truck-legal AND says it is modeled', () => {
    const s = renderRoute({ distanceM: 545960, durationS: 19800 }, prov({
      backendId: 'verified', backendVersion: '3.4',
      restrictionsRequested: ['height'], restrictionsHonoured: ['height'],
      legalityAssured: true, networkVintage: '2026-08-01',
    }));
    expect(s).toContain('truck-legal');
    expect(s).toContain('Modeled estimate, not an observation');
  });

  it('and it says RAIL-legal for a rail profile, not truck-legal', () => {
    // The mode is carried on provenance for this reason. Rendering "truck-legal"
    // from provenance that does not know the mode prints it over any profile.
    const s = renderRoute({ distanceM: 1000, durationS: 100 }, prov({
      mode: 'rail', restrictionsRequested: ['weight'], restrictionsHonoured: ['weight'],
      legalityAssured: true,
    }));
    expect(s).toContain('rail-legal');
    expect(s).not.toContain('truck-legal');
  });

  it('an unassured route says NOT legality-assured, with what was requested', () => {
    const s = renderRoute({ distanceM: 545960, durationS: 19800 }, prov({
      backendId: 'endpoint-only', restrictionsRequested: ['height'], restrictionsHonoured: [],
      legalityAssured: false, networkVintage: '2026-08-01',
    }));
    expect(s).toContain('NOT legality-assured');
    expect(s).toContain('honoured none');
  });

  it('NOTHING REQUESTED MAKES NO LEGALITY CLAIM, not a passing one', () => {
    // `truck-legal for ` with an empty list asserts a clearance nobody asked for
    // and nothing checked — a join on an empty array.
    const s = renderRoute({ distanceM: 1000, durationS: 3660 },
      prov({ legalityAssured: true, restrictionsRequested: [], restrictionsHonoured: [] }));
    expect(s).toContain('no legality claim is made');
    expect(s).not.toContain('truck-legal');
  });

  it('the network vintage is stated — the graph is evidence too', () => {
    expect(renderRoute({ distanceM: 1000, durationS: 100 }, prov({ networkVintage: '2026-08-01' })))
      .toContain('network 2026-08-01');
  });

  it('an unknown vintage says so rather than omitting the line', () => {
    expect(renderRoute({ distanceM: 1000, durationS: 100 }, prov({ networkVintage: null })))
      .toContain('network vintage unknown');
  });

  it('the rendering names the operation, since capability is per operation', () => {
    expect(renderRoute({ distanceM: 1000, durationS: 60 }, prov({ operation: 'matrix' })))
      .toContain('for matrix');
  });

  it('every spatial claim is sourceClass modeled — never reported', () => {
    expect(spatialClaim(ROUTE, prov({}), renderRoute).sourceClass).toBe('modeled');
  });

  it('a claim holds no clock: two over identical inputs are identical', () => {
    // computedAt is injected. Defaulting it to the wall clock makes two runs
    // over the same inputs produce two different claims, so a replay can never
    // be compared byte-for-byte against the original.
    const a = spatialClaim(ROUTE, prov({}), renderRoute);
    const b = spatialClaim(ROUTE, prov({}), renderRoute);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.provenance.computedAt).toBe(AT);
  });
});

// ─── the inventory is the operator-facing truth ──────────────────────────────
describe('inventory reports what each backend can be trusted to do', () => {
  const reg = () => new SpatialRegistry()
    .register(fakeEngine(caps('good', ['height'], [ASSURED_HEIGHT('route')], ['route']), ROUTE))
    .register(fakeEngine(caps('bad', ['height'], [REFUTED_HEIGHT('route')], ['route']), ROUTE));

  it('separates assured from refuted per backend', () => {
    const inv = reg().inventory();
    expect(inv.find(i => i.backendId === 'good')!.assured).toContain('height');
    expect(inv.find(i => i.backendId === 'bad')!.refuted).toContain('height');
  });

  it('one row per (backend, operation), not one per backend', () => {
    const multi = new SpatialRegistry().register(
      fakeEngine(caps('m', ['height'], [ASSURED_HEIGHT('route')], ['route', 'matrix']), ROUTE));
    expect(multi.inventory().map(r => r.operation).sort()).toEqual(['matrix', 'route']);
  });

  it('the unhonoured column can actually be non-empty', () => {
    // Arbitrating over [...restrictionsHonoured] makes it empty by
    // construction: a column of zeroes reading as a clean bill on every
    // backend. Over the full vocabulary the ones it does not honour show.
    const row = reg().inventory().find(i => i.backendId === 'good')!;
    expect(row.unhonoured.length).toBeGreaterThan(0);
    expect(row.unhonoured).toContain('hazmat');
  });
});
