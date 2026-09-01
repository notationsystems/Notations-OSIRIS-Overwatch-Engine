/**
 * Payload Terminal — closed-loop decision episodes.
 *
 * A load becomes useful system-identification material only when the decision
 * context survives: what Payload knew, which actions were feasible, which one
 * was selected, how it was assigned, and what the physical system returned.
 * This ledger preserves that sequence append-only. It does not choose actions,
 * dispatch loads, or fabricate outcomes for alternatives that were not run.
 */

import { createHash } from 'crypto';
import type { Attestation } from './attestation';
import type { Hash, ISODateTime } from './types';

export type DecisionMetricName =
  | 'quoted_cost'
  | 'selection_probability'
  | 'predicted_transit_hours'
  | 'predicted_dwell_minutes'
  | 'predicted_accessorial_cost'
  | 'actual_transit_hours'
  | 'actual_dwell_minutes'
  | 'actual_accessorial_cost'
  | 'carrier_invoice'
  | 'gross_margin'
  | 'damage_cost'
  | 'rejection_indicator';

export type DecisionMetricUnit =
  | 'money_minor'
  | 'hours'
  | 'minutes'
  | 'probability'
  | 'binary';

/** A number cannot enter the decision record without its evidential standing. */
export interface DecisionMetric {
  readonly name: DecisionMetricName;
  readonly value: number;
  readonly unit: DecisionMetricUnit;
  /** Required when unit is money_minor; absent on non-money measures. */
  readonly currency?: string;
  /** Optional prediction/measurement interval. Both ends or neither. */
  readonly low?: number;
  readonly high?: number;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
}

export type AlternativeFeasibility =
  | { readonly status: 'feasible'; readonly evidenceIds: readonly string[] }
  | {
      readonly status: 'undetermined';
      readonly reason: string;
      readonly remedy: string;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly status: 'refused';
      readonly code: string;
      readonly reason: string;
      readonly remedy: string;
      readonly evidenceIds: readonly string[];
    };

export interface DecisionAlternative {
  readonly actionId: string;
  readonly carrierId: string;
  readonly laneId: string;
  readonly departureWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly feasibility: AlternativeFeasibility;
  readonly quotedCost: DecisionMetric | null;
  readonly predictedOutcomes: readonly DecisionMetric[];
}

export interface DecisionContext {
  readonly opportunityId: string;
  readonly stateSnapshotId: string;
  /** Latest knowledge permitted to influence the decision. */
  readonly knowledgeCutoff: ISODateTime;
  readonly evidenceIds: readonly string[];
  readonly constraintIds: readonly string[];
}

export interface EpisodeOpenedEvent {
  readonly kind: 'episode_opened';
  readonly eventId: string;
  readonly episodeId: string;
  readonly recordedAt: ISODateTime;
  readonly context: DecisionContext;
  /** Feasible set as it existed before selection, including refusals. */
  readonly alternatives: readonly DecisionAlternative[];
}

export type SelectionBasis =
  | 'operator_judgment'
  | 'deterministic_policy'
  | 'randomized_policy'
  | 'designed_exploration';

export interface DecisionRecordedEvent {
  readonly kind: 'decision_recorded';
  readonly eventId: string;
  readonly episodeId: string;
  readonly selectedActionId: string;
  readonly decidedAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly selectionBasis: SelectionBasis;
  readonly policy: { readonly policyId: string; readonly version: string } | null;
  /** Required for randomized/designed assignments so evaluation can reweight. */
  readonly assignmentProbability: DecisionMetric | null;
  readonly decidedBy: { readonly kind: 'operator' | 'policy'; readonly id: string };
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
  /** Required when a pre-execution decision is retaken. */
  readonly supersedesEventId?: string;
  /** Required to select an undetermined action; refused actions stay refused. */
  readonly override?: {
    readonly approvedBy: string;
    readonly reason: string;
    readonly evidenceIds: readonly string[];
  };
}

