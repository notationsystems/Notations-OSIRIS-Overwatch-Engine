/**
 * One ordered database for Payload's durable freight facts.
 *
 * The existing domain journals remain separate hash chains because they have
 * different replay rules. SQLite gives every accepted record one global
 * sequence so the complete operational history is retrievable as a single
 * timeline without weakening either stream's integrity.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type {
  CarrierCommunicationAppendResult,
  CarrierCommunicationEvent,
  CarrierCommunicationEventStore,
  StoredCarrierCommunicationRecord,
} from './carrierCommunicationsStore';
import {
  carrierCommunicationRecordHash,
  verifyCarrierCommunicationRecords,
} from './carrierCommunicationsStore';
import type {
  LoadOperationEvent,
  LoadOperationEventStore,
  LoadOperationStoreAppendResult,
  StoredLoadOperationRecord,
} from './loadOperationsStore';
import {
  loadOperationRecordHash,
  stableValue,
  verifyLoadOperationRecords,
} from './loadOperationsStore';
import type {
  ProcurementEvent,
  ProcurementEventStore,
  ProcurementStoreAppendResult,
  StoredProcurementRecord,
} from './procurementStore';
import { procurementRecordHash, verifyProcurementRecords } from './procurementStore';
import type {
  CommercialEvent,
  CommercialEventStore,
  CommercialStoreAppendResult,
  StoredCommercialRecord,
} from './commercialStore';
import { commercialRecordHash, verifyCommercialRecords } from './commercialStore';
import type { Hash, ISODateTime } from './types';

export type PayloadEventStream = 'load_operation' | 'carrier_communication' | 'procurement' | 'commercial';

/** Database ordering metadata; domain facts remain typed inside `event`. */
export type LinearizedPayloadEvent = {
  readonly sequence: number;
  readonly stream: PayloadEventStream;
  readonly eventId: string;
  readonly operationId: string;
  readonly kind: string;
  readonly recordedAt: ISODateTime;
  readonly commandHash: Hash;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
  readonly event: LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent;
};

/** Retrieval cursor metadata, not an attestation about the physical world. */
export type LinearizedEventPage = {
  readonly kind: 'linearized_event_page';
  readonly afterSequence: number;
  readonly nextAfterSequence: number;
  readonly hasMore: boolean;
  readonly events: readonly LinearizedPayloadEvent[];
};

/** Locally observed database counters, not operational or market claims. */
export type PayloadEventDatabaseSummary = {
  readonly kind: 'payload_event_database_summary';
  readonly databasePath: string;
  readonly durability: 'sqlite_wal';
  readonly totalEvents: number;
  readonly lastSequence: number;
  readonly operationEvents: number;
  readonly communicationEvents: number;
  readonly procurementEvents: number;
  readonly commercialEvents: number;
  readonly proofBatches: number;
};

/** A proof-job commitment. `pending` is never treated as a completed proof. */
export type PayloadProofBatch = {
  readonly batchId: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly eventCount: number;
  readonly root: Hash;
  readonly program: 'payload_event_batch_v1';
  readonly proverSystem: 'sp1';
  readonly status: 'pending' | 'proved' | 'failed';
  readonly createdAt: ISODateTime;
  readonly proofId: string | null;
  readonly verificationKey: string | null;
  readonly error: string | null;
};

export type PayloadProofBatchResult =
  | { readonly kind: 'created'; readonly batch: PayloadProofBatch }
  | {
      readonly kind: 'refusal';
      readonly code: 'PROOF_BATCH_EMPTY' | 'PROOF_BATCH_RANGE_INVALID' | 'PROOF_BATCH_CONCURRENT_WRITE';
      readonly detail: string;
      readonly remedy: string;
    };

type DbRow = {
  sequence: number;
  stream: PayloadEventStream;
  event_id: string;
  operation_id: string;
  kind: string;
  recorded_at: string;
  command_hash: string;
  previous_hash: string | null;
  record_hash: string;
  event_json: string;
};

type CountRow = { total: number };
type MaxRow = { maximum: number | null };

const BATCH_LEAF_DOMAIN = 'payload.event_batch.leaf.v1';
const BATCH_NODE_DOMAIN = 'payload.event_batch.node.v1';
const BATCH_EMPTY_DOMAIN = 'payload.event_batch.empty.v1';
type SQLInputValue = null | number | bigint | string | Uint8Array;

