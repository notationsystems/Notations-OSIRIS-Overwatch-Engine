/** Append-only delivery and carrier-event evidence for dispatched loads. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { processSingleton } from './processSingleton';
import { stableValue } from './loadOperationsStore';
import type { Hash, ISODateTime } from './types';

interface CommunicationEventBase {
  readonly eventId: string;
  readonly messageId: string;
  readonly operationId: string;
  readonly dispatchEventId: string;
  readonly recordedAt: ISODateTime;
  readonly commandHash: Hash;
}

export interface DispatchAttemptStartedEvent extends CommunicationEventBase {
  readonly kind: 'dispatch_attempt_started';
  readonly attemptId: string;
  readonly requestedAt: ISODateTime;
}

export interface DispatchAttemptSucceededEvent extends CommunicationEventBase {
  readonly kind: 'dispatch_attempt_succeeded';
  readonly attemptId: string;
  readonly provider: string;
  readonly providerReceiptId: string;
  readonly acceptedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export interface DispatchAttemptFailedEvent extends CommunicationEventBase {
  readonly kind: 'dispatch_attempt_failed';
  readonly attemptId: string;
  readonly provider: string;
  readonly code: string;
  readonly detail: string;
  readonly retryable: boolean;
  readonly evidenceIds: readonly string[];
}

export type CarrierAcknowledgementStatus = 'accepted' | 'rejected';
export type CarrierTrackingStatus =
  | 'picked_up'
  | 'in_transit'
  | 'arrived'
  | 'delivered'
  | 'exception';

export interface CarrierEventRecordedEvent extends CommunicationEventBase {
  readonly kind: 'carrier_event_recorded';
  readonly carrierEventId: string;
  readonly carrierId: string;
  readonly eventKind: 'acknowledgement' | 'tracking';
  readonly status: CarrierAcknowledgementStatus | CarrierTrackingStatus;
  readonly occurredAt: ISODateTime;
  readonly knownAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export type CarrierCommunicationEvent =
  | DispatchAttemptStartedEvent
  | DispatchAttemptSucceededEvent
  | DispatchAttemptFailedEvent
  | CarrierEventRecordedEvent;

export interface StoredCarrierCommunicationRecord {
  readonly event: CarrierCommunicationEvent;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
}

export type CarrierCommunicationAppendResult =
  | { readonly kind: 'appended'; readonly record: StoredCarrierCommunicationRecord }
  | { readonly kind: 'duplicate'; readonly record: StoredCarrierCommunicationRecord }
  | {
      readonly kind: 'refusal';
      readonly code:
        | 'COMMUNICATION_EVENT_ID_CONFLICT'
        | 'COMMUNICATION_STORE_CONCURRENT_WRITE'
        | 'COMMUNICATION_STORE_CORRUPT';
      readonly detail: string;
      readonly remedy: string;
    };

export interface CarrierCommunicationEventStore {
  readonly durability: 'memory' | 'local_jsonl_single_writer';
  readAll(): Promise<readonly StoredCarrierCommunicationRecord[]>;
  append(
    event: CarrierCommunicationEvent,
    expectedPreviousHash?: Hash | null,
  ): Promise<CarrierCommunicationAppendResult>;
}

const DOMAIN = 'payload.carrier_communications.record.v1';

function hashRecord(event: CarrierCommunicationEvent, previousHash: Hash | null): Hash {
  return createHash('sha256')
    .update(`${DOMAIN}|${previousHash ?? 'GENESIS'}|${JSON.stringify(stableValue(event))}`)
    .digest('hex');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      freeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function refusal(
  code: Extract<CarrierCommunicationAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<CarrierCommunicationAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function verifyRecords(records: readonly StoredCarrierCommunicationRecord[]): string | null {
  let previous: Hash | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.event?.eventId || ids.has(record.event.eventId)) {
      return `empty or duplicate communication event id ${record.event?.eventId ?? '(missing)'}`;
    }
    if (!/^[a-f0-9]{64}$/.test(record.event.commandHash)) {
      return `record ${record.event.eventId} has an invalid command hash`;
    }
    if (record.previousHash !== previous) {
      return `record ${record.event.eventId} does not extend the preceding hash`;
    }
    if (record.recordHash !== hashRecord(record.event, previous)) {
      return `record ${record.event.eventId} hash does not match its canonical event`;
    }
    if (!Number.isFinite(Date.parse(record.event.recordedAt))) {
      return `record ${record.event.eventId} has an invalid recordedAt`;
    }
    ids.add(record.event.eventId);
    previous = record.recordHash;
  }
  return null;
}

function appendTo(
  records: StoredCarrierCommunicationRecord[],
  event: CarrierCommunicationEvent,
  expectedPreviousHash?: Hash | null,
): CarrierCommunicationAppendResult {
  const existing = records.find(record => record.event.eventId === event.eventId);
  if (existing) {
    if (JSON.stringify(stableValue(existing.event)) === JSON.stringify(stableValue(event))) {
      return { kind: 'duplicate', record: existing };
    }
    return refusal(
      'COMMUNICATION_EVENT_ID_CONFLICT',
      `Communication event id ${event.eventId} already identifies different content.`,
      'Retry the original command or allocate a new event id.',
    );
  }
  const previousHash = records.length ? records[records.length - 1].recordHash : null;
  if (expectedPreviousHash !== undefined && expectedPreviousHash !== previousHash) {
    return refusal(
      'COMMUNICATION_STORE_CONCURRENT_WRITE',
      `Journal tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'}.`,
      'Reload communication state and retry the same event id.',
    );
  }
  const sealedEvent = freeze(event);
  const record = freeze({ event: sealedEvent, previousHash, recordHash: hashRecord(sealedEvent, previousHash) });
  records.push(record);
  return { kind: 'appended', record };
}

export class MemoryCarrierCommunicationStore implements CarrierCommunicationEventStore {
  readonly durability = 'memory' as const;
  private readonly records: StoredCarrierCommunicationRecord[] = [];

  async readAll(): Promise<readonly StoredCarrierCommunicationRecord[]> {
    return Object.freeze([...this.records]);
  }

  async append(
    event: CarrierCommunicationEvent,
    expectedPreviousHash?: Hash | null,
  ): Promise<CarrierCommunicationAppendResult> {
    return appendTo(this.records, event, expectedPreviousHash);
  }
}

type QueueRegistry = Map<string, Promise<unknown>>;
const fileQueues = () => processSingleton<QueueRegistry>('carrier-communication-file-queues', () => new Map());

async function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const queues = fileQueues();
  const prior = queues.get(path) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  queues.set(path, current);
  try { return await current; }
  finally { if (queues.get(path) === current) queues.delete(path); }
}

export class FileCarrierCommunicationStore implements CarrierCommunicationEventStore {
  readonly durability = 'local_jsonl_single_writer' as const;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async readAll(): Promise<readonly StoredCarrierCommunicationRecord[]> {
    let body: string;
    try { body = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!body) return Object.freeze([]);
    if (!body.endsWith('\n')) {
      throw new Error('COMMUNICATION_STORE_CORRUPT: journal ends with a partial record');
    }
    const records: StoredCarrierCommunicationRecord[] = [];
    for (const [index, line] of body.slice(0, -1).split('\n').entries()) {
      try { records.push(JSON.parse(line) as StoredCarrierCommunicationRecord); }
      catch { throw new Error(`COMMUNICATION_STORE_CORRUPT: journal line ${index + 1} is not valid JSON`); }
    }
    const defect = verifyRecords(records);
    if (defect) throw new Error(`COMMUNICATION_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  async append(
    event: CarrierCommunicationEvent,
    expectedPreviousHash?: Hash | null,
  ): Promise<CarrierCommunicationAppendResult> {
    return serialized(this.filePath, async () => {
      let records: StoredCarrierCommunicationRecord[];
      try { records = [...await this.readAll()]; }
      catch (error) {
        return refusal(
          'COMMUNICATION_STORE_CORRUPT',
          (error as Error).message,
          'Restore the delivery journal from a verified replica; never truncate an invalid line automatically.',
        );
      }
      const result = appendTo(records, event, expectedPreviousHash);
      if (result.kind !== 'appended') return result;
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(result.record)}\n`, { encoding: 'utf8', flag: 'a' });
      return result;
    });
  }
}
