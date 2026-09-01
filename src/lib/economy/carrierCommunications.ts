/** Durable carrier tender delivery and inbound carrier-event workflow. */

import type { DecisionLedgerEntry, DecisionMetric, ExecutionStartedEvent } from './decisionEpisode';
import type { Field, OpportunityFieldName } from './intake';
import type {
  LoadOperationRefusal,
  LoadOperationSnapshot,
  LoadOperationsWorkflow,
  OperationalAlternativeState,
} from './loadOperations';
import { hashCommand } from './loadOperationsStore';
import {
  type CarrierAcknowledgementStatus,
  type CarrierCommunicationEvent,
  type CarrierCommunicationEventStore,
  type CarrierEventRecordedEvent,
  type CarrierTrackingStatus,
  type DispatchAttemptFailedEvent,
  type DispatchAttemptStartedEvent,
  type DispatchAttemptSucceededEvent,
  type StoredCarrierCommunicationRecord,
} from './carrierCommunicationsStore';
import type { ISODateTime } from './types';

export interface CarrierDispatchEnvelope {
  readonly schemaVersion: 'payload.carrier_dispatch.v1';
  readonly messageId: string;
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly loadId: string;
  readonly actionId: string;
  readonly carrierId: string;
  readonly laneId: string;
  readonly tender: {
    readonly origin: string;
    readonly destination: string;
    readonly equipment: string;
    readonly pickupWindow: string;
    readonly commodity: Field<string | number>;
    readonly weightLbs: Field<string | number>;
    readonly deliveryWindow: Field<string | number>;
    readonly agreedRate: {
      readonly amountMinor: number;
      readonly currency: string;
      readonly attestation: DecisionMetric['attestation'];
      readonly evidenceIds: readonly string[];
    };
  };
  readonly sourceEvidenceIds: readonly string[];
}

export interface CarrierDispatchAttempt {
  readonly attemptId: string;
  readonly state: 'sending' | 'delivered' | 'failed';
  readonly requestedAt: ISODateTime;
  readonly completedAt: ISODateTime | null;
  readonly provider: string | null;
  readonly providerReceiptId: string | null;
  readonly failure: {
    readonly code: string;
    readonly detail: string;
    readonly retryable: boolean;
  } | null;
}

export interface CarrierEventEvidence {
  readonly eventId: string;
  readonly carrierEventId: string;
  readonly eventKind: 'acknowledgement' | 'tracking';
  readonly status: CarrierAcknowledgementStatus | CarrierTrackingStatus;
  readonly occurredAt: ISODateTime;
  readonly knownAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export interface CarrierCommunicationSnapshot {
  readonly envelope: CarrierDispatchEnvelope;
  readonly durability: CarrierCommunicationEventStore['durability'];
  readonly deliveryState: 'pending' | 'sending' | 'delivered' | 'failed';
  readonly acknowledgement: 'pending' | CarrierAcknowledgementStatus;
  readonly latestTrackingStatus: CarrierTrackingStatus | null;
  readonly attempts: readonly CarrierDispatchAttempt[];
  readonly carrierEvents: readonly CarrierEventEvidence[];
}

export type CarrierCommunicationRefusalCode =
  | 'COMMUNICATION_COMMAND_INVALID'
  | 'COMMUNICATION_OPERATION_NOT_FOUND'
  | 'COMMUNICATION_DISPATCH_NOT_READY'
  | 'COMMUNICATION_RATE_MISSING'
  | 'COMMUNICATION_MESSAGE_UNKNOWN'
  | 'COMMUNICATION_BINDING_MISMATCH'
  | 'COMMUNICATION_ALREADY_DELIVERED'
  | 'COMMUNICATION_CARRIER_EVENT_REFUSED'
  | 'COMMUNICATION_EVENT_ID_CONFLICT'
  | 'COMMUNICATION_STORE_CONCURRENT_WRITE'
  | 'COMMUNICATION_STORE_CORRUPT'
  | 'COMMUNICATION_STORE_UNAVAILABLE';

export interface CarrierCommunicationRefusal {
  readonly kind: 'refusal';
  readonly code: CarrierCommunicationRefusalCode;
  readonly detail: string;
  readonly remedy: string;
}

export type CarrierCommunicationCommandResult =
  | {
      readonly kind: 'accepted';
      readonly persistence: 'appended' | 'duplicate';
      readonly snapshot: CarrierCommunicationSnapshot;
    }
  | {
      readonly kind: 'delivery_failed';
      readonly persistence: 'appended' | 'duplicate';
      readonly snapshot: CarrierCommunicationSnapshot;
    }
  | CarrierCommunicationRefusal;

export interface SendCarrierDispatchCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly requestedAt: ISODateTime;
}

