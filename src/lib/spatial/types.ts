/**
 * Payload — the spatial semantic surface.
 *
 * Payload calls THESE types. It never calls a vendor's. ORS, pgRouting,
 * VROOM and cuOpt are backends behind this boundary, and the boundary is
 * only real if no vendor concept appears in a signature or a returned type —
 * which `spatial.test.ts` asserts over the source rather than trusting.
 *
 * THE FAILURE MODE THIS GUARDS. Nobody accidentally builds a routing engine.
 * What happens is leakage: `route()` nominally abstracts a backend while
 * callers come to depend on that backend's field names, its error codes, its
 * particular notion of a truck profile. The interface is then nominal, a
 * swap breaks every caller, and you have built a routing engine out of
 * someone else's without the ability to replace it. That is a boundary whose
 * effective scope is narrower than its apparent scope — the class this tree
 * keeps finding — so the completeness of the boundary is the property under
 * test.
 */

import type { Attestation } from '../economy/attestation';
import type { ComputedBy } from '../economy/models';

/* ── Geometry, stated once ───────────────────────────────────────────── */

/** WGS84. Stated because a coordinate without a datum is not a location. */
export interface Point {
  readonly lat: number;
  readonly lon: number;
}

export interface Waypoint extends Point {
  /** The facility or stop this point stands for, when it stands for one.
   *  Absent means a bare coordinate, which is a different thing from an
   *  unresolved facility — see the facility register's resolution gate. */
  readonly facilityId?: string;
}

/* ── The vehicle profile ─────────────────────────────────────────────── */

/**
 * TRUCK-LEGALITY DERIVES FROM THIS, NOT FROM WHICH ENDPOINT WAS CALLED.
 *
 * Measured earlier in this programme: sweeping a height constraint across a
 * threshold changed duration by 68% while distance moved 0.3% — the routing
 * service returns a legal route only when it is TOLD the vehicle. A "truck
 * routing API" called without a profile returns a car route with a lorry
 * label, and nothing in the response says so.
 *
 * So the profile is required on every routing call, and every result echoes
 * the profile that actually ran. A caller comparing two routes can then see
 * whether they were computed for the same vehicle.
 */
export interface VehicleProfile {
  readonly kind: 'truck' | 'van' | 'car';
  /** Metres. */
  readonly heightM?: number;
  readonly widthM?: number;
  readonly lengthM?: number;
  /** Kilograms, gross. */
  readonly weightKg?: number;
  /** Kilograms per axle — the constraint that closes bridges. */
  readonly axleLoadKg?: number;
  readonly hazmat?: boolean;
  /** Avoid toll roads, ferries — stated so a cost comparison is like-for-like. */
  readonly avoid?: readonly ('tolls' | 'ferries' | 'highways')[];
}

/* ── Reproducibility, declared by the backend ────────────────────────── */

/**
 * Whether re-running this computation reproduces the answer.
 *
 * THE SHARP ISSUE IN THIS STACK. The programme requires that identical
 * State + Constraints + Objective yield identical output. Most vehicle
 * routing solvers are TIME-BOXED HEURISTICS: they explore until a budget
 * expires, so the same input on a loaded machine can give a different
 * answer. That is not a defect in the solver — it is what makes it fast
 * enough to use — but it means "deterministic replay" is a claim only some
 * backends can support.
 *
 * Declared by the backend at registration, never inferred. A result that
 * cannot be reproduced says so, so a replay reports a RE-COMPUTATION rather
 * than implying it recovered the original answer.
 */
export type Reproducibility =
  /** Same input, same output, always. */
  | 'deterministic'
  /** Same input AND same seed reproduce; the seed is recorded on the result. */
  | 'seeded'
  /** Time-boxed search. Re-running may differ. Auditable, not reproducible. */
  | 'time_boxed';

/* ── Every spatial answer carries who computed it ────────────────────── */

/**
 * The envelope on every result. A route, a matrix and an assignment are all
 * PREDICTIONS — a solver is a model of the world with assumptions and an
 * evidence boundary, exactly as a language model is — so each names the
 * registered model that produced it and carries an attestation like any
 * other derived quantity.
 */
export interface SpatialResult<T> {
  readonly value: T;
  readonly computedBy: ComputedBy;
  readonly reproducibility: Reproducibility;
  /** Present when reproducibility is 'seeded'. */
  readonly seed?: number;
  /** The profile that ACTUALLY ran, echoed back. */
  readonly profile?: VehicleProfile;
  readonly attestation: Attestation;
  readonly computedAt: string;
}

/* ── Refusals ────────────────────────────────────────────────────────── */

