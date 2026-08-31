import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NO_SPATIAL_BACKEND, NO_ROUTING_OPTIMIZER, registerBackend, backendModel,
  backendAttestation, checkSupported, vrpConserves,
} from './registry';
import { SPATIAL_BACKEND_UNAVAILABLE, SPATIAL_OPERATION_UNSUPPORTED } from './types';
import type { RoutingOptimizer, VehicleProfile } from './types';
import { clearRegistry } from '../economy/models';
import { isAdmissible } from '../economy/attestation';

const TRUCK: VehicleProfile = { kind: 'truck', heightM: 4.11, weightKg: 36000 };

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
    const src = readFileSync(join(SPATIAL_DIR, 'types.ts'), 'utf8');
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
      waypoints: [{ lat: 43.65, lon: -79.38 }, { lat: 42.33, lon: -83.05 }],
      profile: TRUCK,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.refusal.code).toBe(SPATIAL_BACKEND_UNAVAILABLE);
      // The distinction that matters: nothing was found impossible.
      expect(out.refusal.detail).toContain('not about the road network');
      expect(out.refusal.remedy).toContain('straight-line distance is not a road');
    }
  });

  it('every operation refuses, not just the one anyone remembered', async () => {
    const outs = await Promise.all([
      NO_SPATIAL_BACKEND.matrix({ origins: [], destinations: [], profile: TRUCK }),
      NO_SPATIAL_BACKEND.isochrone({ origin: { lat: 0, lon: 0 }, profile: TRUCK, rangeS: [600] }),
      NO_SPATIAL_BACKEND.nearest({ origin: { lat: 0, lon: 0 }, candidates: [], profile: TRUCK }),
      NO_SPATIAL_BACKEND.serviceArea({ origin: { lat: 0, lon: 0 }, profile: TRUCK, maxDurationS: 600 }),
      NO_SPATIAL_BACKEND.mapMatch({ trace: [], profile: TRUCK }),
      NO_SPATIAL_BACKEND.networkAnalysis({ facilityIds: [], profile: TRUCK, question: 'connectivity' }),
      NO_ROUTING_OPTIMIZER.vrp({ vehicles: [], objective: 'min_cost' }),
    ]);
    for (const out of outs) expect(out.ok).toBe(false);
  });
});

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
    // Reproducibility travels as a known limitation, so it reaches a reader
    // of the registry rather than living only in code.
    expect(model!.knownLimitations.join(' ')).toContain('deterministic');
  });

  it('a time-boxed backend says so in the registry', () => {
    const reg = {
      backendId: 'solver-b', modelId: 'M-VRP', version: '2.1.0',
      reproducibility: 'time_boxed' as const,
      evidenceBoundary: 'heuristic search, quality scales with budget',
      knownLimitations: ['re-running may return a different plan'],
      uncertainty: { kind: 'none' as const },
      knownAt: '2026-06-01',
    };
    registerBackend(reg);
    expect(backendModel(reg)!.knownLimitations.join(' ')).toContain('time_boxed');
  });

  it('a routed answer is MODELLED, not observed', () => {
    const att = backendAttestation();
    expect(att.evidenceClass).toBe('estimated');
    // Modelled but not fabricated: still admissible, and its bias is not an
    // interest problem — nobody is negotiating with the road network.
    expect(isAdmissible(att)).toBe(true);
    expect(att.interest).toBe('disinterested');
  });
});

describe('an unsupported constraint is refused, never silently dropped', () => {
  const limited: RoutingOptimizer = {
    backendId: 'limited',
    supports: { capacity: false, timeWindows: false, pickupDelivery: false, multiVehicle: true, skills: false },
    vrp: async () => ({ ok: false, refusal: { code: 'x', detail: '', remedy: '' } }),
  };

  it('refuses time windows a backend cannot honour', () => {
    const r = checkSupported(limited, {
      vehicles: [{}],
      jobs: [{ windows: [{ from: 'a', to: 'b' }] }],
    });
    expect(r).not.toBeNull();
    expect(r!.code).toBe(SPATIAL_OPERATION_UNSUPPORTED);
    expect(r!.detail).toContain('timeWindows');
    // The reason this matters, in the remedy the operator reads.
    expect(r!.remedy).toContain('looks exactly like a valid plan');
  });

  it('names every unsupported constraint, not just the first', () => {
    const r = checkSupported(limited, {
      vehicles: [{}],
      jobs: [{ windows: [{ from: 'a', to: 'b' }], demand: { pallets: 4 }, requiredSkills: ['reefer'] }],
      shipments: [{}],
    });
    expect(r).not.toBeNull();
    for (const need of ['timeWindows', 'capacity', 'skills', 'pickupDelivery']) {
      expect(r!.detail).toContain(need);
    }
  });

  it('passes a request the backend can honour', () => {
    expect(checkSupported(limited, { vehicles: [{}, {}], jobs: [{}] })).toBeNull();
  });
});

describe('a dispatch plan accounts for every job', () => {
  it('detects a job the solver silently omitted', () => {
    // The defect: a plan that looks complete because what did not fit was
    // dropped rather than reported.
    const req = { jobs: [{ jobId: 'J-1' }, { jobId: 'J-2' }, { jobId: 'J-3' }] };
    const value = {
      assignments: [{ steps: [{ kind: 'job', refId: 'J-1' }, { kind: 'job', refId: 'J-2' }] }],
      unassigned: [],
    };
    const check = vrpConserves(req, value);
    expect(check.conserves).toBe(false);
    expect(check.missing).toEqual(['J-3']);
  });

  it('conserves when the unfitted job is reported', () => {
    const req = { jobs: [{ jobId: 'J-1' }, { jobId: 'J-2' }] };
    const value = {
      assignments: [{ steps: [{ kind: 'job', refId: 'J-1' }] }],
      unassigned: [{ refId: 'J-2' }],
    };
    expect(vrpConserves(req, value).conserves).toBe(true);
  });

  it('counts shipments too', () => {
    const req = { shipments: [{ shipmentId: 'S-1' }] };
    expect(vrpConserves(req, { assignments: [], unassigned: [] }).missing).toEqual(['S-1']);
  });
});