export interface RecordCarrierEventCommand {
  readonly operationId: string;
  readonly messageId: string;
  readonly eventId: string;
  readonly carrierEventId: string;
  readonly carrierId: string;
  readonly eventKind: 'acknowledgement' | 'tracking';
  readonly status: CarrierAcknowledgementStatus | CarrierTrackingStatus;
  readonly occurredAt: ISODateTime;
  readonly knownAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export type CarrierDispatchGatewayResult =
  | {
      readonly kind: 'delivered';
      readonly provider: string;
      readonly providerReceiptId: string;
      readonly acceptedAt: ISODateTime;
      readonly completedAt: ISODateTime;
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly kind: 'failed';
      readonly provider: string;
      readonly code: string;
      readonly detail: string;
      readonly retryable: boolean;
      readonly completedAt: ISODateTime;
      readonly evidenceIds: readonly string[];
    };

export interface CarrierDispatchGateway {
  deliver(envelope: CarrierDispatchEnvelope, idempotencyKey: string): Promise<CarrierDispatchGatewayResult>;
}

type OperationsReader = Pick<LoadOperationsWorkflow, 'get' | 'list'>;

class CommunicationProjectionDefect extends Error {}

function refusal(
  code: CarrierCommunicationRefusalCode,
  detail: string,
  remedy: string,
): CarrierCommunicationRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function nonEmpty(values: readonly string[] | undefined): values is readonly string[] {
  return !!values?.length && values.every(value => typeof value === 'string' && value.trim().length > 0);
}

function latest<T extends DecisionLedgerEntry['event']['kind']>(
  entries: readonly DecisionLedgerEntry[],
  kind: T,
): Extract<DecisionLedgerEntry['event'], { kind: T }> | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.kind === kind) return event as Extract<DecisionLedgerEntry['event'], { kind: T }>;
  }
  return null;
}

function presentString(snapshot: LoadOperationSnapshot, name: OpportunityFieldName): string | null {
  const field = snapshot.opportunity.fields[name];
  return field.state === 'present' && typeof field.value === 'string' && field.value.trim()
    ? field.value
    : null;
}

function selectedAlternative(
  snapshot: LoadOperationSnapshot,
  execution: ExecutionStartedEvent,
): OperationalAlternativeState | null {
  return snapshot.alternatives.find(value => value.alternative.actionId === execution.actionId) ?? null;
}

function validMoney(metric: DecisionMetric | null): metric is DecisionMetric & { currency: string } {
  return !!metric && metric.unit === 'money_minor' && Number.isFinite(metric.value) &&
    metric.value >= 0 && !!metric.currency?.trim();
}

