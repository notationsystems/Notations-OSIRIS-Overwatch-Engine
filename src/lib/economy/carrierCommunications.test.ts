import { afterEach, describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestationOf } from './attestation';
import {
  CarrierCommunicationsWorkflow,
  deriveCarrierDispatchEnvelope,
  type CarrierDispatchEnvelope,
  type CarrierDispatchGateway,
  type CarrierDispatchGatewayResult,
} from './carrierCommunications';
import {
  FileCarrierCommunicationStore,
  MemoryCarrierCommunicationStore,
} from './carrierCommunicationsStore';
import { WebhookCarrierDispatchGateway } from './carrierDispatchGateway';
import { DecisionEpisodeLedger, type DecisionAlternative, type DecisionMetric } from './decisionEpisode';
import { present, type Opportunity, type OpportunityFieldName } from './intake';
import type { LoadOperationSnapshot } from './loadOperations';
import { hashCommand } from './loadOperationsStore';

const times = {
  received: '2026-09-01T11:00:00.000Z',
  opened: '2026-09-01T12:00:00.000Z',
  decided: '2026-09-01T12:01:00.000Z',
  dispatched: '2026-09-01T12:02:00.000Z',
  requested: '2026-09-01T12:03:00.000Z',
  completed: '2026-09-01T12:03:01.000Z',
};

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function metric(): DecisionMetric {
  return {
    name: 'quoted_cost',
    value: 145000,
    unit: 'money_minor',
    currency: 'CAD',
    attestation: attestationOf('reported', 'high', 'negotiating_position', 'quote:carrier:a'),
    evidenceIds: ['quote:carrier:a'],
  };
}

function opportunity(): Opportunity {
  const fields: Record<OpportunityFieldName, ReturnType<typeof present<string | number>>> = {
    origin: present('Toronto, ON', 'Toronto'),
    destination: present('Detroit, MI', 'Detroit'),
    commodity: present('packaged food', 'packaged food'),
    weightLbs: present(38000, '38000 lbs'),
    equipment: present('reefer_53', '53 foot reefer'),
    pickupWindow: present('2026-09-02T14:00:00.000Z/2026-09-02T15:00:00.000Z', '2-3pm'),
    deliveryWindow: present('2026-09-03T17:00:00.000Z/2026-09-03T19:00:00.000Z', '5-7pm'),
    targetRate: present(220000, 'CAD 2200'),
  };
  return {
    opportunityId: 'operation:1',
    sourceMessageId: 'private-message-reference',
    channel: 'gmail',
    receivedAt: times.received,
    fields,
    missingFields: [],
    unparsedFields: [],
    completeness: { present: 8, of: 8 },
    quotable: true,
    blockedOn: [],
    attestation: attestationOf('derived', 'medium', 'negotiating_position', 'intake:1'),
    extractedBy: { id: 'extractor:1', vendor: 'vendor:test' },
    renderedClaim: 'sanitized opportunity',
  };
}

