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
import type {
  ProjectCargoEvent,
  ProjectCargoEventStore,
  ProjectCargoStoreAppendResult,
  StoredProjectCargoRecord,
} from './projectCargoStore';
import { projectCargoRecordHash, verifyProjectCargoRecords } from './projectCargoStore';
import type { Hash, ISODateTime } from './types';

export type PayloadEventStream = 'load_operation' | 'carrier_communication' | 'procurement' | 'commercial' | 'project_cargo';

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
  readonly event: LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent | ProjectCargoEvent;
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
  readonly projectCargoEvents: number;
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
  readonly status: 'pending' | 'proving' | 'proved' | 'failed';
  readonly createdAt: ISODateTime;
  readonly proofId: string | null;
  readonly verificationKey: string | null;
  readonly proofMode: 'core' | 'compressed' | 'groth16' | 'plonk' | null;
  readonly proofSha256: Hash | null;
  readonly publicValues: Readonly<Record<string, unknown>> | null;
  readonly verifiedAt: ISODateTime | null;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: ISODateTime | null;
  readonly attempts: number;
  readonly error: string | null;
};

export type PayloadProofWitness = {
  readonly schema: 'payload.event_batch.witness.v1';
  readonly batchId: string;
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly eventCount: number;
  readonly expectedRoot: Hash;
  readonly priorHashes: Readonly<Record<PayloadEventStream, Hash | null>>;
  readonly events: readonly {
    readonly sequence: number;
    readonly stream: PayloadEventStream;
    readonly eventId: string;
    readonly operationId: string;
    readonly kind: string;
    readonly recordedAt: ISODateTime;
    readonly commandHash: Hash;
    readonly previousHash: Hash | null;
    readonly recordHash: Hash;
    readonly canonicalEventJson: string;
  }[];
};

