import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import {
  deriveCarrierDispatchEnvelope,
  type CarrierCommunicationSnapshot,
  type CarrierDispatchEnvelope,
} from './carrierCommunications';
import {
  buildControlTowerSnapshot,
  FreightControlTower,
  type ControlTowerSnapshot,
} from './controlTower';
import { DecisionEpisodeLedger, type DecisionAlternative, type DecisionMetric } from './decisionEpisode';
import { present, type Opportunity, type OpportunityFieldName } from './intake';
import type { LoadOperationPhase, LoadOperationSnapshot } from './loadOperations';

const time = {
  received: '2026-09-01T11:00:00.000Z',
  opened: '2026-09-01T12:00:00.000Z',
  decided: '2026-09-01T12:01:00.000Z',
  dispatched: '2026-09-01T12:02:00.000Z',
  deliveredTender: '2026-09-01T12:03:00.000Z',
  pickupStart: '2026-09-02T14:00:00.000Z',
  pickupEnd: '2026-09-02T15:00:00.000Z',
  deliveryStart: '2026-09-03T17:00:00.000Z',
  deliveryEnd: '2026-09-03T19:00:00.000Z',
};

function metric(
  name: DecisionMetric['name'] = 'quoted_cost',
  value = 145000,
): DecisionMetric {
  return {
    name,
    value,
    unit: 'money_minor',
    currency: 'CAD',
    attestation: attestationOf('reported', 'high', 'negotiating_position', `evidence:${name}`),
    evidenceIds: [`evidence:${name}`],
  };
}

function opportunity(operationId: string): Opportunity {
  const fields: Record<OpportunityFieldName, ReturnType<typeof present<string | number>>> = {
    origin: present('Toronto, ON', 'Toronto'),
    destination: present('Detroit, MI', 'Detroit'),
    commodity: present('packaged food', 'packaged food'),
    weightLbs: present(38000, '38000 lbs'),
    equipment: present('reefer_53', '53 foot reefer'),
    pickupWindow: present(`${time.pickupStart}/${time.pickupEnd}`, '2-3pm'),
    deliveryWindow: present(`${time.deliveryStart}/${time.deliveryEnd}`, '5-7pm'),
    targetRate: present(220000, 'CAD 2200'),
  };
  return {
    opportunityId: operationId,
    sourceMessageId: `private:${operationId}`,
    channel: 'gmail',
    receivedAt: time.received,
    fields,
    missingFields: [],
    unparsedFields: [],
    completeness: { present: 8, of: 8 },
    quotable: true,
    blockedOn: [],
    attestation: attestationOf('derived', 'medium', 'negotiating_position', `intake:${operationId}`),
    extractedBy: { id: 'extractor:test', vendor: 'vendor:test' },
    renderedClaim: 'sanitized opportunity',
  };
}

function operation(
  operationId = 'operation:1',
  phase: LoadOperationPhase = 'outcome_pending',
): LoadOperationSnapshot {
  const quote = metric();
  const alternative: DecisionAlternative = {
    actionId: `action:${operationId}`,
    carrierId: 'carrier:a',
    laneId: 'lane:TOR-DET',
    departureWindow: { start: time.pickupStart, end: time.pickupEnd },
    feasibility: { status: 'feasible', evidenceIds: ['authorization:a'] },
    quotedCost: quote,
    predictedOutcomes: [],
  };
  const episodeId = `episode:${operationId}`;
  const ledger = new DecisionEpisodeLedger();
  const events = [
    {
      kind: 'episode_opened' as const,
      eventId: `opened:${operationId}`,
      episodeId,
      recordedAt: time.opened,
      context: {
        opportunityId: operationId,
        stateSnapshotId: `state:${operationId}`,
        knowledgeCutoff: time.opened,
        evidenceIds: [`state:${operationId}`],
        constraintIds: ['constraint:insurance'],
      },
      alternatives: [alternative],
    },
    {
      kind: 'decision_recorded' as const,
      eventId: `decision:${operationId}`,
      episodeId,
      selectedActionId: alternative.actionId,
      decidedAt: time.decided,
      recordedAt: time.decided,
      selectionBasis: 'operator_judgment' as const,
      policy: null,
      assignmentProbability: null,
      decidedBy: { kind: 'operator' as const, id: 'operator:desk' },
      rationale: 'Authorized carrier selected.',
      evidenceIds: [`selection:${operationId}`],
    },
    {
      kind: 'execution_started' as const,
      eventId: `dispatch:${operationId}`,
      episodeId,
      actionId: alternative.actionId,
      loadId: `load:${operationId}`,
      startedAt: time.dispatched,
      recordedAt: time.dispatched,
      evidenceIds: [`dispatch:${operationId}`],
    },
  ];
  for (const event of events) {
    const result = ledger.append(event);
    if (result.kind === 'refusal') throw new Error(result.detail);
  }
  return {
    operationId,
    opportunity: opportunity(operationId),
    phase,
    durability: 'memory',
    alternatives: [{
      alternative: {
        actionId: alternative.actionId,
        carrierId: alternative.carrierId,
        laneId: alternative.laneId,
        departureWindow: alternative.departureWindow,
        quotedCost: quote,
        predictedOutcomes: [],
      },
      evidenceIds: ['quote:a', 'capacity:a'],
      authorization: {
        loadId: `load:${operationId}`,
        decision: 'authorized',
        checks: [],
        blockedBy: [],
        decidedAt: time.opened,
        statement: 'authorized',
      },
      authorizationEventId: `authorization:${operationId}`,
      authorizationEvidenceIds: [`authorization:${operationId}`],
    }],
    episodeId,
    decisionEntries: ledger.entries(episodeId),
  };
}