function operationSnapshot(): LoadOperationSnapshot {
  const quote = metric();
  const alternative: DecisionAlternative = {
    actionId: 'action:a',
    carrierId: 'carrier:a',
    laneId: 'lane:TOR-DET',
    departureWindow: {
      start: '2026-09-02T14:00:00.000Z',
      end: '2026-09-02T15:00:00.000Z',
    },
    feasibility: { status: 'feasible', evidenceIds: ['authorization:a'] },
    quotedCost: quote,
    predictedOutcomes: [],
  };
  const ledger = new DecisionEpisodeLedger();
  for (const event of [
    {
      kind: 'episode_opened' as const,
      eventId: 'episode-opened:1',
      episodeId: 'episode:1',
      recordedAt: times.opened,
      context: {
        opportunityId: 'operation:1',
        stateSnapshotId: 'state:1',
        knowledgeCutoff: times.opened,
        evidenceIds: ['state:1'],
        constraintIds: ['constraint:insurance'],
      },
      alternatives: [alternative],
    },
    {
      kind: 'decision_recorded' as const,
      eventId: 'decision:1',
      episodeId: 'episode:1',
      selectedActionId: 'action:a',
      decidedAt: times.decided,
      recordedAt: times.decided,
      selectionBasis: 'operator_judgment' as const,
      policy: null,
      assignmentProbability: null,
      decidedBy: { kind: 'operator' as const, id: 'operator:1' },
      rationale: 'Authorized carrier selected.',
      evidenceIds: ['decision-note:1'],
    },
    {
      kind: 'execution_started' as const,
      eventId: 'dispatch:1',
      episodeId: 'episode:1',
      actionId: 'action:a',
      loadId: 'load:1',
      startedAt: times.dispatched,
      recordedAt: times.dispatched,
      evidenceIds: ['dispatch-record:1'],
    },
  ]) {
    const appended = ledger.append(event);
    if (appended.kind === 'refusal') throw new Error(appended.detail);
  }
  return {
    operationId: 'operation:1',
    opportunity: opportunity(),
    phase: 'outcome_pending',
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
      evidenceIds: ['quote:carrier:a', 'capacity:carrier:a'],
      authorization: {
        loadId: 'load:1',
        decision: 'authorized',
        checks: [],
        blockedBy: [],
        decidedAt: times.opened,
        statement: 'authorized',
      },
      authorizationEventId: 'authorization:a',
      authorizationEvidenceIds: ['authorization:a'],
    }],
    episodeId: 'episode:1',
    decisionEntries: ledger.entries('episode:1'),
  };
}

function reader(snapshot = operationSnapshot()) {
  return {
    async get(operationId: string) {
      return operationId === snapshot.operationId
        ? snapshot
        : { kind: 'refusal' as const, code: 'OPERATION_NOT_FOUND' as const, detail: 'not found', remedy: 'register' };
    },
    async list() { return [snapshot]; },
  };
}

class QueueGateway implements CarrierDispatchGateway {
  readonly calls: Array<{ envelope: CarrierDispatchEnvelope; idempotencyKey: string }> = [];
  constructor(private readonly results: CarrierDispatchGatewayResult[]) {}
  async deliver(envelope: CarrierDispatchEnvelope, idempotencyKey: string) {
    this.calls.push({ envelope, idempotencyKey });
    const result = this.results.shift();
    if (!result) throw new Error('No queued gateway result.');
    return result;
  }
}

function delivered(
  receipt = 'receipt:1',
  completedAt = times.completed,
): CarrierDispatchGatewayResult {
  return {
    kind: 'delivered',
    provider: 'test-gateway',
    providerReceiptId: receipt,
    acceptedAt: completedAt,
    completedAt,
    evidenceIds: [`receipt:${receipt}`],
  };
}