export type PayloadProofClaimResult =
  | { readonly kind: 'claimed'; readonly batch: PayloadProofBatch; readonly witness: PayloadProofWitness }
  | { readonly kind: 'idle' }
  | { readonly kind: 'refusal'; readonly code: 'PROOF_WORKER_INVALID' | 'PROOF_BATCH_CONCURRENT_WRITE'; readonly detail: string; readonly remedy: string };

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
  let event: LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent | ProjectCargoEvent;
  try { event = JSON.parse(row.event_json) as LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent | ProjectCargoEvent; }
  catch { return `sequence ${row.sequence} has invalid event JSON`; }
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1) return 'event sequence is invalid';
  if (!['load_operation', 'carrier_communication', 'procurement', 'commercial', 'project_cargo'].includes(row.stream)) return `sequence ${row.sequence} has an unknown stream`;
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
    event: JSON.parse(row.event_json) as LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent | ProjectCargoEvent,
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
    proofMode: row.proof_mode === null ? null : row.proof_mode as PayloadProofBatch['proofMode'],
    proofSha256: row.proof_sha256 === null ? null : String(row.proof_sha256),
    publicValues: row.public_values_json === null ? null : JSON.parse(String(row.public_values_json)) as Record<string, unknown>,
    verifiedAt: row.verified_at === null ? null : String(row.verified_at),
    leaseOwner: row.lease_owner === null ? null : String(row.lease_owner),
    leaseExpiresAt: row.lease_expires_at === null ? null : String(row.lease_expires_at),
    attempts: Number(row.attempts ?? 0),
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
        stream TEXT NOT NULL CHECK(stream IN ('load_operation', 'carrier_communication', 'procurement', 'commercial', 'project_cargo')),
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
        status TEXT NOT NULL CHECK(status IN ('pending', 'proving', 'proved', 'failed')),
        created_at TEXT NOT NULL,
        proof_id TEXT,
        verification_key TEXT,
        proof_mode TEXT CHECK(proof_mode IS NULL OR proof_mode IN ('core', 'compressed', 'groth16', 'plonk')),
        proof_sha256 TEXT,
        public_values_json TEXT,
        verified_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        UNIQUE(from_sequence, to_sequence),
        CHECK(from_sequence > 0 AND to_sequence >= from_sequence AND event_count > 0)
      );
    `);
    const eventTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payload_events'").get() as { sql?: string } | undefined;
    if (eventTable?.sql && !eventTable.sql.includes("'project_cargo'")) this.migrateEventTableToV4();
    const proofTable = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payload_proof_batches'").get() as { sql?: string } | undefined;
    if (proofTable?.sql && (!proofTable.sql.includes("'proving'") || !proofTable.sql.includes('lease_owner'))) this.migrateProofTableToV4();
    this.db.prepare("INSERT OR IGNORE INTO payload_schema(version, applied_at) VALUES (4, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))").run();
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

  projectCargoStore(): ProjectCargoEventStore {
    return new SqliteProjectCargoStore(this);
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
      projectCargoEvents: count("WHERE stream = 'project_cargo'"),
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
          prover_system, status, created_at, proof_id, verification_key,
          proof_mode, proof_sha256, public_values_json, verified_at,
          lease_owner, lease_expires_at, attempts, error
        ) VALUES (?, ?, ?, ?, ?, 'payload_event_batch_v1', 'sp1', 'pending', ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL)
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

  proofWitness(batchId: string): PayloadProofWitness {
    const batchRow = this.db.prepare('SELECT * FROM payload_proof_batches WHERE batch_id = ?').get(batchId) as Record<string, unknown> | undefined;
    if (!batchRow) throw new Error(`PROOF_BATCH_NOT_FOUND: ${batchId}`);
    const batch = proofBatch(batchRow);
    const rows = this.db.prepare(`
      SELECT sequence, stream, event_id, operation_id, kind, recorded_at,
             command_hash, previous_hash, record_hash, event_json
        FROM payload_events WHERE sequence BETWEEN ? AND ? ORDER BY sequence ASC
    `).all(batch.fromSequence, batch.toSequence) as DbRow[];
    const events = rows.map(linearized);
    if (events.length !== batch.eventCount || events[0]?.sequence !== batch.fromSequence || events.at(-1)?.sequence !== batch.toSequence || payloadEventBatchRoot(events) !== batch.root) {
      throw new Error('PROOF_BATCH_WITNESS_INVALID: committed range no longer reconstructs the batch root');
    }
    const streams: PayloadEventStream[] = ['load_operation', 'carrier_communication', 'procurement', 'commercial', 'project_cargo'];
    const priorHashes = Object.fromEntries(streams.map(stream => {
      const row = this.db.prepare('SELECT record_hash FROM payload_events WHERE stream = ? AND sequence < ? ORDER BY sequence DESC LIMIT 1').get(stream, batch.fromSequence) as { record_hash: string } | undefined;
      return [stream, row?.record_hash ?? null];
    })) as Record<PayloadEventStream, Hash | null>;
    return freeze({
      schema: 'payload.event_batch.witness.v1' as const,
      batchId: batch.batchId,
      fromSequence: batch.fromSequence,
      toSequence: batch.toSequence,
      eventCount: batch.eventCount,
      expectedRoot: batch.root,
      priorHashes,
      events: events.map(event => ({ sequence: event.sequence, stream: event.stream, eventId: event.eventId, operationId: event.operationId, kind: event.kind, recordedAt: event.recordedAt, commandHash: event.commandHash, previousHash: event.previousHash, recordHash: event.recordHash, canonicalEventJson: canonical(event.event) })),
    });
  }

  claimProofBatch(workerId: string, leaseSeconds = 300, now = new Date().toISOString()): PayloadProofClaimResult {
    if (!workerId.trim() || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600 || !Number.isFinite(Date.parse(now))) {
      return { kind: 'refusal', code: 'PROOF_WORKER_INVALID', detail: 'Worker identity, lease duration, or time is invalid.', remedy: 'Use a stable worker identity, a 30..3600 second lease, and a valid clock.' };
    }
    const expiresAt = new Date(Date.parse(now) + leaseSeconds * 1000).toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM payload_proof_batches
         WHERE status = 'pending' OR (status = 'proving' AND lease_expires_at < ?) OR (status = 'failed' AND attempts < 3)
         ORDER BY from_sequence ASC LIMIT 1
      `).get(now) as Record<string, unknown> | undefined;
      if (!row) { this.db.exec('ROLLBACK'); return { kind: 'idle' }; }
      const changed = this.db.prepare(`
        UPDATE payload_proof_batches
           SET status = 'proving', lease_owner = ?, lease_expires_at = ?, attempts = attempts + 1, error = NULL
         WHERE batch_id = ? AND (status = 'pending' OR (status = 'proving' AND lease_expires_at < ?) OR (status = 'failed' AND attempts < 3))
      `).run(workerId, expiresAt, String(row.batch_id), now);
      if (changed.changes !== 1) { this.db.exec('ROLLBACK'); return { kind: 'refusal', code: 'PROOF_BATCH_CONCURRENT_WRITE', detail: 'Another worker claimed the batch.', remedy: 'Poll for the next pending batch.' }; }
      this.db.exec('COMMIT');
      const batch = this.listProofBatches().find(item => item.batchId === String(row.batch_id))!;
      return { kind: 'claimed', batch, witness: this.proofWitness(batch.batchId) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  completeProofBatch(input: {
    readonly batchId: string;
    readonly workerId: string;
    readonly proofId: string;
    readonly verificationKey: string;
    readonly proofMode: Exclude<PayloadProofBatch['proofMode'], null>;
    readonly proofSha256: Hash;
    readonly publicValues: Readonly<Record<string, unknown>>;
    readonly verifiedAt: ISODateTime;
  }): PayloadProofBatch {
    if (!input.workerId.trim() || !input.proofId.trim() || !input.verificationKey.trim() || !/^[a-f0-9]{64}$/.test(input.proofSha256) || !Number.isFinite(Date.parse(input.verifiedAt))) throw new Error('PROOF_RESULT_INVALID: proof metadata is incomplete');
    const row = this.db.prepare('SELECT * FROM payload_proof_batches WHERE batch_id = ?').get(input.batchId) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`PROOF_BATCH_NOT_FOUND: ${input.batchId}`);
    const batch = proofBatch(row);
    if (batch.status !== 'proving' || batch.leaseOwner !== input.workerId || !batch.leaseExpiresAt || Date.parse(input.verifiedAt) > Date.parse(batch.leaseExpiresAt)) throw new Error('PROOF_BATCH_LEASE_LOST: worker no longer owns a valid proof lease');
    if (input.publicValues.program !== batch.program || input.publicValues.batchId !== batch.batchId || input.publicValues.root !== batch.root || Number(input.publicValues.fromSequence) !== batch.fromSequence || Number(input.publicValues.toSequence) !== batch.toSequence || Number(input.publicValues.eventCount) !== batch.eventCount) throw new Error('PROOF_PUBLIC_VALUES_MISMATCH: verified public values do not bind the committed batch');
    const result = this.db.prepare(`
      UPDATE payload_proof_batches
         SET status = 'proved', proof_id = ?, verification_key = ?, proof_mode = ?, proof_sha256 = ?,
             public_values_json = ?, verified_at = ?, lease_owner = NULL, lease_expires_at = NULL, error = NULL
       WHERE batch_id = ? AND status = 'proving' AND lease_owner = ?
    `).run(input.proofId, input.verificationKey, input.proofMode, input.proofSha256, canonical(input.publicValues), input.verifiedAt, input.batchId, input.workerId);
    if (result.changes !== 1) throw new Error('PROOF_BATCH_LEASE_LOST: proof result was not committed');
    return this.listProofBatches().find(item => item.batchId === input.batchId)!;
  }

  failProofBatch(batchId: string, workerId: string, error: string): PayloadProofBatch {
    const detail = error.trim().slice(0, 2000);
    if (!workerId.trim() || !detail) throw new Error('PROOF_RESULT_INVALID: worker identity and failure detail are required');
    const result = this.db.prepare(`
      UPDATE payload_proof_batches SET status = 'failed', error = ?, lease_owner = NULL, lease_expires_at = NULL
       WHERE batch_id = ? AND status = 'proving' AND lease_owner = ?
    `).run(detail, batchId, workerId);
    if (result.changes !== 1) throw new Error('PROOF_BATCH_LEASE_LOST: failure was not committed');
    return this.listProofBatches().find(item => item.batchId === batchId)!;
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

  readProjectCargo(): readonly StoredProjectCargoRecord[] {
    const records = this.rowsFor('project_cargo').map(row => ({
      event: JSON.parse(row.event_json) as ProjectCargoEvent,
      previousHash: row.previous_hash,
      recordHash: row.record_hash,
    }));
    const defect = verifyProjectCargoRecords(records);
    if (defect) throw new Error(`PROJECT_CARGO_STORE_CORRUPT: ${defect}`);
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

  appendProjectCargo(
    event: ProjectCargoEvent,
    expectedPreviousHash?: Hash | null,
  ): ProjectCargoStoreAppendResult {
    const result = this.append('project_cargo', event, expectedPreviousHash, projectCargoRecordHash);
    if ('record' in result) return { kind: result.kind, record: result.record as StoredProjectCargoRecord };
    return Object.freeze({
      kind: 'refusal' as const,
      code: result.kind === 'conflict' ? 'PROJECT_CARGO_EVENT_ID_CONFLICT' as const
        : result.kind === 'concurrent' ? 'PROJECT_CARGO_STORE_CONCURRENT_WRITE' as const : 'PROJECT_CARGO_STORE_CORRUPT' as const,
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

  private append<E extends LoadOperationEvent | CarrierCommunicationEvent | ProcurementEvent | CommercialEvent | ProjectCargoEvent>(
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

  private migrateEventTableToV4(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE payload_events RENAME TO payload_events_before_v4;
      CREATE TABLE payload_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL CHECK(stream IN ('load_operation', 'carrier_communication', 'procurement', 'commercial', 'project_cargo')),
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
        FROM payload_events_before_v4 ORDER BY sequence ASC;
      DROP TABLE payload_events_before_v4;
      CREATE INDEX payload_events_operation_sequence ON payload_events(operation_id, sequence);
      CREATE INDEX payload_events_stream_sequence ON payload_events(stream, sequence);
      CREATE INDEX payload_events_recorded_sequence ON payload_events(recorded_at, sequence);
      COMMIT;
    `);
  }

  private migrateProofTableToV4(): void {
    this.db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE payload_proof_batches RENAME TO payload_proof_batches_before_v4;
      CREATE TABLE payload_proof_batches (
        batch_id TEXT PRIMARY KEY,
        from_sequence INTEGER NOT NULL,
        to_sequence INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        root TEXT NOT NULL,
        program TEXT NOT NULL CHECK(program = 'payload_event_batch_v1'),
        prover_system TEXT NOT NULL CHECK(prover_system = 'sp1'),
        status TEXT NOT NULL CHECK(status IN ('pending', 'proving', 'proved', 'failed')),
        created_at TEXT NOT NULL,
        proof_id TEXT,
        verification_key TEXT,
        proof_mode TEXT CHECK(proof_mode IS NULL OR proof_mode IN ('core', 'compressed', 'groth16', 'plonk')),
        proof_sha256 TEXT,
        public_values_json TEXT,
        verified_at TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        UNIQUE(from_sequence, to_sequence),
        CHECK(from_sequence > 0 AND to_sequence >= from_sequence AND event_count > 0)
      );
      INSERT INTO payload_proof_batches(
        batch_id, from_sequence, to_sequence, event_count, root, program,
        prover_system, status, created_at, proof_id, verification_key, error
      )
      SELECT batch_id, from_sequence, to_sequence, event_count, root, program,
             prover_system, status, created_at, proof_id, verification_key, error
        FROM payload_proof_batches_before_v4 ORDER BY from_sequence ASC;
      DROP TABLE payload_proof_batches_before_v4;
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

class SqliteProjectCargoStore implements ProjectCargoEventStore {
  readonly durability = 'sqlite_wal' as const;
  constructor(private readonly database: PayloadEventDatabase) {}
  async readAll(): Promise<readonly StoredProjectCargoRecord[]> { return this.database.readProjectCargo(); }
  async append(event: ProjectCargoEvent, expectedPreviousHash?: Hash | null): Promise<ProjectCargoStoreAppendResult> {
    return this.database.appendProjectCargo(event, expectedPreviousHash);
  }
}