export interface ExecutionStartedEvent {
  readonly kind: 'execution_started';
  readonly eventId: string;
  readonly episodeId: string;
  readonly actionId: string;
  readonly loadId: string;
  readonly startedAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export type OutcomeAbsenceReason =
  | 'pending'
  | 'not_observed'
  | 'not_applicable'
  | 'conflicting';

export interface OutcomeAbsence {
  readonly metric: DecisionMetricName;
  readonly reason: OutcomeAbsenceReason;
  readonly detail: string;
  readonly remedy: string;
  readonly evidenceIds: readonly string[];
}

export interface OutcomeObservedEvent {
  readonly kind: 'outcome_observed';
  readonly eventId: string;
  readonly episodeId: string;
  readonly actionId: string;
  readonly loadId: string;
  /** When the physical outcome occurred. */
  readonly occurredAt: ISODateTime;
  /** When the outcome became knowable to Payload. */
  readonly knownAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly metrics: readonly DecisionMetric[];
  readonly absences: readonly OutcomeAbsence[];
  readonly evidenceIds: readonly string[];
  /** Revisions append and name the immediately prior outcome event. */
  readonly supersedesEventId?: string;
}

export type DecisionEpisodeEvent =
  | EpisodeOpenedEvent
  | DecisionRecordedEvent
  | ExecutionStartedEvent
  | OutcomeObservedEvent;

export interface DecisionLedgerEntry {
  readonly event: DecisionEpisodeEvent;
  readonly previousHash: Hash | null;
  readonly eventHash: Hash;
}

export type DecisionLedgerRefusalCode =
  | 'DECISION_EPISODE_DUPLICATE'
  | 'DECISION_EVENT_DUPLICATE'
  | 'DECISION_EPISODE_NOT_OPEN'
  | 'DECISION_EVENT_ORDER_INVALID'
  | 'DECISION_WARRANT_INVALID'
  | 'DECISION_METRIC_INVALID'
  | 'DECISION_ACTION_UNKNOWN'
  | 'DECISION_ACTION_REFUSED'
  | 'DECISION_OVERRIDE_REQUIRED'
  | 'DECISION_SUPERSESSION_INVALID'
  | 'DECISION_EXECUTION_INVALID'
  | 'DECISION_OUTCOME_INVALID';

export interface DecisionLedgerRefusal {
  readonly kind: 'refusal';
  readonly code: DecisionLedgerRefusalCode;
  readonly detail: string;
  readonly remedy: string;
}

export type DecisionAppendResult =
  | { readonly kind: 'appended'; readonly entry: DecisionLedgerEntry }
  | DecisionLedgerRefusal;

export type EpisodeResearchClass =
  | 'operational_observation'
  | 'policy_observation'
  | 'controlled_experiment';

const HASH_DOMAIN = 'payload.decision_episode.v1';

function refusal(
  code: DecisionLedgerRefusalCode,
  detail: string,
  remedy: string,
): DecisionLedgerRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function time(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nonEmpty(ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every(id => id.trim().length > 0);
}

function metricDefect(metric: DecisionMetric): string | null {
  if (!Number.isFinite(metric.value)) return `${metric.name} is not finite`;
  if (metric.attestation.inputCount < 1) return `${metric.name} has a vacuous attestation`;
  if (!nonEmpty(metric.evidenceIds)) return `${metric.name} cites no evidence`;
  if (metric.unit === 'money_minor' && !metric.currency) return `${metric.name} is money without a currency`;
  if (metric.unit !== 'money_minor' && metric.currency !== undefined) return `${metric.name} carries a currency but is not money`;
  if ((metric.low === undefined) !== (metric.high === undefined)) return `${metric.name} carries only one interval bound`;
  if (metric.low !== undefined && metric.high !== undefined) {
    if (!Number.isFinite(metric.low) || !Number.isFinite(metric.high)) return `${metric.name} interval is not finite`;
    if (metric.low > metric.value || metric.value > metric.high) return `${metric.name} point lies outside its interval`;
  }
  if (metric.unit === 'probability' && (metric.value <= 0 || metric.value > 1)) {
    return `${metric.name} probability is outside (0, 1]`;
  }
  if (metric.unit === 'binary' && metric.value !== 0 && metric.value !== 1) {
    return `${metric.name} binary value is not 0 or 1`;
  }
  return null;
}

function stable(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, stable(child)]),
  );
}