/** Derive the immutable external tender from the authorized execution record. */
export function deriveCarrierDispatchEnvelope(
  snapshot: LoadOperationSnapshot,
): CarrierDispatchEnvelope | CarrierCommunicationRefusal {
  const execution = latest(snapshot.decisionEntries, 'execution_started');
  if (!execution) {
    return refusal(
      'COMMUNICATION_DISPATCH_NOT_READY',
      `${snapshot.operationId} has no authorized execution record.`,
      'Complete authorization, assignment, and dispatch before communicating the tender.',
    );
  }
  const alternative = selectedAlternative(snapshot, execution);
  if (!alternative || alternative.authorization?.decision !== 'authorized' ||
      alternative.authorization.loadId !== execution.loadId) {
    return refusal(
      'COMMUNICATION_BINDING_MISMATCH',
      `${execution.eventId} does not bind to an authorized carrier alternative for ${execution.loadId}.`,
      'Stop delivery and repair the operation journal from a verified copy.',
    );
  }
  const quotedCost = alternative.alternative.quotedCost;
  if (!validMoney(quotedCost)) {
    return refusal(
      'COMMUNICATION_RATE_MISSING',
      `Selected action ${execution.actionId} has no explicit monetary carrier rate.`,
      'Record an evidenced carrier rate before sending a binding tender.',
    );
  }
  const origin = presentString(snapshot, 'origin');
  const destination = presentString(snapshot, 'destination');
  const equipment = presentString(snapshot, 'equipment');
  const pickupWindow = presentString(snapshot, 'pickupWindow');
  if (!origin || !destination || !equipment || !pickupWindow) {
    return refusal(
      'COMMUNICATION_DISPATCH_NOT_READY',
      `${snapshot.operationId} lacks a carrier-tender routing field.`,
      'Resolve origin, destination, equipment, and pickup window before delivery.',
    );
  }
  const messageId = `dispatch:${hashCommand({
    domain: 'payload.carrier_dispatch.message.v1',
    operationId: snapshot.operationId,
    dispatchEventId: execution.eventId,
    loadId: execution.loadId,
    carrierId: alternative.alternative.carrierId,
  })}`;
  return Object.freeze({
    schemaVersion: 'payload.carrier_dispatch.v1' as const,
    messageId,
    operationId: snapshot.operationId,
    dispatchEventId: execution.eventId,
    loadId: execution.loadId,
    actionId: execution.actionId,
    carrierId: alternative.alternative.carrierId,
    laneId: alternative.alternative.laneId,
    tender: Object.freeze({
      origin,
      destination,
      equipment,
      pickupWindow,
      commodity: snapshot.opportunity.fields.commodity,
      weightLbs: snapshot.opportunity.fields.weightLbs,
      deliveryWindow: snapshot.opportunity.fields.deliveryWindow,
      agreedRate: Object.freeze({
        amountMinor: quotedCost.value,
        currency: quotedCost.currency,
        attestation: quotedCost.attestation,
        evidenceIds: quotedCost.evidenceIds,
      }),
    }),
    sourceEvidenceIds: Object.freeze([...new Set([
      ...alternative.evidenceIds,
      ...quotedCost.evidenceIds,
      ...execution.evidenceIds,
    ])]),
  });
}

