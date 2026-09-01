import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import {
  DecisionEpisodeLedger,
  type DecisionAlternative,
  type DecisionMetric,
  type EpisodeOpenedEvent,
} from './decisionEpisode';
import {
  commitExplorationSalt,
  proposeExplorationAssignment,
  type ExplorationAssignmentPolicy,
  type ExplorationAssignmentRequest,
} from './explorationAssignment';

const openedAt = '2026-09-01T12:00:00.000Z';
const decidedAt = '2026-09-01T12:05:00.000Z';
// Public test vector only. Production openings must come from secret storage.
const randomizationSalt = 'PUBLIC-TEST-VECTOR-NOT-A-SECRET';

const quoted = (id: string): DecisionMetric => ({
  name: 'quoted_cost', value: 150000, unit: 'money_minor', currency: 'CAD',
  attestation: attestationOf('reported', 'medium', 'negotiating_position', `quote:${id}`),
  evidenceIds: [`quote:${id}`],
});

const action = (
  id: string,
  carrierId: string,
  windowStart = '2026-09-01T14:00:00.000Z',
  windowEnd = '2026-09-01T15:00:00.000Z',
): DecisionAlternative => ({
  actionId: id, carrierId, laneId: 'lane:TOR-DET',
  departureWindow: { start: windowStart, end: windowEnd },
  feasibility: { status: 'feasible', evidenceIds: [`vetting:${carrierId}`] },
  quotedCost: quoted(id), predictedOutcomes: [],
});

const opening = (alternatives: readonly DecisionAlternative[]): EpisodeOpenedEvent => ({
  kind: 'episode_opened', eventId: 'event:open', episodeId: 'episode:explore', recordedAt: openedAt,
  context: {
    opportunityId: 'opportunity:1', stateSnapshotId: 'snapshot:1', knowledgeCutoff: openedAt,
    evidenceIds: ['opportunity:evidence'], constraintIds: ['constraint:insurance'],
  },
  alternatives,
});

const policy = (candidateActionIds: readonly string[], factor: ExplorationAssignmentPolicy['factor'] = 'carrier'):
ExplorationAssignmentPolicy => ({
  policyId: 'carrier-exploration', version: '1.0.0', factor,
  algorithm: 'sha256_equal_cdf_v1',
  randomizationSaltCommitment: commitExplorationSalt(randomizationSalt),
  candidateActionIds,
  evidenceIds: ['policy:carrier-exploration@1.0.0'],
});

const request = (
  opened: EpisodeOpenedEvent,
  candidateActionIds: readonly string[],
  overrides: Partial<ExplorationAssignmentRequest> = {},
): ExplorationAssignmentRequest => ({
  opened,
  policy: policy(candidateActionIds),
  randomizationUnitId: 'opportunity:1',
  randomizationSalt,
  eventId: 'event:decision',
  decidedAt,
  recordedAt: decidedAt,
  ...overrides,
});

