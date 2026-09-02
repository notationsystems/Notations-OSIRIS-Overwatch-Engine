/**
 * PayloadOS Physical-Economy Corpus V0.
 *
 * Immutable, evidence-linked records are globally sequenced for retrieval and
 * independently hash-chained per visibility scope. Public knowledge may be
 * composed with exactly one customer corpus; private scopes never compose with
 * one another. Similar names are never identities: resolution uses canonical
 * ids or explicit alias records only.
 */

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { stableValue } from './loadOperationsStore';
import { corpusAccessDefect, corpusAccessScopeDefect, type CorpusAccess } from './corpusPolicy';

export type CorpusScope = 'global' | `customer:${string}`;
export type CorpusEntityKind = 'organization' | 'facility' | 'material' | 'process' | 'network' | 'market' | 'geography';
export type CorpusRecordType = 'evidence' | 'entity' | 'alias' | 'relationship' | 'observation';
export type CorpusValueKind = 'reported' | 'estimated' | 'derived';
export type CorpusConfidence = 'high' | 'medium' | 'low';
export type CorpusRelationshipPredicate =
  | 'operated_by' | 'owned_by' | 'located_in' | 'produces' | 'consumes'
  | 'transforms' | 'supplies' | 'connects_to' | 'ships_via' | 'trades_in'
  | 'substitutes_for' | 'depends_on';

type CommonRecord = {
  readonly schema: 'payload.corpus.record.v1';
  readonly recordId: string;
  readonly recordType: CorpusRecordType;
  readonly knownAt: string;
  readonly supersedes?: string;
  /** Optional for V0 replay compatibility; every published projection denies missing classification. */
  readonly access?: CorpusAccess;
};

export type CorpusEvidenceRecord = CommonRecord & {
  readonly recordType: 'evidence';
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly title: string;
  readonly sourceUrl: string;
  readonly artifactSha256: string;
  readonly retrievedAt: string;
  readonly publishedAt?: string;
  readonly locator?: string;
  readonly license?: string;
  /** Raw bytes stay in object storage; canonical state holds only their identity and locator. */
  readonly artifactId?: string;
  readonly storageUri?: string;
  readonly mediaType?: string;
  readonly parserVersion?: string;
};

export type CorpusEntityRecord = CommonRecord & {
  readonly recordType: 'entity';
  readonly entityId: string;
  readonly entityKind: CorpusEntityKind;
  readonly canonicalName: string;
  readonly description?: string;
  readonly countryCode?: string;
  readonly location?: { readonly lat: number; readonly lng: number; readonly precision: 'exact' | 'site' | 'city' | 'region' | 'country' };
  readonly evidenceIds: readonly string[];
};

export type CorpusAliasRecord = CommonRecord & {
  readonly recordType: 'alias';
  readonly aliasId: string;
  readonly scheme: string;
  readonly value: string;
  readonly entityId: string;
  readonly evidenceIds: readonly string[];
};

export type CorpusRelationshipRecord = CommonRecord & {
  readonly recordType: 'relationship';
  readonly relationshipId: string;
  readonly subjectEntityId: string;
  readonly predicate: CorpusRelationshipPredicate;
  readonly objectEntityId: string;
  readonly validFrom?: string;
  readonly validTo?: string;
  readonly valueKind: CorpusValueKind;
  readonly confidence: CorpusConfidence;
  readonly evidenceIds: readonly string[];
};

export type CorpusObservationRecord = CommonRecord & {
  readonly recordType: 'observation';
  readonly observationId: string;
  readonly entityId: string;
  readonly metric: string;
  readonly value: number | string | boolean;
  readonly unit?: string;
  readonly basis?: string;
  readonly period?: { readonly start: string; readonly end: string };
  readonly valueKind: CorpusValueKind;
  readonly confidence: CorpusConfidence;
  readonly evidenceIds: readonly string[];
};

export type CorpusRecordInput = CorpusEvidenceRecord | CorpusEntityRecord | CorpusAliasRecord | CorpusRelationshipRecord | CorpusObservationRecord;
export type StoredCorpusRecord = CorpusRecordInput & {
  readonly sequence: number;
  readonly scope: CorpusScope;
  readonly recordedAt: string;
  readonly previousHash: string | null;
  readonly recordHash: string;
};

