import { describe, it, expect } from 'vitest';
import {
  SpatialRegistry, arbitrate, shortfallOf, spatialClaim, renderRoute,
  NO_BACKEND_CAPABILITIES,
} from './registry';
import type {
  BackendCapabilities, RestrictionVerification, SpatialEngine, SpatialOperation,
  RestrictionKind, SpatialProvenance, Route, VehicleProfile,
} from './engine.types';

const AT = '2026-08-31T00:00:00.000Z';

const TRUCK: VehicleProfile = {
  profileId: 'truck_53ft_dryvan@1.0.0', mode: 'truck', heightMm: 4110, grossWeightKg: 36000,
};

/** The measured probe: distance -0.3%, duration +68%. */
const DISCRIMINATING = {
  description: 'height sweep across a bridge threshold',
  belowThreshold: { distanceM: 18261, durationS: 1102 },
  aboveThreshold: { distanceM: 18202, durationS: 1851 },
  durationDeltaPct: 68.0,
  verifiedAt: AT,
};
/** Byte-identical across the threshold: accepted and applied nothing. */
const IDENTICAL = {
  description: 'height sweep, no effect',
  belowThreshold: { distanceM: 18261, durationS: 1102 },
  aboveThreshold: { distanceM: 18261, durationS: 1102 },
  durationDeltaPct: 0,
  verifiedAt: AT,
};

const v = (
  restriction: RestrictionKind,
  operation: SpatialOperation,
  status: RestrictionVerification['status'],
  probe: RestrictionVerification['probe'],
): RestrictionVerification => ({ restriction, operation, status, probe, note: '' });

function caps(over: Partial<BackendCapabilities>): BackendCapabilities {
  return { ...NO_BACKEND_CAPABILITIES, backendId: 'B', ...over };
}

function engine(c: BackendCapabilities): SpatialEngine {
  const ok = async (): Promise<any> => ({
    status: 'ok',
    claim: {
      value: { distanceM: 1000, durationS: 60, geometry: [], legs: [] },
      provenance: {
        backendId: c.backendId, backendVersion: '1', operation: 'route',
        restrictionsRequested: [], restrictionsHonoured: [], legalityAssured: false,
        networkVintage: null, computedAt: AT, computeMs: 1,
      },
      sourceClass: 'modeled', renderedClaim: 'r',
    },
  });
  return {
    capabilities: c,
    route: ok, matrix: ok, isochrone: ok, nearest: ok,
    serviceArea: ok, mapMatch: ok, networkAnalysis: ok,
  };
}

describe('arbitration is per operation, so a matrix cannot borrow a route verdict', () => {
  // The measured backend: honours height on route, discards it on matrix.
  const ASYMMETRIC = caps({
    operations: new Set<SpatialOperation>(['route', 'matrix']),
    restrictionsHonoured: new Map([
      ['route' as SpatialOperation, new Set<RestrictionKind>(['height'])],
      ['matrix' as SpatialOperation, new Set<RestrictionKind>(['height'])],
    ]),
    verification: [
      v('height', 'route', 'assured', DISCRIMINATING),
      v('height', 'matrix', 'refuted', IDENTICAL),
    ],
  });

  it('the same restriction is assured on route and refuted on matrix', () => {
    expect(arbitrate(ASYMMETRIC, 'route', ['height']).assured).toEqual(['height']);
    expect(arbitrate(ASYMMETRIC, 'matrix', ['height']).refuted).toEqual(['height']);
  });

  it('select() for matrix does not inherit the route assurance', () => {
    // THE DEFECT THIS CLOSES. Arbitrating per backend rather than per operation
    // would have selected this backend for matrix as fully assured, and the
    // dispatcher would get a car-legal matrix labelled truck-legal.
    const reg = new SpatialRegistry().register(engine(ASYMMETRIC));
    const forRoute = reg.select('route', ['height']);
    const forMatrix = reg.select('matrix', ['height']);
    expect(shortfallOf(forRoute.arbitration!)).toEqual([]);
    expect(shortfallOf(forMatrix.arbitration!)).toEqual(['height']);
  });

  it('an operation the backend declares but never probed is unverified, not assured', () => {
    const unprobed = caps({
      operations: new Set<SpatialOperation>(['isochrone']),
      restrictionsHonoured: new Map([['isochrone' as SpatialOperation, new Set<RestrictionKind>(['height'])]]),
      verification: [],
    });
    expect(arbitrate(unprobed, 'isochrone', ['height']).unverified).toEqual(['height']);
  });

  it('a probe that ran but did not discriminate counts as refuted, not unverified', () => {
    // Claimed `assured`, but the two sides are identical. The claim loses to
    // the measurement — otherwise a backend self-certifies.
    const lying = caps({
      operations: new Set<SpatialOperation>(['route']),
      restrictionsHonoured: new Map([['route' as SpatialOperation, new Set<RestrictionKind>(['height'])]]),
      verification: [v('height', 'route', 'assured', IDENTICAL)],
    });
    expect(arbitrate(lying, 'route', ['height']).refuted).toEqual(['height']);
  });

  it('a restriction not in the operation map at all is unhonoured', () => {
    expect(arbitrate(ASYMMETRIC, 'route', ['hazmat']).unhonoured).toEqual(['hazmat']);
  });
});

