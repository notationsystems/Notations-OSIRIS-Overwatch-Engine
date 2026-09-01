/**
 * Append-only persistence for load-operation workflow events.
 *
 * The JSONL file is a local/single-writer durability adapter. Every line is a
 * hash-linked record; restart recovery replays and verifies the entire chain.
 * A partial or conflicting line refuses recovery instead of truncating history.
 */

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { processSingleton } from './processSingleton';
import type { Authorization } from './authorization';
import type { DecisionAlternative, DecisionEpisodeEvent } from './decisionEpisode';
import type { Opportunity } from './intake';
import type { Hash, ISODateTime } from './types';

export interface OperationalAlternativeDraft {
  readonly actionId: string;
  readonly carrierId: string;
  readonly laneId: string;
  readonly departureWindow: DecisionAlternative['departureWindow'];
  readonly quotedCost: DecisionAlternative['quotedCost'];
  readonly predictedOutcomes: DecisionAlternative['predictedOutcomes'];
}

interface OperationEventBase {
  readonly eventId: string;
  readonly operationId: string;
  readonly recordedAt: ISODateTime;
  /** Hash of caller-supplied command fields, used to distinguish retry from collision. */
  readonly commandHash: Hash;
}

export interface OpportunityRegisteredEvent extends OperationEventBase {
  readonly kind: 'opportunity_registered';
  readonly opportunity: Opportunity;
}

export interface AlternativeRegisteredEvent extends OperationEventBase {
  readonly kind: 'alternative_registered';
  readonly alternative: OperationalAlternativeDraft;
  readonly evidenceIds: readonly string[];
}

export interface AuthorizationRecordedEvent extends OperationEventBase {
  readonly kind: 'authorization_recorded';
  readonly actionId: string;
  readonly authorization: Authorization;
  readonly evidenceIds: readonly string[];
}

export interface DecisionEventRecorded extends OperationEventBase {
  readonly kind: 'decision_event_recorded';
  readonly decisionEvent: DecisionEpisodeEvent;
}

export type LoadOperationEvent =
  | OpportunityRegisteredEvent
  | AlternativeRegisteredEvent
  | AuthorizationRecordedEvent
  | DecisionEventRecorded;

export interface StoredLoadOperationRecord {
  readonly event: LoadOperationEvent;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
}

export type LoadOperationStoreAppendResult =
  | { readonly kind: 'appended'; readonly record: StoredLoadOperationRecord }
  | { readonly kind: 'duplicate'; readonly record: StoredLoadOperationRecord }
  | {
      readonly kind: 'refusal';
      readonly code:
        | 'OPERATION_EVENT_ID_CONFLICT'
        | 'OPERATION_STORE_CONCURRENT_WRITE'
        | 'OPERATION_STORE_CORRUPT';
      readonly detail: string;
      readonly remedy: string;
    };

export interface LoadOperationEventStore {
  readonly durability: 'memory' | 'local_jsonl_single_writer';
  readAll(): Promise<readonly StoredLoadOperationRecord[]>;
  append(event: LoadOperationEvent, expectedPreviousHash?: Hash | null): Promise<LoadOperationStoreAppendResult>;
}

const DOMAIN = 'payload.load_operations.record.v1';

export function stableValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function hashCommand(value: unknown): Hash {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function hashRecord(event: LoadOperationEvent, previousHash: Hash | null): Hash {
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
  code: 'OPERATION_EVENT_ID_CONFLICT' | 'OPERATION_STORE_CONCURRENT_WRITE' | 'OPERATION_STORE_CORRUPT',
  detail: string,
  remedy: string,
): Extract<LoadOperationStoreAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function verifyRecords(records: readonly StoredLoadOperationRecord[]): string | null {
  let previous: Hash | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.event?.eventId || ids.has(record.event.eventId)) {
      return `empty or duplicate workflow event id ${record.event?.eventId ?? '(missing)'}`;
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
  records: StoredLoadOperationRecord[],
  event: LoadOperationEvent,
  expectedPreviousHash?: Hash | null,
): LoadOperationStoreAppendResult {
  const existing = records.find(record => record.event.eventId === event.eventId);
  if (existing) {
    if (JSON.stringify(stableValue(existing.event)) === JSON.stringify(stableValue(event))) {
      return { kind: 'duplicate', record: existing };
    }
    return refusal(
      'OPERATION_EVENT_ID_CONFLICT',
      `Workflow event id ${event.eventId} already identifies different content.`,
      'Retry with the original command or allocate a new event id; event identity is immutable.',
    );
  }
  const previousHash = records.length ? records[records.length - 1].recordHash : null;
  if (expectedPreviousHash !== undefined && previousHash !== expectedPreviousHash) {
    return refusal(
      'OPERATION_STORE_CONCURRENT_WRITE',
      `Journal tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'} before append.`,
      'Reload the workflow and retry the same command event id against the new tail.',
    );
  }
  const sealedEvent = freeze(event);
  const record = freeze({
    event: sealedEvent,
    previousHash,
    recordHash: hashRecord(sealedEvent, previousHash),
  });
  records.push(record);
  return { kind: 'appended', record };
}

export class MemoryLoadOperationStore implements LoadOperationEventStore {
  readonly durability = 'memory' as const;
  private readonly records: StoredLoadOperationRecord[] = [];

  async readAll(): Promise<readonly StoredLoadOperationRecord[]> {
    return Object.freeze([...this.records]);
  }

  async append(event: LoadOperationEvent, expectedPreviousHash?: Hash | null): Promise<LoadOperationStoreAppendResult> {
    return appendTo(this.records, event, expectedPreviousHash);
  }
}

type QueueRegistry = Map<string, Promise<unknown>>;
const fileQueues = () => processSingleton<QueueRegistry>('load-operation-file-queues', () => new Map());

async function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const queues = fileQueues();
  const prior = queues.get(path) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  queues.set(path, current);
  try {
    return await current;
  } finally {
    if (queues.get(path) === current) queues.delete(path);
  }
}

export class FileLoadOperationStore implements LoadOperationEventStore {
  readonly durability = 'local_jsonl_single_writer' as const;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = resolve(filePath);
  }

  async readAll(): Promise<readonly StoredLoadOperationRecord[]> {
    let body: string;
    try {
      body = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!body) return Object.freeze([]);
    if (!body.endsWith('\n')) {
      throw new Error('OPERATION_STORE_CORRUPT: journal ends with a partial record; no history was truncated');
    }
    const records: StoredLoadOperationRecord[] = [];
    for (const [index, line] of body.slice(0, -1).split('\n').entries()) {
      try {
        records.push(JSON.parse(line) as StoredLoadOperationRecord);
      } catch {
        throw new Error(`OPERATION_STORE_CORRUPT: journal line ${index + 1} is not valid JSON`);
      }
    }
    const defect = verifyRecords(records);
    if (defect) throw new Error(`OPERATION_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  async append(event: LoadOperationEvent, expectedPreviousHash?: Hash | null): Promise<LoadOperationStoreAppendResult> {
    return serialized(this.filePath, async () => {
      let records: StoredLoadOperationRecord[];
      try {
        records = [...await this.readAll()];
      } catch (error) {
        return refusal(
          'OPERATION_STORE_CORRUPT',
          (error as Error).message,
          'Restore the journal from a verified replica; never truncate or skip an invalid line automatically.',
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