export const SPATIAL_BACKEND_UNAVAILABLE = 'SPATIAL_BACKEND_UNAVAILABLE';
export const SPATIAL_NO_ROUTE_EXISTS = 'SPATIAL_NO_ROUTE_EXISTS';
export const SPATIAL_PROFILE_UNSUPPORTED = 'SPATIAL_PROFILE_UNSUPPORTED';
export const SPATIAL_OPERATION_UNSUPPORTED = 'SPATIAL_OPERATION_UNSUPPORTED';
export const SPATIAL_INPUT_UNUSABLE = 'SPATIAL_INPUT_UNUSABLE';

/**
 * A refusal, never a fabricated answer.
 *
 * The three states a caller must be able to tell apart: a route exists and
 * here it is; NO route exists for this vehicle (a finding — the bridge is
 * too low); and we could not ask (the backend was down). Collapsing the
 * second into the third loses a real constraint; collapsing either into a
 * straight-line estimate is the fabrication the whole substrate refuses.
 */
export interface SpatialRefusal {
  readonly code: string;
  readonly detail: string;
  readonly remedy: string;
  /** The backend that refused, when one was reached at all. */
  readonly backend?: string;
}

export type SpatialOutcome<T> =
  | { readonly ok: true; readonly result: SpatialResult<T> }
  | { readonly ok: false; readonly refusal: SpatialRefusal };

/* ── SpatialEngine: the semantic operations ──────────────────────────── */

export interface RouteRequest {
  readonly waypoints: readonly Waypoint[];
  readonly profile: VehicleProfile;
  /** Departure, when the answer depends on it (traffic, restrictions). */
  readonly departAt?: string;
}

export interface RouteValue {
  readonly distanceM: number;
  readonly durationS: number;
  /** Ordered geometry, when the backend returns one. Absent is not zero. */
  readonly geometry?: readonly Point[];
  /** Per-leg breakdown, one per waypoint pair. */
  readonly legs: readonly { readonly distanceM: number; readonly durationS: number }[];
}

export interface MatrixRequest {
  readonly origins: readonly Waypoint[];
  readonly destinations: readonly Waypoint[];
  readonly profile: VehicleProfile;
}

export interface MatrixValue {
  /** [origin][destination]. `null` where no route exists — NEVER 0, which
   *  would read as "co-located" and price a lane at nothing. */
  readonly distanceM: readonly (readonly (number | null)[])[];
  readonly durationS: readonly (readonly (number | null)[])[];
  /** Cells that came back empty, so a caller can account for every drop. */
  readonly unreachable: readonly { readonly from: number; readonly to: number }[];
}

export interface IsochroneRequest {
  readonly origin: Waypoint;
  readonly profile: VehicleProfile;
  readonly rangeS: readonly number[];
}

export interface IsochroneValue {
  readonly bands: readonly { readonly rangeS: number; readonly polygon: readonly Point[] }[];
}

export interface NearestRequest {
  readonly origin: Point;
  readonly candidates: readonly Waypoint[];
  readonly profile: VehicleProfile;
  readonly limit?: number;
}

export interface NearestValue {
  readonly ranked: readonly {
    readonly waypoint: Waypoint;
    readonly distanceM: number;
    readonly durationS: number;
  }[];
}

export interface ServiceAreaRequest {
  readonly origin: Waypoint;
  readonly profile: VehicleProfile;
  readonly maxDurationS: number;
}

export interface ServiceAreaValue {
  readonly polygon: readonly Point[];
  readonly reachableFacilityIds: readonly string[];
}

export interface MapMatchRequest {
  /** A raw GPS trace, in time order. */
  readonly trace: readonly { readonly at: string; readonly point: Point }[];
  readonly profile: VehicleProfile;
}

export interface MapMatchValue {
  readonly matched: readonly Point[];
  /** Trace points the matcher could not place. Reported, not dropped. */
  readonly unmatchedIndices: readonly number[];
  readonly confidence: number;
}

export interface NetworkAnalysisRequest {
  readonly facilityIds: readonly string[];
  readonly profile: VehicleProfile;
  readonly question: 'connectivity' | 'centrality' | 'chokepoints';
}

export interface NetworkAnalysisValue {
  readonly rows: readonly { readonly facilityId: string; readonly score: number | null }[];
}

/**
 * Spatial computation, semantically. Every method returns an OUTCOME — a
 * result or a typed refusal — because "the backend was unreachable" and
 * "no route exists for this vehicle" are answers a dispatcher must tell
 * apart, and an exception collapses both into a stack trace.
 */
/**
 * The named semantic operations. Declared here rather than in the registry
 * because a CAPABILITY IS PER OPERATION, and the capability module must be
 * able to say which one without depending on the registry.
 */