describe('strict:false actually yields a planning estimate', () => {
  const PARTIAL = caps({
    operations: new Set<SpatialOperation>(['route']),
    restrictionsHonoured: new Map([['route' as SpatialOperation, new Set<RestrictionKind>(['height'])]]),
    verification: [v('height', 'route', 'assured', DISCRIMINATING)],
  });
  const reg = () => new SpatialRegistry().register(engine(PARTIAL));

  it('strict refuses when a requirement is unassured', async () => {
    const out = await reg().route(
      { from: [0, 0], to: [1, 1], profile: TRUCK, require: ['height', 'weight'] },
      { strict: true },
    );
    expect(out.status).toBe('refused');
    if (out.status === 'refused') expect(out.unhonoured).toContain('weight');
  });

  it('THE UNREACHABLE BRANCH: strict:false returns degraded, naming the shortfall', async () => {
    // Traced over all four inputs of the original, `degraded` could not be
    // produced: select() returned engine:null whenever anything was unassured,
    // so route() refused before reaching the degraded construction. strict:false
    // and strict:true were the same function.
    const out = await reg().route(
      { from: [0, 0], to: [1, 1], profile: TRUCK, require: ['height', 'weight'] },
      { strict: false },
    );
    expect(out.status).toBe('degraded');
    if (out.status === 'degraded') {
      expect(out.unhonoured).toContain('weight');
      expect(out.unhonoured).not.toContain('height');
      expect(out.warning).toContain('do not send a driver');
    }
  });

  it('the two modes genuinely differ — the pin against them collapsing again', async () => {
    const req = { from: [0, 0] as const, to: [1, 1] as const, profile: TRUCK, require: ['height', 'weight'] as RestrictionKind[] };
    const strict = await reg().route(req, { strict: true });
    const loose = await reg().route(req, { strict: false });
    expect(strict.status).not.toBe(loose.status);
  });

  it('a fully assured request is plain ok under either mode', async () => {
    const req = { from: [0, 0] as const, to: [1, 1] as const, profile: TRUCK, require: ['height'] as RestrictionKind[] };
    expect((await reg().route(req, { strict: true })).status).toBe('ok');
    expect((await reg().route(req, { strict: false })).status).toBe('ok');
  });

  it('no registered backend at all still refuses, under both modes', async () => {
    const empty = new SpatialRegistry();
    const req = { from: [0, 0] as const, to: [1, 1] as const, profile: TRUCK, require: [] as RestrictionKind[] };
    expect((await empty.route(req, { strict: false })).status).toBe('refused');
    expect((await empty.route(req, { strict: true })).status).toBe('refused');
  });

  it('strict refuses WITHOUT calling the backend', async () => {
    // Otherwise the refusal depends on whether the backend happened to be up,
    // and a request is spent to discard its answer.
    let called = 0;
    const counting = engine(PARTIAL);
    const wrapped: SpatialEngine = {
      ...counting,
      route: async (r) => { called++; return counting.route(r); },
    };
    const out = await new SpatialRegistry().register(wrapped).route(
      { from: [0, 0], to: [1, 1], profile: TRUCK, require: ['height', 'weight'] },
      { strict: true },
    );
    expect(out.status).toBe('refused');
    expect(called).toBe(0);
  });
});

