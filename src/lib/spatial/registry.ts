// src/lib/spatial/registry.ts
//
// The blanket. Payload calls the semantic interface; the registry selects a backend
// that can honour the REQUIRED restrictions, and refuses when none can.
//
// This file is where the byte-identical-route finding becomes structural: a route is
// legality-assured only when every requested restriction is both HONOURED by the
// backend and VERIFIED by a discriminating probe. An endpoint that accepts a height
// parameter and applies nothing yields `degraded`, never `ok`.

import { registerModel, lookupModel, type RegisteredModel, type UncertaintySpec } from '../economy/models';
import { attestationOf, type Attestation } from '../economy/attestation';
import type {
  SpatialEngine, RoutingOptimizer, BackendCapabilities, RestrictionKind,
  SpatialOperation, SpatialResult, SpatialClaim, SpatialProvenance,
  SpatialRefusalReason, RestrictionVerification, RouteRequest, Route, VrpRequest,
} from './engine.types';
import { isDiscriminating, SPATIAL_OPERATIONS, RESTRICTION_KINDS } from './engine.types';

// ─────────────────────────────────────────────────────────────────────────────
// Capability arbitration
// ─────────────────────────────────────────────────────────────────────────────

export interface Arbitration {
  /** The operation these verdicts are about. A verdict without one is unusable. */
  operation: SpatialOperation;
  /** Restrictions honoured AND verified by a discriminating probe. */
  assured: RestrictionKind[];
  /** Claimed by the backend but never verified, or verified by a null probe. */
  unverified: RestrictionKind[];
  /** Requested and not honoured at all. */
  unhonoured: RestrictionKind[];
  /** Probes whose two sides were identical — proof the restriction is NOT applied. */
  refuted: RestrictionKind[];
}

/** Everything requested that is not `assured`, in one list. */
export function shortfallOf(a: Arbitration): RestrictionKind[] {
  return [...a.unhonoured, ...a.refuted, ...a.unverified];
}

/**
 * Arbitrate a backend's capabilities FOR ONE OPERATION.
 *
 * `operation` is a required parameter and not an afterthought. Reconnaissance
 * measured a backend that honours truck restrictions on its directions and
 * isochrone endpoints and DISCARDS them on its matrix endpoint — 200, a
 * well-formed matrix, no warning field, the restriction never read. The matrix
 * is what a dispatcher calls for fleet assignment.
 *
 * Arbitrating per backend rather than per operation reintroduces exactly that
 * defect one layer up: `select('matrix', ['height'])` would consult a verdict
 * earned on `route` and hand back a car-legal matrix labelled truck-legal.
 */
