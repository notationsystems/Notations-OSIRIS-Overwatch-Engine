import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestationOf } from './attestation';
import type { AuthorizationRequest } from './authorization';
import type { DecisionMetric, DecisionRecordedEvent } from './decisionEpisode';
import { commitExplorationSalt } from './explorationAssignment';
import { present, type Opportunity, type OpportunityFieldName } from './intake';
import {
  LoadOperationsWorkflow,
  type AuthorizeAlternativeCommand,
  type RegisterAlternativeCommand,
} from './loadOperations';
import {
  FileLoadOperationStore,
  MemoryLoadOperationStore,
  hashCommand,
  type AlternativeRegisteredEvent,
} from './loadOperationsStore';

const operationId = 'opportunity:1';
const episodeId = 'episode:1';
const t = {
  intake: '2026-09-01T12:00:00.000Z',
  alternativeA: '2026-09-01T12:01:00.000Z',
  alternativeB: '2026-09-01T12:02:00.000Z',
  authorizationA: '2026-09-01T12:03:00.000Z',
  authorizationB: '2026-09-01T12:04:00.000Z',
  opening: '2026-09-01T12:05:00.000Z',
  decision: '2026-09-01T12:06:00.000Z',
  pickup: '2026-09-01T14:00:00.000Z',
  windowEnd: '2026-09-01T15:00:00.000Z',
  occurred: '2026-09-02T18:00:00.000Z',
  known: '2026-09-02T18:10:00.000Z',
  revisedKnown: '2026-09-03T10:00:00.000Z',
};

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const attestation = attestationOf('derived', 'medium', 'negotiating_position', 'sanitized shipper intake');

function opportunity(id = operationId, quotable = true): Opportunity {
  const values: Record<OpportunityFieldName, ReturnType<typeof present<string | number>>> = {
    origin: present('Toronto, ON', 'Toronto'),
    destination: present('Detroit, MI', 'Detroit'),
    commodity: present('packaged food', 'packaged food'),
    weightLbs: present(38000, '38000 lbs'),
    equipment: present('reefer_53', '53 foot reefer'),
    pickupWindow: present(`${t.pickup}/${t.windowEnd}`, 'September 1, 2–3pm'),
    deliveryWindow: present('2026-09-02T17:00:00.000Z/2026-09-02T19:00:00.000Z', 'September 2, 5–7pm'),
    targetRate: present(220000, 'CAD 2200'),
  };
  if (!quotable) {
    values.origin = { state: 'missing', whoKnows: 'the shipper', askable: true } as ReturnType<typeof present<string | number>>;
  }
  return {
    opportunityId: id,
    sourceMessageId: `message:${id}`,
    channel: 'gmail',
    receivedAt: t.intake,
    fields: values,
    missingFields: quotable ? [] : ['origin'],
    unparsedFields: [],
    completeness: { present: quotable ? 8 : 7, of: 8 },
    quotable,
    blockedOn: quotable ? [] : ['origin'],
    attestation,
    extractedBy: { id: 'extractor:1', vendor: 'vendor:a' },
    renderedClaim: `${id}: sanitized opportunity`,
  };
}

function metric(
  name: DecisionMetric['name'],
  value: number,
  unit: DecisionMetric['unit'],
  evidenceId: string,
): DecisionMetric {
  return {
    name, value, unit,
    ...(unit === 'money_minor' ? { currency: 'CAD' } : {}),
    attestation: attestationOf('reported', 'high', 'disinterested', evidenceId),
    evidenceIds: [evidenceId],
  };
}

function alternative(
  actionId: string,
  carrierId: string,
  recordedAt: string,
): RegisterAlternativeCommand {
  return {
    operationId,
    eventId: `event:alternative:${actionId}`,
    recordedAt,
    alternative: {
      actionId,
      carrierId,
      laneId: 'lane:TOR-DET',
      departureWindow: { start: t.pickup, end: t.windowEnd },
      quotedCost: metric('quoted_cost', actionId.endsWith(':a') ? 145000 : 151000, 'money_minor', `quote:${actionId}`),
      predictedOutcomes: [metric('predicted_transit_hours', 5, 'hours', `model:${actionId}`)],
    },
    evidenceIds: [`quote:${actionId}`, `capacity:${actionId}`],
  };
}

function authorizationRequest(carrierId: string, authorized = true): AuthorizationRequest {
  return {
    loadId: 'load:1',
    tenderedCarrierId: carrierId,
    bolCarrierId: carrierId,
    pickupAt: t.pickup,
    bookedAt: t.intake,
    declaredValue: { amount: 5000000, currency: 'CAD' },
    carrier: {
      carrierId,
      insuranceExpiresAt: authorized ? '2027-01-01T00:00:00.000Z' : '2026-08-31T00:00:00.000Z',
      cargoCoverAmount: { amount: 10000000, currency: 'CAD' },
      authorityGrantedAt: '2020-01-01T00:00:00.000Z',
      authorityRevokedAt: null,
    },
    actingAuthority: { principal: 'payload.dispatch', mayBind: true },
  };
}

