import { createHash } from 'node:crypto';
import { Pool, type PoolClient, type PoolConfig } from 'pg';
import type { CorpusRepository, CorpusReplayTarget } from './corpusRepository';
import {
  activeCorpusRecords,
  canonicalCorpusJson,
  corpusRecordDefect,
  corpusRecordHash,
  corpusRecordInput,
  corpusScopeValid,
  corpusVisibleScopes,
  findFacilitiesInRecords,
  prepareCorpusAppend,
  verifyCorpusRecordSet,
  type CorpusAppendResult,
  type CorpusPage,
  type CorpusProjectionEvent,
  type CorpusProjectionEventPage,
  type CorpusProjectionSource,
  type CorpusProjectorCheckpoint,
  type CorpusRecordInput,
  type CorpusRecordType,
  type CorpusReplayPage,
  type CorpusScope,
  type CorpusSummary,
  type FacilityDiscoveryResult,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const REQUIRED_MIGRATION = 1;
const GLOBAL_SEQUENCE_LOCK = 1_917_309_337;

type RecordRow = {
  sequence: string | number;
  scope: string;
  record_id: string;
  record_type: CorpusRecordType;
  known_at: string;
  recorded_at: string;
  previous_hash: string | null;
  record_hash: string;
  record_json: CorpusRecordInput | string;
};

type EventRow = {
  sequence: string | number;
  event_id: string;
  scope: string;
  record_id: string;
  record_type: CorpusRecordType;
  known_at: string;
  occurred_at: string;
  record_hash: string;
};

export interface PostgresCorpusRepositoryOptions {
  readonly tenantId?: string;
  readonly allowGlobalWrites?: boolean;
  readonly allowReplay?: boolean;
  readonly maxConnections?: number;
  readonly ssl?: false | { readonly rejectUnauthorized: boolean };
  readonly applicationName?: string;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalCorpusJson(value)).digest('hex');
}

function safeSequence(value: string | number, context: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error(`CORPUS_DATABASE_CORRUPT: ${context} has an unsafe sequence`);
  return sequence;
}

function storedRecord(row: RecordRow): StoredCorpusRecord {
  const sequence = safeSequence(row.sequence, `record ${row.record_id}`);
  let input: CorpusRecordInput;
  try { input = typeof row.record_json === 'string' ? JSON.parse(row.record_json) as CorpusRecordInput : row.record_json; }
  catch { throw new Error(`CORPUS_DATABASE_CORRUPT: record ${row.record_id} has invalid JSON`); }
  const defect = corpusRecordDefect(input);
  if (defect || !corpusScopeValid(row.scope) || input.recordId !== row.record_id || input.recordType !== row.record_type || input.knownAt !== row.known_at || !HASH.test(row.record_hash) || (row.previous_hash !== null && !HASH.test(row.previous_hash)) || !Number.isFinite(Date.parse(row.recorded_at))) {
    throw new Error(`CORPUS_DATABASE_CORRUPT: record ${row.record_id} contradicts indexed metadata${defect ? ` (${defect})` : ''}`);
  }
  return freeze({ ...input, sequence, scope: row.scope, recordedAt: row.recorded_at, previousHash: row.previous_hash, recordHash: row.record_hash } as StoredCorpusRecord);
}

function projectionEvent(row: EventRow): CorpusProjectionEvent {
  const sequence = safeSequence(row.sequence, `outbox event ${row.event_id}`);
  if (!ID.test(row.event_id) || !corpusScopeValid(row.scope) || !ID.test(row.record_id) || !HASH.test(row.record_hash) || row.event_id !== `corpus-event:${row.record_hash}` || !Number.isFinite(Date.parse(row.known_at)) || !Number.isFinite(Date.parse(row.occurred_at))) {
    throw new Error(`CORPUS_DATABASE_CORRUPT: projection event ${sequence} has invalid metadata`);
  }
  return freeze({ sequence, eventId: row.event_id, eventType: 'corpus.record.appended' as const, scope: row.scope, recordId: row.record_id, recordType: row.record_type, knownAt: row.known_at, occurredAt: row.occurred_at, recordHash: row.record_hash });
}

function displayDatabasePath(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return `postgresql://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '') || '(default)'}/payload_corpus`;
  } catch {
    return 'postgresql://configured/payload_corpus';
  }
}

