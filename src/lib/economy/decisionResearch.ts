/**
 * Research-safe projections over closed-loop freight decisions.
 *
 * This module does not estimate causal effects. It prepares the material an
 * estimator would need while preserving the most important negative fact:
 * only the action that physically ran has an observed outcome. Every other
 * candidate remains explicitly counterfactual.
 */

import { attestationOf, type Attestation } from './attestation';
import {
  DecisionEpisodeLedger,
  type DecisionAlternative,
  type DecisionLedgerEntry,
  type DecisionMetric,
  type DecisionRecordedEvent,
  type EpisodeOpenedEvent,
  type EpisodeResearchClass,
  type ExecutionStartedEvent,
  type OutcomeAbsenceReason,
  type OutcomeObservedEvent,
  type SelectionBasis,
} from './decisionEpisode';
import type { ISODateTime } from './types';

export type ResearchOutcomeMetricName =
  | 'actual_transit_hours'
  | 'actual_dwell_minutes'
  | 'actual_accessorial_cost'
  | 'carrier_invoice'
  | 'gross_margin'
  | 'damage_cost'
  | 'rejection_indicator';

export interface DecisionResearchQuery {
  readonly asOf: ISODateTime;
  readonly metric: ResearchOutcomeMetricName;
}

export type ResearchOutcomeAvailability =
  | 'observed'
  | OutcomeAbsenceReason
  | 'no_outcome_event'
  | 'unaccounted';

export interface ResearchCounterfactual {
  readonly actionId: string;
  readonly carrierId: string;
  readonly laneId: string;
  readonly feasibility: DecisionAlternative['feasibility']['status'];
  readonly outcomeStatus: 'not_observed_by_design';
}

export interface DecisionResearchRow {
  readonly episodeId: string;
  readonly opportunityId: string;
  readonly stateSnapshotId: string;
  readonly knowledgeCutoff: ISODateTime;
  readonly actionId: string;
  readonly loadId: string;
  readonly carrierId: string;
  readonly laneId: string;
  readonly selectionBasis: SelectionBasis;
  readonly policy: DecisionRecordedEvent['policy'];
  readonly assignmentProbability: DecisionMetric | null;
  readonly researchClass: EpisodeResearchClass;
  readonly eligibleForCausalComparison: boolean;
  readonly outcomeAvailability: ResearchOutcomeAvailability;
  readonly outcome: DecisionMetric | null;
  readonly outcomeEventId: string | null;
  readonly occurredAt: ISODateTime | null;
  readonly knownAt: ISODateTime | null;
  /** Alternatives are retained, but never populated with invented outcomes. */
  readonly counterfactuals: readonly ResearchCounterfactual[];
  readonly sourceEventIds: readonly string[];
}

export type DecisionResearchExclusionReason =
  | 'decision_missing'
  | 'execution_missing'
  | 'ledger_verification_failed';

export interface DecisionResearchExclusion {
  readonly episodeId: string;
  readonly reason: DecisionResearchExclusionReason;
  readonly detail: string;
  readonly remedy: string;
}

/** Counts describe Payload's own ledger population, not an external rate. */
export interface DecisionResearchCoverage {
  readonly openedEpisodes: number;
  readonly decidedEpisodes: number;
  readonly executedEpisodes: number;
  readonly episodesWithAnyOutcome: number;
  readonly noOutcomeEventEpisodes: number;
  readonly observedMetricEpisodes: number;
  readonly explicitlyAbsentMetricEpisodes: number;
  readonly unaccountedMetricEpisodes: number;
  readonly controlledExperimentEpisodes: number;
  readonly attestation: Attestation;
}

export interface DecisionResearchCohort {
  readonly query: DecisionResearchQuery;
  readonly rows: readonly DecisionResearchRow[];
  readonly exclusions: readonly DecisionResearchExclusion[];
  readonly coverage: DecisionResearchCoverage;
  readonly caveats: readonly string[];
}