describe('carrier communication workflow', () => {
  it('derives a stable carrier tender without shipper target rate or message identity', () => {
    const first = deriveCarrierDispatchEnvelope(operationSnapshot());
    const second = deriveCarrierDispatchEnvelope(operationSnapshot());
    expect(first).toEqual(second);
    expect(first).not.toHaveProperty('kind');
    if ('kind' in first) return;
    expect(first.tender.agreedRate).toMatchObject({
      amountMinor: 145000,
      currency: 'CAD',
      attestation: { evidenceClass: 'reported', interest: 'negotiating_position' },
      evidenceIds: ['quote:carrier:a'],
    });
    expect(JSON.stringify(first)).not.toContain('220000');
    expect(JSON.stringify(first)).not.toContain('private-message-reference');
  });

  it('delivers once, persists the receipt, and makes exact retries side-effect free', async () => {
    const gateway = new QueueGateway([delivered()]);
    const workflow = new CarrierCommunicationsWorkflow(
      reader(), new MemoryCarrierCommunicationStore(), gateway,
    );
    const command = { operationId: 'operation:1', eventId: 'attempt:1', requestedAt: times.requested };
    const sent = await workflow.send(command);
    expect(sent).toMatchObject({ kind: 'accepted', persistence: 'appended' });
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].idempotencyKey).toBe('attempt:1');
    expect(await workflow.send(command)).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });
    expect(gateway.calls).toHaveLength(1);
    expect(await workflow.send({ ...command, eventId: 'attempt:2' })).toMatchObject({
      kind: 'refusal', code: 'COMMUNICATION_ALREADY_DELIVERED',
    });
  });

  it('records retryable failure and permits a new explicit attempt', async () => {
    const gateway = new QueueGateway([
      {
        kind: 'failed', provider: 'test-gateway', code: 'PROVIDER_HTTP_503',
        detail: 'temporary failure', retryable: true, completedAt: times.completed,
        evidenceIds: ['carrier-http-status:503'],
      },
      delivered('receipt:retry', '2026-09-01T12:04:01.000Z'),
    ]);
    const workflow = new CarrierCommunicationsWorkflow(
      reader(), new MemoryCarrierCommunicationStore(), gateway,
    );
    expect(await workflow.send({
      operationId: 'operation:1', eventId: 'attempt:1', requestedAt: times.requested,
    })).toMatchObject({ kind: 'delivery_failed', snapshot: { deliveryState: 'failed' } });
    expect(await workflow.send({
      operationId: 'operation:1', eventId: 'attempt:2', requestedAt: '2026-09-01T12:04:00.000Z',
    })).toMatchObject({ kind: 'accepted', snapshot: { deliveryState: 'delivered' } });
    expect(gateway.calls).toHaveLength(2);
  });

  it('binds acknowledgements and tracking to the selected carrier and message', async () => {
    const workflow = new CarrierCommunicationsWorkflow(
      reader(), new MemoryCarrierCommunicationStore(), new QueueGateway([delivered()]),
    );
    await workflow.send({ operationId: 'operation:1', eventId: 'attempt:1', requestedAt: times.requested });
    const current = await workflow.get('operation:1');
    if ('kind' in current) throw new Error(current.detail);
    const base = {
      operationId: 'operation:1',
      messageId: current.envelope.messageId,
      eventId: 'carrier-event:1',
      carrierEventId: 'provider-event:1',
      carrierId: 'carrier:a',
      eventKind: 'acknowledgement' as const,
      status: 'accepted' as const,
      occurredAt: '2026-09-01T12:03:02.000Z',
      knownAt: '2026-09-01T12:03:03.000Z',
      recordedAt: '2026-09-01T12:03:04.000Z',
      evidenceIds: ['provider-event:1'],
    };
    expect(await workflow.recordCarrierEvent(base)).toMatchObject({
      kind: 'accepted', snapshot: { acknowledgement: 'accepted' },
    });
    expect(await workflow.recordCarrierEvent({
      ...base, recordedAt: '2026-09-01T12:03:05.000Z',
    })).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });
    expect(await workflow.recordCarrierEvent({
      ...base, eventId: 'carrier-event:2', carrierEventId: 'provider-event:2', carrierId: 'carrier:b',
    })).toMatchObject({ kind: 'refusal', code: 'COMMUNICATION_BINDING_MISMATCH' });
  });

  it('recovers delivery state from the file journal and refuses a partial tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-carrier-communications-'));
    dirs.push(dir);
    const path = join(dir, 'communications.jsonl');
    const first = new CarrierCommunicationsWorkflow(
      reader(), new FileCarrierCommunicationStore(path), new QueueGateway([delivered()]),
    );
    await first.send({ operationId: 'operation:1', eventId: 'attempt:1', requestedAt: times.requested });
    const recovered = new CarrierCommunicationsWorkflow(
      reader(), new FileCarrierCommunicationStore(path), new QueueGateway([]),
    );
    expect(await recovered.get('operation:1')).toMatchObject({ deliveryState: 'delivered' });
    await appendFile(path, '{"partial":');
    expect(await recovered.get('operation:1')).toMatchObject({
      kind: 'refusal', code: 'COMMUNICATION_STORE_CORRUPT',
    });
    expect(await readFile(path, 'utf8')).toContain('{"partial":');
  });

  it('refuses a hash-valid journal whose receipt timeline is semantically impossible', async () => {
    const store = new MemoryCarrierCommunicationStore();
    const envelope = deriveCarrierDispatchEnvelope(operationSnapshot());
    if ('kind' in envelope) throw new Error(envelope.detail);
    await store.append({
      kind: 'dispatch_attempt_started',
      eventId: 'attempt:forged',
      attemptId: 'attempt:forged',
      messageId: envelope.messageId,
      operationId: envelope.operationId,
      dispatchEventId: envelope.dispatchEventId,
      requestedAt: times.requested,
      recordedAt: times.requested,
      commandHash: hashCommand('forged-start'),
    });
    await store.append({
      kind: 'dispatch_attempt_succeeded',
      eventId: 'attempt:forged:result',
      attemptId: 'attempt:forged',
      messageId: envelope.messageId,
      operationId: envelope.operationId,
      dispatchEventId: envelope.dispatchEventId,
      provider: 'forged-provider',
      providerReceiptId: 'forged-receipt',
      acceptedAt: '2026-09-01T12:02:59.000Z',
      recordedAt: times.completed,
      evidenceIds: ['forged-receipt'],
      commandHash: hashCommand('forged-success'),
    });
    const workflow = new CarrierCommunicationsWorkflow(reader(), store, new QueueGateway([]));
    expect(await workflow.get('operation:1')).toMatchObject({
      kind: 'refusal', code: 'COMMUNICATION_STORE_CORRUPT',
    });
  });
});