/**
 * PostgreSQL/PostGIS implementation of the canonical corpus contract.
 * Every operation is a transaction because the RLS tenant is transaction-local.
 */
export class PostgresCorpusRepository implements CorpusRepository, CorpusReplayTarget {
  readonly backend = 'postgresql' as const;
  readonly databasePath: string;
  private readonly pool: Pool;
  private readonly tenantId: string | undefined;
  private readonly allowGlobalWrites: boolean;
  private readonly allowReplay: boolean;
  private ready: Promise<void> | null = null;

  constructor(connectionString: string, options: PostgresCorpusRepositoryOptions = {}) {
    if (!connectionString.trim()) throw new Error('CORPUS_POSTGRES_CONFIG_INVALID: connection string is empty');
    if (options.tenantId !== undefined && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(options.tenantId)) throw new Error('CORPUS_POSTGRES_CONFIG_INVALID: tenant id is invalid');
    this.databasePath = displayDatabasePath(connectionString);
    this.tenantId = options.tenantId;
    this.allowGlobalWrites = options.allowGlobalWrites === true;
    this.allowReplay = options.allowReplay === true;
    const config: PoolConfig = {
      connectionString,
      max: options.maxConnections ?? 10,
      application_name: options.applicationName ?? 'payload-corpus',
      ...(options.ssl === false || options.ssl === undefined ? {} : { ssl: options.ssl }),
    };
    this.pool = new Pool(config);
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      const readiness = (async () => {
        const result = await this.pool.query<{ version: number | string; postgis: boolean }>(`
          SELECT COALESCE(MAX(version), 0) AS version,
                 EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'postgis') AS postgis
          FROM payload_corpus.schema_migrations
        `).catch(error => {
          throw new Error(`CORPUS_POSTGRES_NOT_MIGRATED: ${error instanceof Error ? error.message : 'schema check failed'}`);
        });
        const row = result.rows[0];
        if (!row || Number(row.version) < REQUIRED_MIGRATION || row.postgis !== true) throw new Error(`CORPUS_POSTGRES_NOT_MIGRATED: migration ${REQUIRED_MIGRATION} and PostGIS are required`);
      })();
      this.ready = readiness.catch(error => {
        this.ready = null;
        throw error;
      });
    }
    await this.ready;
  }

  private assertScope(scope: CorpusScope, write = false): void {
    if (!corpusScopeValid(scope)) throw new Error('CORPUS_SCOPE_INVALID: scope is invalid');
    if (this.allowReplay) return;
    if (scope !== 'global' && scope !== `customer:${this.tenantId ?? ''}`) throw new Error('CORPUS_TENANT_SCOPE_DENIED: repository tenant does not authorize this customer scope');
    if (write && scope === 'global' && !this.allowGlobalWrites) throw new Error('CORPUS_GLOBAL_WRITE_DENIED: this repository connection is not configured for global writes');
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('payload.tenant_id', $1, true), set_config('payload.allow_global_write', $2, true)", [this.tenantId ?? '', this.allowGlobalWrites ? 'on' : 'off']);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* the connection already failed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadVisibleRecords(client: PoolClient): Promise<StoredCorpusRecord[]> {
    const result = await client.query<RecordRow>(`
      SELECT sequence::text, scope, record_id, record_type, known_at, recorded_at,
             previous_hash, record_hash, record_json
      FROM payload_corpus.corpus_records ORDER BY sequence ASC
    `);
    const records = result.rows.map(storedRecord);
    verifyCorpusRecordSet(records);
    return records;
  }

  async summary(): Promise<CorpusSummary> {
    return this.transaction(async client => {
      const [grouped, totals] = await Promise.all([
        client.query<{ scope: string; record_type: CorpusRecordType; count: string }>('SELECT scope, record_type, COUNT(*)::text AS count FROM payload_corpus.corpus_records GROUP BY scope, record_type ORDER BY scope, record_type'),
        client.query<{ last_sequence: string; projection_events: string; projector_checkpoints: string }>(`
          SELECT COALESCE((SELECT MAX(sequence) FROM payload_corpus.corpus_records), 0)::text AS last_sequence,
                 (SELECT COUNT(*) FROM payload_corpus.corpus_outbox_events)::text AS projection_events,
                 (SELECT COUNT(*) FROM payload_corpus.corpus_projector_checkpoints)::text AS projector_checkpoints
        `),
      ]);
      const row = totals.rows[0];
      return freeze({
        kind: 'physical_economy_corpus_summary' as const,
        databasePath: this.databasePath,
        durability: 'postgresql_postgis' as const,
        lastSequence: safeSequence(row?.last_sequence ?? 0, 'summary'),
        projectionEvents: safeSequence(row?.projection_events ?? 0, 'summary outbox'),
        projectorCheckpoints: safeSequence(row?.projector_checkpoints ?? 0, 'summary checkpoints'),
        records: grouped.rows.map(item => ({ scope: item.scope, recordType: item.record_type, count: safeSequence(item.count, 'summary group') })),
      });
    });
  }

  async append(scope: CorpusScope, records: readonly CorpusRecordInput[], recordedAt = new Date().toISOString()): Promise<CorpusAppendResult> {
    this.assertScope(scope, true);
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_SEQUENCE_LOCK]);
      const existingRecords = await this.loadVisibleRecords(client);
      const preparation = prepareCorpusAppend(scope, records, recordedAt, existingRecords);
      if (preparation.kind === 'refusal') return preparation;
      const existing = new Map(existingRecords.map(record => [record.recordId, record]));
      const newIds = new Set(preparation.newRecordIds);
      const committed: StoredCorpusRecord[] = [];
      for (const record of records) {
        const prior = existing.get(record.recordId);
        if (!newIds.has(record.recordId) && prior) { committed.push(prior); continue; }
        const sequenceResult = await client.query<{ sequence: string }>("SELECT nextval(pg_get_serial_sequence('payload_corpus.corpus_records', 'sequence'))::text AS sequence");
        const sequence = safeSequence(sequenceResult.rows[0]?.sequence ?? -1, 'next identity');
        const tail = await client.query<{ record_hash: string }>('SELECT record_hash FROM payload_corpus.corpus_records WHERE scope = $1 ORDER BY sequence DESC LIMIT 1', [scope]);
        const previousHash = tail.rows[0]?.record_hash ?? null;
        const recordHash = corpusRecordHash(sequence, scope, recordedAt, previousHash, record);
        await client.query(`
          INSERT INTO payload_corpus.corpus_records(
            sequence, scope, record_id, record_type, known_at, known_at_time,
            known_to, known_to_time, recorded_at, recorded_at_time,
            previous_hash, record_hash, record_json
          ) VALUES ($1,$2,$3,$4,$5,$5::timestamptz,$6,$6::timestamptz,$7,$7::timestamptz,$8,$9,$10::jsonb)
        `, [sequence, scope, record.recordId, record.recordType, record.knownAt, record.knownTo ?? null, recordedAt, previousHash, recordHash, canonicalCorpusJson(record)]);
        await client.query(`
          INSERT INTO payload_corpus.corpus_outbox_events(
            sequence, event_id, scope, record_id, record_type, known_at,
            known_at_time, occurred_at, occurred_at_time, record_hash
          ) VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz,$7,$7::timestamptz,$8)
        `, [sequence, `corpus-event:${recordHash}`, scope, record.recordId, record.recordType, record.knownAt, recordedAt, recordHash]);
        committed.push(freeze({ ...record, sequence, scope, recordedAt, previousHash, recordHash } as StoredCorpusRecord));
      }
      return freeze({ kind: 'committed' as const, records: committed, idempotent: preparation.idempotent });
    }).catch(error => {
      if ((error as { code?: string }).code === '23505') return freeze({ kind: 'refusal' as const, code: 'CORPUS_RECORD_CONFLICT' as const, detail: 'A canonical identity already exists.', remedy: 'Replay current state and append an explicit superseding record.' });
      throw error;
    });
  }

  async page(options: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number; readonly knowledgeCutoff?: string } = {}): Promise<CorpusPage> {
    const scope = options.scope ?? 'global';
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const knowledgeCutoff = options.knowledgeCutoff ?? new Date().toISOString();
    this.assertScope(scope);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isFinite(Date.parse(knowledgeCutoff))) throw new Error('CORPUS_QUERY_INVALID: scope, cursor, limit, or knowledge cutoff is invalid');
    return this.transaction(async client => {
      const admitted = new Set(corpusVisibleScopes(scope));
      const rows = (await this.loadVisibleRecords(client))
        .filter(record => admitted.has(record.scope) && record.sequence > afterSequence && Date.parse(record.knownAt) <= Date.parse(knowledgeCutoff));
      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit);
      return freeze({ kind: 'physical_economy_corpus_page' as const, scope, afterSequence, nextAfterSequence: records.at(-1)?.sequence ?? afterSequence, hasMore, records });
    });
  }

  async projectionSource(scope: CorpusScope = 'global', knowledgeCutoff = new Date().toISOString()): Promise<CorpusProjectionSource> {
    this.assertScope(scope);
    if (!Number.isFinite(Date.parse(knowledgeCutoff))) throw new Error('CORPUS_QUERY_INVALID: projection knowledge cutoff is invalid');
    return this.transaction(async client => {
      const admitted = new Set(corpusVisibleScopes(scope));
      const cutoff = Date.parse(knowledgeCutoff);
      const visible = (await this.loadVisibleRecords(client)).filter(record => admitted.has(record.scope) && Date.parse(record.knownAt) <= cutoff && (!record.knownTo || cutoff < Date.parse(record.knownTo)));
      const records = activeCorpusRecords(visible);
      return freeze({
        kind: 'physical_economy_projection_source' as const,
        scope,
        knowledgeCutoff,
        sourceSequence: visible.at(-1)?.sequence ?? 0,
        sourceDigest: digest(records.map(record => ({ recordId: record.recordId, recordHash: record.recordHash }))),
        records,
      });
    });
  }

  async findFacilities(materialRef: string, options: { readonly scope?: CorpusScope; readonly asOf?: string; readonly knowledgeCutoff?: string } = {}): Promise<FacilityDiscoveryResult> {
    const scope = options.scope ?? 'global';
    this.assertScope(scope);
    const source = await this.projectionSource(scope, options.knowledgeCutoff);
    return findFacilitiesInRecords(materialRef, source.records, { ...options, scope, knowledgeCutoff: source.knowledgeCutoff });
  }

  async replayPage(options: { readonly afterSequence?: number; readonly limit?: number } = {}): Promise<CorpusReplayPage> {
    if (!this.allowReplay) throw new Error('CORPUS_REPLAY_DENIED: replay reads require a migration-only repository');
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 500;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) throw new Error('CORPUS_REPLAY_CURSOR_INVALID: cursor or limit is invalid');
    return this.transaction(async client => {
      const rows = (await this.loadVisibleRecords(client)).filter(record => record.sequence > afterSequence);
      const hasMore = rows.length > limit;
      const records = rows.slice(0, limit);
      return freeze({ kind: 'physical_economy_corpus_replay_page' as const, afterSequence, nextAfterSequence: records.at(-1)?.sequence ?? afterSequence, hasMore, records });
    });
  }

  async readProjectionEvents(options: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number } = {}): Promise<CorpusProjectionEventPage> {
    const scope = options.scope ?? 'global';
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    this.assertScope(scope);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('CORPUS_PROJECTION_CURSOR_INVALID: scope, cursor, or limit is invalid');
    return this.transaction(async client => {
      const scopes = corpusVisibleScopes(scope);
      const result = await client.query<EventRow>(`
        SELECT sequence::text, event_id, scope, record_id, record_type, known_at, occurred_at, record_hash
        FROM payload_corpus.corpus_outbox_events
        WHERE scope = ANY($1::text[]) AND sequence > $2
        ORDER BY sequence ASC LIMIT $3
      `, [scopes, afterSequence, limit + 1]);
      const hasMore = result.rows.length > limit;
      const events = result.rows.slice(0, limit).map(projectionEvent);
      return freeze({ kind: 'corpus_projection_event_page' as const, scope, afterSequence, nextAfterSequence: events.at(-1)?.sequence ?? afterSequence, hasMore, events });
    });
  }

  async checkpointProjection(input: { readonly projector: string; readonly scope?: CorpusScope; readonly sequence: number; readonly updatedAt?: string }): Promise<CorpusProjectorCheckpoint> {
    const scope = input.scope ?? 'global';
    const updatedAt = input.updatedAt ?? new Date().toISOString();
    this.assertScope(scope, true);
    if (!ID.test(input.projector) || !Number.isSafeInteger(input.sequence) || input.sequence < 0 || !Number.isFinite(Date.parse(updatedAt))) throw new Error('CORPUS_PROJECTION_CHECKPOINT_INVALID: projector, scope, sequence, or time is invalid');
    return this.transaction(async client => {
      const scopes = corpusVisibleScopes(scope);
      const maximum = await client.query<{ sequence: string }>('SELECT COALESCE(MAX(sequence), 0)::text AS sequence FROM payload_corpus.corpus_outbox_events WHERE scope = ANY($1::text[])', [scopes]);
      if (input.sequence > safeSequence(maximum.rows[0]?.sequence ?? 0, 'outbox maximum')) throw new Error('CORPUS_PROJECTION_CHECKPOINT_INVALID: sequence is beyond the visible outbox');
      const existing = await client.query<{ sequence: string }>('SELECT sequence::text FROM payload_corpus.corpus_projector_checkpoints WHERE projector = $1 AND scope = $2', [input.projector, scope]);
      if (existing.rows[0] && input.sequence < safeSequence(existing.rows[0].sequence, 'checkpoint')) throw new Error('CORPUS_PROJECTION_CHECKPOINT_REGRESSION: checkpoints may only advance');
      await client.query(`
        INSERT INTO payload_corpus.corpus_projector_checkpoints(projector, scope, sequence, updated_at, updated_at_time)
        VALUES ($1,$2,$3,$4,$4::timestamptz)
        ON CONFLICT(projector, scope) DO UPDATE
        SET sequence = EXCLUDED.sequence, updated_at = EXCLUDED.updated_at, updated_at_time = EXCLUDED.updated_at_time
      `, [input.projector, scope, input.sequence, updatedAt]);
      return freeze({ kind: 'corpus_projector_checkpoint' as const, projector: input.projector, scope, sequence: input.sequence, updatedAt });
    });
  }

  async importReplayRecords(records: readonly StoredCorpusRecord[]): Promise<{ readonly imported: number; readonly lastSequence: number }> {
    if (!this.allowReplay) throw new Error('CORPUS_REPLAY_DENIED: construct a migration-only repository with allowReplay=true');
    verifyCorpusRecordSet(records);
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_SEQUENCE_LOCK]);
      const count = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM payload_corpus.corpus_records');
      if (Number(count.rows[0]?.count ?? 0) !== 0) throw new Error('CORPUS_REPLAY_TARGET_NOT_EMPTY: exact replay requires an empty central corpus');
      for (const record of [...records].sort((a, b) => a.sequence - b.sequence)) {
        const input = corpusRecordInput(record);
        await client.query(`
          INSERT INTO payload_corpus.corpus_records(
            sequence, scope, record_id, record_type, known_at, known_at_time,
            known_to, known_to_time, recorded_at, recorded_at_time,
            previous_hash, record_hash, record_json
          ) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$5::timestamptz,$6,$6::timestamptz,$7,$7::timestamptz,$8,$9,$10::jsonb)
        `, [record.sequence, record.scope, record.recordId, record.recordType, record.knownAt, record.knownTo ?? null, record.recordedAt, record.previousHash, record.recordHash, canonicalCorpusJson(input)]);
        await client.query(`
          INSERT INTO payload_corpus.corpus_outbox_events(
            sequence, event_id, scope, record_id, record_type, known_at,
            known_at_time, occurred_at, occurred_at_time, record_hash
          ) VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz,$7,$7::timestamptz,$8)
        `, [record.sequence, `corpus-event:${record.recordHash}`, record.scope, record.recordId, record.recordType, record.knownAt, record.recordedAt, record.recordHash]);
      }
      const lastSequence = records.at(-1)?.sequence ?? 0;
      if (lastSequence > 0) await client.query("SELECT setval(pg_get_serial_sequence('payload_corpus.corpus_records', 'sequence'), $1, true)", [lastSequence]);
      return freeze({ imported: records.length, lastSequence });
    });
  }
}