export type DecisionResearchProjectionResult =
  | { readonly kind: 'projected'; readonly cohort: DecisionResearchCohort }
  | {
      readonly kind: 'refusal';
      readonly code: 'DECISION_RESEARCH_AS_OF_INVALID';
      readonly detail: string;
      readonly remedy: string;
    };

function latest<T extends DecisionLedgerEntry['event']['kind']>(
  entries: readonly DecisionLedgerEntry[],
  kind: T,
): Extract<DecisionLedgerEntry['event'], { kind: T }> | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.kind === kind) return event as Extract<DecisionLedgerEntry['event'], { kind: T }>;
  }
  return undefined;
}

function researchClass(
  opened: EpisodeOpenedEvent,
  decision: DecisionRecordedEvent,
): EpisodeResearchClass {
  if (opened.alternatives.length < 2) return 'operational_observation';
  if (decision.selectionBasis === 'randomized_policy' || decision.selectionBasis === 'designed_exploration') {
    return 'controlled_experiment';
  }
  return 'policy_observation';
}

function asKnownAt(
  entries: readonly DecisionLedgerEntry[],
  asOf: number,
): readonly DecisionLedgerEntry[] {
  return entries.filter(entry => Date.parse(entry.event.recordedAt) <= asOf);
}

function metricEvent(
  entries: readonly DecisionLedgerEntry[],
  metric: ResearchOutcomeMetricName,
): OutcomeObservedEvent | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.kind !== 'outcome_observed') continue;
    if (event.metrics.some(value => value.name === metric) ||
        event.absences.some(absence => absence.metric === metric)) return event;
  }
  return undefined;
}

function exclusion(
  episodeId: string,
  reason: DecisionResearchExclusionReason,
  detail: string,
  remedy: string,
): DecisionResearchExclusion {
  return Object.freeze({ episodeId, reason, detail, remedy });
}

function counterfactuals(
  opened: EpisodeOpenedEvent,
  execution: ExecutionStartedEvent,
): readonly ResearchCounterfactual[] {
  return Object.freeze(opened.alternatives
    .filter(alternative => alternative.actionId !== execution.actionId)
    .map(alternative => Object.freeze({
      actionId: alternative.actionId,
      carrierId: alternative.carrierId,
      laneId: alternative.laneId,
      feasibility: alternative.feasibility.status,
      outcomeStatus: 'not_observed_by_design' as const,
    })));
}

/**
 * Project the ledger exactly as it was knowable at `query.asOf`.
 * Late revisions remain invisible until their recordedAt, while an outcome's
 * occurredAt and knownAt remain available for lag and censoring analysis.
 */
