import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import {
  DecisionEpisodeLedger,
  type DecisionAlternative,
  type DecisionEpisodeEvent,
  type DecisionMetric,
  type DecisionRecordedEvent,
  type OutcomeObservedEvent,
} from './decisionEpisode';
import { projectDecisionResearchCohort } from './decisionResearch';

const at = (minute: number): string => `2026-09-01T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00.000Z`;

const metric = (name: DecisionMetric['name'], value: number, unit: DecisionMetric['unit']): DecisionMetric => ({
  name, value, unit,
  ...(unit === 'money_minor' ? { currency: 'CAD' } : {}),
  attestation: attestationOf('reported', 'high', 'disinterested', `source:${name}`),
  evidenceIds: [`source:${name}`],
});

const alternative = (actionId: string, carrierId: string): DecisionAlternative => ({
  actionId, carrierId, laneId: 'lane:TOR-DET',
  departureWindow: { start: at(120), end: at(180) },
  feasibility: { status: 'feasible', evidenceIds: [`vetting:${carrierId}`] },
  quotedCost: metric('quoted_cost', 150000, 'money_minor'),
  predictedOutcomes: [metric('predicted_transit_hours', 5, 'hours')],
});

function episode(
  id: string,
  options: {
    decision?: Partial<DecisionRecordedEvent>;
    execute?: boolean;
    outcomes?: readonly OutcomeObservedEvent[];
  } = {},
): readonly DecisionEpisodeEvent[] {
  const actionA = alternative(`${id}:a`, `${id}:carrier:a`);
  const actionB = alternative(`${id}:b`, `${id}:carrier:b`);
  const decision: DecisionRecordedEvent = {
    kind: 'decision_recorded', eventId: `${id}:decision`, episodeId: id,
    selectedActionId: actionA.actionId, decidedAt: at(5), recordedAt: at(5),
    selectionBasis: 'operator_judgment', policy: null, assignmentProbability: null,
    decidedBy: { kind: 'operator', id: 'desk:1' }, rationale: 'service fit',
    evidenceIds: [`${id}:decision:evidence`], ...options.decision,
  };
  return [
    {
      kind: 'episode_opened', eventId: `${id}:open`, episodeId: id, recordedAt: at(0),
      context: {
        opportunityId: `${id}:opportunity`, stateSnapshotId: `${id}:snapshot`,
        knowledgeCutoff: at(0), evidenceIds: [`${id}:opportunity:evidence`], constraintIds: [],
      },
      alternatives: [actionA, actionB],
    },
    decision,
    ...(options.execute === false ? [] : [{
      kind: 'execution_started' as const, eventId: `${id}:execution`, episodeId: id,
      actionId: actionA.actionId, loadId: `${id}:load`, startedAt: at(120), recordedAt: at(120),
      evidenceIds: [`${id}:dispatch`],
    }]),
    ...(options.outcomes ?? []),
  ];
}

const outcome = (
  id: string,
  eventId: string,
  recordedMinute: number,
  values: readonly DecisionMetric[],
  absences: OutcomeObservedEvent['absences'] = [],
  supersedesEventId?: string,
): OutcomeObservedEvent => ({
  kind: 'outcome_observed', eventId, episodeId: id, actionId: `${id}:a`, loadId: `${id}:load`,
  occurredAt: at(180), knownAt: at(recordedMinute - 1), recordedAt: at(recordedMinute),
  metrics: values, absences, evidenceIds: [`${eventId}:evidence`],
  ...(supersedesEventId ? { supersedesEventId } : {}),
});

function ledgerOf(events: readonly DecisionEpisodeEvent[]): DecisionEpisodeLedger {
  const ledger = new DecisionEpisodeLedger();
  for (const event of events) {
    const result = ledger.append(event);
    if (result.kind === 'refusal') throw new Error(`${result.code}: ${result.detail}`);
  }
  return ledger;
}

