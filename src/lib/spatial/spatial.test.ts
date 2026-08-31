import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_SPATIAL_BACKEND, NO_ROUTING_OPTIMIZER, registerBackend, backendModel,
  backendAttestation, checkOptimizerSupported, spatialAvailability,
  anySpatialOperationAvailable,
} from './registry';
import {
  vrpConserves, isDiscriminating, legalityAssured, unhonouredFor,
  assertIntegerDimensions, RESTRICTION_CAPS, RESTRICTION_KINDS, SPATIAL_OPERATIONS,
  isProbeable, DISCRIMINATION_FLOOR_PCT,
  type RoutingOptimizer, type VehicleProfile, type RestrictionVerification,
  type VrpRequest, type VrpSolution, type SpatialClaim, type Matrix, type Job,
} from './engine.types';
import { clearRegistry } from '../economy/models';
import { isAdmissible } from '../economy/attestation';

const TRUCK: VehicleProfile = {
  profileId: 'truck_53ft_dryvan@1.0.0', mode: 'truck',
  heightMm: 4110, grossWeightKg: 36000,
};

const SPATIAL_DIR = join(process.cwd(), 'src/lib/spatial');

/**
 * THE BOUNDARY IS ONLY REAL IF NO VENDOR CONCEPT CROSSES IT.
 *
 * Nobody accidentally builds a routing engine. What happens is leakage —
 * callers come to depend on a backend's field names and error codes, the
 * interface becomes nominal, and a swap breaks everything. So the absence of
 * vendor vocabulary in the semantic surface is asserted over the source,
 * the same way the route gate's wiring is.
 */