export function projectDecisionResearchCohort(
  ledger: DecisionEpisodeLedger,
  query: DecisionResearchQuery,
): DecisionResearchProjectionResult {
  const asOf = Date.parse(query.asOf);
  if (!Number.isFinite(asOf)) {
    return Object.freeze({
      kind: 'refusal' as const,
      code: 'DECISION_RESEARCH_AS_OF_INVALID' as const,
      detail: `Research projection has invalid asOf ${query.asOf}.`,
      remedy: 'Supply an explicit ISO timestamp; the knowledge state is never defaulted.',
    });
  }

  const rows: DecisionResearchRow[] = [];
  const exclusions: DecisionResearchExclusion[] = [];
  let openedEpisodes = 0;
  let decidedEpisodes = 0;
  let executedEpisodes = 0;
  let episodesWithAnyOutcome = 0;
  let noOutcomeEventEpisodes = 0;
  let observedMetricEpisodes = 0;
  let explicitlyAbsentMetricEpisodes = 0;
  let unaccountedMetricEpisodes = 0;
  let controlledExperimentEpisodes = 0;

  for (const episodeId of ledger.episodeIds()) {
    const complete = ledger.entries(episodeId);
    const entries = asKnownAt(complete, asOf);
    const opened = latest(entries, 'episode_opened');
    if (!opened) continue;
    openedEpisodes += 1;
    if (!ledger.verify(episodeId)) {
      exclusions.push(exclusion(
        episodeId,
        'ledger_verification_failed',
        'The episode hash chain does not verify.',
        'Repair storage from a trusted append-only replica before using this episode for research.',
      ));
      continue;
    }
    const decision = latest(entries, 'decision_recorded');
    if (!decision) {
      exclusions.push(exclusion(
        episodeId, 'decision_missing', 'No decision was knowable at the evaluation time.',
        'Wait for or append the selected action; do not infer it from the later load.',
      ));
      continue;
    }
    decidedEpisodes += 1;
    const execution = latest(entries, 'execution_started');
    if (!execution) {
      exclusions.push(exclusion(
        episodeId, 'execution_missing', 'The selected action has no recorded physical execution.',
        'Attach dispatch evidence or leave the episode outside observed-outcome analysis.',
      ));
      continue;
    }
    executedEpisodes += 1;
    const anyOutcome = latest(entries, 'outcome_observed');
    if (anyOutcome) episodesWithAnyOutcome += 1;
    else noOutcomeEventEpisodes += 1;
    const relevantOutcome = metricEvent(entries, query.metric);
    const observed = relevantOutcome?.metrics.find(metric => metric.name === query.metric) ?? null;
    const absence = relevantOutcome?.absences.find(candidate => candidate.metric === query.metric);
    const availability: ResearchOutcomeAvailability = observed
      ? 'observed'
      : absence?.reason ?? (anyOutcome ? 'unaccounted' : 'no_outcome_event');
    if (observed) observedMetricEpisodes += 1;
    else if (absence) explicitlyAbsentMetricEpisodes += 1;
    else if (anyOutcome) unaccountedMetricEpisodes += 1;

    const action = opened.alternatives.find(alternative => alternative.actionId === execution.actionId)!;
    const classification = researchClass(opened, decision);
    if (classification === 'controlled_experiment') controlledExperimentEpisodes += 1;
    rows.push(Object.freeze({
      episodeId,
      opportunityId: opened.context.opportunityId,
      stateSnapshotId: opened.context.stateSnapshotId,
      knowledgeCutoff: opened.context.knowledgeCutoff,
      actionId: execution.actionId,
      loadId: execution.loadId,
      carrierId: action.carrierId,
      laneId: action.laneId,
      selectionBasis: decision.selectionBasis,
      policy: decision.policy,
      assignmentProbability: decision.assignmentProbability,
      researchClass: classification,
      eligibleForCausalComparison: classification === 'controlled_experiment' && observed !== null,
      outcomeAvailability: availability,
      outcome: observed,
      outcomeEventId: relevantOutcome?.eventId ?? null,
      occurredAt: relevantOutcome?.occurredAt ?? null,
      knownAt: relevantOutcome?.knownAt ?? null,
      counterfactuals: counterfactuals(opened, execution),
      sourceEventIds: Object.freeze([
        opened.eventId, decision.eventId, execution.eventId,
        ...(relevantOutcome ? [relevantOutcome.eventId] : []),
      ]),
    }));
  }

  const coverage = Object.freeze({
    openedEpisodes,
    decidedEpisodes,
    executedEpisodes,
    episodesWithAnyOutcome,
    noOutcomeEventEpisodes,
    observedMetricEpisodes,
    explicitlyAbsentMetricEpisodes,
    unaccountedMetricEpisodes,
    controlledExperimentEpisodes,
    attestation: attestationOf(
      'derived', 'high', 'disinterested',
      `Exact counts over Payload's verified append-only decision ledger as of ${query.asOf}.`,
    ),
  });
  return Object.freeze({
    kind: 'projected' as const,
    cohort: Object.freeze({
      query: Object.freeze({ ...query }),
      rows: Object.freeze(rows),
      exclusions: Object.freeze(exclusions),
      coverage,
      caveats: Object.freeze([
        'Only executed actions carry observed outcomes; all unexecuted alternatives remain counterfactual.',
        'Controlled-experiment classification records assignment design and propensity, not a treatment-effect estimate.',
        'Coverage is reported before comparison so missing outcomes cannot silently disappear from the denominator.',
        'The as-of boundary uses recordedAt; late evidence and revisions are invisible before Payload knew them.',
      ]),
    }),
  });
}
