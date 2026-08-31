// src/lib/spatial/engine.types.ts
//
// PAYLOAD SPATIAL — semantic interfaces over heterogeneous spatial computation.
//
// Payload calls the semantic interface; it never calls a vendor. Routing and
// optimization engines are replaceable actors behind a blanket, exactly as
// model providers are behind ModelProvider. Vendor names appear in `docs/` and
// in the ledger, never in this directory — `spatial.test.ts` enforces that, and
// it has already caught one refusal string of ours that named three.
//
// Three properties carry this design, and each is a lesson already paid for:
//
//  1. A BACKEND DECLARES ITS CAPABILITIES AND THE INTERFACE REFUSES WHAT IT LACKS.
//     Measured: a truck endpoint accepted a height parameter and applied
//     nothing — 3.00m and 4.11m returned byte-identical routes. Calling a truck
//     endpoint proves nothing. Legality is derived from a DECLARED and VERIFIED
//     capability, never from which URL was called.
//
//  2. EVERY RESULT IS A CLAIM, NOT GROUND TRUTH. A route, a matrix, a VRP solution
//     is a modeled output carrying its backend, version, and admissibility. A GPU
//     solver returning an answer 40x faster returns the same KIND of object.
//
//  3. DURATION IS MANDATORY, DISTANCE IS NOT SUFFICIENT. Measured: crossing a height
//     threshold moved distance -0.3% and duration +68%. An economics stage comparing
//     distances reads a legal and an illegal route as the same number.

import type { ISODateTime } from '../economy/types';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Geometry and vehicle profile
// ─────────────────────────────────────────────────────────────────────────────

/** [lon, lat] — GeoJSON order, stated because half of all spatial bugs are this. */
export type Position = readonly [number, number];

export interface VehicleProfile {
  profileId: string;                 // 'truck_53ft_dryvan@1.0.0'
  mode: 'truck' | 'car' | 'rail' | 'sea';
  /** INTEGER millimetres / kilograms. Floats at a legal threshold are the mud-tonnage class. */
  heightMm?: number;
  widthMm?: number;
  lengthMm?: number;
  grossWeightKg?: number;
  axleLoadKg?: number;
  hazmat?: HazmatClass | null;
  /** Hours-of-service, when the backend supports it — see `RESTRICTION_CAPS`. */
  hosRuleset?: 'us_fmcsa' | 'ca_nsc' | 'none';
}

export type HazmatClass = 'general' | 'explosive' | 'flammable' | 'corrosive' | 'radioactive';

/**
 * The restrictions a caller may REQUIRE. A backend that cannot honour a required
 * restriction must refuse, not silently ignore it — the byte-identical-route finding.
 */
export type RestrictionKind =
  | 'height' | 'width' | 'length' | 'weight' | 'axle_load'
  | 'hazmat' | 'hos' | 'toll_avoidance' | 'border_crossing';

export const RESTRICTION_KINDS: readonly RestrictionKind[] = [
  'height', 'width', 'length', 'weight', 'axle_load',
  'hazmat', 'hos', 'toll_avoidance', 'border_crossing',
];

/**
 * WHICH PROFILE FIELD EACH RESTRICTION READS, and its unit.
 *
 * Added because the profile comment referenced `RESTRICTION_CAPS` and no such
 * thing existed — a dangling reference in a shipped interface is a claim about
 * a mechanism that is not there. This is that mechanism: the mapping is
 * declared once, so a restriction cannot be required without naming the field
 * that carries its value.
 *
 * `null` means the restriction is not a scalar on the profile (`hazmat` is a
 * class, `toll_avoidance` and `border_crossing` are preferences). Those are
 * still restrictions and still must be honoured or refused; they simply have no
 * integer threshold to probe across.
 */
export const RESTRICTION_CAPS: Record<
  RestrictionKind,
  { field: keyof VehicleProfile | null; unit: 'mm' | 'kg' | 'class' | 'preference' }
> = {
  height: { field: 'heightMm', unit: 'mm' },
  width: { field: 'widthMm', unit: 'mm' },
  length: { field: 'lengthMm', unit: 'mm' },
  weight: { field: 'grossWeightKg', unit: 'kg' },
  axle_load: { field: 'axleLoadKg', unit: 'kg' },
  hazmat: { field: 'hazmat', unit: 'class' },
  hos: { field: 'hosRuleset', unit: 'preference' },
  toll_avoidance: { field: null, unit: 'preference' },
  border_crossing: { field: null, unit: 'preference' },
};

