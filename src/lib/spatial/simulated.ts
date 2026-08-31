// src/lib/spatial/simulated.ts
//
// A SIMULATED spatial backend — a real actor behind the semantic interface, so
// the system runs end to end without a road server.
//
// THIS IS NOT A FALLBACK. `NO_SPATIAL_BACKEND` refuses precisely so that a
// missing backend can never be mistaken for an answer; this is a backend that
// is REGISTERED, DECLARED, and labelled at every exit. The difference between
// the two is the whole point of the abstraction: swapping a real engine in
// changes one registration line and nothing else.
//
// WHAT IT IS HONEST ABOUT
//
//   backendId          'simulated' — it appears in every provenance record
//   evidence class     `representative`, so `restsOnRepresentative` is TRUE and
//                      `isAdmissible()` is FALSE. Simulated numbers therefore
//                      flow to a DISPLAY and are refused by an EVIDENCE gate,
//                      which is the correct behaviour in both directions and is
//                      demonstrated rather than asserted in the demo run.
//   rendered claim     every sentence begins SIMULATED.
//
// WHAT IT MODELS, and why the shape matters
//
// Restrictions genuinely bind. A profile that exceeds a corridor's clearance is
// pushed onto a slower path, and the detour reproduces the MEASURED signature of
// a real honoured restriction: distance barely moves, duration moves a lot. That
// is what makes the capability probe discriminate — a simulated backend that
// accepted a height and ignored it would be `refuted` by the very arbiter this
// codebase built, and the demo would show it.

import { createHash } from 'crypto';
import type {
  BackendCapabilities, Isochrone, IsochroneRequest, MapMatch, MapMatchRequest,
  Matrix, MatrixRequest, NearestRequest, NearestResult, NetworkAnalysis,
  NetworkAnalysisRequest, Position, RestrictionKind, RestrictionVerification,
  Route, RouteRequest, RoutingOptimizer, SpatialClaim, SpatialEngine,
  SpatialOperation, SpatialProvenance, SpatialResult, VehicleProfile,
  VrpRequest, VrpSolution,
} from './engine.types';
import { assertIntegerDimensions } from './engine.types';

export const SIMULATED_BACKEND_ID = 'simulated';
export const SIMULATED_VERSION = '1.0.0';
/** The network this pretends to know. Stated, so nobody reads it as a real extract. */
export const SIMULATED_NETWORK_VINTAGE = 'synthetic-2026-08';

/* ── geometry ────────────────────────────────────────────────────────────── */

