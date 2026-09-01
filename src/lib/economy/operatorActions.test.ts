import { describe, expect, it } from 'vitest';
import {
  CarrierCommunicationsWorkflow,
  type CarrierDispatchGateway,
  type CarrierDispatchGatewayResult,
} from './carrierCommunications';
import { MemoryCarrierCommunicationStore } from './carrierCommunicationsStore';
import { LoadOperationsWorkflow } from './loadOperations';
import { MemoryLoadOperationStore } from './loadOperationsStore';
import { OperatorActions } from './operatorActions';

class TestGateway implements CarrierDispatchGateway {
  readonly calls: string[] = [];

  constructor(private readonly now: () => string) {}

  async deliver(_envelope: unknown, idempotencyKey: string): Promise<CarrierDispatchGatewayResult> {
    this.calls.push(idempotencyKey);
    const instant = this.now();
    return {
      kind: 'delivered',
      provider: 'test-cockpit-gateway',
      providerReceiptId: `receipt:${idempotencyKey}`,
      acceptedAt: instant,
      completedAt: instant,
      evidenceIds: [`gateway:${idempotencyKey}`],
    };
  }
}

const envelope = (action: string, requestId: string, payload: Record<string, unknown>) => ({
  action,
  requestId,
  actorId: 'desk:one',
  payload,
});

