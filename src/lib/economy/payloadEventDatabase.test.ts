import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import type { CarrierCommunicationEvent } from './carrierCommunicationsStore';
import type { LoadOperationEvent } from './loadOperationsStore';
import { hashCommand, loadOperationRecordHash } from './loadOperationsStore';
import { PayloadEventDatabase, payloadEventBatchRoot } from './payloadEventDatabase';
import { ProcurementWorkflow } from './procurement';
import { ProcurementActions } from './procurementActions';
import type { CommercialEvent } from './commercialStore';
import { attestationOf } from './attestation';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function operationEvent(eventId: string, recordedAt: string): LoadOperationEvent {
  const command = { eventId, operationId: 'operation:db:1', recordedAt, source: 'test' };
  return {
    kind: 'opportunity_registered',
    eventId,
    operationId: command.operationId,
    recordedAt,
    commandHash: hashCommand(command),
    opportunity: {} as LoadOperationEvent & never,
  };
}

function communicationEvent(eventId: string, recordedAt: string): CarrierCommunicationEvent {
  const command = { eventId, operationId: 'operation:db:1', recordedAt, source: 'test' };
  return {
    kind: 'dispatch_attempt_started',
    eventId,
    attemptId: eventId,
    messageId: 'message:db:1',
    operationId: command.operationId,
    dispatchEventId: 'dispatch:db:1',
    requestedAt: recordedAt,
    recordedAt,
    commandHash: hashCommand(command),
  };
}

function commercialEvent(eventId: string, recordedAt: string): CommercialEvent {
  const command = { eventId, operationId: 'inventory-lot:db:1', recordedAt, source: 'test' };
  const attestation = attestationOf('reported', 'medium', 'self_reported', 'database test');
  return {
    kind: 'inventory_lot_opened', eventId, operationId: command.operationId, recordedAt, commandHash: hashCommand(command),
    lot: {
      lotId: command.operationId, sourceProcurementId: 'procurement:db:1', sourcePositionId: 'position:db:1',
      sourceSnapshotId: 'procurement-state:db:1', materialId: 'material:db', specificationId: 'spec:db',
      initialQuantity: { amount: 5, unit: 'tonne', attestation, evidenceIds: ['evidence:db:quantity'] },
      locationId: 'warehouse:db', receivedAt: recordedAt,
      totalLandedCost: { kind: 'observed', value: { amountMinor: 50_000, currency: 'CAD', attestation, evidenceIds: ['evidence:db:cost'] } },
      openedAt: recordedAt, evidenceIds: ['evidence:db:lot'],
    },
  };
}

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'payload-events-'));
  directories.push(directory);
  return join(directory, 'payload.sqlite');
}

