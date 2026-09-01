/**
 * Safe experimental assignment for freight decisions.
 *
 * This is a proposal generator, not an authorization or execution path. It
 * randomizes only across a pre-registered set of actions already marked
 * feasible, varies one named factor at a time, and emits the exact propensity
 * required by DecisionEpisodeLedger.
 */

import { createHash } from 'crypto';
import { attestationOf } from './attestation';
import type {
  DecisionAlternative,
  DecisionMetric,
  DecisionRecordedEvent,
  EpisodeOpenedEvent,
} from './decisionEpisode';
import type { ISODateTime } from './types';

export type ExplorationFactor = 'carrier' | 'departure_window';

export interface ExplorationAssignmentPolicy {
  readonly policyId: string;
  readonly version: string;
  readonly factor: ExplorationFactor;
  readonly algorithm: 'sha256_equal_cdf_v1';
  /** SHA-256 commitment to entropy fixed before the assignment population is used. */
  readonly randomizationSaltCommitment: string;
  /** Pre-registered population. Renormalizing after a refusal is not allowed. */
  readonly candidateActionIds: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface ExplorationAssignmentRequest {
  readonly opened: EpisodeOpenedEvent;
  readonly policy: ExplorationAssignmentPolicy;
  /** Stable identity fixed before assignment, normally opportunity/load intent. */
  readonly randomizationUnitId: string;
  /** Secret opening of policy.randomizationSaltCommitment; never returned. */
  readonly randomizationSalt: string;
  readonly eventId: string;
  readonly decidedAt: ISODateTime;
  readonly recordedAt: ISODateTime;
}

export interface ExplorationAssignmentProposal {
  readonly kind: 'proposal';
  readonly decision: DecisionRecordedEvent;
  readonly eligibleActionIds: readonly string[];
  readonly randomization: {
    readonly algorithm: ExplorationAssignmentPolicy['algorithm'];
    readonly unitId: string;
    readonly saltCommitment: string;
    readonly digest: string;
  };
  readonly statement: string;
}

export type ExplorationRefusalCode =
  | 'EXPLORATION_POLICY_INVALID'
  | 'EXPLORATION_RANDOMNESS_INVALID'
  | 'EXPLORATION_TIME_INVALID'
  | 'EXPLORATION_ACTION_UNKNOWN'
  | 'EXPLORATION_ACTION_INELIGIBLE'
  | 'EXPLORATION_POPULATION_TOO_SMALL'
  | 'EXPLORATION_FACTOR_CONFOUNDED';

export interface ExplorationAssignmentRefusal {
  readonly kind: 'refusal';
  readonly code: ExplorationRefusalCode;
  readonly detail: string;
  readonly remedy: string;
}

export type ExplorationAssignmentResult =
  | ExplorationAssignmentProposal
  | ExplorationAssignmentRefusal;

const DOMAIN = 'payload.exploration_assignment.sha256_equal_cdf_v1';
const SALT_DOMAIN = 'payload.exploration_assignment.salt.v1';
const TWO_POW_52 = 4_503_599_627_370_496;

export function commitExplorationSalt(salt: string): string {
  return createHash('sha256').update(`${SALT_DOMAIN}|${salt}`).digest('hex');
}

function nonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && values.every(value => value.trim().length > 0);
}

function refusal(
  code: ExplorationRefusalCode,
  detail: string,
  remedy: string,
): ExplorationAssignmentRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function windowKey(action: DecisionAlternative): string {
  return `${action.departureWindow.start}|${action.departureWindow.end}`;
}