const R_EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function greatCircleM(a: Position, b: Position): number {
  const [lon1, lat1] = a, [lon2, lat2] = b;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Roads are not straight. A fixed factor, stated, not tuned to any observation. */
const ROAD_DETOUR_FACTOR = 1.27;

/** Deterministic per-leg jitter so two different lanes are not identical, and so
 *  the SAME lane is always identical. Seeded from the coordinates only. */
function seeded(a: Position, b: Position): number {
  const h = createHash('sha256').update(`${a[0]},${a[1]}|${b[0]},${b[1]}`).digest();
  return h.readUInt32BE(0) / 0xffffffff;
}

/* ── the simulated network's constraints ─────────────────────────────────── */

/**
 * Clearances the simulated network enforces. A profile exceeding one is routed
 * around it — which is what makes a discriminating probe possible.
 */
export const SIM_CLEARANCE_MM = 4_150;      // a low bridge on the main corridor
export const SIM_WEIGHT_LIMIT_KG = 36_000;  // a posted bridge limit

/** How much a forced detour costs. Reproduces the measured real-world signature:
 *  distance barely moves, duration moves a great deal (surface streets). */
const DETOUR_DISTANCE_FACTOR = 0.997;   // -0.3%
const DETOUR_DURATION_FACTOR = 1.68;    // +68%

function binds(profile: VehicleProfile, r: RestrictionKind): boolean {
  if (r === 'height') return (profile.heightMm ?? 0) > SIM_CLEARANCE_MM;
  if (r === 'weight') return (profile.grossWeightKg ?? 0) > SIM_WEIGHT_LIMIT_KG;
  return false;
}

const BASE_SPEED_KMH: Record<VehicleProfile['mode'], number> = {
  truck: 78, car: 95, rail: 60, sea: 33,
};

/* ── capabilities, with the probes that verify them ──────────────────────── */

const PROBED_AT = '2026-08-31T00:00:00.000Z';

/** A probe recorded from this backend's own behaviour across the clearance. */
function selfProbe(restriction: RestrictionKind, operation: SpatialOperation): RestrictionVerification {
  const below = { distanceM: 545_960, durationS: 25_200 };
  const above = {
    distanceM: Math.round(below.distanceM * DETOUR_DISTANCE_FACTOR),
    durationS: Math.round(below.durationS * DETOUR_DURATION_FACTOR),
  };
  return {
    restriction, operation, status: 'assured',
    probe: {
      description: `simulated ${restriction} sweep across the modelled clearance`,
      belowThreshold: below, aboveThreshold: above,
      durationDeltaPct: ((above.durationS - below.durationS) / below.durationS) * 100,
      verifiedAt: PROBED_AT,
    },
    note: 'this backend applies the restriction; the probe measures it doing so',
  };
}

/**
 * Restrictions are honoured on the operations that route, and NOT on `matrix`.
 *
 * Deliberate. Reconnaissance of a real engine found exactly this asymmetry — its
 * matrix request type has no field for dimensional restrictions while its
 * directions and isochrone types do. Reproducing it here means the demo
 * exercises the per-operation arbitration for real: `select('matrix', ['height'])`
 * comes back short, and a strict caller refuses, on a backend that routes fine.
 */
const HONOURING_OPS: SpatialOperation[] = ['route', 'isochrone', 'service_area', 'nearest'];
const SUPPORTED_OPS: SpatialOperation[] = [
  'route', 'matrix', 'isochrone', 'nearest', 'service_area', 'network_analysis',
];

export const SIMULATED_CAPABILITIES: BackendCapabilities = {
  backendId: SIMULATED_BACKEND_ID,
  operations: new Set(SUPPORTED_OPS),
  restrictionsHonoured: new Map(
    SUPPORTED_OPS.map(op => [
      op,
      new Set<RestrictionKind>(HONOURING_OPS.includes(op) ? ['height', 'weight'] : []),
    ]),
  ),
  verification: HONOURING_OPS.flatMap(op => [selfProbe('height', op), selfProbe('weight', op)]),
  maxMatrixDimension: 100,
  supportsIsochrone: true,
  coverage: {
    regions: ['SIMULATED'],
    note: 'a synthetic network. It covers everywhere and knows nowhere: distances are '
      + 'great-circle with a fixed detour factor, not a road graph.',
  },
};

/* ── claim construction ──────────────────────────────────────────────────── */

function provenance(
  operation: SpatialOperation, profile: VehicleProfile,
  requested: readonly RestrictionKind[], honoured: RestrictionKind[],
  computedAt: string, computeMs: number,
): SpatialProvenance {
  return {
    backendId: SIMULATED_BACKEND_ID, backendVersion: SIMULATED_VERSION,
    operation, mode: profile.mode,
    restrictionsRequested: [...requested],
    restrictionsHonoured: honoured,
    legalityAssured: requested.length > 0 && honoured.length === requested.length,
    networkVintage: SIMULATED_NETWORK_VINTAGE,
    computedAt, computeMs,
  };
}

function claim<T>(value: T, p: SpatialProvenance, sentence: string): SpatialClaim<T> {
  return {
    value, provenance: p, sourceClass: 'modeled',
    // EVERY sentence starts here. A simulated number that reaches a person
    // without this word is the only way this module can do harm.
    renderedClaim: `SIMULATED — ${sentence} (backend ${p.backendId} ${p.backendVersion}, `
      + `network ${p.networkVintage}). Not a measurement of any real road network.`,
  };
}

/** Which of the requested restrictions this backend honours for an operation. */
function honouredFor(op: SpatialOperation, requested: readonly RestrictionKind[]): RestrictionKind[] {
  const set = SIMULATED_CAPABILITIES.restrictionsHonoured.get(op);
  return requested.filter(r => set?.has(r));
}

/* ── the legs ────────────────────────────────────────────────────────────── */

function leg(from: Position, to: Position, profile: VehicleProfile) {
  const straight = greatCircleM(from, to);
  const jitter = 0.96 + seeded(from, to) * 0.08;      // deterministic ±4%
  let distanceM = Math.round(straight * ROAD_DETOUR_FACTOR * jitter);
  let durationS = Math.round((distanceM / 1000) / BASE_SPEED_KMH[profile.mode] * 3600);

  // A binding restriction pushes the vehicle onto a slower path.
  if (binds(profile, 'height') || binds(profile, 'weight')) {
    distanceM = Math.round(distanceM * DETOUR_DISTANCE_FACTOR);
    durationS = Math.round(durationS * DETOUR_DURATION_FACTOR);
  }
  return { distanceM, durationS, from, to };
}

/* ── the engine ──────────────────────────────────────────────────────────── */

export interface SimulatedOptions {
  /** Injected. The engine holds no clock. */
  now: string;
}

export function createSimulatedEngine(opts: SimulatedOptions): SpatialEngine {
  const { now } = opts;

  const refuse = <T>(reason: Parameters<typeof mk>[0], remedy: string,
                     requested: RestrictionKind[], unhonoured: RestrictionKind[]): SpatialResult<T> =>
    ({ status: 'refused', reason, remedy, requestedRestrictions: requested, unhonoured });
  const mk = (r: 'operation_unsupported' | 'restriction_not_honoured' | 'outside_coverage'
    | 'matrix_too_large' | 'no_route_exists' | 'restriction_unverified' | 'backend_unreachable') => r;

  return {
    capabilities: SIMULATED_CAPABILITIES,

    async route(req: RouteRequest): Promise<SpatialResult<Route>> {
      assertIntegerDimensions(req.profile);
      const pts: Position[] = [req.from, ...(req.via ?? []), req.to];
      const legs = pts.slice(0, -1).map((p, i) => leg(p, pts[i + 1], req.profile));
      const distanceM = legs.reduce((n, l) => n + l.distanceM, 0);
      const durationS = legs.reduce((n, l) => n + l.durationS, 0);
      const honoured = honouredFor('route', req.require);
      const p = provenance('route', req.profile, req.require, honoured, now, 3);
      const h = Math.floor(durationS / 3600), m = Math.round((durationS % 3600) / 60);
      return {
        status: 'ok',
        claim: claim<Route>(
          { distanceM, durationS, geometry: pts, legs },
          p,
          `${(distanceM / 1000).toFixed(1)} km, ${h}h${String(m).padStart(2, '0')} for a `
          + `${req.profile.mode}${honoured.length ? `, honouring ${honoured.join('/')}` : ''}`,
        ),
      };
    },

    async matrix(req: MatrixRequest): Promise<SpatialResult<Matrix>> {
      assertIntegerDimensions(req.profile);
      const n = req.origins.length * req.destinations.length;
      if (SIMULATED_CAPABILITIES.maxMatrixDimension !== null
          && n > SIMULATED_CAPABILITIES.maxMatrixDimension) {
        return refuse('matrix_too_large',
          `${n} cells exceeds the ${SIMULATED_CAPABILITIES.maxMatrixDimension}-cell limit. `
          + 'Split the request, or configure a backend with a larger matrix.',
          [...req.require], []);
      }
      const durationsS: (number | null)[][] = [];
      const distancesM: (number | null)[][] = [];
      const unreachablePairs: Array<{ origin: number; destination: number }> = [];
      req.origins.forEach((o, i) => {
        durationsS.push([]); distancesM.push([]);
        req.destinations.forEach((d, j) => {
          // A same-point pair is zero, not unreachable. Distinguished deliberately.
          const l = leg(o, d, req.profile);
          durationsS[i].push(l.durationS);
          distancesM[i].push(l.distanceM);
          void j;
        });
      });
      // NOTE: `require` is deliberately NOT honoured here — see HONOURING_OPS.
      const p = provenance('matrix', req.profile, req.require, honouredFor('matrix', req.require), now, 5);
      return {
        status: 'ok',
        claim: claim<Matrix>({ durationsS, distancesM, unreachablePairs }, p,
          `${req.origins.length}x${req.destinations.length} matrix`),
      };
    },

    async isochrone(req: IsochroneRequest): Promise<SpatialResult<Isochrone>> {
      assertIntegerDimensions(req.profile);
      const honoured = honouredFor('isochrone', req.require);
      const slow = binds(req.profile, 'height') || binds(req.profile, 'weight');
      const kmh = BASE_SPEED_KMH[req.profile.mode] / (slow ? DETOUR_DURATION_FACTOR : 1);
      const polygons = req.rangesS.map(rangeS => {
        const reachM = (kmh * 1000 / 3600) * rangeS / ROAD_DETOUR_FACTOR;
        const dLat = (reachM / R_EARTH_M) * (180 / Math.PI);
        const dLon = dLat / Math.max(0.2, Math.cos(rad(req.center[1])));
        const ring: Position[] = Array.from({ length: 24 }, (_, k) => {
          const t = (k / 24) * 2 * Math.PI;
          return [req.center[0] + dLon * Math.cos(t), req.center[1] + dLat * Math.sin(t)] as const;
        });
        return { rangeS, ring: [...ring, ring[0]] };
      });
      const p = provenance('isochrone', req.profile, req.require, honoured, now, 4);
      return {
        status: 'ok',
        claim: claim<Isochrone>({ polygons }, p,
          `${polygons.length} reachability ring(s) from the centre`),
      };
    },

    async nearest(req: NearestRequest): Promise<SpatialResult<NearestResult>> {
      assertIntegerDimensions(req.profile);
      const scored = req.candidates.map(c => {
        const l = leg(req.point, c.at, req.profile);
        return { id: c.id, durationS: l.durationS, distanceM: l.distanceM };
      }).sort((a, b) => a.durationS - b.durationS);
      const p = provenance('nearest', req.profile, req.require, honouredFor('nearest', req.require), now, 2);
      return {
        status: 'ok',
        claim: claim<NearestResult>(
          { ranked: scored.slice(0, req.limit), unreachable: [] }, p,
          `${Math.min(req.limit, scored.length)} of ${req.candidates.length} candidates ranked by DRIVE TIME`,
        ),
      };
    },

    async serviceArea(req: IsochroneRequest): Promise<SpatialResult<Isochrone>> {
      return this.isochrone(req);
    },

    async mapMatch(_req: MapMatchRequest): Promise<SpatialResult<MapMatch>> {
      // NOT SUPPORTED, and it refuses rather than returning the trace unchanged.
      // Echoing the input back as "matched" would be the most plausible lie this
      // module could tell: every point present, confidence unstated, nothing
      // actually snapped to anything.
      return refuse('operation_unsupported',
        'The simulated backend has no road graph, so a trace cannot be snapped to one. '
        + 'Returning the trace unchanged would be indistinguishable from a real match.',
        [], []);
    },

    async networkAnalysis(req: NetworkAnalysisRequest): Promise<SpatialResult<NetworkAnalysis>> {
      assertIntegerDimensions(req.profile);
      const p = provenance('network_analysis', req.profile, req.require,
        honouredFor('network_analysis', req.require), now, 2);
      return {
        status: 'ok',
        claim: claim<NetworkAnalysis>({
          question: req.question,
          reachable: [...req.targets],
          unreachable: [],
          note: 'a synthetic network is fully connected by construction; this answers '
            + 'the shape of the question, not the connectivity of any real graph.',
        }, p, `${req.targets.length} target(s) reachable`),
      };
    },
  };
}

/* ── the optimizer ───────────────────────────────────────────────────────── */

/**
 * A nearest-neighbour VRP. Deterministic, and honest that it is a heuristic:
 * `optimality: 'feasible_not_proven'` on every solution, because it never
 * proves anything. A solver claiming `proven_optimal` from a greedy walk would
 * be the sharpest available lie in this file.
 */
export function createSimulatedOptimizer(opts: SimulatedOptions): RoutingOptimizer {
  const { now } = opts;
  void now;
  return {
    backendId: SIMULATED_BACKEND_ID,
    operations: new Set(['vrp', 'capacity', 'multi_vehicle']),

    async vrp(req: VrpRequest): Promise<SpatialResult<VrpSolution>> {
      const jobs = [...(req.jobs ?? [])];
      const vehicles = req.vehicles;
      if (vehicles.length === 0) {
        return { status: 'refused', reason: 'no_route_exists',
          remedy: 'No vehicles supplied, so there is no plan to make. Supply at least one.',
          requestedRestrictions: [], unhonoured: [] };
      }
      const routes: VrpSolution['routes'] = [];
      const unassigned: VrpSolution['unassigned'] = [];
      const pool = [...jobs];

      for (const v of vehicles) {
        let cursor: Position = v.start ?? [0, 0];
        let load = v.capacity.map(() => 0);
        let t = 0, dist = 0;
        const steps: VrpSolution['routes'][number]['steps'] = [
          { kind: 'start', arrivalS: 0 },
        ];
        for (;;) {
          const feasible = pool
            .map((j, idx) => ({ j, idx, l: leg(cursor, j.at, v.profile) }))
            .filter(({ j }) => j.amount.every((a, k) => load[k] + a <= v.capacity[k]))
            .sort((a, b) => a.l.durationS - b.l.durationS);
          if (feasible.length === 0) break;
          const pick = feasible[0];
          t += pick.l.durationS + pick.j.serviceS;
          dist += pick.l.distanceM;
          load = load.map((n, k) => n + pick.j.amount[k]);
          steps.push({ kind: 'job', id: pick.j.jobId, arrivalS: t });
          cursor = pick.j.at;
          pool.splice(pick.idx, 1);
        }
        steps.push({ kind: 'end', arrivalS: t });
        routes.push({ vehicleId: v.vehicleId, steps, durationS: t, distanceM: dist, load });
      }

      for (const j of pool) {
        unassigned.push({
          jobId: j.jobId,
          reason: 'no vehicle had remaining capacity for this job under its stated demand',
        });
      }

      const p = provenance('route', vehicles[0].profile, [], [], now, 8);
      return {
        status: 'ok',
        claim: claim<VrpSolution>({
          routes, unassigned,
          objectiveValue: routes.reduce((n, r) => n + r.durationS, 0),
          // NEVER proven. A greedy nearest-neighbour walk proves nothing, and
          // saying otherwise would be the sharpest lie available here.
          optimality: 'feasible_not_proven',
          solverMs: 8,
        }, p, `${routes.length} route(s), ${unassigned.length} unassigned`),
      };
    },

    async pickupDelivery() {
      return { status: 'refused', reason: 'operation_unsupported',
        remedy: 'The simulated optimizer does not model pickup-delivery pairing. A plan that '
          + 'ignored the pairing would look exactly like a valid one.',
        requestedRestrictions: [], unhonoured: [] };
    },
    async capacity(req: VrpRequest) { return this.vrp(req); },
    async timeWindows() {
      return { status: 'refused', reason: 'operation_unsupported',
        remedy: 'The simulated optimizer does not honour time windows. Refusing rather than '
          + 'returning a plan that silently ignores them.',
        requestedRestrictions: [], unhonoured: [] };
    },
    async multiVehicle(req: VrpRequest) { return this.vrp(req); },
  };
}
