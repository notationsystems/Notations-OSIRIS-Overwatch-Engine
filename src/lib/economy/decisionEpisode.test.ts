import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import {
  DecisionEpisodeLedger,
  type DecisionAlternative,
  type DecisionEpisodeEvent,
  type DecisionMetric,
  type DecisionRecordedEvent,
  type EpisodeOpenedEvent,
  type ExecutionStartedEvent,
  type OutcomeObservedEvent,
} from './decisionEpisode';

const t0 = '2026-09-01T12:00:00.000Z';
const t1 = '2026-09-01T12:05:00.000Z';
const t2 = '2026-09-01T13:00:00.000Z';
const t3 = '2026-09-02T18:00:00.000Z';
const t4 = '2026-09-02T18:10:00.000Z';

const metric = (
  name: DecisionMetric['name'], value: number, unit: DecisionMetric['unit'],
  evidenceId: string, currency?: string,
): DecisionMetric => ({
  name, value, unit, ...(currency ? { currency } : {}),
  attestation: attestationOf('derived', 'medium', 'unknown', `derived from ${evidenceId}`),
  evidenceIds: [evidenceId],
});

const alternative = (actionId: string, carrierId: string): DecisionAlternative => ({
  actionId, carrierId, laneId: 'lane:TOR-DET',
  departureWindow: { start: t2, end: '2026-09-01T14:00:00.000Z' },
  feasibility: { status: 'feasible', evidenceIds: [`vetting:${carrierId}`] },
  quotedCost: metric('quoted_cost', actionId === 'action:a' ? 145000 : 151000, 'money_minor', `quote:${actionId}`, 'CAD'),
  predictedOutcomes: [metric('predicted_transit_hours', actionId === 'action:a' ? 5.2 : 4.8, 'hours', `model:${actionId}`)],
});

const opened = (alternatives: readonly DecisionAlternative[] = [
  alternative('action:a', 'carrier:a'), alternative('action:b', 'carrier:b'),
]): EpisodeOpenedEvent => ({
  kind: 'episode_opened', eventId: 'event:open', episodeId: 'episode:1', recordedAt: t0,
  context: {
    opportunityId: 'opportunity:1', stateSnapshotId: 'snapshot:1', knowledgeCutoff: t0,
    evidenceIds: ['evidence:opportunity:1'], constraintIds: ['constraint:insurance'],
  },
  alternatives,
});

const decision = (overrides: Partial<DecisionRecordedEvent> = {}): DecisionRecordedEvent => ({
  kind: 'decision_recorded', eventId: 'event:decision', episodeId: 'episode:1',
  selectedActionId: 'action:a', decidedAt: t1, recordedAt: t1,
  selectionBasis: 'operator_judgment', policy: null, assignmentProbability: null,
  decidedBy: { kind: 'operator', id: 'operator:desk-1' },
  rationale: 'Capacity and service fit.', evidenceIds: ['decision:desk-1'],
  ...overrides,
});

const execution = (overrides: Partial<ExecutionStartedEvent> = {}): ExecutionStartedEvent => ({
  kind: 'execution_started', eventId: 'event:execution', episodeId: 'episode:1',
  actionId: 'action:a', loadId: 'load:1', startedAt: t2, recordedAt: t2,
  evidenceIds: ['dispatch:load:1'], ...overrides,
});

const outcome = (overrides: Partial<OutcomeObservedEvent> = {}): OutcomeObservedEvent => ({
  kind: 'outcome_observed', eventId: 'event:outcome', episodeId: 'episode:1',
  actionId: 'action:a', loadId: 'load:1', occurredAt: t3, knownAt: t4, recordedAt: t4,
  metrics: [
    metric('actual_transit_hours', 5.5, 'hours', 'telematics:load:1'),
    metric('actual_accessorial_cost', 12000, 'money_minor', 'invoice:load:1', 'CAD'),
  ],
  absences: [{
    metric: 'damage_cost', reason: 'not_observed', detail: 'Claim window remains open.',
    remedy: 'Re-evaluate after the claim window closes.', evidenceIds: ['claim-status:load:1'],
  }],
  evidenceIds: ['pod:load:1', 'invoice:load:1'], ...overrides,
});