function authorization(
  actionId: string,
  carrierId: string,
  recordedAt: string,
  authorized = true,
): AuthorizeAlternativeCommand {
  return {
    operationId,
    eventId: `event:authorization:${actionId}`,
    recordedAt,
    actionId,
    request: authorizationRequest(carrierId, authorized),
    evidenceIds: [`coi:${carrierId}`, `authority:${carrierId}`, `bol:${carrierId}`],
  };
}

async function registerIntakeAndAlternatives(
  workflow: LoadOperationsWorkflow,
  bothAuthorized = false,
): Promise<void> {
  expect((await workflow.registerOpportunity({
    operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
  })).kind).toBe('accepted');
  expect((await workflow.registerAlternative(alternative('action:a', 'carrier:a', t.alternativeA))).kind)
    .toBe('accepted');
  expect((await workflow.registerAlternative(alternative('action:b', 'carrier:b', t.alternativeB))).kind)
    .toBe('accepted');
  expect((await workflow.authorizeAlternative(authorization(
    'action:a', 'carrier:a', t.authorizationA, true,
  ))).kind).toBe('accepted');
  expect((await workflow.authorizeAlternative(authorization(
    'action:b', 'carrier:b', t.authorizationB, bothAuthorized,
  ))).kind).toBe('accepted');
}

async function open(workflow: LoadOperationsWorkflow): Promise<void> {
  const result = await workflow.openEpisode({
    operationId,
    eventId: 'event:open',
    episodeId,
    recordedAt: t.opening,
    knowledgeCutoff: t.opening,
    stateSnapshotId: 'snapshot:opportunity:1:v1',
    evidenceIds: ['event:intake', 'market:snapshot:1'],
    constraintIds: ['constraint:insurance', 'constraint:cargo-cover'],
  });
  expect(result.kind).toBe('accepted');
}

function manualDecision(actionId = 'action:a'): DecisionRecordedEvent {
  return {
    kind: 'decision_recorded', eventId: 'event:decision', episodeId,
    selectedActionId: actionId, decidedAt: t.decision, recordedAt: t.decision,
    selectionBasis: 'operator_judgment', policy: null, assignmentProbability: null,
    decidedBy: { kind: 'operator', id: 'desk:1' },
    rationale: 'Authorized service fit.', evidenceIds: ['operator:desk:1:selection'],
  };
}

async function assignAndDispatch(workflow: LoadOperationsWorkflow): Promise<void> {
  expect((await workflow.recordAssignment({ operationId, decision: manualDecision() })).kind).toBe('accepted');
  expect((await workflow.dispatch({
    operationId, eventId: 'event:dispatch', loadId: 'load:1',
    startedAt: t.pickup, recordedAt: t.pickup, evidenceIds: ['dispatch:load:1'],
  })).kind).toBe('accepted');
}