export function arbitrate(
  caps: BackendCapabilities,
  operation: SpatialOperation,
  required: readonly RestrictionKind[],
): Arbitration {
  const assured: RestrictionKind[] = [];
  const unverified: RestrictionKind[] = [];
  const unhonoured: RestrictionKind[] = [];
  const refuted: RestrictionKind[] = [];

  const honouredHere = caps.restrictionsHonoured.get(operation);

  for (const r of required) {
    if (!honouredHere?.has(r)) { unhonoured.push(r); continue; }
    const v: RestrictionVerification | undefined =
      caps.verification.find(x => x.restriction === r && x.operation === operation);
    if (!v) { unverified.push(r); continue; }
    // `refuted` is positive evidence the restriction is ignored. A probe that
    // ran but did not discriminate is the same evidence arriving another way,
    // so it lands in the same bucket rather than in `unverified`.
    if (v.status === 'refuted' || (v.probe && !isDiscriminating(v))) { refuted.push(r); continue; }
    // `unhonoured` as a VERDICT means the backend does not accept the parameter
    // at all — the honest failure, and still not an assurance.
    if (v.status === 'unhonoured') { unhonoured.push(r); continue; }
    if (v.status === 'assured' && isDiscriminating(v)) { assured.push(r); continue; }
    unverified.push(r);
  }
  return { operation, assured, unverified, unhonoured, refuted };
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

export interface InventoryRow {
  backendId: string;
  operation: SpatialOperation;
  assured: RestrictionKind[];
  refuted: RestrictionKind[];
  unverified: RestrictionKind[];
  unhonoured: RestrictionKind[];
}

export class SpatialRegistry {
  private engines: SpatialEngine[] = [];
  private optimizers: RoutingOptimizer[] = [];

  register(e: SpatialEngine): this { this.engines.push(e); return this; }
  registerOptimizer(o: RoutingOptimizer): this { this.optimizers.push(o); return this; }

  listOptimizers(): readonly RoutingOptimizer[] { return this.optimizers; }

  /**
   * Every registered backend, per operation, and what it can be trusted to do.
   *
   * Arbitrated over the FULL restriction vocabulary, not over the set the
   * backend already claims. Arbitrating over `[...restrictionsHonoured]` makes
   * `unhonoured` empty by construction — the field would exist and could never
   * be non-empty, which is a column of zeroes that reads as a clean bill.
   */
  inventory(): InventoryRow[] {
    const rows: InventoryRow[] = [];
    for (const e of this.engines) {
      for (const operation of SPATIAL_OPERATIONS) {
        if (!e.capabilities.operations.has(operation)) continue;
        const a = arbitrate(e.capabilities, operation, RESTRICTION_KINDS);
        rows.push({
          backendId: e.capabilities.backendId,
          operation,
          assured: a.assured,
          refuted: a.refuted,
          unverified: a.unverified,
          unhonoured: a.unhonoured,
        });
      }
    }
    return rows;
  }

  /**
   * Select a backend for an operation with required restrictions.
   *
   * ALWAYS RETURNS THE BEST CANDIDATE WHEN ONE EXISTS, with its arbitration —
   * it never returns `null` merely because nothing is perfect.
   *
   * The original returned `engine: null` whenever no backend assured
   * everything, while its own comment said it returned "the closest, and let
   * the caller decide between `degraded` and `refused`". Traced over all four
   * inputs: that made the `degraded` branch of `route()` UNREACHABLE, so
   * `strict: false` refused identically to `strict: true` and the documented
   * planning estimate did not exist. The mechanism's apparent scope was two
   * modes; its effective scope was one, and nothing failed.
   *
   * Preference order is deliberate: a backend that ASSURES every requirement
   * beats one that merely claims them. Speed is never a tiebreaker over
   * legality.
   */
  select(op: SpatialOperation, required: readonly RestrictionKind[]): {
    engine: SpatialEngine | null;
    arbitration: Arbitration | null;
    candidates: string[];
  } {
    const capable = this.engines.filter(e => e.capabilities.operations.has(op));
    const candidates = capable.map(c => c.capabilities.backendId);
    if (capable.length === 0) return { engine: null, arbitration: null, candidates: [] };

    const scored = capable.map(e => ({ e, a: arbitrate(e.capabilities, op, required) }));
    const full = scored.find(s => shortfallOf(s.a).length === 0);
    if (full) return { engine: full.e, arbitration: full.a, candidates };

    // Rank by hard failures first (not honoured, or proven ignored), then by
    // merely-unverified. An unverified restriction is an absence of evidence; a
    // refuted one is evidence of absence, and they must not sort as equals.
    scored.sort((x, y) => {
      const hard = (a: Arbitration) => a.unhonoured.length + a.refuted.length;
      return hard(x.a) - hard(y.a) || x.a.unverified.length - y.a.unverified.length;
    });
    return { engine: scored[0].e, arbitration: scored[0].a, candidates };
  }

  /**
   * Route through the semantic interface. This is what Payload calls — never a vendor.
   *
   * `strict` is the freight default: an unassured restriction REFUSES rather than
   * returning a route that may be illegal. A caller who wants a planning estimate
   * passes strict:false and receives `degraded` with the unhonoured set named.
   */
  async route(req: RouteRequest, opts: { strict?: boolean } = {}): Promise<SpatialResult<Route>> {
    const strict = opts.strict ?? true;
    const sel = this.select('route', req.require);

    if (sel.engine === null || sel.arbitration === null) {
      return {
        status: 'refused',
        reason: 'operation_unsupported',
        remedy:
          'No registered backend supports route(). Registered for this operation: ' +
          `${sel.candidates.join(', ') || 'none'}.`,
        requestedRestrictions: [...req.require],
        unhonoured: [...req.require],
      };
    }

    const { engine, arbitration } = sel;
    const shortfall = shortfallOf(arbitration);

    // Refuse BEFORE calling the backend when strict cannot be satisfied. Calling
    // it first spends the request only to discard the answer, and — worse —
    // makes the refusal depend on whether the backend happened to be up.
    if (strict && shortfall.length > 0) {
      return {
        status: 'refused',
        reason: arbitration.refuted.length ? 'restriction_not_honoured' : 'restriction_unverified',
        remedy:
          `${engine.capabilities.backendId} did not assure ${shortfall.join(', ')} for route. ` +
          `Candidates: ${sel.candidates.join(', ')}. Pass strict:false for a planning estimate ` +
          'that names the shortfall, or register a backend that assures it. A backend that ' +
          'accepts a restriction parameter is not evidence it applies it — verify with a ' +
          'discriminating probe on a lane where the threshold binds.',
        requestedRestrictions: [...req.require],
        unhonoured: shortfall,
      };
    }

    const result = await engine.route(req);
    if (result.status !== 'ok') return result;
    if (shortfall.length === 0) return result;

    return {
      status: 'degraded',
      claim: result.claim,
      unhonoured: shortfall,
      warning:
        `Route computed WITHOUT assured ${shortfall.join(', ')}. Not legality-assured — ` +
        'do not send a driver on this without confirming clearances independently.',
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Backend registration as a model
// ─────────────────────────────────────────────────────────────────────────────

/** How a backend behaves on re-run. Declared, never inferred. */
export type Reproducibility =
  | 'deterministic'
  | 'deterministic_under_conditions'
  | 'version_pinned'
  | 'not_reproducible';

export interface BackendRegistration {
  readonly backendId: string;
  readonly modelId: string;
  readonly version: string;
  readonly reproducibility: Reproducibility;
  /** Where its network is good, and where it is extrapolating. */
  readonly evidenceBoundary: string;
  readonly knownLimitations: readonly string[];
  readonly uncertainty: UncertaintySpec;
  readonly knownAt: string;
}

/** Register a spatial backend as a model — a routing answer is a prediction. */
export function registerBackend(reg: BackendRegistration): RegisteredModel {
  return registerModel({
    modelId: reg.modelId,
    version: reg.version,
    kind: 'solver',
    predicts: 'spatial',
    inputs: ['facilities.register', 'lanes.residuals'],
    evidenceBoundary: reg.evidenceBoundary,
    uncertainty: reg.uncertainty,
    knownLimitations: [...reg.knownLimitations, `reproducibility: ${reg.reproducibility}`],
    knownAt: reg.knownAt,
  });
}

export function backendModel(reg: BackendRegistration): RegisteredModel | undefined {
  return lookupModel(reg.modelId, reg.version);
}

/** A routing answer is MODELLED — nobody observed it — so it enters the lattice
 *  as `estimated`, disinterested, and combines from there like anything else. */
export function backendAttestation(): Attestation {
  return attestationOf('estimated', 'medium', 'disinterested',
    'computed by a routing/optimization backend; modelled, not observed');
}

// ─────────────────────────────────────────────────────────────────────────────
// The null backend
// ─────────────────────────────────────────────────────────────────────────────

function unavailable(op: string): string {
  return (
    `no spatial backend is configured, so ${op} cannot be answered. This is a fact about ` +
    'the installation, not about the road network: no route was found to be impossible. ' +
    'Configure a spatial backend. Until one is registered the terminal refuses rather ' +
    'than estimating: a straight line is not a road, and a lane priced on one is priced ' +
    'on a fiction the caller cannot see.'
  );
}

export function refuse<T>(
  reason: SpatialRefusalReason,
  remedy: string,
  requestedRestrictions: RestrictionKind[] = [],
  unhonoured: RestrictionKind[] = [],
): SpatialResult<T> {
  return { status: 'refused', reason, remedy, requestedRestrictions, unhonoured };
}

export const NO_BACKEND_CAPABILITIES: BackendCapabilities = {
  backendId: 'none',
  operations: new Set<SpatialOperation>(),
  restrictionsHonoured: new Map(),
  verification: [],
  maxMatrixDimension: null,
  supportsIsochrone: false,
  coverage: { regions: [], note: 'no backend configured' },
};

/**
 * The engine used when no backend is configured.
 *
 * IT REFUSES. It does not fall back to great-circle distance, because a
 * straight line between two points is not a road and a lane priced on one is
 * priced on a fiction — and the caller cannot tell, because a number came
 * back. The measured reference: a height constraint swept across a bridge
 * threshold moved duration 68% while distance moved 0.3%, so distance is
 * exactly the axis a straight line gets least wrong and duration the one it
 * gets uselessly wrong.
 */
export const NO_SPATIAL_BACKEND: SpatialEngine = {
  capabilities: NO_BACKEND_CAPABILITIES,
  route: async (r) => refuse('operation_unsupported', unavailable('route'), [...r.require], [...r.require]),
  matrix: async (r) => refuse('operation_unsupported', unavailable('matrix'), [...r.require], [...r.require]),
  isochrone: async (r) => refuse('operation_unsupported', unavailable('isochrone'), [...r.require], [...r.require]),
  nearest: async (r) => refuse('operation_unsupported', unavailable('nearest'), [...r.require], [...r.require]),
  serviceArea: async (r) => refuse('operation_unsupported', unavailable('service_area'), [...r.require], [...r.require]),
  mapMatch: async () => refuse('operation_unsupported', unavailable('map_match')),
  networkAnalysis: async (r) => refuse('operation_unsupported', unavailable('network_analysis'), [...r.require], [...r.require]),
};

export const NO_ROUTING_OPTIMIZER: RoutingOptimizer = {
  backendId: 'none',
  operations: new Set(),
  vrp: async () => refuse('operation_unsupported', unavailable('vrp')),
  pickupDelivery: async () => refuse('operation_unsupported', unavailable('pickup_delivery')),
  capacity: async () => refuse('operation_unsupported', unavailable('capacity')),
  timeWindows: async () => refuse('operation_unsupported', unavailable('time_windows')),
  multiVehicle: async () => refuse('operation_unsupported', unavailable('multi_vehicle')),
};

/**
 * Refuse a VRP request that uses a constraint the optimizer cannot honour.
 *
 * THE ALTERNATIVE IS THE DANGEROUS ONE. A solver handed time windows it does
 * not support will happily return a plan that ignores them, and the plan looks
 * exactly like a valid one. The dispatcher sees assignments, not the silently
 * dropped constraint, and finds out at the dock.
 */
export function checkOptimizerSupported(
  optimizer: RoutingOptimizer,
  req: Pick<VrpRequest, 'jobs' | 'shipments' | 'vehicles'>,
): string | null {
  const need: string[] = [];
  const jobs = req.jobs ?? [];
  if (jobs.some(j => (j.timeWindows?.length ?? 0) > 0) && !optimizer.operations.has('time_windows')) {
    need.push('time_windows');
  }
  if (jobs.some(j => j.amount.some(a => a !== 0)) && !optimizer.operations.has('capacity')) {
    need.push('capacity');
  }
  if ((req.shipments?.length ?? 0) > 0 && !optimizer.operations.has('pickup_delivery')) {
    need.push('pickup_delivery');
  }
  if (req.vehicles.length > 1 && !optimizer.operations.has('multi_vehicle')) {
    need.push('multi_vehicle');
  }
  if (need.length === 0) return null;
  return (
    `the optimizer does not support ${need.join(', ')}. A solver handed a constraint it ` +
    'cannot honour returns a plan that ignores it, and that plan is shaped exactly like a ' +
    'valid one. Refusing is the only way the dispatcher learns before the dock.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// What the UI is allowed to offer
// ─────────────────────────────────────────────────────────────────────────────

export interface OperationAvailability {
  readonly operation: SpatialOperation;
  readonly available: boolean;
  readonly reason: string;
  readonly remedy: string;
  readonly backendId: string;
}

/**
 * Which spatial operations a given engine can actually answer.
 *
 * THIS EXISTS FOR THE UI. A control rail rendering four live buttons is
 * claiming four capabilities. With no backend configured every one of them
 * refuses — so the rail's APPARENT SCOPE is the full operation set while its
 * EFFECTIVE SCOPE is empty, and nothing fails: the operator clicks, nothing
 * happens, and the terminal looks broken rather than unconfigured.
 */
export function spatialAvailability(engine: SpatialEngine): OperationAvailability[] {
  const caps = engine.capabilities;
  return SPATIAL_OPERATIONS.map((operation) => {
    const available = caps.operations.has(operation);
    return {
      operation,
      available,
      reason: available
        ? ''
        : caps.backendId === 'none'
          ? 'No spatial backend is configured. This is a fact about the installation, ' +
            'not about the road network.'
          : `The configured backend does not offer ${operation}.`,
      remedy: available
        ? ''
        : 'Configure a spatial backend that offers this operation. Until then the terminal ' +
          'refuses rather than estimating: a straight line is not a road.',
      backendId: caps.backendId,
    };
  });
}

export function anySpatialOperationAvailable(engine: SpatialEngine): boolean {
  return spatialAvailability(engine).some((a) => a.available);
}

// ─────────────────────────────────────────────────────────────────────────────
// Claim construction — every spatial output carries its warrant
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `computedAt` is INJECTED, not read from the clock.
 *
 * The original defaulted to `new Date().toISOString()`. A claim that stamps
 * itself is not reproducible: two runs over identical inputs produce two
 * different claims, so a replay can never be compared byte-for-byte against
 * the original, and the notary's in-time discipline — a commitment made when
 * the fact existed — has nothing stable to bind to. The engine holds no clock,
 * for the same reason `notarizeCondition` takes `now` as a parameter.
 */
export function spatialClaim<T>(
  value: T,
  p: SpatialProvenance,
  render: (v: T, prov: SpatialProvenance) => string,
): SpatialClaim<T> {
  return { value, provenance: p, sourceClass: 'modeled', renderedClaim: render(value, p) };
}

/** The default rendering. States the backend, the assurance, and the network vintage. */
export function renderRoute(
  r: { distanceM: number; durationS: number },
  p: SpatialProvenance,
): string {
  const km = (r.distanceM / 1000).toFixed(1);
  const h = Math.floor(r.durationS / 3600);
  const m = Math.round((r.durationS % 3600) / 60);

  // NOTHING REQUIRED MEANS NO LEGALITY CLAIM, not a passing one. The original
  // rendered "truck-legal for " with an empty list when `require` was empty,
  // asserting a clearance nobody asked for and nothing checked — the cheapest
  // possible overclaim, produced by a `join` on an empty array.
  const legality = p.restrictionsRequested.length === 0
    ? 'no restrictions requested, so no legality claim is made'
    : p.legalityAssured
      ? `${p.mode}-legal for ${p.restrictionsHonoured.join('/')}`
      : `NOT legality-assured (requested ${p.restrictionsRequested.join('/')}, ` +
        `honoured ${p.restrictionsHonoured.join('/') || 'none'})`;

  const vintage = p.networkVintage ? `network ${p.networkVintage}` : 'network vintage unknown';
  return (
    `${km} km, ${h}h${String(m).padStart(2, '0')} — ${legality}; ` +
    `computed by ${p.backendId} ${p.backendVersion} for ${p.operation}, ${vintage}. ` +
    'Modeled estimate, not an observation.'
  );
}