export type CorpusAppendResult =
  | { readonly kind: 'committed'; readonly records: readonly StoredCorpusRecord[]; readonly idempotent: boolean }
  | { readonly kind: 'refusal'; readonly code: 'CORPUS_INPUT_INVALID' | 'CORPUS_RECORD_CONFLICT' | 'CORPUS_REFERENCE_MISSING' | 'CORPUS_KNOWLEDGE_ORDER_INVALID' | 'CORPUS_REVISION_INVALID'; readonly detail: string; readonly remedy: string };
type CorpusAppendRefusal = Extract<CorpusAppendResult, { kind: 'refusal' }>;

export type CorpusProjectionSource = {
  readonly kind: 'physical_economy_projection_source';
  readonly scope: CorpusScope;
  readonly knowledgeCutoff: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly records: readonly StoredCorpusRecord[];
};

export type FacilityDiscoveryResult =
  | {
      readonly kind: 'facility_discovery';
      readonly material: { readonly entityId: string; readonly name: string };
      readonly scope: CorpusScope;
      readonly asOf: string;
      readonly knowledgeCutoff: string;
      readonly facilities: readonly {
        readonly entityId: string;
        readonly name: string;
        readonly countryCode?: string;
        readonly location?: CorpusEntityRecord['location'];
        readonly operator?: { readonly entityId: string; readonly name: string };
        readonly relationshipId: string;
        readonly confidence: CorpusConfidence;
        readonly evidence: readonly CorpusEvidenceRecord[];
      }[];
    }
  | { readonly kind: 'refusal'; readonly code: 'CORPUS_SCOPE_INVALID' | 'MATERIAL_UNRESOLVED' | 'MATERIAL_AMBIGUOUS' | 'NO_EVIDENCED_FACILITIES'; readonly detail: string; readonly remedy: string };