export type SpatialOperation =
  | 'route' | 'matrix' | 'isochrone' | 'nearest'
  | 'serviceArea' | 'mapMatch' | 'networkAnalysis';

export interface SpatialEngine {
  readonly backendId: string;
  route(req: RouteRequest): Promise<SpatialOutcome<RouteValue>>;
  matrix(req: MatrixRequest): Promise<SpatialOutcome<MatrixValue>>;
  isochrone(req: IsochroneRequest): Promise<SpatialOutcome<IsochroneValue>>;
  nearest(req: NearestRequest): Promise<SpatialOutcome<NearestValue>>;
  serviceArea(req: ServiceAreaRequest): Promise<SpatialOutcome<ServiceAreaValue>>;
  mapMatch(req: MapMatchRequest): Promise<SpatialOutcome<MapMatchValue>>;
  networkAnalysis(req: NetworkAnalysisRequest): Promise<SpatialOutcome<NetworkAnalysisValue>>;
}

/* ── RoutingOptimizer: the vehicle-routing surface ───────────────────── */

export interface TimeWindow {
  readonly from: string;
  readonly to: string;
}

export interface OptimizerVehicle {
  readonly vehicleId: string;
  readonly start?: Waypoint;
  readonly end?: Waypoint;
  readonly profile: VehicleProfile;
  /** Capacity dimensions, named. `[weightKg, pallets]` and `[pallets, weightKg]`
   *  are different vectors, so the names travel with the numbers. */
  readonly capacity?: Readonly<Record<string, number>>;
  readonly availability?: TimeWindow;
  /** Endorsements and equipment: hazmat, tanker, reefer, TWIC. */
  readonly skills?: readonly string[];
}

export interface OptimizerJob {
  readonly jobId: string;
  readonly location: Waypoint;
  readonly serviceS?: number;
  readonly windows?: readonly TimeWindow[];
  readonly demand?: Readonly<Record<string, number>>;
  readonly requiredSkills?: readonly string[];
  readonly priority?: number;
}

/** A pickup and its delivery, which must ride the same vehicle in order. */
export interface OptimizerShipment {
  readonly shipmentId: string;
  readonly pickup: OptimizerJob;
  readonly delivery: OptimizerJob;
}

export interface VrpRequest {
  readonly vehicles: readonly OptimizerVehicle[];
  readonly jobs?: readonly OptimizerJob[];
  readonly shipments?: readonly OptimizerShipment[];
  /** What "better" means. Stated, because a plan is only optimal against one. */
  readonly objective: 'min_cost' | 'min_duration' | 'min_empty_distance' | 'max_served';
  /** Wall-clock budget. A time-boxed backend uses it; a deterministic one
   *  ignores it, and says which it did on the result. */
  readonly budgetMs?: number;
  readonly seed?: number;
}

export interface VrpAssignment {
  readonly vehicleId: string;
  /** Ordered stops. */
  readonly steps: readonly {
    readonly kind: 'start' | 'job' | 'pickup' | 'delivery' | 'end';
    readonly refId?: string;
    readonly arrivalS: number;
    readonly location: Waypoint;
  }[];
  readonly distanceM: number;
  readonly durationS: number;
}

export interface VrpValue {
  readonly assignments: readonly VrpAssignment[];
  /**
   * EVERY JOB THAT WAS NOT SERVED, WITH ITS REASON.
   *
   * A solver that silently omits a job it could not fit produces a plan that
   * looks complete and is not — the same defect as a mean over a partition
   * that quietly dropped its inconvenient half. Accounting for every drop,
   * applied to dispatch: served + unassigned must equal the input.
   */
  readonly unassigned: readonly {
    readonly refId: string;
    readonly reason: string;
  }[];
  readonly objectiveValue: number;
  /** True when the backend proved optimality rather than stopping on budget. */
  readonly provedOptimal: boolean;
}

/**
 * Vehicle routing, semantically. One entry point: the sub-capabilities
 * (capacity, time windows, pickup/delivery, multi-vehicle) are FEATURES OF A
 * REQUEST, not separate methods — a `capacity()` and a `timeWindows()` that
 * cannot be combined would model a solver that does one at a time, and the
 * whole reason to use a VRP solver is that it does them together.
 */
export interface RoutingOptimizer {
  readonly backendId: string;
  /** What this backend can honour. A request using an unsupported feature is
   *  REFUSED rather than silently solved without the constraint. */
  readonly supports: Readonly<{
    capacity: boolean;
    timeWindows: boolean;
    pickupDelivery: boolean;
    multiVehicle: boolean;
    skills: boolean;
  }>;
  vrp(req: VrpRequest): Promise<SpatialOutcome<VrpValue>>;
}