function project(
  envelope: CarrierDispatchEnvelope,
  records: readonly StoredCarrierCommunicationRecord[],
  durability: CarrierCommunicationEventStore['durability'],
): CarrierCommunicationSnapshot {
  const events = records.map(record => record.event).filter(event => event.messageId === envelope.messageId);
  const attempts = new Map<string, CarrierDispatchAttempt>();
  const carrierEvents: CarrierEventEvidence[] = [];
  const carrierEventIds = new Set<string>();
  let previousRecordedAt: number | null = null;
  for (const event of events) {
    if (event.operationId !== envelope.operationId || event.dispatchEventId !== envelope.dispatchEventId) {
      throw new CommunicationProjectionDefect(`${event.eventId} is bound to a different dispatch envelope`);
    }
    const recordedAt = Date.parse(event.recordedAt);
    if (previousRecordedAt !== null && recordedAt < previousRecordedAt) {
      throw new CommunicationProjectionDefect(`${event.eventId} is recorded before its message predecessor`);
    }
    previousRecordedAt = recordedAt;
    if (event.kind === 'dispatch_attempt_started') {
      const requestedAt = Date.parse(event.requestedAt);
      if (!event.attemptId.trim() || !Number.isFinite(requestedAt) || requestedAt > recordedAt) {
        throw new CommunicationProjectionDefect(`attempt ${event.eventId} has invalid identity or request time`);
      }
      if (attempts.has(event.attemptId)) {
        throw new CommunicationProjectionDefect(`attempt ${event.attemptId} starts more than once`);
      }
      attempts.set(event.attemptId, Object.freeze({
        attemptId: event.attemptId,
        state: 'sending' as const,
        requestedAt: event.requestedAt,
        completedAt: null,
        provider: null,
        providerReceiptId: null,
        failure: null,
      }));
    } else if (event.kind === 'dispatch_attempt_succeeded') {
      const attempt = attempts.get(event.attemptId);
      if (!attempt || attempt.state !== 'sending') {
        throw new CommunicationProjectionDefect(`success ${event.eventId} has no open attempt`);
      }
      const acceptedAt = Date.parse(event.acceptedAt);
      if (!event.provider.trim() || !event.providerReceiptId.trim() || !nonEmpty(event.evidenceIds) ||
          !Number.isFinite(acceptedAt) || acceptedAt > recordedAt ||
          Date.parse(attempt.requestedAt) > acceptedAt) {
        throw new CommunicationProjectionDefect(`success ${event.eventId} has invalid receipt evidence or time`);
      }
      attempts.set(event.attemptId, Object.freeze({
        ...attempt,
        state: 'delivered' as const,
        completedAt: event.recordedAt,
        provider: event.provider,
        providerReceiptId: event.providerReceiptId,
      }));
    } else if (event.kind === 'dispatch_attempt_failed') {
      const attempt = attempts.get(event.attemptId);
      if (!attempt || attempt.state !== 'sending') {
        throw new CommunicationProjectionDefect(`failure ${event.eventId} has no open attempt`);
      }
      if (!event.provider.trim() || !event.code.trim() || !event.detail.trim() || !nonEmpty(event.evidenceIds) ||
          Date.parse(attempt.requestedAt) > recordedAt) {
        throw new CommunicationProjectionDefect(`failure ${event.eventId} has invalid failure evidence or time`);
      }
      attempts.set(event.attemptId, Object.freeze({
        ...attempt,
        state: 'failed' as const,
        completedAt: event.recordedAt,
        provider: event.provider,
        failure: Object.freeze({ code: event.code, detail: event.detail, retryable: event.retryable }),
      }));
    } else {
      if (attempts.size === 0) {
        throw new CommunicationProjectionDefect(`carrier event ${event.eventId} precedes any delivery attempt`);
      }
      if (event.carrierId !== envelope.carrierId) {
        throw new CommunicationProjectionDefect(`carrier event ${event.eventId} names another carrier`);
      }
      const statuses = event.eventKind === 'acknowledgement'
        ? new Set<string>(['accepted', 'rejected'])
        : new Set<string>(['picked_up', 'in_transit', 'arrived', 'delivered', 'exception']);
      const occurredAt = Date.parse(event.occurredAt);
      const knownAt = Date.parse(event.knownAt);
      if (!event.carrierEventId.trim() || carrierEventIds.has(event.carrierEventId) ||
          !statuses.has(event.status) || !nonEmpty(event.evidenceIds) ||
          !Number.isFinite(occurredAt) || !Number.isFinite(knownAt) ||
          occurredAt > knownAt || knownAt > recordedAt) {
        throw new CommunicationProjectionDefect(`carrier event ${event.eventId} has invalid or duplicate evidence`);
      }
      carrierEventIds.add(event.carrierEventId);
      carrierEvents.push(Object.freeze({
        eventId: event.eventId,
        carrierEventId: event.carrierEventId,
        eventKind: event.eventKind,
        status: event.status,
        occurredAt: event.occurredAt,
        knownAt: event.knownAt,
        recordedAt: event.recordedAt,
        evidenceIds: event.evidenceIds,
      }));
    }
  }
  const attemptList = [...attempts.values()];
  const lastAttempt = attemptList.at(-1);
  const acknowledgement = [...carrierEvents].reverse()
    .find(event => event.eventKind === 'acknowledgement')?.status ?? 'pending';
  const tracking = [...carrierEvents].reverse().find(event => event.eventKind === 'tracking')?.status ?? null;
  return Object.freeze({
    envelope,
    durability,
    deliveryState: lastAttempt?.state ?? 'pending',
    acknowledgement: acknowledgement as CarrierCommunicationSnapshot['acknowledgement'],
    latestTrackingStatus: tracking as CarrierTrackingStatus | null,
    attempts: Object.freeze(attemptList),
    carrierEvents: Object.freeze(carrierEvents),
  });
}

function commandDefect(eventId: string, at: string): CarrierCommunicationRefusal | null {
  if (!eventId?.trim() || !Number.isFinite(Date.parse(at))) {
    return refusal(
      'COMMUNICATION_COMMAND_INVALID',
      'Communication event identity or timestamp is invalid.',
      'Supply a stable event id and explicit ISO timestamp.',
    );
  }
  return null;
}

function isOperationRefusal(value: LoadOperationSnapshot | LoadOperationRefusal): value is LoadOperationRefusal {
  return 'kind' in value && value.kind === 'refusal';
}

function isOperationList(
  value: readonly LoadOperationSnapshot[] | LoadOperationRefusal,
): value is readonly LoadOperationSnapshot[] {
  return Array.isArray(value);
}

function isCommunicationRefusal(
  value: CarrierDispatchEnvelope | CarrierCommunicationRefusal,
): value is CarrierCommunicationRefusal {
  return 'kind' in value && value.kind === 'refusal';
}