describe('exploration assignment proposals', () => {
  it('is reproducible and invariant to candidate list order', () => {
    const opened = opening([action('action:a', 'carrier:a'), action('action:b', 'carrier:b')]);
    const first = proposeExplorationAssignment(request(opened, ['action:b', 'action:a']));
    const second = proposeExplorationAssignment(request(opened, ['action:a', 'action:b']));
    expect(first.kind).toBe('proposal');
    expect(second.kind).toBe('proposal');
    if (first.kind !== 'proposal' || second.kind !== 'proposal') return;
    expect(first.decision.selectedActionId).toBe(second.decision.selectedActionId);
    expect(first.randomization.digest).toBe(second.randomization.digest);
    expect(first.eligibleActionIds).toEqual(['action:a', 'action:b']);
  });

  it('records exact propensity and produces a ledger-valid decision without executing it', () => {
    const opened = opening([action('action:a', 'carrier:a'), action('action:b', 'carrier:b')]);
    const proposal = proposeExplorationAssignment(request(opened, ['action:a', 'action:b']));
    expect(proposal.kind).toBe('proposal');
    if (proposal.kind !== 'proposal') return;
    expect(proposal.decision).toMatchObject({
      selectionBasis: 'designed_exploration',
      assignmentProbability: { name: 'selection_probability', value: 0.5, unit: 'probability' },
    });
    const ledger = new DecisionEpisodeLedger();
    expect(ledger.append(opened).kind).toBe('appended');
    expect(ledger.append(proposal.decision).kind).toBe('appended');
    expect(ledger.entries(opened.episodeId)).toHaveLength(2);
  });

  it('changes the audit receipt when the pre-registered randomization unit changes', () => {
    const opened = opening([action('action:a', 'carrier:a'), action('action:b', 'carrier:b')]);
    const first = proposeExplorationAssignment(request(opened, ['action:a', 'action:b']));
    const second = proposeExplorationAssignment(request(opened, ['action:a', 'action:b'], {
      randomizationUnitId: 'opportunity:2',
    }));
    expect(first.kind === 'proposal' && first.randomization.digest)
      .not.toBe(second.kind === 'proposal' && second.randomization.digest);
  });

  it('refuses entropy that does not open the pre-registered commitment', () => {
    const opened = opening([action('action:a', 'carrier:a'), action('action:b', 'carrier:b')]);
    expect(proposeExplorationAssignment(request(opened, ['action:a', 'action:b'], {
      randomizationSalt: 'PUBLIC-TEST-VECTOR-WRONG-OPENING',
    }))).toMatchObject({ kind: 'refusal', code: 'EXPLORATION_RANDOMNESS_INVALID' });
  });

  it('refuses to renormalize around an undetermined or refused action', () => {
    const uncertain: DecisionAlternative = {
      ...action('action:u', 'carrier:u'),
      feasibility: {
        status: 'undetermined', reason: 'insurance stale', remedy: 'refresh certificate',
        evidenceIds: ['vetting:carrier:u'],
      },
    };
    const opened = opening([action('action:a', 'carrier:a'), uncertain]);
    expect(proposeExplorationAssignment(request(opened, ['action:a', 'action:u'])))
      .toMatchObject({ kind: 'refusal', code: 'EXPLORATION_ACTION_INELIGIBLE' });
  });

  it('refuses a population changed after the episode opening', () => {
    const opened = opening([action('action:a', 'carrier:a'), action('action:b', 'carrier:b')]);
    expect(proposeExplorationAssignment(request(opened, ['action:a', 'action:invented'])))
      .toMatchObject({ kind: 'refusal', code: 'EXPLORATION_ACTION_UNKNOWN' });
  });

  it('refuses a carrier experiment confounded by departure window', () => {
    const opened = opening([
      action('action:a', 'carrier:a'),
      action('action:b', 'carrier:b', '2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z'),
    ]);
    expect(proposeExplorationAssignment(request(opened, ['action:a', 'action:b'])))
      .toMatchObject({ kind: 'refusal', code: 'EXPLORATION_FACTOR_CONFOUNDED' });
  });

  it('permits a departure-window experiment only when carrier and lane stay fixed', () => {
    const opened = opening([
      action('action:early', 'carrier:a'),
      action('action:late', 'carrier:a', '2026-09-01T16:00:00.000Z', '2026-09-01T17:00:00.000Z'),
    ]);
    const result = proposeExplorationAssignment(request(
      opened,
      ['action:early', 'action:late'],
      { policy: policy(['action:early', 'action:late'], 'departure_window') },
    ));
    expect(result.kind).toBe('proposal');
  });

  it('refuses a single-action population because it is not an experiment', () => {
    const opened = opening([action('action:a', 'carrier:a')]);
    expect(proposeExplorationAssignment(request(opened, ['action:a'])))
      .toMatchObject({ kind: 'refusal', code: 'EXPLORATION_POPULATION_TOO_SMALL' });
  });
});