function appendAll(ledger: DecisionEpisodeLedger, events: readonly DecisionEpisodeEvent[]): void {
  for (const event of events) {
    const result = ledger.append(event);
    if (result.kind !== 'appended') throw new Error(`${result.code}: ${result.detail}`);
  }
}

describe('decision episode ledger', () => {
  it('preserves the selected action and every alternative that was available', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened(), decision()]);
    const events = ledger.entries('episode:1').map(entry => entry.event);
    expect(events[0].kind).toBe('episode_opened');
    expect(events[0].kind === 'episode_opened' && events[0].alternatives.map(a => a.actionId))
      .toEqual(['action:a', 'action:b']);
    expect(events[1]).toMatchObject({ kind: 'decision_recorded', selectedActionId: 'action:a' });
  });

  it('refuses an action inserted after the feasible set was recorded', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened()]);
    const result = ledger.append(decision({ selectedActionId: 'action:invented' }));
    expect(result).toMatchObject({ kind: 'refusal', code: 'DECISION_ACTION_UNKNOWN' });
    expect(ledger.entries('episode:1')).toHaveLength(1);
  });

  it('requires an accountable override for an undetermined action and never permits a refused one', () => {
    const uncertain: DecisionAlternative = {
      ...alternative('action:u', 'carrier:u'),
      feasibility: {
        status: 'undetermined', reason: 'insurance evidence stale', remedy: 'refresh insurer confirmation',
        evidenceIds: ['vetting:carrier:u'],
      },
    };
    const refused: DecisionAlternative = {
      ...alternative('action:r', 'carrier:r'),
      feasibility: {
        status: 'refused', code: 'INSURANCE_LAPSED', reason: 'cover expired', remedy: 'obtain active cover',
        evidenceIds: ['vetting:carrier:r'],
      },
    };
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened([uncertain, refused])]);
    expect(ledger.append(decision({ selectedActionId: 'action:u' })))
      .toMatchObject({ kind: 'refusal', code: 'DECISION_OVERRIDE_REQUIRED' });
    expect(ledger.append(decision({
      selectedActionId: 'action:u',
      override: { approvedBy: 'risk:1', reason: 'binder confirmed by phone', evidenceIds: ['approval:1'] },
    })).kind).toBe('appended');

    const second = new DecisionEpisodeLedger();
    appendAll(second, [opened([uncertain, refused])]);
    expect(second.append(decision({
      selectedActionId: 'action:r',
      override: { approvedBy: 'risk:1', reason: 'take risk', evidenceIds: ['approval:2'] },
    }))).toMatchObject({ kind: 'refusal', code: 'DECISION_ACTION_REFUSED' });
  });

  it('binds execution and outcomes to the action that physically ran', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened(), decision()]);
    expect(ledger.append(execution({ actionId: 'action:b' })))
      .toMatchObject({ kind: 'refusal', code: 'DECISION_EXECUTION_INVALID' });
    appendAll(ledger, [execution()]);
    expect(ledger.append(outcome({ actionId: 'action:b' })))
      .toMatchObject({ kind: 'refusal', code: 'DECISION_OUTCOME_INVALID' });
    expect(ledger.append(outcome()).kind).toBe('appended');
  });

  it('keeps revised outcomes append-only and requires explicit supersession', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened(), decision(), execution(), outcome()]);
    const revised = outcome({
      eventId: 'event:outcome:revised',
      recordedAt: '2026-09-03T12:00:00.000Z', knownAt: '2026-09-03T11:55:00.000Z',
      metrics: [metric('actual_accessorial_cost', 18000, 'money_minor', 'invoice:revised', 'CAD')],
      absences: [], evidenceIds: ['invoice:revised'],
    });
    expect(ledger.append(revised))
      .toMatchObject({ kind: 'refusal', code: 'DECISION_SUPERSESSION_INVALID' });
    expect(ledger.append({ ...revised, supersedesEventId: 'event:outcome' }).kind).toBe('appended');
    const outcomes = ledger.entries('episode:1').filter(entry => entry.event.kind === 'outcome_observed');
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].event.eventId).toBe('event:outcome');
    expect(outcomes[1].event).toMatchObject({ supersedesEventId: 'event:outcome' });
  });

  it('calls a load controlled only when assignment design and propensity were recorded', () => {
    const ordinary = new DecisionEpisodeLedger();
    appendAll(ordinary, [opened(), decision()]);
    expect(ordinary.researchClass('episode:1')).toBe('policy_observation');

    const designed = new DecisionEpisodeLedger();
    appendAll(designed, [opened(), decision({
      selectionBasis: 'randomized_policy',
      policy: { policyId: 'carrier-exploration', version: '1.0.0' },
      assignmentProbability: metric('selection_probability', 0.5, 'probability', 'policy:carrier-exploration@1'),
      decidedBy: { kind: 'policy', id: 'carrier-exploration@1.0.0' },
    })]);
    expect(designed.researchClass('episode:1')).toBe('controlled_experiment');
  });

  it('refuses a designed assignment that omits propensity', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened()]);
    expect(ledger.append(decision({
      selectionBasis: 'designed_exploration',
      policy: { policyId: 'explore', version: '1' },
      assignmentProbability: null,
    }))).toMatchObject({ kind: 'refusal', code: 'DECISION_WARRANT_INVALID' });
  });

  it('refuses metric names paired with semantically wrong units', () => {
    const ledger = new DecisionEpisodeLedger();
    const bad = alternative('action:bad', 'carrier:bad');
    expect(ledger.append(opened([{
      ...bad,
      predictedOutcomes: [metric('predicted_transit_hours', 5, 'minutes', 'model:bad')],
    }]))).toMatchObject({ kind: 'refusal', code: 'DECISION_METRIC_INVALID' });
  });

  it('keeps policy identity and decider kind coherent with selection basis', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened()]);
    expect(ledger.append(decision({
      selectionBasis: 'deterministic_policy',
      policy: null,
      decidedBy: { kind: 'operator', id: 'operator:desk-1' },
    }))).toMatchObject({ kind: 'refusal', code: 'DECISION_WARRANT_INVALID' });
  });

  it('hash-chains the episode and seals appended events against mutation', () => {
    const ledger = new DecisionEpisodeLedger();
    const open = opened();
    appendAll(ledger, [open, decision(), execution(), outcome()]);
    expect(ledger.verify('episode:1')).toBe(true);
    expect(ledger.entries('episode:1')[1].previousHash)
      .toBe(ledger.entries('episode:1')[0].eventHash);
    expect(() => {
      (open.context as { stateSnapshotId: string }).stateSnapshotId = 'snapshot:tampered';
    }).toThrow();
  });

  it('keeps physical, knowledge, and recording time distinct', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened(), decision(), execution()]);
    expect(ledger.append(outcome({
      occurredAt: t3, knownAt: '2026-09-02T17:59:00.000Z', recordedAt: t4,
    }))).toMatchObject({ kind: 'refusal', code: 'DECISION_EVENT_ORDER_INVALID' });
  });

  it('does not let one outcome event both observe and disclaim the same metric', () => {
    const ledger = new DecisionEpisodeLedger();
    appendAll(ledger, [opened(), decision(), execution()]);
    expect(ledger.append(outcome({
      absences: [{
        metric: 'actual_transit_hours', reason: 'conflicting', detail: 'Two clocks disagree.',
        remedy: 'Reconcile the telematics records.', evidenceIds: ['conflict:load:1'],
      }],
    }))).toMatchObject({ kind: 'refusal', code: 'DECISION_OUTCOME_INVALID' });
  });
});