describe('persistent load operations workflow', () => {
  it('connects intake through automatic outcome capture with every gate visible', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    const intake = await workflow.registerOpportunity({
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    });
    expect(intake.kind === 'accepted' && intake.snapshot.phase).toBe('alternatives_pending');
    await workflow.registerAlternative(alternative('action:a', 'carrier:a', t.alternativeA));
    await workflow.registerAlternative(alternative('action:b', 'carrier:b', t.alternativeB));
    expect((await workflow.get(operationId) as { phase: string }).phase).toBe('authorization_pending');
    await workflow.authorizeAlternative(authorization('action:a', 'carrier:a', t.authorizationA, true));
    await workflow.authorizeAlternative(authorization('action:b', 'carrier:b', t.authorizationB, false));
    expect((await workflow.get(operationId) as { phase: string }).phase).toBe('episode_opening_pending');
    await open(workflow);
    expect((await workflow.get(operationId) as { phase: string }).phase).toBe('assignment_pending');
    const assigned = await workflow.recordAssignment({ operationId, decision: manualDecision() });
    expect(assigned.kind === 'accepted' && assigned.snapshot.phase).toBe('dispatch_pending');
    const dispatched = await workflow.dispatch({
      operationId, eventId: 'event:dispatch', loadId: 'load:1',
      startedAt: t.pickup, recordedAt: t.pickup, evidenceIds: ['dispatch:load:1'],
    });
    expect(dispatched.kind === 'accepted' && dispatched.snapshot.phase).toBe('outcome_pending');
    const captured = await workflow.captureOutcome({
      operationId, eventId: 'event:outcome:1', occurredAt: t.occurred, knownAt: t.known,
      recordedAt: t.known,
      metrics: [
        metric('actual_transit_hours', 5.5, 'hours', 'telematics:load:1'),
        metric('carrier_invoice', 149000, 'money_minor', 'invoice:load:1'),
      ],
      absences: [{
        metric: 'damage_cost', reason: 'pending', detail: 'Claim window remains open.',
        remedy: 'Re-evaluate when the claim window closes.', evidenceIds: ['claim-window:load:1'],
      }],
      evidenceIds: ['pod:load:1', 'invoice:load:1'],
    });
    expect(captured.kind === 'accepted' && captured.snapshot.phase).toBe('outcome_captured');
    if (captured.kind !== 'accepted') return;
    expect(captured.snapshot.alternatives.map(value => [
      value.alternative.actionId, value.authorization?.decision,
    ])).toEqual([['action:a', 'authorized'], ['action:b', 'refused']]);
    expect(captured.snapshot.decisionEntries.map(entry => entry.event.kind)).toEqual([
      'episode_opened', 'decision_recorded', 'execution_started', 'outcome_observed',
    ]);
  });

  it('blocks alternatives until intake is quotable', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    await workflow.registerOpportunity({
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(operationId, false),
    });
    expect(await workflow.registerAlternative(alternative('action:a', 'carrier:a', t.alternativeA)))
      .toMatchObject({ kind: 'refusal', code: 'OPERATION_NOT_QUOTABLE' });
  });

  it('requires an authorization decision for every alternative and binds carrier identity', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    await workflow.registerOpportunity({
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    });
    await workflow.registerAlternative(alternative('action:a', 'carrier:a', t.alternativeA));
    await workflow.registerAlternative(alternative('action:b', 'carrier:b', t.alternativeB));
    expect(await workflow.authorizeAlternative({
      ...authorization('action:a', 'carrier:a', t.authorizationA),
      request: authorizationRequest('carrier:wrong'),
    })).toMatchObject({ kind: 'refusal', code: 'OPERATION_AUTHORIZATION_INVALID' });
    await workflow.authorizeAlternative(authorization('action:a', 'carrier:a', t.authorizationA));
    expect(await workflow.openEpisode({
      operationId, eventId: 'event:open', episodeId, recordedAt: t.opening,
      knowledgeCutoff: t.opening, stateSnapshotId: 'snapshot:1',
      evidenceIds: ['market:snapshot'], constraintIds: [],
    })).toMatchObject({ kind: 'refusal', code: 'OPERATION_AUTHORIZATION_MISSING' });
  });

  it('will not dispatch a different load under the selected action clearance', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    await registerIntakeAndAlternatives(workflow);
    await open(workflow);
    await workflow.recordAssignment({ operationId, decision: manualDecision() });
    expect(await workflow.dispatch({
      operationId, eventId: 'event:dispatch:wrong', loadId: 'load:other',
      startedAt: t.pickup, recordedAt: t.pickup, evidenceIds: ['dispatch:other'],
    })).toMatchObject({ kind: 'refusal', code: 'OPERATION_DISPATCH_REFUSED' });
    expect((await workflow.get(operationId) as { phase: string }).phase).toBe('dispatch_pending');
  });

  it('appends outcome revisions automatically and makes retries idempotent', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    await registerIntakeAndAlternatives(workflow);
    await open(workflow);
    await assignAndDispatch(workflow);
    const first = {
      operationId, eventId: 'event:outcome:1', occurredAt: t.occurred,
      knownAt: t.known, recordedAt: t.known,
      metrics: [metric('carrier_invoice', 149000, 'money_minor', 'invoice:provisional')],
      absences: [], evidenceIds: ['invoice:provisional'],
    } as const;
    expect((await workflow.captureOutcome(first)).kind).toBe('accepted');
    const second = {
      operationId, eventId: 'event:outcome:2', occurredAt: t.occurred,
      knownAt: t.revisedKnown, recordedAt: t.revisedKnown,
      metrics: [metric('carrier_invoice', 153000, 'money_minor', 'invoice:final')],
      absences: [], evidenceIds: ['invoice:final'],
    } as const;
    expect((await workflow.captureOutcome(second)).kind).toBe('accepted');
    const retry = await workflow.captureOutcome(second);
    expect(retry).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });
    if (retry.kind !== 'accepted') return;
    const outcomes = retry.snapshot.decisionEntries.filter(entry => entry.event.kind === 'outcome_observed');
    expect(outcomes).toHaveLength(2);
    expect(outcomes[1].event).toMatchObject({ supersedesEventId: 'event:outcome:1' });
  });

  it('recovers from a fresh workflow instance over the same file journal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-operations-'));
    tempDirs.push(dir);
    const file = join(dir, 'operations.jsonl');
    const first = new LoadOperationsWorkflow(new FileLoadOperationStore(file));
    await first.registerOpportunity({
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    });
    await first.registerAlternative(alternative('action:a', 'carrier:a', t.alternativeA));
    const recovered = await new LoadOperationsWorkflow(new FileLoadOperationStore(file)).get(operationId);
    expect(recovered).toMatchObject({
      operationId, phase: 'authorization_pending', durability: 'local_jsonl_single_writer',
    });
  });

  it('persists exploration decisions without persisting the salt opening', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-operations-'));
    tempDirs.push(dir);
    const file = join(dir, 'operations.jsonl');
    const workflow = new LoadOperationsWorkflow(new FileLoadOperationStore(file));
    await registerIntakeAndAlternatives(workflow, true);
    await open(workflow);
    const salt = 'PUBLIC-TEST-OPENING-NOT-A-PRODUCTION-SECRET';
    const result = await workflow.exploreAssignment({
      operationId,
      policy: {
        policyId: 'carrier-exploration', version: '1.0.0', factor: 'carrier',
        algorithm: 'sha256_equal_cdf_v1', candidateActionIds: ['action:a', 'action:b'],
        randomizationSaltCommitment: commitExplorationSalt(salt),
        evidenceIds: ['policy:carrier-exploration@1.0.0'],
      },
      randomizationUnitId: operationId,
      randomizationSalt: salt,
      eventId: 'event:decision:exploration',
      decidedAt: t.decision,
      recordedAt: t.decision,
    });
    expect(result).toMatchObject({ kind: 'accepted', snapshot: { phase: 'dispatch_pending' } });
    const journal = await readFile(file, 'utf8');
    expect(journal).not.toContain(salt);
    expect(journal).toContain(commitExplorationSalt(salt));
  });

  it('distinguishes an exact retry from an event-id collision', async () => {
    const workflow = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    const command = {
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    } as const;
    expect(await workflow.registerOpportunity(command))
      .toMatchObject({ kind: 'accepted', persistence: 'appended' });
    expect(await workflow.registerOpportunity(command))
      .toMatchObject({ kind: 'accepted', persistence: 'duplicate' });
    expect(await workflow.registerOpportunity({
      ...command, recordedAt: t.alternativeA,
    })).toMatchObject({ kind: 'refusal', code: 'OPERATION_EVENT_ID_CONFLICT' });
  });

  it('refuses an append validated against a stale journal tail', async () => {
    const store = new MemoryLoadOperationStore();
    const command = {
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    } as const;
    const workflow = new LoadOperationsWorkflow(store);
    await workflow.registerOpportunity(command);
    const alternativeCommand = alternative('action:a', 'carrier:a', t.alternativeA);
    const event: AlternativeRegisteredEvent = {
      kind: 'alternative_registered', eventId: alternativeCommand.eventId, operationId,
      recordedAt: alternativeCommand.recordedAt, commandHash: hashCommand(alternativeCommand),
      alternative: alternativeCommand.alternative, evidenceIds: alternativeCommand.evidenceIds,
    };
    expect(await store.append(event, null)).toMatchObject({
      kind: 'refusal', code: 'OPERATION_STORE_CONCURRENT_WRITE',
    });
    expect((await store.readAll())).toHaveLength(1);
  });

  it('refuses partial files and semantically invalid but hash-valid replay', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-operations-'));
    tempDirs.push(dir);
    const file = join(dir, 'operations.jsonl');
    const persistent = new LoadOperationsWorkflow(new FileLoadOperationStore(file));
    await persistent.registerOpportunity({
      operationId, eventId: 'event:intake', recordedAt: t.intake, opportunity: opportunity(),
    });
    await appendFile(file, '{"partial":', 'utf8');
    expect(await persistent.get(operationId)).toMatchObject({
      kind: 'refusal', code: 'OPERATION_STORE_CORRUPT',
    });

    const store = new MemoryLoadOperationStore();
    const workflow = new LoadOperationsWorkflow(store);
    await registerIntakeAndAlternatives(workflow);
    await open(workflow);
    const late = alternative('action:late', 'carrier:late', '2026-09-01T12:07:00.000Z');
    const event: AlternativeRegisteredEvent = {
      kind: 'alternative_registered', eventId: late.eventId, operationId,
      recordedAt: late.recordedAt, commandHash: hashCommand(late),
      alternative: late.alternative, evidenceIds: late.evidenceIds,
    };
    expect((await store.append(event)).kind).toBe('appended');
    expect(await workflow.get(operationId)).toMatchObject({
      kind: 'refusal', code: 'OPERATION_STORE_CORRUPT',
    });
  });
});