describe('operator action cockpit', () => {
  it('operates one load end to end from business facts and derives every durable binding', async () => {
    let now = '2026-09-01T10:00:00.000Z';
    const clock = () => now;
    const operations = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    const gateway = new TestGateway(clock);
    const communications = new CarrierCommunicationsWorkflow(
      operations,
      new MemoryCarrierCommunicationStore(),
      gateway,
    );
    const cockpit = new OperatorActions(operations, communications, clock);
    const operationId = 'op:cockpit:1';

    const intake = await cockpit.execute(envelope('create_opportunity', 'request:intake', {
      operationId,
      sourceReference: 'email:shipper:1',
      origin: 'Toronto, ON',
      destination: 'Detroit, MI',
      equipment: '53 ft dry van',
      commodity: 'Packaged food',
      weightLbs: 38_000,
      pickupStart: '2026-09-02T12:00:00.000Z',
      pickupEnd: '2026-09-02T14:00:00.000Z',
      deliveryStart: '2026-09-03T12:00:00.000Z',
      deliveryEnd: '2026-09-03T16:00:00.000Z',
    }));
    expect(intake).toMatchObject({ kind: 'accepted', operation: { phase: 'alternatives_pending' } });

    now = '2026-09-01T10:01:00.000Z';
    const quoted = await cockpit.execute(envelope('add_carrier_alternative', 'request:quote', {
      operationId,
      sourceReference: 'quote:carrier:1',
      carrierId: 'carrier:mc-123456',
      laneId: 'lane:TOR-DET',
      departureStart: '2026-09-02T12:00:00.000Z',
      departureEnd: '2026-09-02T14:00:00.000Z',
      quotedCostMinor: 145_000,
      currency: 'CAD',
    }));
    expect(quoted).toMatchObject({ kind: 'accepted', operation: { phase: 'authorization_pending' } });
    if (quoted.kind !== 'accepted' || !quoted.operation) throw new Error('quote failed');
    const actionId = quoted.operation.alternatives[0].alternative.actionId;

    now = '2026-09-01T10:02:00.000Z';
    const authorized = await cockpit.execute(envelope('authorize_carrier', 'request:authorize', {
      operationId,
      actionId,
      sourceReference: 'compliance:carrier:1',
      loadId: 'load:cockpit:1',
      bolCarrierId: 'carrier:mc-123456',
      declaredValueMinor: 5_000_000,
      currency: 'CAD',
      insuranceExpiresAt: '2027-01-01T00:00:00.000Z',
      cargoCoverAmountMinor: 10_000_000,
      authorityGrantedAt: '2020-01-01T00:00:00.000Z',
    }));
    expect(authorized).toMatchObject({
      kind: 'accepted',
      operation: { phase: 'episode_opening_pending', alternatives: [{ authorization: { decision: 'authorized' } }] },
    });

    now = '2026-09-01T10:03:00.000Z';
    expect(await cockpit.execute(envelope('open_decision_episode', 'request:open', { operationId })))
      .toMatchObject({ kind: 'accepted', operation: { phase: 'assignment_pending' } });

    now = '2026-09-01T10:04:00.000Z';
    expect(await cockpit.execute(envelope('assign_carrier', 'request:assign', {
      operationId,
      actionId,
      rationale: 'Best authorized service and cost fit.',
    }))).toMatchObject({ kind: 'accepted', operation: { phase: 'dispatch_pending' } });

    now = '2026-09-01T10:05:00.000Z';
    expect(await cockpit.execute(envelope('dispatch_load', 'request:dispatch', { operationId })))
      .toMatchObject({ kind: 'accepted', operation: { phase: 'outcome_pending' } });

    now = '2026-09-01T10:06:00.000Z';
    expect(await cockpit.execute(envelope('send_tender', 'request:send', { operationId })))
      .toMatchObject({ kind: 'accepted', communication: { deliveryState: 'delivered' } });
    expect(gateway.calls).toHaveLength(1);

    now = '2026-09-01T10:07:00.000Z';
    expect(await cockpit.execute(envelope('record_carrier_acknowledgement', 'request:ack', {
      operationId,
      status: 'accepted',
      occurredAt: '2026-09-01T10:06:30.000Z',
      sourceReference: 'email:carrier-ack:1',
    }))).toMatchObject({ kind: 'accepted', communication: { acknowledgement: 'accepted' } });

    now = '2026-09-03T15:00:00.000Z';
    expect(await cockpit.execute(envelope('record_tracking', 'request:tracking', {
      operationId,
      status: 'delivered',
      occurredAt: '2026-09-03T14:55:00.000Z',
      sourceReference: 'telematics:delivered:1',
    }))).toMatchObject({ kind: 'accepted', communication: { latestTrackingStatus: 'delivered' } });

    const ready = await cockpit.inspect(operationId);
    expect(ready).toMatchObject({
      kind: 'operator_cockpit_snapshot',
      actions: expect.arrayContaining([expect.objectContaining({ action: 'capture_settlement', recommended: true })]),
    });

    now = '2026-09-03T15:05:00.000Z';
    const settled = await cockpit.execute(envelope('capture_settlement', 'request:settlement', {
      operationId,
      sourceReference: 'settlement:load:1',
      pickupAt: '2026-09-02T12:15:00.000Z',
      deliveredAt: '2026-09-03T14:55:00.000Z',
      currency: 'CAD',
      carrierInvoiceMinor: 145_000,
      accessorialCostMinor: 5_000,
      shipperRevenueMinor: 190_000,
      damageCostMinor: 0,
      rejected: false,
    }));
    expect(settled).toMatchObject({ kind: 'accepted', operation: { phase: 'outcome_captured' } });
    if (settled.kind !== 'accepted' || !settled.operation) throw new Error('settlement failed');
    const outcome = settled.operation.decisionEntries.at(-1)?.event;
    expect(outcome).toMatchObject({
      kind: 'outcome_observed',
      actionId,
      loadId: 'load:cockpit:1',
      metrics: expect.arrayContaining([
        expect.objectContaining({ name: 'gross_margin', value: 40_000, currency: 'CAD' }),
      ]),
    });

    expect(await cockpit.execute(envelope('capture_settlement', 'request:settlement', {
      operationId,
      sourceReference: 'settlement:load:1',
      pickupAt: '2026-09-02T12:15:00.000Z',
      deliveredAt: '2026-09-03T14:55:00.000Z',
      currency: 'CAD',
      carrierInvoiceMinor: 145_000,
      accessorialCostMinor: 5_000,
      shipperRevenueMinor: 190_000,
      damageCostMinor: 0,
      rejected: false,
    }))).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });
  });

  it('rejects raw journal fields instead of accepting a disguised command', async () => {
    const operations = new LoadOperationsWorkflow(new MemoryLoadOperationStore());
    const communications = new CarrierCommunicationsWorkflow(
      operations,
      new MemoryCarrierCommunicationStore(),
      new TestGateway(() => '2026-09-01T10:00:00.000Z'),
    );
    const cockpit = new OperatorActions(operations, communications, () => '2026-09-01T10:00:00.000Z');
    const result = await cockpit.execute({
      ...envelope('create_opportunity', 'request:forged', {
        operationId: 'op:forged', sourceReference: 'source:1', origin: 'Toronto', destination: 'Detroit',
        equipment: 'van', pickupStart: '2026-09-02T12:00:00.000Z', pickupEnd: '2026-09-02T14:00:00.000Z',
      }),
      eventId: 'forged:event-id',
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'OPERATOR_ACTION_INVALID' });
    expect(await operations.get('op:forged')).toMatchObject({ kind: 'refusal', code: 'OPERATION_NOT_FOUND' });
  });
});