describe('the inventory can actually report an unhonoured restriction', () => {
  it('arbitrating over the honoured set alone makes the column vacuous', () => {
    const partial = caps({
      operations: new Set<SpatialOperation>(['route']),
      restrictionsHonoured: new Map([['route' as SpatialOperation, new Set<RestrictionKind>(['height'])]]),
      verification: [v('height', 'route', 'assured', DISCRIMINATING)],
    });
    const rows = new SpatialRegistry().register(engine(partial)).inventory();
    expect(rows).toHaveLength(1);
    expect(rows[0].assured).toEqual(['height']);
    // The original arbitrated over [...restrictionsHonoured], which makes
    // `unhonoured` empty by construction: a column of zeroes reading as a
    // clean bill. Over the full vocabulary the eight it does NOT honour show.
    expect(rows[0].unhonoured.length).toBeGreaterThan(0);
    expect(rows[0].unhonoured).toContain('hazmat');
  });

  it('one row per (backend, operation), not one per backend', () => {
    const two = caps({
      operations: new Set<SpatialOperation>(['route', 'matrix']),
      restrictionsHonoured: new Map(),
      verification: [],
    });
    const rows = new SpatialRegistry().register(engine(two)).inventory();
    expect(rows.map(r => r.operation).sort()).toEqual(['matrix', 'route']);
  });
});

describe('a claim holds no clock, and never overstates its legality', () => {
  const prov = (over: Partial<SpatialProvenance>): SpatialProvenance => ({
    backendId: 'B', backendVersion: '1', operation: 'route',
    restrictionsRequested: [], restrictionsHonoured: [], legalityAssured: false,
    networkVintage: null, computedAt: AT, computeMs: 5, ...over,
  });

  it('two claims over identical inputs are identical — no self-stamping', () => {
    // The original defaulted computedAt to new Date().toISOString(), so two
    // runs over the same inputs produced two different claims and a replay
    // could never be compared byte-for-byte.
    const r: Route = { distanceM: 1000, durationS: 60, geometry: [], legs: [] };
    const a = spatialClaim(r, prov({}), renderRoute);
    const b = spatialClaim(r, prov({}), renderRoute);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.provenance.computedAt).toBe(AT);
  });

  it('NO RESTRICTIONS REQUESTED MAKES NO LEGALITY CLAIM', () => {
    // The original rendered "truck-legal for " — a clearance nobody asked for
    // and nothing checked, produced by a join on an empty array.
    const s = renderRoute({ distanceM: 1000, durationS: 3660 },
      prov({ legalityAssured: true, restrictionsRequested: [], restrictionsHonoured: [] }));
    expect(s).toContain('no legality claim is made');
    expect(s).not.toMatch(/legal for\s*;/);
  });

  it('an unassured route says so, and names what was requested', () => {
    const s = renderRoute({ distanceM: 18202, durationS: 1851 },
      prov({ legalityAssured: false, restrictionsRequested: ['height'], restrictionsHonoured: [] }));
    expect(s).toContain('NOT legality-assured');
    expect(s).toContain('honoured none');
  });

  it('the rendering names the operation, since capability is per operation', () => {
    const s = renderRoute({ distanceM: 1000, durationS: 60 }, prov({ operation: 'matrix' }));
    expect(s).toContain('for matrix');
  });

  it('every rendering says it is modeled, not observed', () => {
    expect(renderRoute({ distanceM: 1, durationS: 1 }, prov({}))).toContain('not an observation');
  });
});