export class CarrierCommunicationsWorkflow {
  constructor(
    private readonly operations: OperationsReader,
    private readonly store: CarrierCommunicationEventStore,
    private readonly gateway: CarrierDispatchGateway,
  ) {}

  async list(): Promise<readonly CarrierCommunicationSnapshot[] | CarrierCommunicationRefusal> {
    const operations = await this.operations.list();
    if (!isOperationList(operations)) return this.operationFailure(operations);
    let records: readonly StoredCarrierCommunicationRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return this.storeFailure(error); }
    const envelopes = new Map<string, CarrierDispatchEnvelope>();
    for (const operation of operations) {
      const derived = deriveCarrierDispatchEnvelope(operation);
      if (isCommunicationRefusal(derived)) {
        if (derived.code === 'COMMUNICATION_DISPATCH_NOT_READY') continue;
        return derived;
      }
      envelopes.set(derived.messageId, derived);
    }
    for (const record of records) {
      const envelope = envelopes.get(record.event.messageId);
      if (!envelope || envelope.operationId !== record.event.operationId ||
          envelope.dispatchEventId !== record.event.dispatchEventId) {
        return refusal(
          'COMMUNICATION_STORE_CORRUPT',
          `${record.event.eventId} references no current immutable dispatch envelope.`,
          'Stop delivery and restore both journals from a mutually consistent backup.',
        );
      }
    }
    try {
      return Object.freeze([...envelopes.values()].map(envelope => project(envelope, records, this.store.durability)));
    } catch (error) { return this.projectionFailure(error); }
  }

  async get(operationId: string): Promise<CarrierCommunicationSnapshot | CarrierCommunicationRefusal> {
    const envelope = await this.envelope(operationId);
    if (isCommunicationRefusal(envelope)) return envelope;
    try { return project(envelope, await this.store.readAll(), this.store.durability); }
    catch (error) { return this.storeOrProjectionFailure(error); }
  }

  async send(command: SendCarrierDispatchCommand): Promise<CarrierCommunicationCommandResult> {
    const invalid = commandDefect(command.eventId, command.requestedAt);
    if (invalid || !command.operationId?.trim()) return invalid ?? refusal(
      'COMMUNICATION_COMMAND_INVALID', 'Operation identity is empty.', 'Name the dispatched operation.',
    );
    const envelope = await this.envelope(command.operationId);
    if (isCommunicationRefusal(envelope)) return envelope;
    let records: readonly StoredCarrierCommunicationRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(command);
    const existing = records.find(record => record.event.eventId === command.eventId);
    if (existing && existing.event.commandHash !== commandHash) {
      return refusal(
        'COMMUNICATION_EVENT_ID_CONFLICT',
        `${command.eventId} already identifies another send command.`,
        'Retry the original send or allocate a new attempt event id.',
      );
    }
    let snapshot: CarrierCommunicationSnapshot;
    try { snapshot = project(envelope, records, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    const resultEventId = `${command.eventId}:result`;
    const existingResult = records.find(record => record.event.eventId === resultEventId);
    if (existingResult) {
      return {
        kind: existingResult.event.kind === 'dispatch_attempt_failed' ? 'delivery_failed' : 'accepted',
        persistence: 'duplicate',
        snapshot,
      };
    }
    if (!existing && snapshot.attempts.some(attempt => attempt.state === 'delivered')) {
      return refusal(
        'COMMUNICATION_ALREADY_DELIVERED',
        `${envelope.messageId} already has a provider receipt.`,
        'Do not create a second binding tender; wait for acknowledgement or record a carrier event.',
      );
    }
    if (!existing) {
      const started: DispatchAttemptStartedEvent = {
        kind: 'dispatch_attempt_started',
        eventId: command.eventId,
        attemptId: command.eventId,
        messageId: envelope.messageId,
        operationId: envelope.operationId,
        dispatchEventId: envelope.dispatchEventId,
        requestedAt: command.requestedAt,
        recordedAt: command.requestedAt,
        commandHash,
      };
      const appended = await this.append(started, records, envelope);
      if (appended.kind === 'refusal') return appended;
      try { records = await this.readStoreOrThrow(); }
      catch (error) { return this.storeFailure(error); }
    }
    const delivered = await this.gateway.deliver(envelope, command.eventId);
    const requestedAt = Date.parse(command.requestedAt);
    const completedAt = Date.parse(delivered.completedAt);
    const gatewayInvalid = !Number.isFinite(completedAt) || completedAt < requestedAt ||
      !delivered.provider?.trim() || !nonEmpty(delivered.evidenceIds) ||
      (delivered.kind === 'delivered'
        ? !delivered.providerReceiptId?.trim() || !Number.isFinite(Date.parse(delivered.acceptedAt)) ||
          Date.parse(delivered.acceptedAt) < requestedAt || Date.parse(delivered.acceptedAt) > completedAt
        : !delivered.code?.trim() || !delivered.detail?.trim());
    if (gatewayInvalid) {
      return refusal(
        'COMMUNICATION_COMMAND_INVALID',
        'Carrier gateway returned invalid identity, evidence, receipt, or timing.',
        'Correct the adapter contract and retry the same attempt event id.',
      );
    }
    const resultEvent: DispatchAttemptSucceededEvent | DispatchAttemptFailedEvent = delivered.kind === 'delivered'
      ? {
          kind: 'dispatch_attempt_succeeded', eventId: resultEventId, attemptId: command.eventId,
          messageId: envelope.messageId, operationId: envelope.operationId,
          dispatchEventId: envelope.dispatchEventId, recordedAt: delivered.completedAt,
          provider: delivered.provider, providerReceiptId: delivered.providerReceiptId,
          acceptedAt: delivered.acceptedAt, evidenceIds: delivered.evidenceIds,
          commandHash: hashCommand({ command, delivered }),
        }
      : {
          kind: 'dispatch_attempt_failed', eventId: resultEventId, attemptId: command.eventId,
          messageId: envelope.messageId, operationId: envelope.operationId,
          dispatchEventId: envelope.dispatchEventId, recordedAt: delivered.completedAt,
          provider: delivered.provider, code: delivered.code, detail: delivered.detail,
          retryable: delivered.retryable, evidenceIds: delivered.evidenceIds,
          commandHash: hashCommand({ command, delivered }),
        };
    const appended = await this.append(resultEvent, records, envelope);
    if (appended.kind === 'refusal') return appended;
    let projected: CarrierCommunicationSnapshot;
    try { projected = project(envelope, await this.readStoreOrThrow(), this.store.durability); }
    catch (error) { return this.storeOrProjectionFailure(error); }
    return {
      kind: delivered.kind === 'delivered' ? 'accepted' : 'delivery_failed',
      persistence: appended.persistence,
      snapshot: projected,
    };
  }

  async recordCarrierEvent(command: RecordCarrierEventCommand): Promise<CarrierCommunicationCommandResult> {
    const invalid = commandDefect(command.eventId, command.recordedAt);
    if (invalid) return invalid;
    const statuses = command.eventKind === 'acknowledgement'
      ? new Set<string>(['accepted', 'rejected'])
      : new Set<string>(['picked_up', 'in_transit', 'arrived', 'delivered', 'exception']);
    if (!command.operationId?.trim() || !command.messageId?.trim() || !command.carrierEventId?.trim() ||
        !command.carrierId?.trim() || !statuses.has(command.status) ||
        !command.evidenceIds?.length || command.evidenceIds.some(value => !value.trim())) {
      return refusal(
        'COMMUNICATION_COMMAND_INVALID',
        'Carrier event identity, status, binding, or evidence is invalid.',
        'Supply the provider event id, exact message/carrier binding, recognized status, and evidence.',
      );
    }
    const occurred = Date.parse(command.occurredAt);
    const known = Date.parse(command.knownAt);
    const recorded = Date.parse(command.recordedAt);
    if (![occurred, known, recorded].every(Number.isFinite) || occurred > known || known > recorded) {
      return refusal(
        'COMMUNICATION_COMMAND_INVALID',
        'Carrier event violates occurredAt <= knownAt <= recordedAt.',
        'Preserve the physical, knowledge, and recording clocks.',
      );
    }
    const envelope = await this.envelope(command.operationId);
    if (isCommunicationRefusal(envelope)) return envelope;
    if (envelope.messageId !== command.messageId || envelope.carrierId !== command.carrierId) {
      return refusal(
        'COMMUNICATION_BINDING_MISMATCH',
        `${command.carrierEventId} does not name the selected dispatch message and carrier.`,
        'Reject the callback and reconcile provider routing before recording it.',
      );
    }
    let records: readonly StoredCarrierCommunicationRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(command);
    const existing = records.find(record => record.event.eventId === command.eventId);
    if (existing) {
      const retryHash = existing.event.kind === 'carrier_event_recorded'
        ? hashCommand({ ...command, recordedAt: existing.event.recordedAt })
        : commandHash;
      if (existing.event.commandHash !== retryHash) {
        return refusal(
          'COMMUNICATION_EVENT_ID_CONFLICT',
          `${command.eventId} already identifies different carrier evidence.`,
          'Retry the original provider event or use its real stable event id.',
        );
      }
      return { kind: 'accepted', persistence: 'duplicate', snapshot: project(envelope, records, this.store.durability) };
    }
    const before = project(envelope, records, this.store.durability);
    if (before.attempts.length === 0) {
      return refusal(
        'COMMUNICATION_CARRIER_EVENT_REFUSED',
        `${envelope.messageId} has never been offered to a delivery gateway.`,
        'Send the dispatch before accepting carrier acknowledgement or tracking evidence.',
      );
    }
    const event: CarrierEventRecordedEvent = {
      kind: 'carrier_event_recorded',
      ...command,
      dispatchEventId: envelope.dispatchEventId,
      commandHash,
    };
    const appended = await this.append(event, records, envelope);
    if (appended.kind === 'refusal') return appended;
    let projected: CarrierCommunicationSnapshot;
    try { projected = project(envelope, await this.readStoreOrThrow(), this.store.durability); }
    catch (error) { return this.storeOrProjectionFailure(error); }
    return {
      kind: 'accepted', persistence: appended.persistence,
      snapshot: projected,
    };
  }

  private async envelope(
    operationId: string,
  ): Promise<CarrierDispatchEnvelope | CarrierCommunicationRefusal> {
    const operation = await this.operations.get(operationId);
    if (isOperationRefusal(operation)) return this.operationFailure(operation);
    return deriveCarrierDispatchEnvelope(operation);
  }

  private async append(
    event: CarrierCommunicationEvent,
    records: readonly StoredCarrierCommunicationRecord[],
    envelope: CarrierDispatchEnvelope,
  ): Promise<
    | { kind: 'accepted'; persistence: 'appended' | 'duplicate' }
    | CarrierCommunicationRefusal
  > {
    try {
      const previousHash = records.length ? records[records.length - 1].recordHash : null;
      project(envelope, [...records, { event, previousHash, recordHash: '' }], this.store.durability);
      const result = await this.store.append(event, previousHash);
      if (result.kind === 'refusal') return refusal(result.code, result.detail, result.remedy);
      return { kind: 'accepted', persistence: result.kind === 'duplicate' ? 'duplicate' : 'appended' };
    } catch (error) { return this.storeOrProjectionFailure(error); }
  }

  private async readStoreOrThrow(): Promise<readonly StoredCarrierCommunicationRecord[]> {
    return this.store.readAll();
  }

  private operationFailure(value: LoadOperationRefusal): CarrierCommunicationRefusal {
    if (value.code === 'OPERATION_STORE_CORRUPT') {
      return refusal('COMMUNICATION_STORE_CORRUPT', value.detail, value.remedy);
    }
    return refusal(
      value.code === 'OPERATION_NOT_FOUND'
        ? 'COMMUNICATION_OPERATION_NOT_FOUND'
        : value.code.includes('STORE')
          ? 'COMMUNICATION_STORE_UNAVAILABLE'
          : 'COMMUNICATION_DISPATCH_NOT_READY',
      value.detail,
      value.remedy,
    );
  }

  private projectionFailure(error: unknown): CarrierCommunicationRefusal {
    return refusal(
      'COMMUNICATION_STORE_CORRUPT',
      (error as Error).message,
      'Stop carrier delivery and restore the communication journal from a verified copy.',
    );
  }

  private storeFailure(error: unknown): CarrierCommunicationRefusal {
    return refusal(
      (error as Error).message.includes('COMMUNICATION_STORE_CORRUPT')
        ? 'COMMUNICATION_STORE_CORRUPT'
        : 'COMMUNICATION_STORE_UNAVAILABLE',
      (error as Error).message,
      'Restore persistent communication storage and retry the same event id.',
    );
  }

  private storeOrProjectionFailure(error: unknown): CarrierCommunicationRefusal {
    return error instanceof CommunicationProjectionDefect
      ? this.projectionFailure(error)
      : this.storeFailure(error);
  }
}