function factorDefect(
  factor: ExplorationFactor,
  actions: readonly DecisionAlternative[],
): string | null {
  const lanes = new Set(actions.map(action => action.laneId));
  if (lanes.size !== 1) return 'candidate actions span more than one lane';
  if (factor === 'carrier') {
    if (new Set(actions.map(windowKey)).size !== 1) return 'carrier candidates use different departure windows';
    if (new Set(actions.map(action => action.carrierId)).size !== actions.length) {
      return 'carrier experiment does not assign one distinct carrier per action';
    }
    return null;
  }
  if (new Set(actions.map(action => action.carrierId)).size !== 1) {
    return 'departure-window candidates use different carriers';
  }
  if (new Set(actions.map(windowKey)).size !== actions.length) {
    return 'departure-window experiment does not assign one distinct window per action';
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Produce a reproducible equal-probability assignment proposal. The SHA-256
 * digest is the audit receipt; its first 52 bits map into the equal CDF.
 */
export function proposeExplorationAssignment(
  request: ExplorationAssignmentRequest,
): ExplorationAssignmentResult {
  const { opened, policy } = request;
  if (!policy.policyId.trim() || !policy.version.trim() ||
      policy.algorithm !== 'sha256_equal_cdf_v1' || !nonEmpty(policy.evidenceIds) ||
      !request.randomizationUnitId.trim() || !request.eventId.trim()) {
    return refusal(
      'EXPLORATION_POLICY_INVALID',
      'Exploration policy, evidence, randomization unit, or event identity is incomplete.',
      'Pre-register a versioned policy, candidate set, evidence, and stable randomization unit.',
    );
  }
  if (!request.randomizationSalt ||
      !/^[a-f0-9]{64}$/.test(policy.randomizationSaltCommitment) ||
      commitExplorationSalt(request.randomizationSalt) !== policy.randomizationSaltCommitment) {
    return refusal(
      'EXPLORATION_RANDOMNESS_INVALID',
      'Randomization entropy does not open the salt commitment fixed by the policy.',
      'Use the pre-committed secret; rotate to a newly versioned policy if that secret is unavailable.',
    );
  }
  const candidateIds = [...policy.candidateActionIds].sort();
  if (candidateIds.length < 2 || new Set(candidateIds).size !== candidateIds.length ||
      candidateIds.some(id => !id.trim())) {
    return refusal(
      'EXPLORATION_POPULATION_TOO_SMALL',
      'Exploration requires at least two distinct, non-empty candidate action ids.',
      'Pre-register two or more genuinely different actions; a one-action choice is operational observation.',
    );
  }
  const openedById = new Map(opened.alternatives.map(action => [action.actionId, action]));
  const unknown = candidateIds.filter(id => !openedById.has(id));
  if (unknown.length) {
    return refusal(
      'EXPLORATION_ACTION_UNKNOWN',
      `Policy names actions absent from the episode opening: ${unknown.join(', ')}.`,
      'Open a new episode with the changed feasible set; do not insert actions after registration.',
    );
  }
  const actions = candidateIds.map(id => openedById.get(id)!);
  const ineligible = actions.filter(action => action.feasibility.status !== 'feasible');
  if (ineligible.length) {
    return refusal(
      'EXPLORATION_ACTION_INELIGIBLE',
      `Experimental population contains non-feasible actions: ${ineligible.map(action => `${action.actionId}:${action.feasibility.status}`).join(', ')}.`,
      'Resolve missing safety evidence or register a policy population containing only feasible actions; never renormalize silently.',
    );
  }
  const defect = factorDefect(policy.factor, actions);
  if (defect) {
    return refusal(
      'EXPLORATION_FACTOR_CONFOUNDED',
      `Cannot identify ${policy.factor}: ${defect}.`,
      'Hold lane and non-experimental action dimensions constant, or pre-register a factorial design.',
    );
  }
  const openedAt = Date.parse(opened.recordedAt);
  const decidedAt = Date.parse(request.decidedAt);
  const recordedAt = Date.parse(request.recordedAt);
  if (![openedAt, decidedAt, recordedAt].every(Number.isFinite) ||
      decidedAt < openedAt || recordedAt < decidedAt) {
    return refusal(
      'EXPLORATION_TIME_INVALID',
      'Assignment must be decided after episode opening and recorded no earlier than it was decided.',
      'Preserve opening, decision, and recording clocks rather than repairing them into one timestamp.',
    );
  }

  const digest = createHash('sha256').update([
    DOMAIN,
    `${policy.policyId}@${policy.version}`,
    opened.episodeId,
    opened.context.stateSnapshotId,
    request.randomizationUnitId,
    request.randomizationSalt,
    ...candidateIds,
  ].join('|')).digest('hex');
  const draw = Number.parseInt(digest.slice(0, 13), 16) / TWO_POW_52;
  const selected = actions[Math.min(Math.floor(draw * actions.length), actions.length - 1)];
  const probability: DecisionMetric = Object.freeze({
    name: 'selection_probability',
    value: 1 / actions.length,
    unit: 'probability',
    attestation: attestationOf(
      'derived', 'high', 'disinterested',
      `Equal assignment across ${actions.length} pre-registered feasible actions under ${policy.policyId}@${policy.version}.`,
    ),
    evidenceIds: Object.freeze([...policy.evidenceIds, opened.eventId]),
  });
  const decision: DecisionRecordedEvent = {
    kind: 'decision_recorded',
    eventId: request.eventId,
    episodeId: opened.episodeId,
    selectedActionId: selected.actionId,
    decidedAt: request.decidedAt,
    recordedAt: request.recordedAt,
    selectionBasis: 'designed_exploration',
    policy: { policyId: policy.policyId, version: policy.version },
    assignmentProbability: probability,
    decidedBy: { kind: 'policy', id: `${policy.policyId}@${policy.version}` },
    rationale:
      `Pre-registered ${policy.factor} exploration using ${policy.algorithm}; ` +
      `salt commitment ${policy.randomizationSaltCommitment}; digest ${digest}.`,
    evidenceIds: [...policy.evidenceIds, opened.eventId],
  };
  return deepFreeze({
    kind: 'proposal' as const,
    decision,
    eligibleActionIds: candidateIds,
    randomization: {
      algorithm: policy.algorithm,
      unitId: request.randomizationUnitId,
      saltCommitment: policy.randomizationSaltCommitment,
      digest,
    },
    statement:
      `${opened.episodeId}: propose ${selected.actionId} at probability ${probability.value}; ` +
      'authorization and physical execution remain separate gates.',
  });
}