describe('webhook carrier dispatch gateway', () => {
  it('refuses to send bearer authority over cleartext remote HTTP', () => {
    expect(() => new WebhookCarrierDispatchGateway({
      endpoint: 'http://carrier-adapter.example.test/tenders',
      bearerToken: 'PUBLIC-TEST-OUTBOUND-TOKEN-NOT-A-SECRET',
      provider: 'test-adapter',
    })).toThrow(/HTTPS/);
  });

  it('sends the stable idempotency key and accepts a bounded provider receipt', async () => {
    let captured: RequestInit | undefined;
    const gateway = new WebhookCarrierDispatchGateway({
      endpoint: 'https://carrier-adapter.example.test/tenders',
      bearerToken: 'PUBLIC-TEST-OUTBOUND-TOKEN-NOT-A-SECRET',
      provider: 'test-adapter',
      now: () => times.completed,
      fetcher: async (_input, init) => {
        captured = init;
        return new Response(JSON.stringify({ receiptId: 'provider:123', acceptedAt: times.completed }), {
          status: 202,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const envelope = deriveCarrierDispatchEnvelope(operationSnapshot());
    if ('kind' in envelope) throw new Error(envelope.detail);
    expect(await gateway.deliver(envelope, 'attempt:stable')).toMatchObject({
      kind: 'delivered', providerReceiptId: 'provider:123',
    });
    expect(new Headers(captured?.headers).get('idempotency-key')).toBe('attempt:stable');
    expect(new Headers(captured?.headers).get('authorization')).toBe(
      'Bearer PUBLIC-TEST-OUTBOUND-TOKEN-NOT-A-SECRET',
    );
    expect(String(captured?.body)).not.toContain('220000');
  });

  it('classifies provider outages without persisting the response body', async () => {
    const gateway = new WebhookCarrierDispatchGateway({
      endpoint: 'https://carrier-adapter.example.test/tenders',
      bearerToken: 'PUBLIC-TEST-OUTBOUND-TOKEN-NOT-A-SECRET',
      provider: 'test-adapter',
      now: () => times.completed,
      fetcher: async () => new Response('sensitive provider diagnostic', { status: 503 }),
    });
    const envelope = deriveCarrierDispatchEnvelope(operationSnapshot());
    if ('kind' in envelope) throw new Error(envelope.detail);
    const result = await gateway.deliver(envelope, 'attempt:stable');
    expect(result).toMatchObject({ kind: 'failed', code: 'PROVIDER_HTTP_503', retryable: true });
    expect(JSON.stringify(result)).not.toContain('sensitive provider diagnostic');
  });
});
