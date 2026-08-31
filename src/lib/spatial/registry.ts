//
// THE BACKEND REGISTRY — registration, refusal, and what the UI may offer.
//
// A backend is registered as a MODEL, because a routing answer is a modelled
// quantity and the same identity discipline applies to it as to any other
// prediction: an id, a version, an evidence boundary, and known limitations.
//

import { registerModel, lookupModel, type RegisteredModel, type UncertaintySpec } from '../economy/models';
import { attestationOf, type Attestation } from '../economy/attestation';
import type {
  SpatialEngine, RoutingOptimizer, SpatialResult, SpatialRefusalReason,
  SpatialOperation, BackendCapabilities, RestrictionKind, VrpRequest, VrpSolution,
} from './engine.types';
import { SPATIAL_OPERATIONS } from './engine.types';

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

/** Register a spatial backend as a model. Returns the registry entry. */
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

/** The attestation a backend's output carries. A routing answer is a MODELLED
 *  quantity — it is not something anybody observed — so it enters the lattice
 *  as `estimated`, disinterested, and combines from there like anything else. */
export function backendAttestation(): Attestation {
  return attestationOf('estimated', 'medium', 'disinterested',
    'computed by a routing/optimization backend; modelled, not observed');
}

export function refuse<T>(
  reason: SpatialRefusalReason,
  remedy: string,
  requestedRestrictions: RestrictionKind[] = [],
  unhonoured: RestrictionKind[] = [],
): SpatialResult<T> {
  return { status: 'refused', reason, remedy, requestedRestrictions, unhonoured };
}

function unavailable(op: string): string {
  return (
    `no spatial backend is configured, so ${op} cannot be answered. This is a fact about ` +
    'the installation, not about the road network: no route was found to be impossible. ' +
    'Configure a spatial backend. Until one is registered the terminal refuses rather ' +
    'than estimating: a straight line is not a road, and a lane priced on one is priced ' +
    'on a fiction the caller cannot see.'
  );
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
  route: async (r) => refuse('operation_unsupported', unavailable('route'), r.require, r.require),
  matrix: async (r) => refuse('operation_unsupported', unavailable('matrix'), r.require, r.require),
  isochrone: async (r) => refuse('operation_unsupported', unavailable('isochrone'), r.require, r.require),
  nearest: async (r) => refuse('operation_unsupported', unavailable('nearest'), r.require, r.require),
  serviceArea: async (r) => refuse('operation_unsupported', unavailable('service_area'), r.require, r.require),
  mapMatch: async () => refuse('operation_unsupported', unavailable('map_match')),
  networkAnalysis: async (r) => refuse('operation_unsupported', unavailable('network_analysis'), r.require, r.require),
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

/* ── WHAT THE UI IS ALLOWED TO OFFER ──────────────────────────────────────── */

export interface OperationAvailability {
  readonly operation: SpatialOperation;
  readonly available: boolean;
  /** Why not, in the operator's terms. Empty when available. */
  readonly reason: string;
  readonly remedy: string;
  readonly backendId: string;
}

/**
 * Which spatial operations a given engine can actually answer.
 *
 * THIS EXISTS FOR THE UI, AND THE REASON IS THE DEFECT CLASS. A control rail
 * that renders four live buttons is claiming four capabilities. With no backend
 * configured every one of them refuses — so the rail's APPARENT SCOPE is the
 * full operation set while its EFFECTIVE SCOPE is empty, and nothing fails: the
 * operator clicks, nothing happens, and the terminal looks broken rather than
 * unconfigured.
 *
 * The engine answers, not the component. A backend registered later changes the
 * rail with no edit to the rail. Read from the DECLARED capability set, so a
 * backend supporting three of seven operations offers three.
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

/** True when at least one operation can be answered. */
export function anySpatialOperationAvailable(engine: SpatialEngine): boolean {
  return spatialAvailability(engine).some((a) => a.available);
}
