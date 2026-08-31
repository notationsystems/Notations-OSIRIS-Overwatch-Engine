/**
 * Payload — binding a spatial backend to a registered model.
 *
 * A ROUTING ENGINE IS A PREDICTIVE MODEL. It has assumptions (the network
 * vintage, the restriction data, the speed profile), an evidence boundary
 * (where its map is good), and known limitations. So a backend does not
 * simply get plugged in: it REGISTERS, exactly as a language model or a
 * statistical fit does, and every answer it gives names the model id and
 * version that produced it.
 *
 * That is what makes the differentiation structural rather than a claim
 * about ourselves. "We combine heterogeneous computation into an auditable
 * decision" is only true if every contributor to the decision is registered
 * — and a backend called beside the registry contributes with no id, which
 * means the residual attributes its error to nothing.
 */

import {
  registerModel, lookupModel, type RegisteredModel, type UncertaintySpec,
} from '../economy/models';
import { attestationOf, type Attestation } from '../economy/attestation';
import type {
  Reproducibility, SpatialEngine, RoutingOptimizer, SpatialOutcome, SpatialRefusal,
} from './types';
import { SPATIAL_BACKEND_UNAVAILABLE, SPATIAL_OPERATION_UNSUPPORTED } from './types';

export interface BackendRegistration {
  readonly backendId: string;
  readonly modelId: string;
  readonly version: string;
  /** How the backend behaves on re-run. Declared, never inferred. */
  readonly reproducibility: Reproducibility;
  /** Where its map/network is good, and where it is extrapolating. */
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
    knownLimitations: [
      ...reg.knownLimitations,
      `reproducibility: ${reg.reproducibility}`,
    ],
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

export function refuse<T>(refusal: SpatialRefusal): SpatialOutcome<T> {
  return { ok: false, refusal };
}

/**
 * The engine used when no backend is configured.
 *
 * IT REFUSES. It does not fall back to great-circle distance, because a
 * straight line between two points is not a road and a lane priced on one is
 * priced on a fiction — and the caller cannot tell, because a number came
 * back. The measured reference for this: a height constraint swept across a
 * bridge threshold moved duration 68% while distance moved 0.3%, so distance
 * is exactly the axis a straight line gets least wrong and duration the one
 * it gets uselessly wrong.
 */
export const NO_SPATIAL_BACKEND: SpatialEngine = {
  backendId: 'none',
  route: async () => refuse(unavailable('route')),
  matrix: async () => refuse(unavailable('matrix')),
  isochrone: async () => refuse(unavailable('isochrone')),
  nearest: async () => refuse(unavailable('nearest')),
  serviceArea: async () => refuse(unavailable('serviceArea')),
  mapMatch: async () => refuse(unavailable('mapMatch')),
  networkAnalysis: async () => refuse(unavailable('networkAnalysis')),
};

function unavailable(op: string): SpatialRefusal {
  return {
    code: SPATIAL_BACKEND_UNAVAILABLE,
    detail:
      `no spatial backend is configured, so ${op} cannot be answered. This is a fact about ` +
      'the installation, not about the road network: no route was found to be impossible.',
    remedy:
      'configure a spatial backend. Until one is configured this refuses rather than ' +
      'estimating — a straight-line distance is not a road, and a lane priced on one is ' +
      'priced on a fiction the caller cannot see.',
    backend: 'none',
  };
}

export const NO_ROUTING_OPTIMIZER: RoutingOptimizer = {
  backendId: 'none',
  supports: {
    capacity: false, timeWindows: false, pickupDelivery: false,
    multiVehicle: false, skills: false,
  },
  vrp: async () => refuse(unavailable('vrp')),
};

/**
 * Refuse a request that uses a constraint the backend cannot honour.
 *
 * THE ALTERNATIVE IS THE DANGEROUS ONE. A solver handed time windows it does
 * not support will happily return a plan that ignores them, and the plan
 * looks exactly like a valid one. The dispatcher sees assignments, not the
 * silently dropped constraint, and finds out at the dock.
 */
export function checkSupported(
  optimizer: RoutingOptimizer,
  req: {
    jobs?: readonly { windows?: readonly unknown[]; demand?: unknown; requiredSkills?: readonly unknown[] }[];
    shipments?: readonly unknown[];
    vehicles: readonly unknown[];
  },
): SpatialRefusal | null {
  const need: string[] = [];
  const jobs = req.jobs ?? [];
  if (jobs.some(j => j.windows && j.windows.length > 0) && !optimizer.supports.timeWindows) {
    need.push('timeWindows');
  }
  if (jobs.some(j => j.demand) && !optimizer.supports.capacity) need.push('capacity');
  if (jobs.some(j => j.requiredSkills && j.requiredSkills.length > 0) && !optimizer.supports.skills) {
    need.push('skills');
  }
  if ((req.shipments?.length ?? 0) > 0 && !optimizer.supports.pickupDelivery) {
    need.push('pickupDelivery');
  }
  if (req.vehicles.length > 1 && !optimizer.supports.multiVehicle) need.push('multiVehicle');
  if (need.length === 0) return null;
  return {
    code: SPATIAL_OPERATION_UNSUPPORTED,
    detail:
      `${optimizer.backendId} cannot honour: ${need.join(', ')}. The request states constraints ` +
      'this backend would ignore.',
    remedy:
      'use a backend that supports these constraints, or restate the problem without them. A ' +
      'plan computed with a constraint silently dropped looks exactly like a valid plan, and ' +
      'the difference surfaces at the dock.',
    backend: optimizer.backendId,
  };
}

/**
 * Conservation over a VRP answer: every job in, accounted for out.
 *
 * A solver that omits what it could not fit returns a plan that looks
 * complete. Served + unassigned must equal the input, and this is where that
 * is checked rather than trusted.
 */
export function vrpConserves(
  req: { jobs?: readonly { jobId: string }[]; shipments?: readonly { shipmentId: string }[] },
  value: {
    assignments: readonly { steps: readonly { refId?: string; kind: string }[] }[];
    unassigned: readonly { refId: string }[];
  },
): { conserves: boolean; missing: string[] } {
  const expected = new Set<string>([
    ...(req.jobs ?? []).map(j => j.jobId),
    ...(req.shipments ?? []).map(s => s.shipmentId),
  ]);
  const seen = new Set<string>();
  for (const a of value.assignments) {
    for (const s of a.steps) if (s.refId) seen.add(s.refId);
  }
  for (const u of value.unassigned) seen.add(u.refId);
  const missing = [...expected].filter(id => !seen.has(id));
  return { conserves: missing.length === 0, missing };
}