function sha(value: string): Hash {
  return createHash('sha256').update(value).digest('hex');
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

function canonical(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

export function payloadEventBatchRoot(events: readonly LinearizedPayloadEvent[]): Hash {
  if (events.length === 0) return sha(BATCH_EMPTY_DOMAIN);
  let level = events.map(event => sha(
    `${BATCH_LEAF_DOMAIN}|${event.sequence}|${event.stream}|${event.recordHash}`,
  ));
  while (level.length > 1) {
    const next: Hash[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(index + 1 < level.length
        ? sha(`${BATCH_NODE_DOMAIN}|${level[index]}|${level[index + 1]}`)
        : level[index]);
    }
    level = next;
  }
  return level[0];
}

function operationRefusal(
  code: Extract<LoadOperationStoreAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<LoadOperationStoreAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function communicationRefusal(
  code: Extract<CarrierCommunicationAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<CarrierCommunicationAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function proofRefusal(
  code: Extract<PayloadProofBatchResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<PayloadProofBatchResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function rowDefect(row: DbRow): string | null {
  let event: LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent;
  try { event = JSON.parse(row.event_json) as LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent; }
  catch { return `sequence ${row.sequence} has invalid event JSON`; }
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) return 'event sequence is invalid';
  if (!['load_operation', 'carrier_communication', 'procurement', 'commercial'].includes(row.stream)) return `sequence ${row.sequence} has an unknown stream`;
  if (event.eventId !== row.event_id || event.operationId !== row.operation_id ||
      event.kind !== row.kind || event.recordedAt !== row.recorded_at || event.commandHash !== row.command_hash) {
    return `sequence ${row.sequence} indexed metadata contradicts its event`;
  }
  if (!/^[a-f0-9]{64}$/.test(row.record_hash) ||
      (row.previous_hash !== null && !/^[a-f0-9]{64}$/.test(row.previous_hash))) {
    return `sequence ${row.sequence} has an invalid record hash`;
  }
  return null;
}

function linearized(row: DbRow): LinearizedPayloadEvent {
  const defect = rowDefect(row);
  if (defect) throw new Error(`PAYLOAD_DATABASE_CORRUPT: ${defect}`);
  return freeze({
    sequence: Number(row.sequence),
    stream: row.stream,
    eventId: row.event_id,
    operationId: row.operation_id,
    kind: row.kind,
    recordedAt: row.recorded_at,
    commandHash: row.command_hash,
    previousHash: row.previous_hash,
    recordHash: row.record_hash,
    event: JSON.parse(row.event_json) as LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent,
  });
}

function proofBatch(row: Record<string, unknown>): PayloadProofBatch {
  return freeze({
    batchId: String(row.batch_id),
    fromSequence: Number(row.from_sequence),
    toSequence: Number(row.to_sequence),
    eventCount: Number(row.event_count),
    root: String(row.root),
    program: 'payload_event_batch_v1' as const,
    proverSystem: 'sp1' as const,
    status: row.status as PayloadProofBatch['status'],
    createdAt: String(row.created_at),
    proofId: row.proof_id === null ? null : String(row.proof_id),
    verificationKey: row.verification_key === null ? null : String(row.verification_key),
    error: row.error === null ? null : String(row.error),
  });
}

export class PayloadEventDatabase {
  readonly databasePath: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.databasePath = resolve(path);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS payload_schema (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      INSERT OR IGNORE INTO payload_schema(version, applied_at)
        VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      CREATE TABLE IF NOT EXISTS payload_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL CHECK(stream IN ('load_operation', 'carrier_communication', 'procurement', 'commercial')),
        event_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        previous_hash TEXT,
        record_hash TEXT NOT NULL,
        event_json TEXT NOT NULL,
        inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(stream, event_id),
        UNIQUE(stream, record_hash)
      );
      CREATE INDEX IF NOT EXISTS payload_events_operation_sequence
        ON payload_events(operation_id, sequence);
      CREATE INDEX IF NOT EXISTS payload_events_stream_sequence
        ON payload_events(stream, sequence);
      CREATE INDEX IF NOT EXISTS payload_events_recorded_sequence
        ON payload_events(recorded_at, sequence);
      CREATE TABLE IF NOT EXISTS payload_proof_batches (
        batch_id TEXT PRIMARY KEY,
        from_sequence INTEGER NOT NULL,
        to_sequence INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        root TEXT NOT NULL,
        program TEXT NOT NULL CHECK(program = 'payload_event_batch_v1'),
        prover_system TEXT NOT NULL CHECK(prover_system = 'sp1'),
        status TEXT NOT NULL CHECK(status IN ('pending', 'proved', 'failed')),
        created_at TEXT NOT NULL,
        proof_id TEXT,
        verification_key TEXT,
        error TEXT,
        UNIQUE(from_sequence, to_sequence),
        CHECK(from_sequence > 0 AND to_sequence >= from_sequence AND event_count > 0)
      );
    `);
    const eventTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payload_events'").get() as { sql?: string } | undefined;
    if (eventTable?.sql && !eventTable.sql.includes("'commercial'")) this.migrateEventTableToV3();
    this.db.prepare("INSERT OR IGNORE INTO payload_schema(version, applied_at) VALUES (3, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run();
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) {
      this.db.close();
      throw new Error('PAYLOAD_DATABASE_CORRUPT: SQLite quick_check did not return ok');
    }
  }

  loadOperationStore(): LoadOperationEventStore {
    return new SqliteLoadOperationStore(this);
  }

  carrierCommunicationStore(): CarrierCommunicationEventStore {
    return new SqliteCarrierCommunicationStore(this);
  }

  procurementStore(): ProcurementEventStore {
    return new SqliteProcurementStore(this);
  }

  commercialStore(): CommercialEventStore {
    return new SqliteCommercialStore(this);
  }

  close(): void {
    this.db.close();
  }

  summary(): PayloadEventDatabaseSummary {
    const count = (where = '') => Number((this.db.prepare(`SELECT COUNT(*) AS total FROM payload_events ${where}`).get() as CountRow).total);
    const last = this.db.prepare('SELECT MAX(sequence) AS maximum FROM payload_events').get() as MaxRow;
    const batches = this.db.prepare('SELECT COUNT(*) AS total FROM payload_proof_batches').get() as CountRow;
    return Object.freeze({
      kind: 'payload_event_database_summary' as const,
      databasePath: this.databasePath,
      durability: 'sqlite_wal' as const,
      totalEvents: count(),
      lastSequence: Number(last.maximum ?? 0),
      operationEvents: count("WHERE stream = 'load_operation'"),
      communicationEvents: count("WHERE stream = 'carrier_communication'"),
      procurementEvents: count("WHERE stream = 'procurement'"),
      commercialEvents: count("WHERE stream = 'commercial'"),
      proofBatches: Number(batches.total),
    });
  }

  queryEvents(options: {
    readonly afterSequence?: number;
    readonly limit?: number;
    readonly operationId?: string;
    readonly stream?: PayloadEventStream;
  } = {}): LinearizedEventPage {
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('PAYLOAD_DATABASE_QUERY_INVALID: afterSequence must be non-negative and limit must be 1..500');
    }
    const clauses = ['sequence > ?'];
    const params: SQLInputValue[] = [after];
    if (options.operationId) { clauses.push('operation_id = ?'); params.push(options.operationId); }
    if (options.stream) { clauses.push('stream = ?'); params.push(options.stream); }
    params.push(limit + 1);
    const rows = this.db.prepare(`
      SELECT sequence, stream, event_id, operation_id, kind, recorded_at,
             command_hash, previous_hash, record_hash, event_json
        FROM payload_events
       WHERE ${clauses.join(' AND ')}
       ORDER BY sequence ASC
       LIMIT ?
    `).all(...params) as DbRow[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(linearized);
    return freeze({
      kind: 'linearized_event_page' as const,
      afterSequence: after,
      nextAfterSequence: events.at(-1)?.sequence ?? after,
      hasMore,
      events,
    });
  }

  listProofBatches(): readonly PayloadProofBatch[] {
    const rows = this.db.prepare('SELECT * FROM payload_proof_batches ORDER BY from_sequence ASC').all() as Record<string, unknown>[];
    return Object.freeze(rows.map(proofBatch));
  }

  createProofBatch(throughSequence?: number, createdAt = new Date().toISOString()): PayloadProofBatchResult {
    if (!Number.isFinite(Date.parse(createdAt))) {
      return proofRefusal('PROOF_BATCH_RANGE_INVALID', 'Proof batch creation time is invalid.', 'Restore the server clock before committing a proof batch.');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare('SELECT MAX(to_sequence) AS maximum FROM payload_proof_batches').get() as MaxRow;
      const lastEvent = this.db.prepare('SELECT MAX(sequence) AS maximum FROM payload_events').get() as MaxRow;
      const from = Number(prior.maximum ?? 0) + 1;
      const available = Number(lastEvent.maximum ?? 0);
      const to = throughSequence ?? available;
      if (!Number.isSafeInteger(to) || to < from || to > available) {
        this.db.exec('ROLLBACK');
        return available < from
          ? proofRefusal('PROOF_BATCH_EMPTY', 'No uncommitted operational events are available.', 'Wait for new durable events before creating another SP1 batch.')
          : proofRefusal('PROOF_BATCH_RANGE_INVALID', `Requested sequence ${to}; available unbatched range is ${from}..${available}.`, 'Choose an existing sequence at or after the first unbatched event.');
      }
      const page = this.queryEvents({ afterSequence: from - 1, limit: Math.min(500, to - from + 1) });
      const events: LinearizedPayloadEvent[] = [...page.events];
      let cursor = page.nextAfterSequence;
      while (cursor < to) {
        const next = this.queryEvents({ afterSequence: cursor, limit: Math.min(500, to - cursor) });
        if (next.events.length === 0) break;
        events.push(...next.events);
        cursor = next.nextAfterSequence;
      }
      const bounded = events.filter(event => event.sequence <= to);
      if (bounded.length === 0 || bounded[0].sequence !== from || bounded.at(-1)?.sequence !== to) {
        this.db.exec('ROLLBACK');
        return proofRefusal('PROOF_BATCH_RANGE_INVALID', 'The requested global sequence range is not contiguous.', 'Run database integrity checks and refuse proving over a partial event range.');
      }
      const root = payloadEventBatchRoot(bounded);
      const batchId = `proof-batch:${sha(`${from}|${to}|${bounded.length}|${root}`)}`;
      this.db.prepare(`
        INSERT INTO payload_proof_batches(
          batch_id, from_sequence, to_sequence, event_count, root, program,
          prover_system, status, created_at, proof_id, verification_key, error
        ) VALUES (?, ?, ?, ?, ?, 'payload_event_batch_v1', 'sp1', 'pending', ?, NULL, NULL, NULL)
      `).run(batchId, from, to, bounded.length, root, createdAt);
      this.db.exec('COMMIT');
      return { kind: 'created', batch: this.listProofBatches().at(-1)! };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      const message = (error as Error).message;
      if (message.includes('UNIQUE')) {
        return proofRefusal('PROOF_BATCH_CONCURRENT_WRITE', 'Another writer committed this proof range.', 'Reload proof batches; do not create an overlapping commitment.');
      }
      throw error;
    }
  }

  readOperations(): readonly StoredLoadOperationRecord[] {
    const records = this.rowsFor('load_operation').map(row => ({
      event: JSON.parse(row.event_json) as LoadOperationEvent,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
    }));
    const defect = verifyLoadOperationRecords(records);
    if (defect) throw new Error(`OPERATION_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  readCommunications(): readonly StoredCarrierCommunicationRecord[] {
    const records = this.rowsFor('carrier_communication').map(row => ({
      event: JSON.parse(row.event_json) as CarrierCommunicationEvent,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
    }));
    const defect = verifyCarrierCommunicationRecords(records);
    if (defect) throw new Error(`COMMUNICATION_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  readProcurements(): readonly StoredProcurementRecord[] {
    const records = this.rowsFor('procurement').map(row => ({
      event: JSON.parse(row.event_json) as ProcurementEvent,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
    }));
    const defect = verifyProcurementRecords(records);
    if (defect) throw new Error(`PROCUREMENT_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  readCommercials(): readonly StoredCommercialRecord[] {
    const records = this.rowsFor('commercial').map(row => ({
      event: JSON.parse(row.event_json) as CommercialEvent,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
    }));
    const defect = verifyCommercialRecords(records);
    if (defect) throw new Error(`COMMERCIAL_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  appendOperation(
    event: LoadOperationEvent,
    expectedPreviousHash?: Hash | null,
  ): LoadOperationStoreAppendResult {
    const result = this.append('load_operation', event, expectedPreviousHash, loadOperationRecordHash);
    if ('record' in result) {
      return { kind: result.kind, record: result.record as StoredLoadOperationRecord };
    }
    return operationRefusal(
      result.kind === 'conflict' ? 'OPERATION_EVENT_ID_CONFLICT'
        : result.kind === 'concurrent' ? 'OPERATION_STORE_CONCURRENT_WRITE' : 'OPERATION_STORE_CORRUPT',
      result.detail,
      result.remedy,
    );
  }

  appendCommunication(
    event: CarrierCommunicationEvent,
    expectedPreviousHash?: Hash | null,
  ): CarrierCommunicationAppendResult {
    const result = this.append('carrier_communication', event, expectedPreviousHash, carrierCommunicationRecordHash);
    if ('record' in result) {
      return { kind: result.kind, record: result.record as StoredCarrierCommunicationRecord };
    }
    return communicationRefusal(
      result.kind === 'conflict' ? 'COMMUNICATION_EVENT_ID_CONFLICT'
        : result.kind === 'concurrent' ? 'COMMUNICATION_STORE_CONCURRENT_WRITE' : 'COMMUNICATION_STORE_CORRUPT',
      result.detail,
      result.remedy,
    );
  }

  appendProcurement(
    event: ProcurementEvent,
    expectedPreviousHash?: Hash | null,
  ): ProcurementStoreAppendResult {
    const result = this.append('procurement', event, expectedPreviousHash, procurementRecordHash);
    if ('record' in result) {
      return { kind: result.kind, record: result.record as StoredProcurementRecord };
    }
    return Object.freeze({
      kind: 'refusal' as const,
      code: result.kind === 'conflict' ? 'PROCUREMENT_EVENT_ID_CONFLICT' as const
        : result.kind === 'concurrent' ? 'PROCUREMENT_STORE_CONCURRENT_WRITE' as const : 'PROCUREMENT_STORE_CORRUPT' as const,
      detail: result.detail,
      remedy: result.remedy,
    });
  }

  appendCommercial(
    event: CommercialEvent,
    expectedPreviousHash?: Hash | null,
  ): CommercialStoreAppendResult {
    const result = this.append('commercial', event, expectedPreviousHash, commercialRecordHash);
    if ('record' in result) {
      return { kind: result.kind, record: result.record as StoredCommercialRecord };
    }
    return Object.freeze({
      kind: 'refusal' as const,
      code: result.kind === 'conflict' ? 'COMMERCIAL_EVENT_ID_CONFLICT' as const
        : result.kind === 'concurrent' ? 'COMMERCIAL_STORE_CONCURRENT_WRITE' as const : 'COMMERCIAL_STORE_CORRUPT' as const,
      detail: result.detail,
      remedy: result.remedy,
    });
  }

  private rowsFor(stream: PayloadEventStream): DbRow[] {
    const rows = this.db.prepare(`
      SELECT sequence, stream, event_id, operation_id, kind, recorded_at,
             command_hash, previous_hash, record_hash, event_json
        FROM payload_events WHERE stream = ? ORDER BY sequence ASC
    `).all(stream) as DbRow[];
    for (const row of rows) {
      const defect = rowDefect(row);
      if (defect) throw new Error(`PAYLOAD_DATABASE_CORRUPT: ${defect}`);
    }
    return rows;
  }

  private append<E extends LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent>(
    stream: PayloadEventStream,
    event: E,
    expectedPreviousHash: Hash | null | undefined,
    recordHash: (event: E, previousHash: Hash | null) => Hash,
  ):
    | { kind: 'appended' | 'duplicate'; record: { event: E; previousHash: Hash | null; recordHash: Hash } }
    | { kind: 'conflict' | 'concurrent' | 'corrupt'; detail: string; remedy: string } {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const existing = this.db.prepare(`
        SELECT sequence, stream, event_id, operation_id, kind, recorded_at,
               command_hash, previous_hash, record_hash, event_json
          FROM payload_events WHERE stream = ? AND event_id = ?
      `).get(stream, event.eventId) as DbRow | undefined;
      if (existing) {
        const defect = rowDefect(existing);
        this.db.exec('ROLLBACK');
        if (defect) return { kind: 'corrupt', detail: defect, remedy: 'Restore the database from a verified backup; do not skip the damaged record.' };
        if (canonical(JSON.parse(existing.event_json)) !== canonical(event)) {
          return {
            kind: 'conflict',
            detail: `${stream} event id ${event.eventId} already identifies different content.`,
            remedy: 'Retry the original action or allocate a new request identity.',
          };
        }
        return {
          kind: 'duplicate',
          record: freeze({ event, previousHash: existing.previous_hash, recordHash: existing.record_hash }),
        };
      }
      const tail = this.db.prepare('SELECT record_hash FROM payload_events WHERE stream = ? ORDER BY sequence DESC LIMIT 1')
        .get(stream) as { record_hash: string } | undefined;
      const previousHash = tail?.record_hash ?? null;
      if (expectedPreviousHash !== undefined && expectedPreviousHash !== previousHash) {
        this.db.exec('ROLLBACK');
        return {
          kind: 'concurrent',
          detail: `${stream} tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'} before append.`,
          remedy: 'Reload current state and retry the same idempotent cockpit request.',
        };
      }
      const nextHash = recordHash(event, previousHash);
      this.db.prepare(`
        INSERT INTO payload_events(
          stream, event_id, operation_id, kind, recorded_at, command_hash,
          previous_hash, record_hash, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        stream, event.eventId, event.operationId, event.kind, event.recordedAt,
        event.commandHash, previousHash, nextHash, JSON.stringify(event),
      );
      this.db.exec('COMMIT');
      return { kind: 'appended', record: freeze({ event, previousHash, recordHash: nextHash }) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      return {
        kind: 'corrupt',
        detail: `SQLite append failed: ${(error as Error).message}`,
        remedy: 'Stop writes, inspect database integrity, and restore from a verified backup if corruption is confirmed.',
      };
    }
  }

  private migrateEventTableToV3(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE payload_events RENAME TO payload_events_before_v3;
      CREATE TABLE payload_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL CHECK(stream IN ('load_operation', 'carrier_communication', 'procurement', 'commercial')),
        event_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        previous_hash TEXT,
        record_hash TEXT NOT NULL,
        event_json TEXT NOT NULL,
        inserted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(stream, event_id),
        UNIQUE(stream, record_hash)
      );
      INSERT INTO payload_events(
        sequence, stream, event_id, operation_id, kind, recorded_at,
        command_hash, previous_hash, record_hash, event_json, inserted_at
      )
      SELECT sequence, stream, event_id, operation_id, kind, recorded_at,
             command_hash, previous_hash, record_hash, event_json, inserted_at
        FROM payload_events_before_v3 ORDER BY sequence ASC;
      DROP TABLE payload_events_before_v3;
      CREATE INDEX payload_events_operation_sequence ON payload_events(operation_id, sequence);
      CREATE INDEX payload_events_stream_sequence ON payload_events(stream, sequence);
      CREATE INDEX payload_events_recorded_sequence ON payload_events(recorded_at, sequence);
      COMMIT;
    `);
  }
}

class SqliteLoadOperationStore implements LoadOperationEventStore {
  readonly durability = 'sqlite_wal' as const;
  constructor(private readonly database: PayloadEventDatabase) {}
  async readAll(): Promise<readonly StoredLoadOperationRecord[]> { return this.database.readOperations(); }
  async append(event: LoadOperationEvent, expectedPreviousHash?: Hash | null): Promise<LoadOperationStoreAppendResult> {
    return this.database.appendOperation(event, expectedPreviousHash);
  }
}

class SqliteCarrierCommunicationStore implements CarrierCommunicationEventStore {
  readonly durability = 'sqlite_wal' as const;
  constructor(private readonly database: PayloadEventDatabase) {}
  async readAll(): Promise<readonly StoredCarrierCommunicationRecord[]> { return this.database.readCommunications(); }
  async append(event: CarrierCommunicationEvent, expectedPreviousHash?: Hash | null): Promise<CarrierCommunicationAppendResult> {
    return this.database.appendCommunication(event, expectedPreviousHash);
  }
}

class SqliteProcurementStore implements ProcurementEventStore {
  readonly durability = 'sqlite_wal' as const;
  constructor(private readonly database: PayloadEventDatabase) {}
  async readAll(): Promise<readonly StoredProcurementRecord[]> { return this.database.readProcurements(); }
  async append(event: ProcurementEvent, expectedPreviousHash?: Hash | null): Promise<ProcurementStoreAppendResult> {
    return this.database.appendProcurement(event, expectedPreviousHash);
  }
}

class SqliteCommercialStore implements CommercialEventStore {
  readonly durability = 'sqlite_wal' as const;
  constructor(private readonly database: PayloadEventDatabase) {}
  async readAll(): Promise<readonly StoredCommercialRecord[]> { return this.database.readCommercials(); }
  async append(event: CommercialEvent, expectedPreviousHash?: Hash | null): Promise<CommercialStoreAppendResult> {
    return this.database.appendCommercial(event, expectedPreviousHash);
  }
}