describe('no vendor concept leaks into the semantic surface', () => {
  const VENDORS = [
    'ors', 'openrouteservice', 'vroom', 'pgrouting', 'postgis', 'cuopt',
    'graphhopper', 'osrm', 'valhalla', 'mapbox', 'google',
  ];

  it('the semantic types name no vendor', () => {
    // Named explicitly because it is the file callers depend on. The check
    // below covers the directory; this one makes the important file's failure
    // read as itself rather than as one entry in a list.
    expect(readdirSync(SPATIAL_DIR), 'the semantic surface was renamed — update this guard')
      .toContain('engine.types.ts');
    const src = readFileSync(join(SPATIAL_DIR, 'engine.types.ts'), 'utf8');
    // Comments may DISCUSS vendors — that is how the design is explained.
    // Code must not. Strip block and line comments, then look.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const found = VENDORS.filter(v => new RegExp(`\\b${v}\\b`, 'i').test(code));
    expect(found, [
      'A vendor name in the semantic surface means callers can depend on it, which makes the',
      'abstraction nominal and the backend unswappable.',
    ].join(' ')).toEqual([]);
  });

  it('every file in the spatial layer keeps vendors out of its code', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(SPATIAL_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(SPATIAL_DIR, file), 'utf8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      for (const v of VENDORS) {
        if (new RegExp(`\\b${v}\\b`, 'i').test(code)) offenders.push(`${file}: ${v}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('with no backend configured, the layer refuses', () => {
  it('route refuses rather than estimating a straight line', async () => {
    const out = await NO_SPATIAL_BACKEND.route({
      from: [-79.38, 43.65], to: [-83.05, 42.33], profile: TRUCK, require: ['height'],
    });
    expect(out.status).toBe('refused');
    if (out.status === 'refused') {
      expect(out.reason).toBe('operation_unsupported');
      // The distinction that matters: nothing was found impossible.
      expect(out.remedy).toContain('not about the road network');
      expect(out.remedy).toContain('a straight line is not a road');
      // The refusal names what was asked for, so the remedy is actionable.
      expect(out.requestedRestrictions).toContain('height');
      expect(out.unhonoured).toContain('height');
    }
  });

  it('every operation refuses, not just the one anyone remembered', async () => {
    const outs = await Promise.all([
      NO_SPATIAL_BACKEND.matrix({ origins: [], destinations: [], profile: TRUCK, require: [], metrics: ['duration'] }),
      NO_SPATIAL_BACKEND.isochrone({ center: [0, 0], profile: TRUCK, require: [], rangesS: [600] }),
      NO_SPATIAL_BACKEND.nearest({ point: [0, 0], candidates: [], profile: TRUCK, require: [], limit: 5 }),
      NO_SPATIAL_BACKEND.serviceArea({ center: [0, 0], profile: TRUCK, require: [], rangesS: [600] }),
      NO_SPATIAL_BACKEND.mapMatch({ trace: [], profile: TRUCK }),
      NO_SPATIAL_BACKEND.networkAnalysis({ origin: [0, 0], targets: [], profile: TRUCK, require: [], question: 'reachability' }),
      NO_ROUTING_OPTIMIZER.vrp({ vehicles: [], matrix: EMPTY_MATRIX_CLAIM, objective: 'min_duration', timeLimitMs: 1000 }),
    ]);
    for (const out of outs) expect(out.status).toBe('refused');
  });

  it('the UI is offered nothing, and told why', () => {
    const avail = spatialAvailability(NO_SPATIAL_BACKEND);
    expect(avail).toHaveLength(SPATIAL_OPERATIONS.length);
    expect(avail.every(a => !a.available)).toBe(true);
    expect(anySpatialOperationAvailable(NO_SPATIAL_BACKEND)).toBe(false);
    for (const a of avail) expect(a.reason).toContain('No spatial backend is configured');
  });
});

const EMPTY_MATRIX_CLAIM: SpatialClaim<Matrix> = {
  value: { durationsS: [], distancesM: [], unreachablePairs: [] },
  provenance: {
    backendId: 'none', backendVersion: '0', operation: 'matrix', mode: 'truck',
    restrictionsRequested: [], restrictionsHonoured: [], legalityAssured: false,
    networkVintage: null, computedAt: '2026-08-31T00:00:00.000Z', computeMs: 0,
  },
  sourceClass: 'modeled',
  renderedClaim: 'empty matrix, no backend',
};

describe('a backend registers as a model, or its answers have no id', () => {
  beforeEach(() => clearRegistry());

  it('registration makes the backend resolvable', () => {
    const reg = {
      backendId: 'engine-a', modelId: 'M-ROUTE', version: '1.0.0',
      reproducibility: 'deterministic' as const,
      evidenceBoundary: 'North American road network, 2026-06 vintage',
      knownLimitations: ['no seasonal weight restrictions'],
      uncertainty: { kind: 'none' as const },
      knownAt: '2026-06-01',
    };
    registerBackend(reg);
    const model = backendModel(reg);
    expect(model).toBeDefined();
    expect(model!.kind).toBe('solver');
    expect(model!.knownLimitations.join(' ')).toContain('deterministic');
  });

  it('a non-reproducible backend says so in the registry', () => {
    const reg = {
      backendId: 'solver-b', modelId: 'M-VRP', version: '2.1.0',
      reproducibility: 'not_reproducible' as const,
      evidenceBoundary: 'heuristic search, quality scales with budget',
      knownLimitations: ['re-running may return a different plan'],
      uncertainty: { kind: 'none' as const },
      knownAt: '2026-06-01',
    };
    registerBackend(reg);
    expect(backendModel(reg)!.knownLimitations.join(' ')).toContain('not_reproducible');
  });

  it('a routed answer is MODELLED, not observed', () => {
    const att = backendAttestation();
    expect(att.evidenceClass).toBe('estimated');
    expect(isAdmissible(att)).toBe(true);
    expect(att.interest).toBe('disinterested');
  });
});

/**
 * THE PROBE IS THE WHOLE CAPABILITY MECHANISM, AND ITS TEST IS DURATION.
 *
 * The measured reference, reproduced as fixtures:
 *   3.00 m  18.261 km  1102 s
 *   4.11 m  18.261 km  1102 s   <- byte-identical to 3.00 m: NOT honoured
 *   4.60 m  18.202 km  1851 s   <- distance -0.3%, duration +68%: honoured
 */
const AT = '2026-08-31T00:00:00.000Z';
const verif = (
  status: RestrictionVerification['status'],
  operation: RestrictionVerification['operation'],
  below: { distanceM: number; durationS: number } | null,
  above?: { distanceM: number; durationS: number },
): RestrictionVerification => ({
  restriction: 'height', operation, status,
  probe: below && above
    ? {
        description: 'height sweep across a bridge threshold',
        belowThreshold: below, aboveThreshold: above,
        durationDeltaPct: below.durationS === 0 ? 0
          : (Math.abs(above.durationS - below.durationS) / below.durationS) * 100,
        verifiedAt: AT,
      }
    : null,
  note: '',
});

describe('a probe discriminates on DURATION, never on distance alone', () => {
  it('identical sides do not discriminate', () => {
    expect(isDiscriminating(verif('refuted', 'route',
      { distanceM: 18261, durationS: 1102 }, { distanceM: 18261, durationS: 1102 }))).toBe(false);
  });

  it('a +68% duration change discriminates', () => {
    expect(isDiscriminating(verif('assured', 'route',
      { distanceM: 18261, durationS: 1102 }, { distanceM: 18202, durationS: 1851 }))).toBe(true);
  });

  it('DISTANCE ALONE DOES NOT — this is the corrected case', () => {
    // The original `isDiscriminating` returned true when EITHER axis moved, so
    // this exact shape — distance -0.3%, duration flat, which is what the real
    // honoured restriction did to DISTANCE — would have been read as a
    // discriminating probe and promoted the capability to assured.
    const distanceOnly = verif('refuted', 'route',
      { distanceM: 18261, durationS: 1102 }, { distanceM: 18202, durationS: 1102 });
    expect(isDiscriminating(distanceOnly)).toBe(false);
  });

  it('a duration wobble below the floor does not discriminate', () => {
    const tiny = verif('refuted', 'route',
      { distanceM: 18261, durationS: 1102 }, { distanceM: 18261, durationS: 1107 });
    expect((5 / 1102) * 100).toBeLessThan(DISCRIMINATION_FLOOR_PCT);
    expect(isDiscriminating(tiny)).toBe(false);
  });

  it('a probe that never ran does not discriminate', () => {
    expect(isDiscriminating(verif('unverified', 'route', null))).toBe(false);
  });
});

describe('a capability is per operation, because a backend is not uniform', () => {
  // Reconnaissance: a backend that honours truck restrictions on directions and
  // isochrones and DISCARDS them on matrix — 200, well-formed, no warning.
  const both = [
    verif('assured', 'route', { distanceM: 18261, durationS: 1102 }, { distanceM: 18202, durationS: 1851 }),
    verif('refuted', 'matrix', { distanceM: 18261, durationS: 1102 }, { distanceM: 18261, durationS: 1102 }),
  ];

  it('assurance on route does NOT carry to matrix', () => {
    expect(legalityAssured(both, 'route', ['height'])).toBe(true);
    expect(legalityAssured(both, 'matrix', ['height'])).toBe(false);
  });

  it('an operation with no verdict at all is NOT assured', () => {
    expect(legalityAssured(both, 'isochrone', ['height'])).toBe(false);
  });

  it('requiring nothing is trivially assured, and requiring something is not', () => {
    expect(legalityAssured([], 'route', [])).toBe(true);
    expect(legalityAssured([], 'route', ['height'])).toBe(false);
  });

  it('the shortfall names the operation that is short', () => {
    expect(unhonouredFor(both, 'route', ['height'])).toEqual([]);
    expect(unhonouredFor(both, 'matrix', ['height'])).toEqual(['height']);
  });

  it('unhonoured and refuted are different states, and both are kept', () => {
    // `unhonoured` = not accepted at all (honest). `refuted` = accepted and
    // ignored (dangerous). A three-state model files both under refuted.
    const notAccepted = verif('unhonoured', 'matrix', null);
    const acceptedAndIgnored = verif('refuted', 'matrix',
      { distanceM: 1, durationS: 1 }, { distanceM: 1, durationS: 1 });
    expect(notAccepted.status).not.toBe(acceptedAndIgnored.status);
    expect(legalityAssured([notAccepted], 'matrix', ['height'])).toBe(false);
    expect(legalityAssured([acceptedAndIgnored], 'matrix', ['height'])).toBe(false);
  });
});

describe('the restriction table is complete, and dimensions are integers', () => {
  it('every restriction kind has a cap entry — no dangling reference', () => {
    // RESTRICTION_CAPS was referenced by a comment on VehicleProfile and did
    // not exist. A shipped interface pointing at a mechanism that is not there
    // is a claim about a guarantee nobody implemented.
    for (const r of RESTRICTION_KINDS) {
      expect(RESTRICTION_CAPS[r], `${r} has no cap entry`).toBeDefined();
    }
    expect(Object.keys(RESTRICTION_CAPS).sort()).toEqual([...RESTRICTION_KINDS].sort());
  });

  it('only scalar-threshold restrictions are probeable', () => {
    expect(isProbeable('height')).toBe(true);
    expect(isProbeable('weight')).toBe(true);
    // A class and a preference have no threshold to straddle, so demanding a
    // discriminating probe of them would be an unmeetable requirement.
    expect(isProbeable('hazmat')).toBe(false);
    expect(isProbeable('toll_avoidance')).toBe(false);
  });

  it('a fractional dimension is refused at the boundary', () => {
    expect(() => assertIntegerDimensions(TRUCK)).not.toThrow();
    expect(() => assertIntegerDimensions({ ...TRUCK, heightMm: 4114.9 }))
      .toThrow(/NON_INTEGER_DIMENSION/);
    expect(() => assertIntegerDimensions({ ...TRUCK, grossWeightKg: -1 }))
      .toThrow(/NON_INTEGER_DIMENSION/);
    // Absent is not invalid: an unstated dimension is unstated, not zero.
    expect(() => assertIntegerDimensions({ profileId: 'p', mode: 'truck' })).not.toThrow();
  });
});

describe('an unsupported constraint is refused, never silently dropped', () => {
  const limited: RoutingOptimizer = {
    backendId: 'limited',
    operations: new Set(['vrp', 'multi_vehicle'] as const),
    vrp: async () => ({ status: 'refused', reason: 'operation_unsupported', remedy: '', requestedRestrictions: [], unhonoured: [] }),
    pickupDelivery: async () => ({ status: 'refused', reason: 'operation_unsupported', remedy: '', requestedRestrictions: [], unhonoured: [] }),
    capacity: async () => ({ status: 'refused', reason: 'operation_unsupported', remedy: '', requestedRestrictions: [], unhonoured: [] }),
    timeWindows: async () => ({ status: 'refused', reason: 'operation_unsupported', remedy: '', requestedRestrictions: [], unhonoured: [] }),
    multiVehicle: async () => ({ status: 'refused', reason: 'operation_unsupported', remedy: '', requestedRestrictions: [], unhonoured: [] }),
  };
  const job = (id: string, over: Partial<Job> = {}) => ({
    jobId: id, at: [0, 0] as const, serviceS: 0, amount: [0], ...over,
  });
  const veh = (id: string) => ({ vehicleId: id, capacity: [10], profile: TRUCK });

  it('refuses time windows a backend cannot honour', () => {
    const r = checkOptimizerSupported(limited, {
      vehicles: [veh('V1')],
      jobs: [job('J1', { timeWindows: [{ fromS: 0, toS: 100 }] })],
    });
    expect(r).not.toBeNull();
    expect(r!).toContain('time_windows');
    expect(r!).toContain('shaped exactly like a');
  });

  it('names every unsupported constraint, not just the first', () => {
    const r = checkOptimizerSupported(limited, {
      vehicles: [veh('V1')],
      jobs: [job('J1', { timeWindows: [{ fromS: 0, toS: 1 }], amount: [4] })],
      shipments: [{ shipmentId: 'S1', pickup: job('P1'), delivery: job('D1'), amount: [1] }],
    });
    expect(r).not.toBeNull();
    for (const need of ['time_windows', 'capacity', 'pickup_delivery']) expect(r!).toContain(need);
  });

  it('passes a request the backend can honour', () => {
    expect(checkOptimizerSupported(limited, {
      vehicles: [veh('V1'), veh('V2')], jobs: [job('J1')],
    })).toBeNull();
  });
});

describe('a dispatch plan accounts for every job', () => {
  const base = { vehicles: [], matrix: EMPTY_MATRIX_CLAIM, objective: 'min_duration' as const, timeLimitMs: 1 };
  const job = (id: string) => ({ jobId: id, at: [0, 0] as const, serviceS: 0, amount: [0] });
  const sol = (steps: string[], unassigned: string[] = []): VrpSolution => ({
    routes: [{
      vehicleId: 'V1', durationS: 0, distanceM: 0, load: [0],
      steps: steps.map(id => ({ kind: 'job' as const, id, arrivalS: 0 })),
    }],
    unassigned: unassigned.map(jobId => ({ jobId, reason: 'no capacity' })),
    objectiveValue: 0, optimality: 'proven_optimal', solverMs: 0,
  });

  it('detects a job the solver silently omitted', () => {
    // The defect: a plan that looks complete — and reports proven_optimal —
    // because what did not fit was dropped rather than reported.
    const req = { ...base, jobs: [job('J-1'), job('J-2'), job('J-3')] };
    expect(vrpConserves(req, sol(['J-1', 'J-2']))).toBe(false);
  });

  it('conserves when the unfitted job is reported', () => {
    const req = { ...base, jobs: [job('J-1'), job('J-2')] };
    expect(vrpConserves(req, sol(['J-1'], ['J-2']))).toBe(true);
  });

  it('counts both legs of a shipment', () => {
    const req = {
      ...base,
      shipments: [{ shipmentId: 'S-1', pickup: job('P-1'), delivery: job('D-1'), amount: [1] }],
    };
    expect(vrpConserves(req, sol(['P-1']))).toBe(false);
    expect(vrpConserves(req, sol(['P-1', 'D-1']))).toBe(true);
  });

  it('proven_optimal over a dropped job is still not conserving', () => {
    const req = { ...base, jobs: [job('J-1'), job('J-2')] };
    const s = sol(['J-1']);
    expect(s.optimality).toBe('proven_optimal');
    expect(vrpConserves(req, s)).toBe(false);
  });
});


/**
 * ONE DEFINITION PER NAME.
 *
 * This guard exists because the directory briefly held two surfaces: a
 * `types.ts` and an `engine.types.ts` that both exported `SpatialEngine`,
 * `SpatialResult`, `VehicleProfile`, `RouteRequest`, `MatrixRequest`,
 * `RoutingOptimizer` and four more — TEN colliding names, with DIFFERENT
 * SHAPES behind them. `SpatialResult<T>` was the success payload in one and
 * the three-state outcome in the other.
 *
 * TypeScript is perfectly happy with that: two modules, two types, no error.
 * A caller importing from the wrong one gets a different contract and finds
 * out at runtime, and the abstraction quietly becomes two abstractions. It is
 * the same drift the ledger warns about for a substrate implemented twice in
 * two languages, at the scale of one directory.
 */
describe('the spatial surface is defined once', () => {
  it('no exported name is declared in two files', () => {
    const byName = new Map<string, string[]>();
    for (const file of readdirSync(SPATIAL_DIR)) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const src = readFileSync(join(SPATIAL_DIR, file), 'utf8');
      // Declarations only — `export type { X } from` re-exports are not
      // definitions and must not count as collisions.
      for (const m of src.matchAll(
        /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|class|function|const|enum)\s+([A-Za-z_$][\w$]*)/gm,
      )) {
        byName.set(m[1], [...(byName.get(m[1]) ?? []), file]);
      }
    }
    const dupes = [...byName.entries()]
      .filter(([, files]) => new Set(files).size > 1)
      .map(([name, files]) => `${name}: ${[...new Set(files)].join(' + ')}`);
    expect(dupes, [
      'The same exported name is declared in more than one file in the spatial layer.',
      'TypeScript accepts this silently and callers get whichever contract they happened',
      'to import. One surface, one definition.',
    ].join(' ')).toEqual([]);
  });

  it('and the pin: the scanner does detect a duplicate when there is one', () => {
    // Without this, a broken regex would report "no duplicates" forever.
    const a = 'export interface Widget { x: number }\n';
    const b = 'export interface Widget { y: string }\n';
    const names = (src: string) =>
      [...src.matchAll(/^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
    expect(names(a)).toEqual(['Widget']);
    expect(names(b)).toEqual(['Widget']);
  });
});