/** Restrictions whose value is a scalar threshold, so a probe can straddle it. */
export function isProbeable(r: RestrictionKind): boolean {
  const unit = RESTRICTION_CAPS[r].unit;
  return unit === 'mm' || unit === 'kg';
}

export const NON_INTEGER_DIMENSION = 'NON_INTEGER_DIMENSION';

/**
 * The profile's dimensions are INTEGER millimetres and kilograms, and this is
 * where that is enforced rather than merely commented.
 *
 * The same lesson as the notary's `assertMilli`: a value the downstream system
 * cannot represent, accepted at the boundary, produces a stable-looking answer
 * over a number nobody can reproduce. Here the stakes are a legal threshold —
 * 4.1149m rounded three different ways by three backends is three different
 * answers to "does this truck fit", and the caller sees one number.
 */
export function assertIntegerDimensions(p: VehicleProfile): void {
  const fields: Array<keyof VehicleProfile> = [
    'heightMm', 'widthMm', 'lengthMm', 'grossWeightKg', 'axleLoadKg',
  ];
  for (const f of fields) {
    const v = p[f];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
      throw new Error(
        `${NON_INTEGER_DIMENSION}: ${String(f)} is ${String(v)}. Dimensions are integer ` +
        'millimetres and kilograms. A fractional value at a legal threshold is rounded ' +
        'differently by every backend, and the caller sees one number with no way to tell.',
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Capability declaration — the mechanism that prevents the silent-ignore failure
// ─────────────────────────────────────────────────────────────────────────────

export type SpatialOperation =
  | 'route' | 'matrix' | 'isochrone' | 'nearest'
  | 'service_area' | 'map_match' | 'network_analysis';

export const SPATIAL_OPERATIONS: readonly SpatialOperation[] = [
  'route', 'matrix', 'isochrone', 'nearest', 'service_area', 'map_match', 'network_analysis',
];

export type OptimizerOperation =
  | 'vrp' | 'pickup_delivery' | 'capacity' | 'time_windows' | 'multi_vehicle';

/**
 * FOUR STATES, NOT THREE.
 *
 * `refuted` and `unhonoured` are different failures and conflating them loses
 * the distinction that matters when choosing a backend:
 *
 *   unhonoured — the backend does not accept the parameter at all. This is the
 *                HONEST failure. Nothing is pretended; the caller knows the
 *                constraint was never in play.
 *   refuted    — the backend ACCEPTS the parameter and applies nothing. It
 *                returns a route that looks constrained and is not. This is the
 *                measured case, and it is the dangerous one.
 *
 * A three-state model has to file both under `refuted`, which reads as "this
 * backend is bad at height" when the two facts call for opposite responses.
 */
export type CapabilityState =
  /** A discriminating probe measured the restriction being applied. */
  | 'assured'
  /** Declared, never probed. Absence of evidence — must not read as a pass. */
  | 'unverified'
  /** Accepted and demonstrably applied nothing. Positive evidence of the lie. */
  | 'refuted'
  /** Not accepted at all. Honest, and still means the load is planned without it. */
  | 'unhonoured';

/**
 * A capability is CLAIMED by the vendor and VERIFIED by a discriminating probe.
 * A probe on a lane where the restriction does not bind proves the endpoint answered,
 * not that the restriction was applied — so the probe must record a lane where the
 * result MEASURABLY changes across the threshold.
 *
 * KEYED BY (restriction × operation), because a backend is not uniform. Measured
 * in reconnaissance: a backend that honours truck restrictions on its directions
 * and isochrone endpoints and DISCARDS them on its matrix endpoint — HTTP 200,
 * well-formed matrix, no warning field, the restriction never read. Upstream and
 * open since 2018. The matrix is what a dispatcher calls for fleet assignment.
 *
 * A verification keyed by restriction alone says "height: verified" and is true
 * of one endpoint and false of another, with the caller unable to tell which.
 */
export interface RestrictionVerification {
  restriction: RestrictionKind;
  /** Which operation this verdict is about. Never optional — see above. */
  operation: SpatialOperation;
  status: CapabilityState;
  probe: {
    description: string;
    /** Below/above the threshold. If these are equal, the restriction is NOT applied. */
    belowThreshold: { distanceM: number; durationS: number };
    aboveThreshold: { distanceM: number; durationS: number };
    /** The discriminating measure. Duration, because distance barely moves. */
    durationDeltaPct: number;
    verifiedAt: ISODateTime;
  } | null;
  note: string;
}

export interface BackendCapabilities {
  backendId: string;
  operations: ReadonlySet<SpatialOperation>;
  /**
   * Restrictions the backend both accepts AND applies, PER OPERATION.
   *
   * Was a single set for the whole backend. That shape cannot represent the
   * measured case above, and a shape that cannot represent a known defect will
   * report green through it.
   */
  restrictionsHonoured: ReadonlyMap<SpatialOperation, ReadonlySet<RestrictionKind>>;
  /** Every declared restriction carries the probe that verified it, per operation. */
  verification: readonly RestrictionVerification[];
  maxMatrixDimension: number | null;
  supportsIsochrone: boolean;
  coverage: { regions: string[]; note: string };
}

/**
 * The floor a duration change must clear to count as a real effect.
 *
 * Derived from the measurement, not chosen by taste: a restriction that IS
 * honoured moved duration 68%, and one that is not moved it 0%. Distance for
 * the same real restriction moved 0.3%.
 */
export const DISCRIMINATION_FLOOR_PCT = 1.0;

/**
 * Did the probe actually discriminate?
 *
 * CORRECTED FROM THE ORIGINAL, which returned true when EITHER duration or
 * distance differed. That contradicts this file's own property 3 and blesses
 * the exact case the measurement rules out: the real probe moved distance
 * -0.3% while duration moved +68%, so a backend whose distance wobbles by a
 * rounding amount with duration flat would have been read as discriminating —
 * and a discriminating probe is what promotes a capability to `assured`.
 *
 * Duration is the axis. Distance is recorded, and is never sufficient alone.
 */
export function isDiscriminating(v: RestrictionVerification): boolean {
  const p = v.probe;
  if (!p) return false;
  const below = p.belowThreshold.durationS;
  const above = p.aboveThreshold.durationS;
  if (below === above) return false;
  const deltaPct = below === 0 ? (above === 0 ? 0 : 100) : (Math.abs(above - below) / below) * 100;
  return deltaPct >= DISCRIMINATION_FLOOR_PCT;
}

/**
 * Legality for ONE operation: every required restriction is `assured` FOR THAT
 * OPERATION. The operation is required, not optional — an optional parameter
 * defaulting to "all verdicts" lets a matrix call read a route call's assurance,
 * which is the defect this signature exists to close.
 *
 * An empty verdict set is FALSE. `[].every()` returning true is how an absence
 * of evidence reads as a pass.
 */
export function legalityAssured(
  verification: readonly RestrictionVerification[],
  operation: SpatialOperation,
  required: readonly RestrictionKind[],
): boolean {
  if (required.length === 0) return true;
  return required.every((r) =>
    verification.some(
      (v) => v.operation === operation && v.restriction === r && v.status === 'assured',
    ));
}

/** The required restrictions that are not assured for this operation. */
export function unhonouredFor(
  verification: readonly RestrictionVerification[],
  operation: SpatialOperation,
  required: readonly RestrictionKind[],
): RestrictionKind[] {
  return required.filter((r) =>
    !verification.some(
      (v) => v.operation === operation && v.restriction === r && v.status === 'assured',
    ));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Results are claims — provenance on every spatial output
// ─────────────────────────────────────────────────────────────────────────────

export interface SpatialProvenance {
  backendId: string;
  backendVersion: string;
  /** The operation this result came from — the axis capability is keyed on. */
  operation: SpatialOperation;
  /**
   * The vehicle class the claim is about.
   *
   * Carried so a legality claim can name what it is legal FOR. Rendering
   * "truck-legal" from provenance that does not know the mode would print it
   * over a rail or sea profile just as happily.
   */
  mode: VehicleProfile['mode'];
  /** Which restrictions were REQUIRED, and which the backend actually honoured. */
  restrictionsRequested: RestrictionKind[];
  restrictionsHonoured: RestrictionKind[];
  /**
   * TRUE only when every requested restriction is in `restrictionsHonoured` AND each
   * is `assured` FOR THIS OPERATION. A route from an endpoint that accepted a height
   * and applied nothing is NOT legality-assured, however it was labelled.
   *
   * Populated from the arbitrated verdicts, never from the vendor's response
   * body: a backend cannot lie its way onto the envelope because the envelope
   * does not read the backend.
   */
  legalityAssured: boolean;
  networkVintage: string | null;     // network extract date — the graph is evidence too
  computedAt: ISODateTime;
  computeMs: number;
}

/** Every spatial result is a claim. `modeled` is the honest class for all of them. */
export interface SpatialClaim<T> {
  value: T;
  provenance: SpatialProvenance;
  sourceClass: 'modeled';
  renderedClaim: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Refusal — three-valued, with the remedy naming what could answer
// ─────────────────────────────────────────────────────────────────────────────

export type SpatialResult<T> =
  | { status: 'ok'; claim: SpatialClaim<T> }
  | {
      status: 'refused';
      reason: SpatialRefusalReason;
      /** What would satisfy this — the remedy is actionable, and names no vendor. */
      remedy: string;
      requestedRestrictions: RestrictionKind[];
      unhonoured: RestrictionKind[];
    }
  | {
      status: 'degraded';
      claim: SpatialClaim<T>;
      /** Computed, but NOT with every requested restriction. Named, never silent. */
      unhonoured: RestrictionKind[];
      warning: string;
    };

export type SpatialRefusalReason =
  | 'operation_unsupported'
  | 'restriction_not_honoured'
  | 'restriction_unverified'
  | 'outside_coverage'
  | 'matrix_too_large'
  | 'backend_unreachable'
  | 'no_route_exists';

/** The warning a degraded result carries. Strict is the freight default. */
export function degradedWarning(
  operation: SpatialOperation,
  unhonoured: readonly RestrictionKind[],
): string {
  return (
    `LEGALITY NOT ASSURED for ${operation} — ` +
    unhonoured.join(', ') +
    '. Do not send a driver on this route without confirming clearances independently. ' +
    'A route returned under an unhonoured restriction is a car route wearing a lorry label.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The semantic interfaces — what Payload calls
// ─────────────────────────────────────────────────────────────────────────────

export interface RouteRequest {
  from: Position;
  to: Position;
  via?: Position[];
  profile: VehicleProfile;
  /** Restrictions the caller REQUIRES. Unhonoured → refuse or degrade, never ignore. */
  require: RestrictionKind[];
  departAt?: ISODateTime;
}

export interface Route {
  distanceM: number;
  /** MANDATORY. Measured: a restriction moves duration 68% and distance 0.3%. */
  durationS: number;
  geometry: Position[];
  legs: Array<{ distanceM: number; durationS: number; from: Position; to: Position }>;
  /** Restriction-relevant, when the backend reports it. */
  tollCostMinor?: number;
  borderCrossings?: string[];
}

export interface MatrixRequest {
  origins: Position[];
  destinations: Position[];
  profile: VehicleProfile;
  require: RestrictionKind[];
  /** A matrix of distances alone is not sufficient for costing — see Route.durationS. */
  metrics: Array<'distance' | 'duration'>;
}

export interface Matrix {
  /** [originIdx][destIdx]. null = no route exists; never 0, never Infinity. */
  durationsS: (number | null)[][];
  distancesM: (number | null)[][];
  unreachablePairs: Array<{ origin: number; destination: number }>;
}

export interface IsochroneRequest {
  center: Position;
  profile: VehicleProfile;
  require: RestrictionKind[];
  rangesS: number[];
}

export interface Isochrone {
  polygons: Array<{ rangeS: number; ring: Position[] }>;
}

export interface NearestRequest {
  point: Position;
  candidates: Array<{ id: string; at: Position }>;
  profile: VehicleProfile;
  require: RestrictionKind[];
  /** Ranked by DRIVE TIME, not haversine — the whole point of asking a router. */
  limit: number;
}

export interface NearestResult {
  ranked: Array<{ id: string; durationS: number; distanceM: number }>;
  /** Candidates the router could not reach. Not silently dropped. */
  unreachable: string[];
}

export interface MapMatchRequest {
  trace: Array<{ at: ISODateTime; position: Position }>;
  profile: VehicleProfile;
}

export interface MapMatch {
  matched: Array<{ at: ISODateTime; position: Position; confidence: number }>;
  /** Segments the matcher could not place. Gaps are stated, per class 7. */
  unmatchedSpans: Array<{ from: ISODateTime; to: ISODateTime }>;
}

/**
 * Network analysis: connectivity and reachability over the road graph.
 *
 * TYPED, where the original had `req: unknown` returning `SpatialResult<unknown>`.
 * An `unknown` on a shipped interface is an operation with no contract: no
 * caller can construct a request, no backend knows what to implement, and no
 * test can fail. Naming the one question this operation actually answers is
 * better than reserving a slot for every question it might.
 */
export interface NetworkAnalysisRequest {
  origin: Position;
  targets: Position[];
  profile: VehicleProfile;
  require: RestrictionKind[];
  question: 'reachability' | 'connected_components' | 'critical_edges';
}

export interface NetworkAnalysis {
  question: NetworkAnalysisRequest['question'];
  reachable: Position[];
  /** Targets the graph cannot reach under this profile. Stated, not dropped. */
  unreachable: Position[];
  note: string;
}

export interface SpatialEngine {
  readonly capabilities: BackendCapabilities;
  route(req: RouteRequest): Promise<SpatialResult<Route>>;
  matrix(req: MatrixRequest): Promise<SpatialResult<Matrix>>;
  isochrone(req: IsochroneRequest): Promise<SpatialResult<Isochrone>>;
  nearest(req: NearestRequest): Promise<SpatialResult<NearestResult>>;
  serviceArea(req: IsochroneRequest): Promise<SpatialResult<Isochrone>>;
  mapMatch(req: MapMatchRequest): Promise<SpatialResult<MapMatch>>;
  networkAnalysis(req: NetworkAnalysisRequest): Promise<SpatialResult<NetworkAnalysis>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The optimizer interface — one contract, GPU or CPU behind it
// ─────────────────────────────────────────────────────────────────────────────

export interface Vehicle {
  vehicleId: string;
  start?: Position;
  end?: Position;
  capacity: number[];                // multi-dimensional: weight, volume, pallets
  timeWindow?: { fromS: number; toS: number };
  profile: VehicleProfile;
  skills?: string[];                 // reefer, hazmat endorsement, tailgate
}

export interface Job {
  jobId: string;
  at: Position;
  serviceS: number;
  amount: number[];                  // same dimensionality as Vehicle.capacity
  timeWindows?: Array<{ fromS: number; toS: number }>;
  requiredSkills?: string[];
  priority?: number;
}

export interface Shipment {
  shipmentId: string;
  pickup: Job;
  delivery: Job;
  amount: number[];
}

export interface VrpRequest {
  vehicles: Vehicle[];
  jobs?: Job[];
  shipments?: Shipment[];
  /** The matrix is an INPUT, and it is itself a claim — provenance travels with it. */
  matrix: SpatialClaim<Matrix>;
  objective: 'min_duration' | 'min_distance' | 'max_contribution' | 'min_vehicles';
  /** Hard cap. A solver that runs unbounded blocks a dispatcher. */
  timeLimitMs: number;
}

export interface VrpSolution {
  routes: Array<{
    vehicleId: string;
    steps: Array<{ kind: 'start' | 'job' | 'pickup' | 'delivery' | 'end'; id?: string; arrivalS: number }>;
    durationS: number;
    distanceM: number;
    load: number[];
  }>;
  /** Jobs the solver could not place, WITH the binding constraint named. */
  unassigned: Array<{ jobId: string; reason: string }>;
  objectiveValue: number;
  /** Did it prove optimality, or time out? A timed-out solution is not optimal. */
  optimality: 'proven_optimal' | 'feasible_not_proven' | 'time_limit_reached';
  solverMs: number;
}

/**
 * CONSERVATION. Every job handed in is assigned or explicitly unassigned.
 *
 * A solver can return `optimality: 'proven_optimal'` over a plan that quietly
 * dropped jobs, and the plan looks complete. Counting is the only thing that
 * catches it, so it is a function here rather than a convention.
 */
export function vrpConserves(req: VrpRequest, sol: VrpSolution): boolean {
  const submitted = new Set<string>([
    ...(req.jobs ?? []).map((j) => j.jobId),
    ...(req.shipments ?? []).flatMap((s) => [s.pickup.jobId, s.delivery.jobId]),
  ]);
  const placed = new Set<string>();
  for (const r of sol.routes) {
    for (const s of r.steps) if (s.id) placed.add(s.id);
  }
  for (const u of sol.unassigned) placed.add(u.jobId);
  if (placed.size !== submitted.size) return false;
  for (const id of submitted) if (!placed.has(id)) return false;
  return true;
}

export interface RoutingOptimizer {
  readonly backendId: string;
  readonly operations: ReadonlySet<OptimizerOperation>;
  vrp(req: VrpRequest): Promise<SpatialResult<VrpSolution>>;
  pickupDelivery(req: VrpRequest): Promise<SpatialResult<VrpSolution>>;
  capacity(req: VrpRequest): Promise<SpatialResult<VrpSolution>>;
  timeWindows(req: VrpRequest): Promise<SpatialResult<VrpSolution>>;
  multiVehicle(req: VrpRequest): Promise<SpatialResult<VrpSolution>>;
}