describe('decision research cohort projection', () => {
  it('keeps unexecuted alternatives explicitly counterfactual and outcome-free', () => {
    const id = 'episode:observed';
    const ledger = ledgerOf(episode(id, {
      outcomes: [outcome(id, `${id}:outcome`, 240, [metric('actual_transit_hours', 5.4, 'hours')])],
    }));
    const result = projectDecisionResearchCohort(ledger, { asOf: at(300), metric: 'actual_transit_hours' });
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.cohort.rows[0]).toMatchObject({
      actionId: `${id}:a`, outcomeAvailability: 'observed',
      outcome: { value: 5.4 }, eligibleForCausalComparison: false,
    });
    expect(result.cohort.rows[0].counterfactuals).toEqual([{
      actionId: `${id}:b`, carrierId: `${id}:carrier:b`, laneId: 'lane:TOR-DET',
      feasibility: 'feasible', outcomeStatus: 'not_observed_by_design',
    }]);
  });

  it('projects the knowledge state as known then, without looking at later outcomes', () => {
    const id = 'episode:as-of';
    const ledger = ledgerOf(episode(id, {
      outcomes: [outcome(id, `${id}:outcome`, 300, [metric('actual_transit_hours', 6, 'hours')])],
    }));
    const before = projectDecisionResearchCohort(ledger, { asOf: at(299), metric: 'actual_transit_hours' });
    expect(before.kind === 'projected' && before.cohort.rows[0].outcomeAvailability)
      .toBe('no_outcome_event');
    expect(before.kind === 'projected' && before.cohort.coverage).toMatchObject({
      noOutcomeEventEpisodes: 1, unaccountedMetricEpisodes: 0,
    });
    const after = projectDecisionResearchCohort(ledger, { asOf: at(300), metric: 'actual_transit_hours' });
    expect(after.kind === 'projected' && after.cohort.rows[0].outcome?.value).toBe(6);
  });

  it('uses the latest event that speaks to the requested metric across partial revisions', () => {
    const id = 'episode:revision';
    const first = outcome(id, `${id}:outcome:1`, 240, [
      metric('actual_transit_hours', 5.5, 'hours'),
      metric('actual_accessorial_cost', 12000, 'money_minor'),
    ]);
    const revision = outcome(
      id, `${id}:outcome:2`, 300,
      [metric('actual_accessorial_cost', 18000, 'money_minor')], [], first.eventId,
    );
    const ledger = ledgerOf(episode(id, { outcomes: [first, revision] }));
    const result = projectDecisionResearchCohort(ledger, { asOf: at(360), metric: 'actual_transit_hours' });
    expect(result.kind === 'projected' && result.cohort.rows[0])
      .toMatchObject({ outcomeEventId: first.eventId, outcome: { value: 5.5 } });
  });

  it('distinguishes an explicit absence from a metric nobody accounted for', () => {
    const absentId = 'episode:absent';
    const unaccountedId = 'episode:unaccounted';
    const absent = outcome(absentId, `${absentId}:outcome`, 240, [], [{
      metric: 'damage_cost', reason: 'pending', detail: 'Claim window open.',
      remedy: 'Check after close.', evidenceIds: ['claim-window'],
    }]);
    const unaccounted = outcome(unaccountedId, `${unaccountedId}:outcome`, 240, [
      metric('actual_transit_hours', 5, 'hours'),
    ]);
    const ledger = ledgerOf([
      ...episode(absentId, { outcomes: [absent] }),
      ...episode(unaccountedId, { outcomes: [unaccounted] }),
    ]);
    const result = projectDecisionResearchCohort(ledger, { asOf: at(300), metric: 'damage_cost' });
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.cohort.rows.map(row => [row.episodeId, row.outcomeAvailability])).toEqual([
      [absentId, 'pending'], [unaccountedId, 'unaccounted'],
    ]);
    expect(result.cohort.coverage).toMatchObject({
      explicitlyAbsentMetricEpisodes: 1, unaccountedMetricEpisodes: 1, observedMetricEpisodes: 0,
    });
  });

  it('marks causal-comparison eligibility only for a designed assignment with an observed outcome', () => {
    const id = 'episode:experiment';
    const ledger = ledgerOf(episode(id, {
      decision: {
        selectionBasis: 'randomized_policy',
        policy: { policyId: 'explore-carriers', version: '1.0.0' },
        assignmentProbability: metric('selection_probability', 0.5, 'probability'),
        decidedBy: { kind: 'policy', id: 'explore-carriers@1.0.0' },
      },
      outcomes: [outcome(id, `${id}:outcome`, 240, [metric('actual_transit_hours', 5, 'hours')])],
    }));
    const result = projectDecisionResearchCohort(ledger, { asOf: at(300), metric: 'actual_transit_hours' });
    expect(result.kind === 'projected' && result.cohort.rows[0]).toMatchObject({
      researchClass: 'controlled_experiment', eligibleForCausalComparison: true,
      assignmentProbability: { value: 0.5 },
    });
  });

  it('reports incomplete episodes as exclusions instead of shrinking the population silently', () => {
    const id = 'episode:not-executed';
    const ledger = ledgerOf(episode(id, { execute: false }));
    const result = projectDecisionResearchCohort(ledger, { asOf: at(300), metric: 'actual_transit_hours' });
    expect(result.kind).toBe('projected');
    if (result.kind !== 'projected') return;
    expect(result.cohort.rows).toHaveLength(0);
    expect(result.cohort.exclusions).toEqual([expect.objectContaining({
      episodeId: id, reason: 'execution_missing',
    })]);
    expect(result.cohort.coverage).toMatchObject({ openedEpisodes: 1, decidedEpisodes: 1, executedEpisodes: 0 });
  });

  it('refuses an implicit or invalid knowledge boundary', () => {
    const result = projectDecisionResearchCohort(new DecisionEpisodeLedger(), {
      asOf: 'not-a-time', metric: 'actual_transit_hours',
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'DECISION_RESEARCH_AS_OF_INVALID' });
  });
});
