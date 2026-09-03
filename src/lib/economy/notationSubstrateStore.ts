/** Durable destination store for federated Notation identities and projections. */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalCorpusJson } from './physicalEconomyCorpus';
import { notationSyncEnvelope, type NotationCorpusSyncPage } from './notationCorpusFederation';
import {
  NOTATION_SUBSTRATE_SCHEMA,
  semanticDocumentForEnvelope,
  vectorProjectionDefect,
  verifyNotationCorpusSyncPage,
  type NotationSemanticDocument,
  type NotationSubstrateAcknowledgement,
  type NotationSubstrateLagSample,
  type NotationVectorProjectionInput,
} from './notationSubstrate';
import { corpusVerificationDigest } from './corpusVerification';

type ChannelRow = {
  channel_id: string;
  source_node_uri: string;
  last_ingested_sequence: number;
  last_upstream_ack_sequence: number;
  source_sequence: number;
  corpus_build_id: string;
  projection_digest: string;
  last_ingested_at: string;
  last_upstream_ack_at: string | null;
};

type AckRow = { acknowledgement_json: string };
type LagRow = { sample_json: string };
type DocumentRow = { document_json: string };
type AckIntegrityRow = AckRow & { journal_sequence: number; acknowledgement_id: string; channel_id: string; page_digest: string; acknowledgement_hash: string };
type LagIntegrityRow = LagRow & { sample_id: string; acknowledgement_id: string; channel_id: string; observed_at: string };
type RecordIntegrityRow = {
  record_uri: string; channel_id: string; source_node_uri: string; source_sequence: number; event_id: string; object_uri: string;
  corpus_build_id: string; projection_digest: string; record_hash: string; envelope_digest: string; envelope_json: string; ingested_at: string;
};
type IdentityRow = { object_uri: string; source_node_uri: string; namespace: string; object_kind: string; local_id: string; record_type: string; first_record_uri: string; latest_record_uri: string; first_source_sequence: number; latest_source_sequence: number };
type DocumentIntegrityRow = DocumentRow & { document_uri: string; source_record_uri: string; object_uri: string; channel_id: string; document_hash: string; known_at: string };
type VectorRow = {
  projection_id: string;
  document_uri: string;
  document_hash: string;
  model_id: string;
  model_version: string;
  dimensions: number;
  vector_json: string;
  vector_hash: string;
  generated_at: string;
};

export type NotationSubstrateIngestionResult = {
  readonly kind: 'notation_substrate_ingestion';
  readonly idempotent: boolean;
  readonly acknowledgement: NotationSubstrateAcknowledgement;
  readonly lag: NotationSubstrateLagSample;
};

const HASH = /^[a-f0-9]{64}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function json<T>(text: string, label: string): T {
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`NOTATION_SUBSTRATE_CORRUPT: ${label} is not valid JSON`); }
}

function identityParts(objectUri: string): { kind: string; namespace: string; localId: string } {
  let parsed: URL;
  try { parsed = new URL(objectUri); } catch { throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: object URI is invalid'); }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parsed.protocol !== 'notation:' || !parsed.hostname || parts.length !== 2) throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: object URI does not identify kind, namespace, and local identity');
  return { kind: parsed.hostname, namespace: decodeURIComponent(parts[0]), localId: decodeURIComponent(parts[1]) };
}