type RecordRow = {
  sequence: number;
  scope: string;
  record_id: string;
  record_type: CorpusRecordType;
  known_at: string;
  recorded_at: string;
  previous_hash: string | null;
  record_hash: string;
  record_json: string;
};

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const CUSTOMER_SCOPE = /^customer:[a-z0-9][a-z0-9._-]{1,63}$/;
const CORPUS_HASH_DOMAIN = 'payload.physical_economy.corpus.record.v1';
const ENTITY_KINDS: readonly CorpusEntityKind[] = ['organization', 'facility', 'material', 'process', 'network', 'market', 'geography'];
const PREDICATES: readonly CorpusRelationshipPredicate[] = ['operated_by', 'owned_by', 'located_in', 'produces', 'consumes', 'transforms', 'supplies', 'connects_to', 'ships_via', 'trades_in', 'substitutes_for', 'depends_on'];
const VALUE_KINDS: readonly CorpusValueKind[] = ['reported', 'estimated', 'derived'];
const CONFIDENCE: readonly CorpusConfidence[] = ['high', 'medium', 'low'];
const LOCATION_PRECISIONS = ['exact', 'site', 'city', 'region', 'country'] as const;

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validTime(value: string | undefined): boolean { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function validStorageUri(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ['https:', 's3:', 'gs:', 'az:', 'file:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch { return false; }
}
function normalizedAlias(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function visibleScopes(scope: CorpusScope): readonly CorpusScope[] { return scope === 'global' ? ['global'] : ['global', scope]; }
function scopeValid(scope: string): scope is CorpusScope { return scope === 'global' || CUSTOMER_SCOPE.test(scope); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
function refusal(code: CorpusAppendRefusal['code'], detail: string, remedy: string): CorpusAppendRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}
function queryRefusal(code: Extract<FacilityDiscoveryResult, { kind: 'refusal' }>['code'], detail: string, remedy: string): FacilityDiscoveryResult {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function evidenceIds(record: CorpusRecordInput): readonly string[] {
  return record.recordType === 'evidence' ? [] : Array.isArray(record.evidenceIds) ? record.evidenceIds : [];
}

function recordDefect(record: CorpusRecordInput): string | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'record is not an object';
  if (record.schema !== 'payload.corpus.record.v1' || typeof record.recordId !== 'string' || !ID.test(record.recordId) || !validTime(record.knownAt)) return `${record.recordId || 'record'} has invalid common identity or time`;
  if (record.supersedes !== undefined && (typeof record.supersedes !== 'string' || !ID.test(record.supersedes) || record.supersedes === record.recordId)) return `${record.recordId} has an invalid supersedes reference`;
  if (record.access !== undefined) {
    const accessProblem = corpusAccessDefect(record.access);
    if (accessProblem) return `${record.recordId} has invalid access classification: ${accessProblem}`;
  }
  if (record.recordType !== 'evidence' && !Array.isArray(record.evidenceIds)) return `${record.recordId} has no evidence-reference array`;
  if (record.recordType !== 'evidence' && record.evidenceIds.length === 0) return `${record.recordId} has no supporting evidence`;
  if (record.recordType === 'evidence') {
    if (typeof record.evidenceId !== 'string' || !ID.test(record.evidenceId) || typeof record.sourceId !== 'string' || !ID.test(record.sourceId) || !nonEmpty(record.title) || typeof record.sourceUrl !== 'string' || !/^https?:\/\//.test(record.sourceUrl) || typeof record.artifactSha256 !== 'string' || !HASH.test(record.artifactSha256) || !validTime(record.retrievedAt) || record.knownAt !== record.retrievedAt || (record.publishedAt !== undefined && (!validTime(record.publishedAt) || Date.parse(record.publishedAt) > Date.parse(record.retrievedAt)))) return `${record.recordId} has invalid evidence metadata`;
    if ((record.artifactId !== undefined && (typeof record.artifactId !== 'string' || !ID.test(record.artifactId))) || (record.storageUri !== undefined && (typeof record.storageUri !== 'string' || !validStorageUri(record.storageUri))) || (record.mediaType !== undefined && (typeof record.mediaType !== 'string' || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(record.mediaType))) || (record.parserVersion !== undefined && !nonEmpty(record.parserVersion))) return `${record.recordId} has invalid artifact metadata`;
  } else if (record.recordType === 'entity') {
    if (typeof record.entityId !== 'string' || !ID.test(record.entityId) || !ENTITY_KINDS.includes(record.entityKind) || !nonEmpty(record.canonicalName) || (record.countryCode !== undefined && (typeof record.countryCode !== 'string' || !/^[A-Z]{2}$/.test(record.countryCode)))) return `${record.recordId} has invalid entity metadata`;
    if (record.location && (!Number.isFinite(record.location.lat) || record.location.lat < -90 || record.location.lat > 90 || !Number.isFinite(record.location.lng) || record.location.lng < -180 || record.location.lng > 180 || !LOCATION_PRECISIONS.includes(record.location.precision))) return `${record.recordId} has invalid coordinates or precision`;
  } else if (record.recordType === 'alias') {
    if (typeof record.aliasId !== 'string' || !ID.test(record.aliasId) || !nonEmpty(record.scheme) || !nonEmpty(record.value) || typeof record.entityId !== 'string' || !ID.test(record.entityId)) return `${record.recordId} has invalid alias metadata`;
  } else if (record.recordType === 'relationship') {
    if (typeof record.relationshipId !== 'string' || !ID.test(record.relationshipId) || !PREDICATES.includes(record.predicate) || !VALUE_KINDS.includes(record.valueKind) || !CONFIDENCE.includes(record.confidence) || typeof record.subjectEntityId !== 'string' || !ID.test(record.subjectEntityId) || typeof record.objectEntityId !== 'string' || !ID.test(record.objectEntityId) || record.subjectEntityId === record.objectEntityId || (record.validFrom !== undefined && !validTime(record.validFrom)) || (record.validTo !== undefined && !validTime(record.validTo)) || (record.validFrom && record.validTo && Date.parse(record.validTo) < Date.parse(record.validFrom))) return `${record.recordId} has invalid relationship metadata`;
  } else if (record.recordType === 'observation') {
    if (typeof record.observationId !== 'string' || !ID.test(record.observationId) || typeof record.entityId !== 'string' || !ID.test(record.entityId) || !nonEmpty(record.metric) || !['number', 'string', 'boolean'].includes(typeof record.value) || (typeof record.value === 'number' && !Number.isFinite(record.value)) || !VALUE_KINDS.includes(record.valueKind) || !CONFIDENCE.includes(record.confidence) || (record.period && (!validTime(record.period.start) || !validTime(record.period.end) || Date.parse(record.period.end) < Date.parse(record.period.start)))) return `${record.recordId} has invalid observation metadata`;
  } else return 'record has an unknown record type';
  if (new Set(evidenceIds(record)).size !== evidenceIds(record).length || evidenceIds(record).some(id => typeof id !== 'string' || !ID.test(id))) return `${record.recordId} has invalid evidence references`;
  return null;
}

function parseRow(row: RecordRow): StoredCorpusRecord {
  if (!scopeValid(row.scope) || !HASH.test(row.record_hash) || (row.previous_hash !== null && !HASH.test(row.previous_hash)) || !validTime(row.recorded_at)) throw new Error(`CORPUS_DATABASE_CORRUPT: sequence ${row.sequence} has invalid indexed metadata`);
  let record: CorpusRecordInput;
  try { record = JSON.parse(row.record_json) as CorpusRecordInput; } catch { throw new Error(`CORPUS_DATABASE_CORRUPT: sequence ${row.sequence} has invalid JSON`); }
  const defect = recordDefect(record);
  if (defect || record.recordId !== row.record_id || record.recordType !== row.record_type || record.knownAt !== row.known_at) throw new Error(`CORPUS_DATABASE_CORRUPT: sequence ${row.sequence} contradicts its canonical record${defect ? ` (${defect})` : ''}`);
  return freeze({ ...record, sequence: Number(row.sequence), scope: row.scope, recordedAt: row.recorded_at, previousHash: row.previous_hash, recordHash: row.record_hash } as StoredCorpusRecord);
}

function stableIdentity(record: CorpusRecordInput | StoredCorpusRecord): string {
  return record.recordType === 'entity' ? record.entityId
    : record.recordType === 'relationship' ? record.relationshipId
      : record.recordType === 'observation' ? record.observationId
        : record.recordType === 'alias' ? record.aliasId : record.evidenceId;
}

function activeRecords(records: readonly StoredCorpusRecord[]): readonly StoredCorpusRecord[] {
  const superseded = new Set(records.flatMap(record => record.supersedes ? [record.supersedes] : []));
  return records.filter(record => !superseded.has(record.recordId));
}

function relationshipActive(record: CorpusRelationshipRecord, asOf: string): boolean {
  const at = Date.parse(asOf);
  return (!record.validFrom || Date.parse(record.validFrom) <= at) && (!record.validTo || Date.parse(record.validTo) >= at);
}

function evidenceView(record: StoredCorpusRecord & CorpusEvidenceRecord): CorpusEvidenceRecord {
  return freeze({
    schema: record.schema, recordId: record.recordId, recordType: 'evidence', knownAt: record.knownAt,
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    evidenceId: record.evidenceId, sourceId: record.sourceId, title: record.title,
    sourceUrl: record.sourceUrl, artifactSha256: record.artifactSha256, retrievedAt: record.retrievedAt,
    ...(record.publishedAt ? { publishedAt: record.publishedAt } : {}),
    ...(record.locator ? { locator: record.locator } : {}),
    ...(record.license ? { license: record.license } : {}),
    ...(record.artifactId ? { artifactId: record.artifactId } : {}),
    ...(record.mediaType ? { mediaType: record.mediaType } : {}),
  });
}

/** Shared deterministic query over either canonical records or a compiled read model. */
export function findFacilitiesInRecords(
  materialRef: string,
  inputRecords: readonly StoredCorpusRecord[],
  options: { readonly scope?: CorpusScope; readonly asOf?: string; readonly knowledgeCutoff?: string } = {},
): FacilityDiscoveryResult {
  const scope = options.scope ?? 'global';
  const asOf = options.asOf ?? new Date().toISOString();
  const cutoff = options.knowledgeCutoff ?? new Date().toISOString();
  if (!scopeValid(scope) || !validTime(asOf) || !validTime(cutoff)) return queryRefusal('CORPUS_SCOPE_INVALID', 'Scope or query time is invalid.', 'Use global or one authorized customer:<id> scope and valid ISO times.');
  const admittedScopes = new Set(visibleScopes(scope));
  const cutoffMs = Date.parse(cutoff);
  const records = activeRecords(inputRecords.filter(record => admittedScopes.has(record.scope) && Date.parse(record.knownAt) <= cutoffMs));
  const entities = records.filter((record): record is StoredCorpusRecord & CorpusEntityRecord => record.recordType === 'entity');
  const entityById = new Map(entities.map(entity => [entity.entityId, entity]));
  const matches = new Set<string>();
  const direct = entityById.get(materialRef);
  if (direct?.entityKind === 'material') matches.add(direct.entityId);
  const needle = normalizedAlias(materialRef);
  for (const alias of records.filter((record): record is StoredCorpusRecord & CorpusAliasRecord => record.recordType === 'alias')) {
    if (normalizedAlias(alias.value) === needle && entityById.get(alias.entityId)?.entityKind === 'material') matches.add(alias.entityId);
  }
  if (matches.size === 0) return queryRefusal('MATERIAL_UNRESOLVED', `No explicit material identity or alias resolves "${materialRef}" in the authorized corpus.`, 'Curate an evidence-linked alias or use a canonical material entity id. Similar names are never merged automatically.');
  if (matches.size > 1) return queryRefusal('MATERIAL_AMBIGUOUS', `"${materialRef}" resolves to ${matches.size} material identities.`, 'Disambiguate with the canonical material entity id; do not select on similarity or ordering.');
  const materialId = [...matches][0];
  const material = entityById.get(materialId)!;
  const relationships = records.filter((record): record is StoredCorpusRecord & CorpusRelationshipRecord => record.recordType === 'relationship' && relationshipActive(record, asOf));
  const evidenceById = new Map(records.filter((record): record is StoredCorpusRecord & CorpusEvidenceRecord => record.recordType === 'evidence').map(record => [record.evidenceId, record]));
  const facilities = relationships
    .filter(relation => relation.predicate === 'produces' && relation.objectEntityId === materialId)
    .flatMap(relation => {
      const facility = entityById.get(relation.subjectEntityId);
      if (!facility || facility.entityKind !== 'facility') return [];
      const operatorRelation = relationships.find(candidate => candidate.subjectEntityId === facility.entityId && candidate.predicate === 'operated_by');
      const operator = operatorRelation ? entityById.get(operatorRelation.objectEntityId) : undefined;
      const evidence = [...new Set([
        ...facility.evidenceIds, ...relation.evidenceIds,
        ...(operatorRelation?.evidenceIds ?? []), ...(operator?.evidenceIds ?? []),
      ])].flatMap(id => {
        const item = evidenceById.get(id);
        return item ? [evidenceView(item)] : [];
      });
      return [{
        entityId: facility.entityId,
        name: facility.canonicalName,
        ...(facility.countryCode ? { countryCode: facility.countryCode } : {}),
        ...(facility.location ? { location: facility.location } : {}),
        ...(operator?.entityKind === 'organization' ? { operator: { entityId: operator.entityId, name: operator.canonicalName } } : {}),
        relationshipId: relation.relationshipId,
        confidence: relation.confidence,
        evidence,
      }];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.entityId.localeCompare(b.entityId));
  if (facilities.length === 0) return queryRefusal('NO_EVIDENCED_FACILITIES', `The corpus resolves ${material.canonicalName} but holds no active evidence-linked producing facility at ${asOf}.`, 'Acquire or validate facility-to-material production relationships; an empty corpus is not evidence that no producer exists.');
  return freeze({ kind: 'facility_discovery' as const, material: { entityId: material.entityId, name: material.canonicalName }, scope, asOf, knowledgeCutoff: cutoff, facilities });
}

export class PhysicalEconomyCorpus {
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
      CREATE TABLE IF NOT EXISTS corpus_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        record_id TEXT NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK(record_type IN ('evidence','entity','alias','relationship','observation')),
        known_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        previous_hash TEXT,
        record_hash TEXT NOT NULL UNIQUE,
        record_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS corpus_records_scope_sequence ON corpus_records(scope, sequence);
      CREATE INDEX IF NOT EXISTS corpus_records_scope_type_known ON corpus_records(scope, record_type, known_at, sequence);
    `);
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('CORPUS_DATABASE_CORRUPT: SQLite quick_check did not return ok'); }
    try { this.allRecords(); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  summary() {
    const rows = this.db.prepare('SELECT scope, record_type, COUNT(*) AS count FROM corpus_records GROUP BY scope, record_type ORDER BY scope, record_type').all() as Array<{ scope: string; record_type: CorpusRecordType; count: number }>;
    const last = this.db.prepare('SELECT MAX(sequence) AS sequence FROM corpus_records').get() as { sequence: number | null };
    return freeze({ kind: 'physical_economy_corpus_summary' as const, databasePath: this.databasePath, durability: 'sqlite_wal' as const, lastSequence: Number(last.sequence ?? 0), records: rows.map(row => ({ scope: row.scope, recordType: row.record_type, count: Number(row.count) })) });
  }

  append(scope: CorpusScope, records: readonly CorpusRecordInput[], recordedAt = new Date().toISOString()): CorpusAppendResult {
    if (!scopeValid(scope) || !validTime(recordedAt) || records.length < 1 || records.length > 1_000) return refusal('CORPUS_INPUT_INVALID', 'Scope, commit time, or batch size is invalid.', 'Use global or customer:<id>, a valid ISO time, and 1..1000 records.');
    const ids = new Set<string>();
    for (const record of records) {
      const defect = recordDefect(record);
      if (defect || ids.has(record.recordId)) return refusal('CORPUS_INPUT_INVALID', defect ?? `Duplicate record id ${record.recordId} in one batch.`, 'Correct the typed record; do not silently drop or merge it.');
      if (record.access) {
        const scopeProblem = corpusAccessScopeDefect(scope, record.access);
        if (scopeProblem) return refusal('CORPUS_INPUT_INVALID', `${record.recordId} has scope-inconsistent access classification: ${scopeProblem}.`, 'Align tenant and visibility metadata with the immutable ledger scope.');
      }
      if (Date.parse(record.knownAt) > Date.parse(recordedAt)) return refusal('CORPUS_KNOWLEDGE_ORDER_INVALID', `${record.recordId} is recorded before its knownAt time.`, 'Record the batch at or after every included claim became knowable.');
      ids.add(record.recordId);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = new Map(this.allRecords().map(record => [record.recordId, record]));
      const staged = new Map(existing);
      let idempotent = true;
      for (const record of records) {
        const prior = existing.get(record.recordId);
        if (prior) {
          const priorInput = JSON.parse((this.db.prepare('SELECT record_json FROM corpus_records WHERE record_id = ?').get(record.recordId) as { record_json: string }).record_json) as CorpusRecordInput;
          if (prior.scope !== scope || canonical(priorInput) !== canonical(record)) { this.db.exec('ROLLBACK'); return refusal('CORPUS_RECORD_CONFLICT', `Record ${record.recordId} already exists with different canonical content.`, 'Create an explicit superseding record; immutable record ids are never overwritten.'); }
          continue;
        }
        idempotent = false;
        const problem = this.referenceDefect(scope, record, staged);
        if (problem) { this.db.exec('ROLLBACK'); return problem; }
        staged.set(record.recordId, { ...record, sequence: -1, scope, recordedAt, previousHash: null, recordHash: '' } as StoredCorpusRecord);
      }
      const committed: StoredCorpusRecord[] = [];
      for (const record of records) {
        const prior = existing.get(record.recordId);
        if (prior) { committed.push(prior); continue; }
        const tail = this.db.prepare('SELECT record_hash FROM corpus_records WHERE scope = ? ORDER BY sequence DESC LIMIT 1').get(scope) as { record_hash: string } | undefined;
        const previousHash = tail?.record_hash ?? null;
        const next = this.db.prepare("SELECT seq + 1 AS sequence FROM sqlite_sequence WHERE name = 'corpus_records'").get() as { sequence?: number } | undefined;
        const sequence = Number(next?.sequence ?? 1);
        const recordHash = sha(canonical({ domain: CORPUS_HASH_DOMAIN, sequence, scope, recordedAt, previousHash, record }));
        const result = this.db.prepare('INSERT INTO corpus_records(scope, record_id, record_type, known_at, recorded_at, previous_hash, record_hash, record_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(scope, record.recordId, record.recordType, record.knownAt, recordedAt, previousHash, recordHash, canonical(record));
        committed.push(freeze({ ...record, sequence: Number(result.lastInsertRowid), scope, recordedAt, previousHash, recordHash } as StoredCorpusRecord));
      }
      this.db.exec('COMMIT');
      return freeze({ kind: 'committed' as const, records: committed, idempotent });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  page(options: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number; readonly knowledgeCutoff?: string } = {}) {
    const scope = options.scope ?? 'global';
    const after = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    const cutoff = options.knowledgeCutoff ?? new Date().toISOString();
    if (!scopeValid(scope) || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !validTime(cutoff)) throw new Error('CORPUS_QUERY_INVALID: scope, cursor, limit, or knowledge cutoff is invalid');
    const allowed = visibleScopes(scope);
    const placeholders = allowed.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM corpus_records WHERE scope IN (${placeholders}) AND sequence > ? AND julianday(known_at) <= julianday(?) ORDER BY sequence ASC LIMIT ?`).all(...allowed, after, cutoff, limit + 1) as RecordRow[];
    const hasMore = rows.length > limit;
    const records = rows.slice(0, limit).map(parseRow);
    this.verifyVisibleChain(scope);
    return freeze({ kind: 'physical_economy_corpus_page' as const, scope, afterSequence: after, nextAfterSequence: records.at(-1)?.sequence ?? after, hasMore, records });
  }

  projectionSource(scope: CorpusScope = 'global', knowledgeCutoff = new Date().toISOString()): CorpusProjectionSource {
    if (!scopeValid(scope) || !validTime(knowledgeCutoff)) throw new Error('CORPUS_QUERY_INVALID: projection scope or knowledge cutoff is invalid');
    const visible = this.visibleRecords(scope, knowledgeCutoff);
    const records = activeRecords(visible);
    return freeze({
      kind: 'physical_economy_projection_source' as const,
      scope,
      knowledgeCutoff,
      sourceSequence: visible.at(-1)?.sequence ?? 0,
      sourceDigest: sha(canonical(records.map(record => ({ recordId: record.recordId, recordHash: record.recordHash })))),
      records,
    });
  }

  findFacilities(materialRef: string, options: { readonly scope?: CorpusScope; readonly asOf?: string; readonly knowledgeCutoff?: string } = {}): FacilityDiscoveryResult {
    const scope = options.scope ?? 'global';
    const cutoff = options.knowledgeCutoff ?? new Date().toISOString();
    if (!scopeValid(scope) || !validTime(cutoff)) return queryRefusal('CORPUS_SCOPE_INVALID', 'Scope or query time is invalid.', 'Use global or one authorized customer:<id> scope and valid ISO times.');
    return findFacilitiesInRecords(materialRef, this.visibleRecords(scope, cutoff), { ...options, scope, knowledgeCutoff: cutoff });
  }

  private allRecords(): StoredCorpusRecord[] {
    const records = (this.db.prepare('SELECT * FROM corpus_records ORDER BY sequence ASC').all() as RecordRow[]).map(parseRow);
    const tails = new Map<string, string | null>();
    for (const record of records) {
      const expectedPrevious = tails.get(record.scope) ?? null;
      const input = JSON.parse((this.db.prepare('SELECT record_json FROM corpus_records WHERE sequence = ?').get(record.sequence) as { record_json: string }).record_json) as CorpusRecordInput;
      const expectedHash = sha(canonical({ domain: CORPUS_HASH_DOMAIN, sequence: record.sequence, scope: record.scope, recordedAt: record.recordedAt, previousHash: expectedPrevious, record: input }));
      if (record.previousHash !== expectedPrevious || record.recordHash !== expectedHash) throw new Error(`CORPUS_DATABASE_CORRUPT: ${record.scope} chain fails at sequence ${record.sequence}`);
      tails.set(record.scope, record.recordHash);
    }
    return records;
  }

  private visibleRecords(scope: CorpusScope, cutoff: string): StoredCorpusRecord[] {
    const allowed = new Set(visibleScopes(scope));
    const cutoffMs = Date.parse(cutoff);
    return this.allRecords().filter(record => allowed.has(record.scope) && Date.parse(record.knownAt) <= cutoffMs);
  }

  private verifyVisibleChain(scope: CorpusScope): void {
    const allowed = new Set(visibleScopes(scope));
    this.allRecords().filter(record => allowed.has(record.scope));
  }

  private referenceDefect(scope: CorpusScope, record: CorpusRecordInput, staged: ReadonlyMap<string, StoredCorpusRecord>): CorpusAppendRefusal | null {
    const visible = (candidate: StoredCorpusRecord | undefined) => Boolean(candidate && (candidate.scope === 'global' || candidate.scope === scope));
    if (record.supersedes) {
      const prior = staged.get(record.supersedes);
      if (!prior || prior.scope !== scope || prior.recordType !== record.recordType || [...staged.values()].some(candidate => candidate.supersedes === record.supersedes)) return refusal('CORPUS_REVISION_INVALID', `${record.recordId} does not supersede one active record of the same type and scope.`, 'Reference the exact prior immutable record once; revisions never cross visibility scopes.');
      if (stableIdentity(record) !== stableIdentity(prior)) return refusal('CORPUS_REVISION_INVALID', `${record.recordId} changes the stable identity of ${record.supersedes}.`, 'Keep the domain identity stable across revisions; only the immutable record id changes.');
      if (Date.parse(record.knownAt) <= Date.parse(prior.knownAt)) return refusal('CORPUS_REVISION_INVALID', `${record.recordId} is not knowable after the record it supersedes.`, 'Give every revision a strictly later knownAt time so historical replay has one deterministic state.');
    }
    const active = activeRecords([...staged.values()]);
    const requireEntity = (entityId: string) => active.some(candidate => visible(candidate) && candidate.recordType === 'entity' && candidate.entityId === entityId);
    const support = evidenceIds(record).map(id => active.find(candidate => visible(candidate) && candidate.recordType === 'evidence' && candidate.evidenceId === id));
    const missingEvidence = evidenceIds(record).find((_id, index) => !support[index]);
    if (missingEvidence) return refusal('CORPUS_REFERENCE_MISSING', `${record.recordId} references unavailable evidence ${missingEvidence}.`, 'Commit the evidence in global or the same customer scope before asserting the claim.');
    const futureEvidence = support.find(candidate => candidate && Date.parse(candidate.knownAt) > Date.parse(record.knownAt));
    if (futureEvidence) return refusal('CORPUS_KNOWLEDGE_ORDER_INVALID', `${record.recordId} claims knowledge before supporting evidence ${futureEvidence.recordId} was acquired.`, 'Set knownAt to the earliest defensible time at or after all supporting evidence became known.');
    const collision = active.find(candidate => visible(candidate) && candidate.recordType === record.recordType && stableIdentity(candidate) === stableIdentity(record) && candidate.recordId !== record.supersedes);
    if (collision) return refusal('CORPUS_RECORD_CONFLICT', `${record.recordType} ${stableIdentity(record)} already has an active canonical record.`, `Create a superseding revision of ${collision.recordId}; stable domain identities have exactly one active record.`);
    if (record.recordType === 'alias' && !requireEntity(record.entityId)) return refusal('CORPUS_REFERENCE_MISSING', `${record.recordId} references unavailable entity ${record.entityId}.`, 'Commit or resolve the entity before its alias.');
    if (record.recordType === 'relationship' && (!requireEntity(record.subjectEntityId) || !requireEntity(record.objectEntityId))) return refusal('CORPUS_REFERENCE_MISSING', `${record.recordId} has an unresolved relationship endpoint.`, 'Commit or resolve both canonical entities before relating them.');
    if (record.recordType === 'observation' && !requireEntity(record.entityId)) return refusal('CORPUS_REFERENCE_MISSING', `${record.recordId} references unavailable entity ${record.entityId}.`, 'Commit or resolve the canonical entity before its observation.');
    return null;
  }
}