function eventHash(event: DecisionEpisodeEvent, previousHash: Hash | null): Hash {
  return createHash('sha256')
    .update(`${HASH_DOMAIN}|${previousHash ?? 'GENESIS'}|${JSON.stringify(stable(event))}`)
    .digest('hex');
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

function metricsDefect(metrics: readonly DecisionMetric[]): string | null {
  const names = new Set<DecisionMetricName>();
  for (const metric of metrics) {
    const defect = metricDefect(metric);
    if (defect) return defect;
    if (names.has(metric.name)) return `${metric.name} appears more than once in one record`;
    names.add(metric.name);
  }
  return null;
}

function openingDefect(event: EpisodeOpenedEvent): DecisionLedgerRefusal | null {
  const recorded = time(event.recordedAt);
  const cutoff = time(event.context.knowledgeCutoff);
  if (recorded === null || cutoff === null || cutoff > recorded) {
    return refusal(
      'DECISION_EVENT_ORDER_INVALID',
      `Episode ${event.episodeId} has an invalid or future knowledge cutoff.`,
      'Record a valid knowledge cutoff no later than the episode opening.',
    );
  }
  if (!event.context.opportunityId || !event.context.stateSnapshotId || !nonEmpty(event.context.evidenceIds)) {
    return refusal(
      'DECISION_WARRANT_INVALID',
      `Episode ${event.episodeId} lacks opportunity, state snapshot, or evidence identity.`,
      'Open the episode from a preserved state snapshot and evidence set.',
    );
  }
  if (event.alternatives.length === 0) {
    return refusal(
      'DECISION_ACTION_UNKNOWN',
      `Episode ${event.episodeId} has no candidate actions.`,
      'Record the feasible set, including refused and undetermined alternatives, before selection.',
    );
  }
  const actionIds = new Set<string>();
  for (const alternative of event.alternatives) {
    if (!alternative.actionId || actionIds.has(alternative.actionId)) {
      return refusal(
        'DECISION_ACTION_UNKNOWN',
        `Episode ${event.episodeId} has an empty or duplicate action id ${alternative.actionId || '(empty)'}.`,
        'Assign one stable identity to every candidate action.',
      );
    }
    actionIds.add(alternative.actionId);
    const start = time(alternative.departureWindow.start);
    const end = time(alternative.departureWindow.end);
    if (start === null || end === null || start > end) {
      return refusal(
        'DECISION_EVENT_ORDER_INVALID',
        `Action ${alternative.actionId} has an invalid departure window.`,
        'Preserve a valid start/end window; do not collapse it into an invented instant.',
      );
    }
    if (!nonEmpty(alternative.feasibility.evidenceIds)) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Action ${alternative.actionId} feasibility cites no evidence.`,
        'Attach the records that established feasibility, refusal, or uncertainty.',
      );
    }
    const defect = metricsDefect([
      ...(alternative.quotedCost ? [alternative.quotedCost] : []),
      ...alternative.predictedOutcomes,
    ]);
    if (defect) {
      return refusal(
        'DECISION_METRIC_INVALID',
        `Action ${alternative.actionId}: ${defect}.`,
        'Correct the metric while preserving its source evidence and attestation.',
      );
    }
  }
  return null;
}

function latest<T extends DecisionEpisodeEvent['kind']>(
  entries: readonly DecisionLedgerEntry[],
  kind: T,
): Extract<DecisionEpisodeEvent, { kind: T }> | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.kind === kind) return event as Extract<DecisionEpisodeEvent, { kind: T }>;
  }
  return undefined;
}

/**
 * Pure in-process ledger. Persistence may store the returned entries, but may
 * not replace them: corrections append with explicit supersession.
 */
export class DecisionEpisodeLedger {
  private readonly episodes = new Map<string, DecisionLedgerEntry[]>();
  private readonly eventIds = new Set<string>();

  append(event: DecisionEpisodeEvent): DecisionAppendResult {
    if (!event.eventId || this.eventIds.has(event.eventId)) {
      return refusal(
        'DECISION_EVENT_DUPLICATE',
        `Decision event id ${event.eventId || '(empty)'} is empty or already registered.`,
        'Reuse an existing event only by reference; a new fact needs a new event id.',
      );
    }

    if (event.kind === 'episode_opened') return this.open(event);
    const entries = this.episodes.get(event.episodeId);
    if (!entries) {
      return refusal(
        'DECISION_EPISODE_NOT_OPEN',
        `Episode ${event.episodeId} has not been opened.`,
        'Append episode_opened with the state snapshot and candidate set first.',
      );
    }
    const priorRecorded = time(entries[entries.length - 1].event.recordedAt);
    const recorded = time(event.recordedAt);
    if (recorded === null || priorRecorded === null || recorded < priorRecorded) {
      return refusal(
        'DECISION_EVENT_ORDER_INVALID',
        `Event ${event.eventId} is recorded before the episode's current ledger tail.`,
        'Append in knowledge order; late-arriving evidence may have an earlier occurredAt, not an earlier recordedAt.',
      );
    }

    const defect = event.kind === 'decision_recorded'
      ? this.decisionDefect(entries, event)
      : event.kind === 'execution_started'
        ? this.executionDefect(entries, event)
        : this.outcomeDefect(entries, event);
    if (defect) return defect;
    return this.commit(entries, event);
  }

  entries(episodeId: string): readonly DecisionLedgerEntry[] {
    return Object.freeze([...(this.episodes.get(episodeId) ?? [])]);
  }

  researchClass(episodeId: string): EpisodeResearchClass {
    const entries = this.episodes.get(episodeId) ?? [];
    const opened = latest(entries, 'episode_opened');
    const decision = latest(entries, 'decision_recorded');
    if (!opened || !decision || opened.alternatives.length < 2) return 'operational_observation';
    if (decision.selectionBasis === 'randomized_policy' || decision.selectionBasis === 'designed_exploration') {
      return 'controlled_experiment';
    }
    return 'policy_observation';
  }

  verify(episodeId: string): boolean {
    const entries = this.episodes.get(episodeId) ?? [];
    let previous: Hash | null = null;
    for (const entry of entries) {
      if (entry.previousHash !== previous) return false;
      if (entry.eventHash !== eventHash(entry.event, previous)) return false;
      previous = entry.eventHash;
    }
    return entries.length > 0;
  }

  private open(event: EpisodeOpenedEvent): DecisionAppendResult {
    if (this.episodes.has(event.episodeId)) {
      return refusal(
        'DECISION_EPISODE_DUPLICATE',
        `Episode ${event.episodeId} is already open.`,
        'Append a new event to the existing episode; do not replace its opening state.',
      );
    }
    const defect = openingDefect(event);
    if (defect) return defect;
    const entries: DecisionLedgerEntry[] = [];
    this.episodes.set(event.episodeId, entries);
    return this.commit(entries, event);
  }

  private decisionDefect(
    entries: readonly DecisionLedgerEntry[],
    event: DecisionRecordedEvent,
  ): DecisionLedgerRefusal | null {
    const opened = latest(entries, 'episode_opened')!;
    const prior = latest(entries, 'decision_recorded');
    const execution = latest(entries, 'execution_started');
    if (execution) {
      return refusal(
        'DECISION_SUPERSESSION_INVALID',
        `Episode ${event.episodeId} already executed load ${execution.loadId}.`,
        'A post-execution alternative is a new decision episode, not a rewrite of the action that ran.',
      );
    }
    if ((prior && event.supersedesEventId !== prior.eventId) || (!prior && event.supersedesEventId !== undefined)) {
      return refusal(
        'DECISION_SUPERSESSION_INVALID',
        `Decision ${event.eventId} does not explicitly supersede the current decision.`,
        prior
          ? `Set supersedesEventId to ${prior.eventId}; both decisions will remain in the ledger.`
          : 'Remove supersedesEventId from the episode\'s first decision.',
      );
    }
    const action = opened.alternatives.find(alternative => alternative.actionId === event.selectedActionId);
    if (!action) {
      return refusal(
        'DECISION_ACTION_UNKNOWN',
        `Decision ${event.eventId} selects ${event.selectedActionId}, which was not in the recorded feasible set.`,
        'Open a new episode if the feasible set changed; do not insert an action after seeing the outcome.',
      );
    }
    if (action.feasibility.status === 'refused') {
      return refusal(
        'DECISION_ACTION_REFUSED',
        `Action ${action.actionId} was refused by ${action.feasibility.code}.`,
        action.feasibility.remedy,
      );
    }
    if (action.feasibility.status === 'undetermined' && !event.override) {
      return refusal(
        'DECISION_OVERRIDE_REQUIRED',
        `Action ${action.actionId} has undetermined feasibility.`,
        'Record an accountable operator override with its evidence, or resolve the missing condition.',
      );
    }
    if (event.override && !nonEmpty(event.override.evidenceIds)) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Decision ${event.eventId} override cites no evidence.`,
        'Attach the approval or resolution record behind the override.',
      );
    }
    const decided = time(event.decidedAt);
    const recorded = time(event.recordedAt);
    const openedAt = time(opened.recordedAt);
    if (decided === null || recorded === null || openedAt === null || decided < openedAt || decided > recorded) {
      return refusal(
        'DECISION_EVENT_ORDER_INVALID',
        `Decision ${event.eventId} has an invalid decision/recording order.`,
        'The decision must occur after the episode opens and no later than it is recorded.',
      );
    }
    if (!nonEmpty(event.evidenceIds)) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Decision ${event.eventId} cites no evidence.`,
        'Attach the policy output, operator record, or approval that made the selection.',
      );
    }
    const designed = event.selectionBasis === 'randomized_policy' || event.selectionBasis === 'designed_exploration';
    if (designed) {
      if (!event.policy || !event.assignmentProbability) {
        return refusal(
          'DECISION_WARRANT_INVALID',
          `Designed assignment ${event.eventId} lacks policy identity or selection probability.`,
          'Record the assignment policy version and propensity used at decision time.',
        );
      }
      if (event.assignmentProbability.name !== 'selection_probability' || event.assignmentProbability.unit !== 'probability') {
        return refusal(
          'DECISION_METRIC_INVALID',
          `Decision ${event.eventId} assignmentProbability is not a selection_probability metric.`,
          'Record propensity as a probability metric with its policy evidence.',
        );
      }
    }
    if (!designed && event.assignmentProbability !== null) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Decision ${event.eventId} records a propensity for a non-designed assignment.`,
        'Use randomized_policy/designed_exploration, or remove the propensity rather than implying randomization.',
      );
    }
    if (event.assignmentProbability) {
      const defect = metricDefect(event.assignmentProbability);
      if (defect) {
        return refusal(
          'DECISION_METRIC_INVALID',
          `Decision ${event.eventId}: ${defect}.`,
          'Correct the recorded propensity without changing the selection that occurred.',
        );
      }
    }
    return null;
  }

  private executionDefect(
    entries: readonly DecisionLedgerEntry[],
    event: ExecutionStartedEvent,
  ): DecisionLedgerRefusal | null {
    const decision = latest(entries, 'decision_recorded');
    if (!decision) {
      return refusal(
        'DECISION_EXECUTION_INVALID',
        `Execution ${event.eventId} has no recorded decision.`,
        'Record the selected action and its decision context before execution.',
      );
    }
    if (latest(entries, 'execution_started')) {
      return refusal(
        'DECISION_EXECUTION_INVALID',
        `Episode ${event.episodeId} already has an execution.`,
        'A second physical intervention is a new episode linked to the first, not a replacement.',
      );
    }
    if (event.actionId !== decision.selectedActionId) {
      return refusal(
        'DECISION_EXECUTION_INVALID',
        `Execution ${event.eventId} runs ${event.actionId}, not selected action ${decision.selectedActionId}.`,
        'Record a pre-execution superseding decision, or open a new episode for the intervention that actually ran.',
      );
    }
    const started = time(event.startedAt);
    const decided = time(decision.decidedAt);
    const recorded = time(event.recordedAt);
    if (started === null || decided === null || recorded === null || started < decided || started > recorded) {
      return refusal(
        'DECISION_EVENT_ORDER_INVALID',
        `Execution ${event.eventId} has an invalid decision/start/recording order.`,
        'Execution must start after selection and no later than it is recorded.',
      );
    }
    if (!event.loadId || !nonEmpty(event.evidenceIds)) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Execution ${event.eventId} lacks load identity or evidence.`,
        'Attach the tender, dispatch, or load-book event that proves the intervention occurred.',
      );
    }
    return null;
  }

  private outcomeDefect(
    entries: readonly DecisionLedgerEntry[],
    event: OutcomeObservedEvent,
  ): DecisionLedgerRefusal | null {
    const execution = latest(entries, 'execution_started');
    if (!execution) {
      return refusal(
        'DECISION_OUTCOME_INVALID',
        `Outcome ${event.eventId} has no executed intervention.`,
        'Do not attach an observed outcome to an action that was never run.',
      );
    }
    if (event.actionId !== execution.actionId || event.loadId !== execution.loadId) {
      return refusal(
        'DECISION_OUTCOME_INVALID',
        `Outcome ${event.eventId} does not identify executed load ${execution.loadId}/${execution.actionId}.`,
        'Attach the outcome to the intervention that physically occurred; alternatives remain counterfactual.',
      );
    }
    const occurred = time(event.occurredAt);
    const known = time(event.knownAt);
    const recorded = time(event.recordedAt);
    const started = time(execution.startedAt);
    if (occurred === null || known === null || recorded === null || started === null ||
        occurred < started || known < occurred || recorded < known) {
      return refusal(
        'DECISION_EVENT_ORDER_INVALID',
        `Outcome ${event.eventId} violates startedAt ≤ occurredAt ≤ knownAt ≤ recordedAt.`,
        'Preserve the physical, knowledge, and recording clocks separately; do not repair them into one timestamp.',
      );
    }
    if (event.metrics.length === 0 && event.absences.length === 0) {
      return refusal(
        'DECISION_OUTCOME_INVALID',
        `Outcome ${event.eventId} contains neither measurements nor typed absences.`,
        'Record what was observed and explicitly name every outcome that remains unavailable.',
      );
    }
    const defect = metricsDefect(event.metrics);
    if (defect) {
      return refusal(
        'DECISION_METRIC_INVALID',
        `Outcome ${event.eventId}: ${defect}.`,
        'Correct the outcome metric while preserving its evidence and attestation.',
      );
    }
    if (!nonEmpty(event.evidenceIds) || event.absences.some(absence => !nonEmpty(absence.evidenceIds))) {
      return refusal(
        'DECISION_WARRANT_INVALID',
        `Outcome ${event.eventId} or one of its absences cites no evidence.`,
        'Attach source records to measurements and to claims that a measurement is unavailable.',
      );
    }
    const prior = latest(entries, 'outcome_observed');
    if ((prior && event.supersedesEventId !== prior.eventId) || (!prior && event.supersedesEventId !== undefined)) {
      return refusal(
        'DECISION_SUPERSESSION_INVALID',
        `Outcome ${event.eventId} does not explicitly supersede the current outcome.`,
        prior
          ? `Set supersedesEventId to ${prior.eventId}; the earlier outcome will remain readable.`
          : 'Remove supersedesEventId from the first outcome.',
      );
    }
    return null;
  }

  private commit(entries: DecisionLedgerEntry[], event: DecisionEpisodeEvent): DecisionAppendResult {
    deepFreeze(event);
    const previousHash = entries.length ? entries[entries.length - 1].eventHash : null;
    const entry = Object.freeze({ event, previousHash, eventHash: eventHash(event, previousHash) });
    entries.push(entry);
    this.eventIds.add(event.eventId);
    return { kind: 'appended', entry };
  }
}