function acknowledgementBasis(value: Omit<NotationSubstrateAcknowledgement, 'acknowledgementHash'>) {
  return value;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export class NotationSubstrateStore {
  readonly backend = 'sqlite_wal' as const;
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
      CREATE TABLE IF NOT EXISTS notation_substrate_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notation_substrate_channels (
        channel_id TEXT PRIMARY KEY,
        source_node_uri TEXT NOT NULL,
        last_ingested_sequence INTEGER NOT NULL CHECK(last_ingested_sequence >= 0),
        last_upstream_ack_sequence INTEGER NOT NULL CHECK(last_upstream_ack_sequence >= 0),
        source_sequence INTEGER NOT NULL CHECK(source_sequence >= last_ingested_sequence),
        corpus_build_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        last_ingested_at TEXT NOT NULL,
        last_upstream_ack_at TEXT
      );
      CREATE TABLE IF NOT EXISTS notation_identity_bindings (
        object_uri TEXT PRIMARY KEY,
        source_node_uri TEXT NOT NULL,
        namespace TEXT NOT NULL,
        object_kind TEXT NOT NULL,
        local_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        first_record_uri TEXT NOT NULL,
        latest_record_uri TEXT NOT NULL,
        first_source_sequence INTEGER NOT NULL,
        latest_source_sequence INTEGER NOT NULL,
        UNIQUE(source_node_uri, namespace, object_kind, local_id)
      );
      CREATE TABLE IF NOT EXISTS notation_substrate_records (
        record_uri TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        source_node_uri TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        event_id TEXT NOT NULL UNIQUE,
        object_uri TEXT NOT NULL REFERENCES notation_identity_bindings(object_uri),
        corpus_build_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        record_hash TEXT NOT NULL,
        envelope_digest TEXT NOT NULL UNIQUE,
        envelope_json TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        UNIQUE(source_node_uri, source_sequence)
      );
      CREATE INDEX IF NOT EXISTS notation_records_object ON notation_substrate_records(object_uri, source_sequence);
      CREATE INDEX IF NOT EXISTS notation_records_channel ON notation_substrate_records(channel_id, source_sequence);
      CREATE TABLE IF NOT EXISTS notation_semantic_documents (
        document_uri TEXT PRIMARY KEY,
        source_record_uri TEXT NOT NULL UNIQUE REFERENCES notation_substrate_records(record_uri),
        object_uri TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        document_hash TEXT NOT NULL UNIQUE,
        known_at TEXT NOT NULL,
        document_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notation_semantic_object ON notation_semantic_documents(object_uri, known_at);
      CREATE TABLE IF NOT EXISTS notation_vector_projections (
        projection_id TEXT PRIMARY KEY,
        document_uri TEXT NOT NULL REFERENCES notation_semantic_documents(document_uri),
        document_hash TEXT NOT NULL,
        model_id TEXT NOT NULL,
        model_version TEXT NOT NULL,
        dimensions INTEGER NOT NULL CHECK(dimensions > 0 AND dimensions <= 4096),
        vector_json TEXT NOT NULL,
        vector_hash TEXT NOT NULL UNIQUE,
        generated_at TEXT NOT NULL,
        UNIQUE(document_uri, model_id, model_version)
      );
      CREATE INDEX IF NOT EXISTS notation_vector_model ON notation_vector_projections(model_id, model_version, dimensions);
      CREATE TABLE IF NOT EXISTS notation_substrate_acknowledgements (
        journal_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        acknowledgement_id TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        page_digest TEXT NOT NULL UNIQUE,
        acknowledgement_hash TEXT NOT NULL UNIQUE,
        acknowledgement_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notation_ack_channel_sequence ON notation_substrate_acknowledgements(channel_id, journal_sequence);
      CREATE TABLE IF NOT EXISTS notation_substrate_lag_samples (
        sample_id TEXT PRIMARY KEY,
        acknowledgement_id TEXT NOT NULL UNIQUE REFERENCES notation_substrate_acknowledgements(acknowledgement_id),
        channel_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        sample_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS notation_lag_channel_time ON notation_substrate_lag_samples(channel_id, observed_at);
    `);
    const schema = this.db.prepare("SELECT value FROM notation_substrate_metadata WHERE key = 'schema'").get() as { value: string } | undefined;
    if (!schema) this.db.prepare("INSERT INTO notation_substrate_metadata(key,value) VALUES ('schema',?)").run(NOTATION_SUBSTRATE_SCHEMA);
    else if (schema.value !== NOTATION_SUBSTRATE_SCHEMA) { this.db.close(); throw new Error(`NOTATION_SUBSTRATE_SCHEMA_UNSUPPORTED: ${schema.value}`); }
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('NOTATION_SUBSTRATE_CORRUPT: SQLite quick_check did not return ok'); }
    try { this.verify(); } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  private verify(): void {
    const previousByChannel = new Map<string, string>();
    const latestAckByChannel = new Map<string, NotationSubstrateAcknowledgement>();
    const acknowledgementIds = new Set<string>();
    const acks = this.db.prepare('SELECT * FROM notation_substrate_acknowledgements ORDER BY journal_sequence ASC').all() as AckIntegrityRow[];
    for (const row of acks) {
      const ack = json<NotationSubstrateAcknowledgement>(row.acknowledgement_json, 'acknowledgement');
      const expectedPrevious = previousByChannel.get(ack.channelId) ?? null;
      const basis: Record<string, unknown> = { ...ack };
      delete basis.acknowledgementHash;
      if (Number(row.journal_sequence) !== ack.journalSequence || row.acknowledgement_id !== ack.acknowledgementId || row.channel_id !== ack.channelId || row.page_digest !== ack.pageDigest || row.acknowledgement_hash !== ack.acknowledgementHash ||
          ack.previousHash !== expectedPrevious || !HASH.test(ack.acknowledgementHash) || corpusVerificationDigest(basis) !== ack.acknowledgementHash) throw new Error('NOTATION_SUBSTRATE_CORRUPT: acknowledgement chain or index is invalid');
      previousByChannel.set(ack.channelId, ack.acknowledgementHash);
      latestAckByChannel.set(ack.channelId, ack);
      acknowledgementIds.add(ack.acknowledgementId);
    }
    const lagRows = this.db.prepare('SELECT * FROM notation_substrate_lag_samples ORDER BY observed_at,sample_id').all() as LagIntegrityRow[];
    for (const row of lagRows) {
      const lag = json<NotationSubstrateLagSample>(row.sample_json, 'lag sample');
      const lagBasis: Record<string, unknown> = { ...lag };
      delete lagBasis.sampleId;
      const expectedId = `notation-lag:${corpusVerificationDigest({ acknowledgementId: row.acknowledgement_id, ...lagBasis })}`;
      if (!acknowledgementIds.has(row.acknowledgement_id) || row.sample_id !== lag.sampleId || expectedId !== lag.sampleId || row.channel_id !== lag.channelId || row.observed_at !== lag.observedAt) throw new Error('NOTATION_SUBSTRATE_CORRUPT: lag sample or acknowledgement binding is invalid');
    }
    const records = this.db.prepare('SELECT * FROM notation_substrate_records ORDER BY source_node_uri,source_sequence').all() as RecordIntegrityRow[];
    for (const row of records) {
      const envelope = json<NotationCorpusSyncPage['envelopes'][number]>(row.envelope_json, 'sync envelope');
      const expectedEnvelope = notationSyncEnvelope(envelope.record, row.corpus_build_id);
      const expected = semanticDocumentForEnvelope(expectedEnvelope, row.projection_digest);
      const actualDocument = this.db.prepare('SELECT * FROM notation_semantic_documents WHERE source_record_uri = ?').get(envelope.recordUri) as DocumentIntegrityRow | undefined;
      const binding = this.db.prepare('SELECT * FROM notation_identity_bindings WHERE object_uri = ?').get(envelope.objectUri) as IdentityRow | undefined;
      const parts = identityParts(envelope.objectUri);
      const actual = actualDocument ? json<NotationSemanticDocument>(actualDocument.document_json, 'semantic document') : null;
      if (row.record_uri !== envelope.recordUri || row.source_node_uri !== envelope.sourceNodeUri || Number(row.source_sequence) !== envelope.sequence || row.event_id !== envelope.eventId || row.object_uri !== envelope.objectUri || row.record_hash !== envelope.recordHash || row.envelope_digest !== envelope.envelopeDigest || !Number.isFinite(Date.parse(row.ingested_at)) ||
          canonicalCorpusJson(envelope) !== canonicalCorpusJson(expectedEnvelope) || !actualDocument || !actual || canonicalCorpusJson(actual) !== canonicalCorpusJson(expected) || actualDocument.document_uri !== actual.documentUri || actualDocument.source_record_uri !== actual.sourceRecordUri || actualDocument.object_uri !== actual.objectUri || actualDocument.channel_id !== row.channel_id || actualDocument.document_hash !== actual.documentHash || actualDocument.known_at !== actual.knownAt ||
          !binding || binding.source_node_uri !== envelope.sourceNodeUri || binding.namespace !== parts.namespace || binding.object_kind !== parts.kind || binding.local_id !== parts.localId || binding.record_type !== envelope.recordType) {
        throw new Error(`NOTATION_SUBSTRATE_CORRUPT: record ${envelope.recordUri} does not reproduce its envelope or semantic document`);
      }
    }
    const bindings = this.db.prepare('SELECT * FROM notation_identity_bindings ORDER BY object_uri').all() as IdentityRow[];
    for (const binding of bindings) {
      const edgeRows = this.db.prepare('SELECT record_uri,source_sequence FROM notation_substrate_records WHERE object_uri=? ORDER BY source_sequence').all(binding.object_uri) as Array<{ record_uri: string; source_sequence: number }>;
      if (!edgeRows.length || binding.first_record_uri !== edgeRows[0].record_uri || Number(binding.first_source_sequence) !== Number(edgeRows[0].source_sequence) || binding.latest_record_uri !== edgeRows.at(-1)!.record_uri || Number(binding.latest_source_sequence) !== Number(edgeRows.at(-1)!.source_sequence)) throw new Error(`NOTATION_SUBSTRATE_CORRUPT: identity ${binding.object_uri} has an invalid record range`);
    }
    const channels = this.db.prepare('SELECT * FROM notation_substrate_channels ORDER BY channel_id').all() as ChannelRow[];
    for (const channel of channels) {
      const ack = latestAckByChannel.get(channel.channel_id);
      if (!ack || Number(channel.last_ingested_sequence) !== ack.acknowledgedSequence || Number(channel.source_sequence) !== ack.sourceSequence || channel.source_node_uri !== ack.sourceNodeUri || channel.corpus_build_id !== ack.corpusBuildId || channel.projection_digest !== ack.projectionDigest || channel.last_ingested_at !== ack.acknowledgedAt || Number(channel.last_upstream_ack_sequence) > Number(channel.last_ingested_sequence) || !Number.isFinite(Date.parse(channel.last_ingested_at)) || channel.last_upstream_ack_at !== null && !Number.isFinite(Date.parse(channel.last_upstream_ack_at))) throw new Error(`NOTATION_SUBSTRATE_CORRUPT: channel ${channel.channel_id} does not reproduce its latest acknowledgement`);
    }
    const vectors = this.db.prepare('SELECT * FROM notation_vector_projections ORDER BY projection_id').all() as VectorRow[];
    for (const row of vectors) {
      const values = json<number[]>(row.vector_json, `vector ${row.projection_id}`);
      const document = this.db.prepare('SELECT document_hash FROM notation_semantic_documents WHERE document_uri = ?').get(row.document_uri) as { document_hash: string } | undefined;
      const basis = { documentUri: row.document_uri, documentHash: row.document_hash, modelId: row.model_id, modelVersion: row.model_version, dimensions: Number(row.dimensions), values };
      if (!document || document.document_hash !== row.document_hash || !MODEL.test(row.model_id) || !MODEL.test(row.model_version) || !Number.isFinite(Date.parse(row.generated_at)) || values.length !== Number(row.dimensions) || values.some(value => !Number.isFinite(value)) || corpusVerificationDigest(basis) !== row.vector_hash || row.projection_id !== `notation-vector:${row.vector_hash}`) throw new Error(`NOTATION_SUBSTRATE_CORRUPT: vector ${row.projection_id} is invalid`);
    }
  }

  channel(channelId: string): Readonly<ChannelRow> | null {
    const row = this.db.prepare('SELECT * FROM notation_substrate_channels WHERE channel_id = ?').get(channelId) as ChannelRow | undefined;
    return row ? freeze({ ...row }) : null;
  }

  ingest(page: NotationCorpusSyncPage, ingestedAt = new Date().toISOString()): NotationSubstrateIngestionResult {
    verifyNotationCorpusSyncPage(page);
    if (!Number.isFinite(Date.parse(ingestedAt))) throw new Error('NOTATION_SUBSTRATE_INPUT_INVALID: ingestedAt is invalid');
    const channelId = page.channel.channelId;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const priorAckRow = this.db.prepare('SELECT acknowledgement_json FROM notation_substrate_acknowledgements WHERE page_digest = ?').get(page.pageDigest) as AckRow | undefined;
      if (priorAckRow) {
        const acknowledgement = json<NotationSubstrateAcknowledgement>(priorAckRow.acknowledgement_json, 'acknowledgement');
        const lagRow = this.db.prepare('SELECT sample_json FROM notation_substrate_lag_samples WHERE acknowledgement_id = ?').get(acknowledgement.acknowledgementId) as LagRow;
        this.db.exec('COMMIT');
        return freeze({ kind: 'notation_substrate_ingestion' as const, idempotent: true, acknowledgement, lag: json<NotationSubstrateLagSample>(lagRow.sample_json, 'lag sample') });
      }
      const state = this.channel(channelId);
      const expectedAfter = state?.last_ingested_sequence ?? 0;
      if (page.afterSequence !== expectedAfter) throw new Error(`NOTATION_SUBSTRATE_CURSOR_DISCONTINUITY: expected ${expectedAfter}, received ${page.afterSequence}`);

      const collisions: string[] = [];
      const pageRecords = new Set<string>();
      const pageEvents = new Set<string>();
      const pageBindings = new Map<string, { sourceNodeUri: string; namespace: string; kind: string; localId: string; recordType: string }>();
      for (const envelope of page.envelopes) {
        const bySequence = this.db.prepare('SELECT envelope_digest FROM notation_substrate_records WHERE source_node_uri = ? AND source_sequence = ?').get(envelope.sourceNodeUri, envelope.sequence) as { envelope_digest: string } | undefined;
        const byRecord = this.db.prepare('SELECT envelope_digest FROM notation_substrate_records WHERE record_uri = ?').get(envelope.recordUri) as { envelope_digest: string } | undefined;
        const byEvent = this.db.prepare('SELECT envelope_digest FROM notation_substrate_records WHERE event_id = ?').get(envelope.eventId) as { envelope_digest: string } | undefined;
        for (const found of [bySequence, byRecord, byEvent]) if (found && found.envelope_digest !== envelope.envelopeDigest) collisions.push(envelope.objectUri);
        const parts = identityParts(envelope.objectUri);
        if (pageRecords.has(envelope.recordUri) || pageEvents.has(envelope.eventId)) collisions.push(envelope.objectUri);
        pageRecords.add(envelope.recordUri); pageEvents.add(envelope.eventId);
        const pending = pageBindings.get(envelope.objectUri);
        if (pending && (pending.sourceNodeUri !== envelope.sourceNodeUri || pending.namespace !== parts.namespace || pending.kind !== parts.kind || pending.localId !== parts.localId || pending.recordType !== envelope.recordType)) collisions.push(envelope.objectUri);
        else pageBindings.set(envelope.objectUri, { sourceNodeUri: envelope.sourceNodeUri, namespace: parts.namespace, kind: parts.kind, localId: parts.localId, recordType: envelope.recordType });
        const binding = this.db.prepare('SELECT source_node_uri,namespace,object_kind,local_id,record_type FROM notation_identity_bindings WHERE object_uri = ?').get(envelope.objectUri) as { source_node_uri: string; namespace: string; object_kind: string; local_id: string; record_type: string } | undefined;
        if (binding && (binding.source_node_uri !== envelope.sourceNodeUri || binding.namespace !== parts.namespace || binding.object_kind !== parts.kind || binding.local_id !== parts.localId || binding.record_type !== envelope.recordType)) collisions.push(envelope.objectUri);
      }
      if (collisions.length) throw new Error(`NOTATION_IDENTITY_COLLISION: ${[...new Set(collisions)].sort().join(',')}`);

      let appliedRecords = 0;
      let existingRecords = 0;
      for (const envelope of page.envelopes) {
        const existing = this.db.prepare('SELECT envelope_digest FROM notation_substrate_records WHERE record_uri = ?').get(envelope.recordUri) as { envelope_digest: string } | undefined;
        if (existing) { existingRecords += 1; continue; }
        const parts = identityParts(envelope.objectUri);
        this.db.prepare(`
          INSERT INTO notation_identity_bindings(object_uri,source_node_uri,namespace,object_kind,local_id,record_type,first_record_uri,latest_record_uri,first_source_sequence,latest_source_sequence)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(object_uri) DO UPDATE SET latest_record_uri=excluded.latest_record_uri,latest_source_sequence=excluded.latest_source_sequence
        `).run(envelope.objectUri, envelope.sourceNodeUri, parts.namespace, parts.kind, parts.localId, envelope.recordType, envelope.recordUri, envelope.recordUri, envelope.sequence, envelope.sequence);
        this.db.prepare(`INSERT INTO notation_substrate_records(record_uri,channel_id,source_node_uri,source_sequence,event_id,object_uri,corpus_build_id,projection_digest,record_hash,envelope_digest,envelope_json,ingested_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope.recordUri, channelId, envelope.sourceNodeUri, envelope.sequence, envelope.eventId, envelope.objectUri, page.corpusBuildId, page.projectionDigest, envelope.recordHash, envelope.envelopeDigest, canonicalCorpusJson(envelope), ingestedAt);
        const document = semanticDocumentForEnvelope(envelope, page.projectionDigest, channelId);
        this.db.prepare('INSERT INTO notation_semantic_documents(document_uri,source_record_uri,object_uri,channel_id,document_hash,known_at,document_json) VALUES (?,?,?,?,?,?,?)').run(document.documentUri, document.sourceRecordUri, document.objectUri, document.channelId, document.documentHash, document.knownAt, canonicalCorpusJson(document));
        appliedRecords += 1;
      }
      const nextJournal = Number((this.db.prepare('SELECT COALESCE(MAX(journal_sequence),0)+1 AS sequence FROM notation_substrate_acknowledgements').get() as { sequence: number }).sequence);
      const priorHash = (this.db.prepare('SELECT acknowledgement_hash FROM notation_substrate_acknowledgements WHERE channel_id = ? ORDER BY journal_sequence DESC LIMIT 1').get(channelId) as { acknowledgement_hash: string } | undefined)?.acknowledgement_hash ?? null;
      const acknowledgementId = `notation-ack:${corpusVerificationDigest({ channelId, pageDigest: page.pageDigest })}`;
      const ackBasis = acknowledgementBasis({
        schema: 'notation.substrate.acknowledgement.v1', journalSequence: nextJournal, acknowledgementId,
        channelId, sourceNodeUri: page.sourceNodeUri, pageDigest: page.pageDigest, corpusBuildId: page.corpusBuildId,
        projectionDigest: page.projectionDigest, afterSequence: page.afterSequence, acknowledgedSequence: page.nextAfterSequence,
        sourceSequence: page.sourceSequence, appliedRecords, existingRecords, acknowledgedAt: ingestedAt, previousHash: priorHash,
      });
      const acknowledgement = freeze({ ...ackBasis, acknowledgementHash: corpusVerificationDigest(ackBasis) });
      this.db.prepare('INSERT INTO notation_substrate_acknowledgements(journal_sequence,acknowledgement_id,channel_id,page_digest,acknowledgement_hash,acknowledgement_json) VALUES (?,?,?,?,?,?)').run(nextJournal, acknowledgementId, channelId, page.pageDigest, acknowledgement.acknowledgementHash, canonicalCorpusJson(acknowledgement));

      const processedAt = page.envelopes.at(-1)?.occurredAt ?? null;
      const publicTimeLagMs = page.hasMore && processedAt && page.sourceLatestOccurredAt
        ? Math.max(0, Date.parse(page.sourceLatestOccurredAt) - Date.parse(processedAt)) : page.hasMore ? null : 0;
      const lagBasis = {
        schema: 'notation.substrate.lag-sample.v1' as const,
        channelId, sourceNodeUri: page.sourceNodeUri, observedAt: ingestedAt,
        acknowledgedSequence: page.nextAfterSequence, sourceSequence: page.sourceSequence,
        canonicalSequenceLag: Math.max(0, page.sourceSequence - page.nextAfterSequence),
        remainingEnvelopeCount: page.remainingEnvelopeCount,
        publicTimeLagMs,
        timeLagBasis: publicTimeLagMs === null ? 'UNOBSERVED' as const : 'LATEST_PUBLIC_ENVELOPE' as const,
      };
      const lag = freeze({ ...lagBasis, sampleId: `notation-lag:${corpusVerificationDigest({ acknowledgementId, ...lagBasis })}` });
      this.db.prepare('INSERT INTO notation_substrate_lag_samples(sample_id,acknowledgement_id,channel_id,observed_at,sample_json) VALUES (?,?,?,?,?)').run(lag.sampleId, acknowledgementId, channelId, ingestedAt, canonicalCorpusJson(lag));
      this.db.prepare(`INSERT INTO notation_substrate_channels(channel_id,source_node_uri,last_ingested_sequence,last_upstream_ack_sequence,source_sequence,corpus_build_id,projection_digest,last_ingested_at,last_upstream_ack_at)
        VALUES (?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(channel_id) DO UPDATE SET source_node_uri=excluded.source_node_uri,last_ingested_sequence=excluded.last_ingested_sequence,source_sequence=excluded.source_sequence,corpus_build_id=excluded.corpus_build_id,projection_digest=excluded.projection_digest,last_ingested_at=excluded.last_ingested_at`).run(
        channelId, page.sourceNodeUri, page.nextAfterSequence, state?.last_upstream_ack_sequence ?? 0, page.sourceSequence, page.corpusBuildId, page.projectionDigest, ingestedAt,
      );
      this.db.exec('COMMIT');
      return freeze({ kind: 'notation_substrate_ingestion' as const, idempotent: false, acknowledgement, lag });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw error;
    }
  }

  markUpstreamAcknowledged(channelId: string, sequence: number, acknowledgedAt = new Date().toISOString()): Readonly<ChannelRow> {
    const state = this.channel(channelId);
    if (!state || !Number.isSafeInteger(sequence) || sequence < state.last_upstream_ack_sequence || sequence > state.last_ingested_sequence || !Number.isFinite(Date.parse(acknowledgedAt))) throw new Error('NOTATION_SUBSTRATE_UPSTREAM_ACK_INVALID: channel, sequence, or time is invalid');
    this.db.prepare('UPDATE notation_substrate_channels SET last_upstream_ack_sequence=?,last_upstream_ack_at=? WHERE channel_id=?').run(sequence, acknowledgedAt, channelId);
    return this.channel(channelId)!;
  }

  acknowledgements(options: { afterSequence?: number; limit?: number } = {}): readonly NotationSubstrateAcknowledgement[] {
    const after = options.afterSequence ?? 0; const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('NOTATION_SUBSTRATE_QUERY_INVALID: acknowledgement cursor or limit is invalid');
    const rows = this.db.prepare('SELECT acknowledgement_json FROM notation_substrate_acknowledgements WHERE journal_sequence > ? ORDER BY journal_sequence ASC LIMIT ?').all(after, limit) as AckRow[];
    return freeze(rows.map(row => json<NotationSubstrateAcknowledgement>(row.acknowledgement_json, 'acknowledgement')));
  }

  lagSamples(options: { channelId?: string; limit?: number } = {}): readonly NotationSubstrateLagSample[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('NOTATION_SUBSTRATE_QUERY_INVALID: lag limit is invalid');
    const rows = options.channelId
      ? this.db.prepare('SELECT sample_json FROM notation_substrate_lag_samples WHERE channel_id = ? ORDER BY observed_at DESC LIMIT ?').all(options.channelId, limit) as LagRow[]
      : this.db.prepare('SELECT sample_json FROM notation_substrate_lag_samples ORDER BY observed_at DESC LIMIT ?').all(limit) as LagRow[];
    return freeze(rows.map(row => json<NotationSubstrateLagSample>(row.sample_json, 'lag sample')));
  }

  semanticDocuments(options: { afterKnownAt?: string; limit?: number; withoutModelId?: string; withoutModelVersion?: string } = {}): readonly NotationSemanticDocument[] {
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || options.afterKnownAt !== undefined && !Number.isFinite(Date.parse(options.afterKnownAt)) ||
        options.withoutModelId !== undefined && !MODEL.test(options.withoutModelId) || options.withoutModelVersion !== undefined && !MODEL.test(options.withoutModelVersion) || Boolean(options.withoutModelId) !== Boolean(options.withoutModelVersion)) throw new Error('NOTATION_SUBSTRATE_QUERY_INVALID: semantic-document cursor, model, or limit is invalid');
    const parameters: Array<string | number> = [];
    const conditions: string[] = [];
    if (options.afterKnownAt) { conditions.push('d.known_at > ?'); parameters.push(options.afterKnownAt); }
    if (options.withoutModelId && options.withoutModelVersion) {
      conditions.push('NOT EXISTS (SELECT 1 FROM notation_vector_projections v WHERE v.document_uri=d.document_uri AND v.model_id=? AND v.model_version=?)');
      parameters.push(options.withoutModelId, options.withoutModelVersion);
    }
    parameters.push(limit);
    const rows = this.db.prepare(`SELECT d.document_json FROM notation_semantic_documents d ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY d.known_at ASC,d.document_uri ASC LIMIT ?`).all(...parameters) as DocumentRow[];
    return freeze(rows.map(row => json<NotationSemanticDocument>(row.document_json, 'semantic document')));
  }

  putVector(input: NotationVectorProjectionInput): { readonly kind: 'notation_vector_projection'; readonly idempotent: boolean; readonly projectionId: string; readonly vectorHash: string } {
    const defect = vectorProjectionDefect(input);
    if (defect) throw new Error(`NOTATION_VECTOR_INPUT_INVALID: ${defect}`);
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const document = this.db.prepare('SELECT document_hash FROM notation_semantic_documents WHERE document_uri = ?').get(input.documentUri) as { document_hash: string } | undefined;
    if (!document || document.document_hash !== input.documentHash) throw new Error('NOTATION_VECTOR_DOCUMENT_MISMATCH: vector does not identify an exact semantic document');
    const basis = { documentUri: input.documentUri, documentHash: input.documentHash, modelId: input.modelId, modelVersion: input.modelVersion, dimensions: input.values.length, values: [...input.values] };
    const vectorHash = corpusVerificationDigest(basis);
    const projectionId = `notation-vector:${vectorHash}`;
    const existing = this.db.prepare('SELECT vector_hash FROM notation_vector_projections WHERE document_uri=? AND model_id=? AND model_version=?').get(input.documentUri, input.modelId, input.modelVersion) as { vector_hash: string } | undefined;
    if (existing) {
      if (existing.vector_hash !== vectorHash) throw new Error('NOTATION_VECTOR_CONFLICT: model version already projected different values for this document');
      return freeze({ kind: 'notation_vector_projection' as const, idempotent: true, projectionId, vectorHash });
    }
    this.db.prepare('INSERT INTO notation_vector_projections(projection_id,document_uri,document_hash,model_id,model_version,dimensions,vector_json,vector_hash,generated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(projectionId, input.documentUri, input.documentHash, input.modelId, input.modelVersion, input.values.length, canonicalCorpusJson(input.values), vectorHash, generatedAt);
    return freeze({ kind: 'notation_vector_projection' as const, idempotent: false, projectionId, vectorHash });
  }

  vectorSearch(input: { modelId: string; modelVersion: string; values: readonly number[]; limit?: number }) {
    const limit = input.limit ?? 10;
    if (!MODEL.test(input.modelId) || !MODEL.test(input.modelVersion) || !Array.isArray(input.values) || input.values.length < 1 || input.values.length > 4096 || input.values.some(value => !Number.isFinite(value)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('NOTATION_VECTOR_QUERY_INVALID: model, vector, or limit is invalid');
    const rows = this.db.prepare('SELECT * FROM notation_vector_projections WHERE model_id=? AND model_version=? AND dimensions=?').all(input.modelId, input.modelVersion, input.values.length) as VectorRow[];
    const hits = rows.map(row => ({
      projectionId: row.projection_id, documentUri: row.document_uri, documentHash: row.document_hash,
      score: { value: cosine(input.values, json<number[]>(row.vector_json, `vector ${row.projection_id}`)), basis: 'cosine_similarity' as const, interpretation: 'Vector proximity only; not truth, confidence, or materiality.' },
    })).sort((left, right) => right.score.value - left.score.value || left.documentUri.localeCompare(right.documentUri)).slice(0, limit);
    return freeze({ kind: 'notation_vector_search' as const, modelId: input.modelId, modelVersion: input.modelVersion, dimensions: input.values.length, hits, limitations: ['Similarity is computed only across vectors produced by the exact named model and version.', 'Vector proximity does not establish empirical truth, confidence, causality, or materiality.'] });
  }

  status() {
    const scalar = (sql: string): number => Number((this.db.prepare(sql).get() as { count: number }).count);
    const channels = this.db.prepare('SELECT * FROM notation_substrate_channels ORDER BY channel_id').all() as ChannelRow[];
    const vectorModels = this.db.prepare('SELECT model_id,model_version,dimensions,COUNT(*) AS count FROM notation_vector_projections GROUP BY model_id,model_version,dimensions ORDER BY model_id,model_version').all() as Array<{ model_id: string; model_version: string; dimensions: number; count: number }>;
    return freeze({
      kind: 'notation_substrate_status' as const,
      schema: NOTATION_SUBSTRATE_SCHEMA,
      backend: this.backend,
      counts: { identities: scalar('SELECT COUNT(*) AS count FROM notation_identity_bindings'), records: scalar('SELECT COUNT(*) AS count FROM notation_substrate_records'), semanticDocuments: scalar('SELECT COUNT(*) AS count FROM notation_semantic_documents'), vectorProjections: scalar('SELECT COUNT(*) AS count FROM notation_vector_projections'), acknowledgements: scalar('SELECT COUNT(*) AS count FROM notation_substrate_acknowledgements'), lagSamples: scalar('SELECT COUNT(*) AS count FROM notation_substrate_lag_samples') },
      channels: channels.map(row => ({ channelId: row.channel_id, sourceNodeUri: row.source_node_uri, lastIngestedSequence: Number(row.last_ingested_sequence), lastUpstreamAcknowledgedSequence: Number(row.last_upstream_ack_sequence), sourceSequence: Number(row.source_sequence), corpusBuildId: row.corpus_build_id, projectionDigest: row.projection_digest, lastIngestedAt: row.last_ingested_at, lastUpstreamAcknowledgedAt: row.last_upstream_ack_at, acknowledgementLag: Number(row.last_ingested_sequence) - Number(row.last_upstream_ack_sequence) })),
      vectorModels: vectorModels.map(row => ({ modelId: row.model_id, modelVersion: row.model_version, dimensions: Number(row.dimensions), count: Number(row.count) })),
      boundaries: { canonicalAuthority: 'Payload canonical corpus', identityAuthority: 'Notation Data Substrate', rawSourceTruthClaimed: false, embeddingProviderStatus: 'UNOBSERVED', vectorProjectionObserved: vectorModels.length > 0 },
    });
  }
}

export type NotationSubstrateStatus = ReturnType<NotationSubstrateStore['status']>;