function envelope(snapshot: LoadOperationSnapshot): CarrierDispatchEnvelope {
  const result = deriveCarrierDispatchEnvelope(snapshot);
  if ('kind' in result) throw new Error(result.detail);
  return result;
}

function communication(
  snapshot: LoadOperationSnapshot,
  overrides: Partial<CarrierCommunicationSnapshot> = {},
): CarrierCommunicationSnapshot {
  return {
    envelope: envelope(snapshot),
    durability: 'memory',
    deliveryState: 'delivered',
    acknowledgement: 'accepted',
    latestTrackingStatus: null,
    attempts: [{
      attemptId: `attempt:${snapshot.operationId}`,
      state: 'delivered',
      requestedAt: time.deliveredTender,
      completedAt: time.deliveredTender,
      provider: 'test-gateway',
      providerReceiptId: `receipt:${snapshot.operationId}`,
      failure: null,
    }],
    carrierEvents: [],
    ...overrides,
  };
}

function snapshot(result: ReturnType<typeof buildControlTowerSnapshot>): ControlTowerSnapshot {
  if (result.kind === 'refusal') throw new Error(result.detail);
  return result;
}

describe('freight control tower', () => {
  it('joins exact load/carrier/lane identity and exposes an unsent tender as the next action', () => {
    const projected = snapshot(buildControlTowerSnapshot(
      [operation()], [], '2026-09-01T13:00:00.000Z',
    ));
    expect(projected.loads[0]).toMatchObject({
      operationId: 'operation:1',
      loadId: 'load:operation:1',
      carrierId: 'carrier:a',
      laneId: 'lane:TOR-DET',
      route: { origin: 'Toronto, ON', destination: 'Detroit, MI', equipment: 'reefer_53' },
      attentionLevel: 'high',
      nextAction: { code: 'tender_send_pending' },
      state: { authorization: 'authorized', tenderDelivery: 'not_created' },
    });
    expect(JSON.stringify(projected)).not.toContain('private:operation:1');
  });

  it('escalates an unacknowledged tender only after its configured grace period', () => {
    const load = operation();
    const carrier = communication(load, { acknowledgement: 'pending' });
    const before = snapshot(buildControlTowerSnapshot(
      [load], [carrier], '2026-09-01T12:20:00.000Z',
    ));
    const after = snapshot(buildControlTowerSnapshot(
      [load], [carrier], '2026-09-01T12:40:00.000Z',
    ));
    expect(before.loads[0].nextAction).toMatchObject({ code: 'carrier_ack_pending', severity: 'low' });
    expect(after.loads[0].nextAction).toMatchObject({ code: 'carrier_ack_pending', severity: 'high' });
  });

  it('makes a missed delivery critical and sorts it ahead of a merely stale load', () => {
    const overdue = operation('operation:overdue');
    const staleBase = operation('operation:stale');
    const stale: LoadOperationSnapshot = {
      ...staleBase,
      opportunity: {
        ...staleBase.opportunity,
        fields: {
          ...staleBase.opportunity.fields,
          deliveryWindow: present(
            '2026-09-04T17:00:00.000Z/2026-09-04T19:00:00.000Z',
            'September 4, 5-7pm',
          ),
        },
      },
    };
    const tracking = (id: string, knownAt: string) => ({
      eventId: `tracking:${id}`,
      carrierEventId: `provider:${id}`,
      eventKind: 'tracking' as const,
      status: 'in_transit' as const,
      occurredAt: knownAt,
      knownAt,
      recordedAt: knownAt,
      evidenceIds: [`telematics:${id}`],
    });
    const projected = snapshot(buildControlTowerSnapshot([
      stale, overdue,
    ], [
      communication(stale, {
        latestTrackingStatus: 'in_transit',
        carrierEvents: [tracking('stale', '2026-09-03T08:00:00.000Z')],
      }),
      communication(overdue, {
        latestTrackingStatus: 'in_transit',
        carrierEvents: [tracking('overdue', '2026-09-03T18:00:00.000Z')],
      }),
    ], '2026-09-03T20:00:00.000Z'));
    expect(projected.loads.map(load => load.operationId)).toEqual([
      'operation:overdue', 'operation:stale',
    ]);
    expect(projected.loads[0].nextAction).toMatchObject({ code: 'delivery_overdue', severity: 'critical' });
    expect(projected.loads[1].issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'tracking_stale', severity: 'high' }),
    ]));
    expect(projected.portfolio).toMatchObject({ critical: 1, high: 1, inMotion: 2 });
  });

  it('turns delivered physical evidence into a settlement work item', () => {
    const load = operation();
    const deliveredAt = '2026-09-03T18:30:00.000Z';
    const projected = snapshot(buildControlTowerSnapshot([load], [communication(load, {
      latestTrackingStatus: 'delivered',
      carrierEvents: [{
        eventId: 'tracking:delivered',
        carrierEventId: 'provider:delivered',
        eventKind: 'tracking',
        status: 'delivered',
        occurredAt: deliveredAt,
        knownAt: deliveredAt,
        recordedAt: deliveredAt,
        evidenceIds: ['pod:1'],
      }],
    })], '2026-09-03T19:00:00.000Z'));
    expect(projected.loads[0].nextAction).toMatchObject({ code: 'settlement_pending', severity: 'medium' });
    expect(projected.portfolio.awaitingSettlement).toBe(1);
  });

  it('keeps a captured outcome out of the exception queue', () => {
    const projected = snapshot(buildControlTowerSnapshot(
      [operation('operation:closed', 'outcome_captured')], [], '2026-09-04T20:00:00.000Z',
    ));
    expect(projected.loads[0]).toMatchObject({ attentionLevel: 'none', nextAction: null });
    expect(projected.portfolio).toMatchObject({ activeLoads: 0, completedLoads: 1, needingAttention: 0 });
  });

  it('refuses invalid clocks, invalid policy, and duplicate communication projections', () => {
    expect(buildControlTowerSnapshot([], [], 'not-a-date')).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_REQUEST_INVALID',
    });
    expect(buildControlTowerSnapshot([], [], time.received, {
      acknowledgementGraceMinutes: -1,
      trackingStaleMinutes: 120,
      settlementGraceMinutes: 1440,
    })).toMatchObject({ kind: 'refusal', code: 'CONTROL_TOWER_REQUEST_INVALID' });
    const load = operation();
    const carrier = communication(load);
    expect(buildControlTowerSnapshot([load], [carrier, carrier], time.received)).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
    });
    expect(buildControlTowerSnapshot([], [carrier], time.received)).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
      detail: expect.stringContaining('unknown operation'),
    });
    expect(buildControlTowerSnapshot([load], [{
      ...carrier,
      envelope: { ...carrier.envelope, carrierId: 'carrier:wrong' },
    }], time.received)).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
      detail: expect.stringContaining('immutable dispatch binding'),
    });
  });

  it('fails closed when either durable source is unavailable', async () => {
    const operationFailure = new FreightControlTower(
      { async list() { return { kind: 'refusal' as const, code: 'OPERATION_STORE_CORRUPT' as const, detail: 'bad chain', remedy: 'restore backup' }; } },
      { async list() { return []; } },
    );
    expect(await operationFailure.read(time.received)).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_OPERATIONS_UNAVAILABLE', detail: 'bad chain',
    });

    const communicationFailure = new FreightControlTower(
      { async list() { return []; } },
      { async list() { return { kind: 'refusal' as const, code: 'COMMUNICATION_STORE_UNAVAILABLE' as const, detail: 'offline', remedy: 'mount volume' }; } },
    );
    expect(await communicationFailure.read(time.received)).toMatchObject({
      kind: 'refusal', code: 'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE', detail: 'offline',
    });
  });
});