describe('globally ordered Payload event database', () => {
  it('linearizes both domain journals, preserves each hash chain, and recovers after restart', async () => {
    const path = await databasePath();
    const database = new PayloadEventDatabase(path);
    const operations = database.loadOperationStore();
    const communications = database.carrierCommunicationStore();

    const first = operationEvent('operation-event:1', '2026-09-01T10:00:00.000Z');
    const carrier = communicationEvent('communication-event:1', '2026-09-01T10:01:00.000Z');
    const second = operationEvent('operation-event:2', '2026-09-01T10:02:00.000Z');
    const firstAppend = await operations.append(first, null);
    expect(firstAppend.kind).toBe('appended');
    expect((await communications.append(carrier, null)).kind).toBe('appended');
    const priorHash = firstAppend.kind === 'appended' ? firstAppend.record.recordHash : null;
    expect((await operations.append(second, priorHash)).kind).toBe('appended');

    const page = database.queryEvents();
    expect(page.events.map(event => [event.sequence, event.stream, event.eventId])).toEqual([
      [1, 'load_operation', 'operation-event:1'],
      [2, 'carrier_communication', 'communication-event:1'],
      [3, 'load_operation', 'operation-event:2'],
    ]);
    expect(database.summary()).toMatchObject({
      durability: 'sqlite_wal', totalEvents: 3, lastSequence: 3,
      operationEvents: 2, communicationEvents: 1,
    });
    expect(await operations.append(second, priorHash)).toMatchObject({ kind: 'duplicate' });
    database.close();

    const recovered = new PayloadEventDatabase(path);
    expect(recovered.readOperations()).toHaveLength(2);
    expect(recovered.readCommunications()).toHaveLength(1);
    expect(recovered.queryEvents({ operationId: 'operation:db:1', limit: 2 })).toMatchObject({
      events: [{ sequence: 1 }, { sequence: 2 }], hasMore: true, nextAfterSequence: 2,
    });
    recovered.close();
  });

  it('creates non-overlapping SP1-ready Merkle commitments over exact global ranges', async () => {
    const database = new PayloadEventDatabase(await databasePath());
    await database.loadOperationStore().append(operationEvent('event:1', '2026-09-01T10:00:00.000Z'), null);
    await database.carrierCommunicationStore().append(communicationEvent('event:2', '2026-09-01T10:01:00.000Z'), null);
    const events = database.queryEvents().events;
    const created = database.createProofBatch(undefined, '2026-09-01T10:02:00.000Z');
    expect(created).toMatchObject({
      kind: 'created',
      batch: {
        fromSequence: 1, toSequence: 2, eventCount: 2,
        program: 'payload_event_batch_v1', proverSystem: 'sp1', status: 'pending',
        root: payloadEventBatchRoot(events),
      },
    });
    expect(database.createProofBatch()).toMatchObject({ kind: 'refusal', code: 'PROOF_BATCH_EMPTY' });
    database.close();
  });

  it('refuses logical tampering even when SQLite itself remains structurally healthy', async () => {
    const path = await databasePath();
    const database = new PayloadEventDatabase(path);
    await database.loadOperationStore().append(operationEvent('event:tamper', '2026-09-01T10:00:00.000Z'), null);
    database.close();

    const raw = new Database(path);
    raw.prepare("UPDATE payload_events SET operation_id = 'operation:other' WHERE sequence = 1").run();
    raw.close();

    const reopened = new PayloadEventDatabase(path);
    expect(() => reopened.readOperations()).toThrow(/PAYLOAD_DATABASE_CORRUPT|OPERATION_STORE_CORRUPT/);
    reopened.close();
  });

  it('linearizes procurement beside freight and preserves the procurement domain chain', async () => {
    const database = new PayloadEventDatabase(await databasePath());
    const workflow = new ProcurementWorkflow(database.procurementStore());
    const actions = new ProcurementActions(workflow, () => '2026-09-01T10:00:00.000Z');
    const created = await actions.execute({
      action: 'register_requirement', requestId: 'request:db:procurement', actorId: 'desk:procurement',
      submittedAt: '2026-09-01T10:00:00.000Z', payload: {
        procurementId: 'procurement:db:1', sourceReference: 'rfq:db:1', materialId: 'material:db', specificationId: 'spec:db',
        quantity: 20, unit: 'tonne', destinationId: 'facility:db', deliveryStart: '2026-09-10T00:00:00.000Z',
        deliveryEnd: '2026-09-20T00:00:00.000Z', currency: 'CAD',
      },
    });
    expect(created).toMatchObject({ kind: 'accepted' });
    expect(database.queryEvents({ stream: 'procurement' }).events).toMatchObject([
      { sequence: 1, stream: 'procurement', operationId: 'procurement:db:1', kind: 'procurement_requirement_registered' },
    ]);
    expect(database.summary()).toMatchObject({ totalEvents: 1, procurementEvents: 1 });
    expect(database.readProcurements()).toHaveLength(1);
    database.close();
  });

  it('linearizes commercial inventory beside procurement and preserves the commercial domain chain', async () => {
    const database = new PayloadEventDatabase(await databasePath());
    expect((await database.commercialStore().append(commercialEvent('commercial-event:1', '2026-09-01T10:00:00.000Z'), null)).kind).toBe('appended');
    expect(database.queryEvents({ stream: 'commercial' }).events).toMatchObject([
      { sequence: 1, stream: 'commercial', operationId: 'inventory-lot:db:1', kind: 'inventory_lot_opened' },
    ]);
    expect(database.summary()).toMatchObject({ totalEvents: 1, commercialEvents: 1 });
    expect(database.readCommercials()).toHaveLength(1);
    database.close();
  });

  it('upgrades a pre-commercial event table without changing prior sequences', async () => {
    const path = await databasePath();
    const legacy = new Database(path);
    const prior = operationEvent('operation-event:legacy', '2026-09-01T00:00:00.000Z');
    legacy.exec(`
      CREATE TABLE payload_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      INSERT INTO payload_schema VALUES (2, '2026-09-01T00:00:00.000Z');
      CREATE TABLE payload_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL CHECK(stream IN ('load_operation', 'carrier_communication', 'procurement')),
        event_id TEXT NOT NULL, operation_id TEXT NOT NULL, kind TEXT NOT NULL,
        recorded_at TEXT NOT NULL, command_hash TEXT NOT NULL, previous_hash TEXT,
        record_hash TEXT NOT NULL, event_json TEXT NOT NULL, inserted_at TEXT NOT NULL,
        UNIQUE(stream, event_id), UNIQUE(stream, record_hash)
      );
    `);
    legacy.prepare(`INSERT INTO payload_events(
      sequence, stream, event_id, operation_id, kind, recorded_at, command_hash,
      previous_hash, record_hash, event_json, inserted_at
    ) VALUES (1, 'load_operation', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`)
      .run(prior.eventId, prior.operationId, prior.kind, prior.recordedAt, prior.commandHash, loadOperationRecordHash(prior, null), JSON.stringify(prior), prior.recordedAt);
    legacy.close();
    const upgraded = new PayloadEventDatabase(path);
    const table = new Database(path, { readonly: true });
    const sql = table.prepare("SELECT sql FROM sqlite_master WHERE name = 'payload_events'").pluck().get() as string;
    expect(sql).toContain("'commercial'");
    table.close();
    expect(upgraded.summary()).toMatchObject({ totalEvents: 1, lastSequence: 1, procurementEvents: 0, commercialEvents: 0 });
    expect(upgraded.queryEvents().events[0]).toMatchObject({ sequence: 1, eventId: 'operation-event:legacy' });
    upgraded.close();
  });
});
