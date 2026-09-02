/**
 * PayloadOS Corpus Compiler V0.
 *
 * The canonical ledger is authoritative. This module creates a disposable,
 * policy-filtered read model that can be deleted and rebuilt without changing
 * canonical identity. Public APIs read this projection, never the write store.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { stableValue } from './loadOperationsStore';
import {
  authorizeCorpusObject,
  CORPUS_POLICY_VERSION,
  joinCorpusPolicies,
  PUBLIC_PROJECTION_ACTOR,
  type DerivedCorpusPolicy,
} from './corpusPolicy';
import {
  findFacilitiesInRecords,
  type CorpusProjectionSource,
  type FacilityDiscoveryResult,
  type PhysicalEconomyCorpus,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';

export const CORPUS_COMPILER_VERSION = '1.0.0';
export const CORPUS_ONTOLOGY_VERSION = 'payload.physical-economy.v1';
export const CORPUS_RECORD_SCHEMA_VERSION = 'payload.corpus.record.v1';
export const CORPUS_REPRESENTATION_SPEC_VERSION = 'payload.corpus.public-read-model.v1';
export const PUBLIC_GLOBAL_PROJECTION_ID = 'public:global';

export const PUBLIC_REPRESENTATION_SPECIFICATION = Object.freeze({
  specificationId: CORPUS_REPRESENTATION_SPEC_VERSION,
  outputs: Object.freeze(['search_index', 'spatial_projection', 'statistics'] as const),
  omitted: Object.freeze(['graph_projection', 'semantic_index', 'summaries'] as const),
});

export type CorpusProjectionManifest = {
  readonly schema: 'payload.corpus.projection.v1';
  readonly corpusBuildId: string;
  readonly canonicalStateFingerprint: string;
  readonly recordSchemaVersion: typeof CORPUS_RECORD_SCHEMA_VERSION;
  readonly ontologyVersion: typeof CORPUS_ONTOLOGY_VERSION;
  readonly policyVersion: typeof CORPUS_POLICY_VERSION;
  readonly embeddingVersion: null;
  readonly representationSpecification: typeof PUBLIC_REPRESENTATION_SPECIFICATION;
  readonly generatedAt: string;
  readonly policyLineageId: string;
  readonly policyInputCount: number;
  readonly effectivePolicy: DerivedCorpusPolicy | null;
  readonly projectionId: typeof PUBLIC_GLOBAL_PROJECTION_ID;
  readonly audience: 'public';
  readonly scope: 'global';
  readonly compilerVersion: typeof CORPUS_COMPILER_VERSION;
  readonly compiledBy: typeof PUBLIC_PROJECTION_ACTOR.actorId;
  readonly compiledAt: string;
  readonly knowledgeCutoff: string;
  readonly sourceSequence: number;
  readonly sourceDigest: string;
  readonly projectionDigest: string;
  readonly recordCount: number;
  readonly recordsByType: Readonly<Record<string, number>>;
  readonly excludedRecords: number;
  readonly exclusions: readonly { readonly code: string; readonly count: number }[];
};

export type CompiledCorpusProjection = {
  readonly kind: 'compiled_corpus_projection';
  readonly manifest: CorpusProjectionManifest;
  readonly records: readonly StoredCorpusRecord[];
};

type ManifestRow = {
  projection_id: string;
  audience: string;
  scope: string;
  source_sequence: number;
  source_digest: string;
  projection_digest: string;
  knowledge_cutoff: string;
  manifest_json: string;
};

type ProjectionRecordRow = { record_json: string };

const HASH = /^[a-f0-9]{64}$/;
function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function manifestBasis(manifest: Omit<CorpusProjectionManifest, 'projectionDigest'> | CorpusProjectionManifest) {
  return {
    schema: manifest.schema,
    corpusBuildId: manifest.corpusBuildId,
    canonicalStateFingerprint: manifest.canonicalStateFingerprint,
    recordSchemaVersion: manifest.recordSchemaVersion,
    ontologyVersion: manifest.ontologyVersion,
    policyVersion: manifest.policyVersion,
    embeddingVersion: manifest.embeddingVersion,
    representationSpecification: manifest.representationSpecification,
    policyLineageId: manifest.policyLineageId,
    policyInputCount: manifest.policyInputCount,
    effectivePolicy: manifest.effectivePolicy,
    projectionId: manifest.projectionId,
    audience: manifest.audience,
    scope: manifest.scope,
    compilerVersion: manifest.compilerVersion,
    compiledBy: manifest.compiledBy,
    knowledgeCutoff: manifest.knowledgeCutoff,
    sourceSequence: manifest.sourceSequence,
    sourceDigest: manifest.sourceDigest,
    recordCount: manifest.recordCount,
    recordsByType: manifest.recordsByType,
    excludedRecords: manifest.excludedRecords,
    exclusions: manifest.exclusions,
  };
}

function projectionDigest(manifest: Omit<CorpusProjectionManifest, 'projectionDigest'> | CorpusProjectionManifest, records: readonly StoredCorpusRecord[]): string {
  return sha(canonical({ manifest: manifestBasis(manifest), records }));
}

function corpusBuildIdFor(canonicalStateFingerprint: string, knowledgeCutoff: string, policyLineageId: string): string {
  return `corpus-build:${sha(canonical({
    canonicalStateFingerprint,
    knowledgeCutoff,
    recordSchemaVersion: CORPUS_RECORD_SCHEMA_VERSION,
    ontologyVersion: CORPUS_ONTOLOGY_VERSION,
    policyVersion: CORPUS_POLICY_VERSION,
    compilerVersion: CORPUS_COMPILER_VERSION,
    embeddingVersion: null,
    representationSpecification: PUBLIC_REPRESENTATION_SPECIFICATION,
    policyLineageId,
  }))}`;
}

function policyCode(record: StoredCorpusRecord): string | null {
  for (const use of ['PROJECTION', 'SEARCH', 'DERIVATION', 'REDISTRIBUTION'] as const) {
    const decision = authorizeCorpusObject(record, PUBLIC_PROJECTION_ACTOR, use);
    if (decision.kind === 'denied') return decision.code;
  }
  return null;
}

function increment(counts: Map<string, number>, code: string): void {
  counts.set(code, (counts.get(code) ?? 0) + 1);
}

/**
 * Compile an exact public read model. A record with a denied dependency is
 * dropped even if its own label says PUBLIC, preventing hidden evidence or
 * endpoint identities from leaking through dangling references.
 */
export function buildPublicProjection(source: CorpusProjectionSource, compiledAt = new Date().toISOString()): CompiledCorpusProjection {
  if (source.scope !== 'global' || !validTime(compiledAt)) throw new Error('CORPUS_PROJECTION_INPUT_INVALID: only a global source and valid compile time are accepted');
  const exclusions = new Map<string, number>();
  const candidates = source.records.filter(record => {
    const code = policyCode(record);
    if (code) increment(exclusions, code);
    return !code;
  });

  const evidenceIds = new Set(candidates.filter(record => record.recordType === 'evidence').map(record => record.evidenceId));
  const entityIds = new Set(candidates.flatMap(record => record.recordType === 'entity' && record.evidenceIds.every(id => evidenceIds.has(id)) ? [record.entityId] : []));
  const accepted = candidates.filter(record => {
    if (record.recordType === 'evidence') return true;
    const supported = record.evidenceIds.every(id => evidenceIds.has(id));
    if (!supported) { increment(exclusions, 'CORPUS_PROJECTION_EVIDENCE_DENIED'); return false; }
    if (record.recordType === 'entity') return entityIds.has(record.entityId);
    if (record.recordType === 'alias') {
      if (entityIds.has(record.entityId)) return true;
      increment(exclusions, 'CORPUS_PROJECTION_ENTITY_DENIED'); return false;
    }
    if (record.recordType === 'relationship') {
      if (entityIds.has(record.subjectEntityId) && entityIds.has(record.objectEntityId)) return true;
      increment(exclusions, 'CORPUS_PROJECTION_ENDPOINT_DENIED'); return false;
    }
    if (entityIds.has(record.entityId)) return true;
    increment(exclusions, 'CORPUS_PROJECTION_ENTITY_DENIED'); return false;
  }).sort((a, b) => a.sequence - b.sequence);

  const recordsByType: Record<string, number> = {};
  for (const record of accepted) recordsByType[record.recordType] = (recordsByType[record.recordType] ?? 0) + 1;
  const policyJoin = accepted.length > 0 ? joinCorpusPolicies(accepted) : null;
  if (policyJoin?.kind === 'refusal') throw new Error(`${policyJoin.code}: ${policyJoin.detail}`);
  const policyLineageId = policyJoin?.lineage.lineageId ?? sha(canonical({ schema: 'payload.corpus.policy-lineage.v1', inputs: [] }));
  const corpusBuildId = corpusBuildIdFor(source.sourceDigest, source.knowledgeCutoff, policyLineageId);
  const withoutDigest: Omit<CorpusProjectionManifest, 'projectionDigest'> = {
    schema: 'payload.corpus.projection.v1',
    corpusBuildId,
    canonicalStateFingerprint: source.sourceDigest,
    recordSchemaVersion: CORPUS_RECORD_SCHEMA_VERSION,
    ontologyVersion: CORPUS_ONTOLOGY_VERSION,
    policyVersion: CORPUS_POLICY_VERSION,
    embeddingVersion: null,
    representationSpecification: PUBLIC_REPRESENTATION_SPECIFICATION,
    generatedAt: compiledAt,
    policyLineageId,
    policyInputCount: policyJoin?.lineage.inputCount ?? 0,
    effectivePolicy: policyJoin?.lineage.effective ?? null,
    projectionId: PUBLIC_GLOBAL_PROJECTION_ID,
    audience: 'public',
    scope: 'global',
    compilerVersion: CORPUS_COMPILER_VERSION,
    compiledBy: PUBLIC_PROJECTION_ACTOR.actorId,
    compiledAt,
    knowledgeCutoff: source.knowledgeCutoff,
    sourceSequence: source.sourceSequence,
    sourceDigest: source.sourceDigest,
    recordCount: accepted.length,
    recordsByType,
    excludedRecords: source.records.length - accepted.length,
    exclusions: [...exclusions].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code)),
  };
  const manifest: CorpusProjectionManifest = { ...withoutDigest, projectionDigest: projectionDigest(withoutDigest, accepted) };
  return freeze({ kind: 'compiled_corpus_projection' as const, manifest, records: accepted });
}

function parseManifest(row: ManifestRow): CorpusProjectionManifest {
  let manifest: CorpusProjectionManifest;
  try { manifest = JSON.parse(row.manifest_json) as CorpusProjectionManifest; }
  catch { throw new Error('CORPUS_PROJECTION_CORRUPT: manifest JSON is invalid'); }
  if (row.projection_id !== PUBLIC_GLOBAL_PROJECTION_ID || manifest.projectionId !== row.projection_id || row.audience !== 'public' || manifest.audience !== row.audience || row.scope !== 'global' || manifest.scope !== row.scope || Number(row.source_sequence) !== manifest.sourceSequence || row.source_digest !== manifest.sourceDigest || row.projection_digest !== manifest.projectionDigest || row.knowledge_cutoff !== manifest.knowledgeCutoff || manifest.schema !== 'payload.corpus.projection.v1' || manifest.compilerVersion !== CORPUS_COMPILER_VERSION || manifest.compiledBy !== PUBLIC_PROJECTION_ACTOR.actorId || manifest.canonicalStateFingerprint !== manifest.sourceDigest || manifest.recordSchemaVersion !== CORPUS_RECORD_SCHEMA_VERSION || manifest.ontologyVersion !== CORPUS_ONTOLOGY_VERSION || manifest.policyVersion !== CORPUS_POLICY_VERSION || manifest.embeddingVersion !== null || manifest.representationSpecification?.specificationId !== CORPUS_REPRESENTATION_SPEC_VERSION || canonical(manifest.representationSpecification) !== canonical(PUBLIC_REPRESENTATION_SPECIFICATION) || manifest.corpusBuildId !== corpusBuildIdFor(manifest.canonicalStateFingerprint, manifest.knowledgeCutoff, manifest.policyLineageId) || !HASH.test(manifest.policyLineageId) || !Number.isSafeInteger(manifest.policyInputCount) || manifest.policyInputCount < 0 || !HASH.test(manifest.sourceDigest) || !HASH.test(manifest.projectionDigest) || !validTime(manifest.compiledAt) || !validTime(manifest.generatedAt) || manifest.generatedAt !== manifest.compiledAt || !validTime(manifest.knowledgeCutoff)) {
    throw new Error('CORPUS_PROJECTION_CORRUPT: manifest contradicts its indexed metadata');
  }
  return manifest;
}

export class CorpusProjectionStore {
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
      CREATE TABLE IF NOT EXISTS corpus_projection_manifests (
        projection_id TEXT PRIMARY KEY,
        audience TEXT NOT NULL,
        scope TEXT NOT NULL,
        source_sequence INTEGER NOT NULL,
        source_digest TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        knowledge_cutoff TEXT NOT NULL,
        manifest_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corpus_projection_records (
        projection_id TEXT NOT NULL REFERENCES corpus_projection_manifests(projection_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        record_id TEXT NOT NULL,
        record_type TEXT NOT NULL,
        record_json TEXT NOT NULL,
        PRIMARY KEY(projection_id, ordinal),
        UNIQUE(projection_id, record_id)
      );
      CREATE INDEX IF NOT EXISTS corpus_projection_type ON corpus_projection_records(projection_id, record_type, ordinal);
    `);
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('CORPUS_PROJECTION_CORRUPT: SQLite quick_check did not return ok'); }
    try { this.loadPublic(); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  replace(projection: CompiledCorpusProjection): { readonly kind: 'projection_stored'; readonly idempotent: boolean; readonly manifest: CorpusProjectionManifest } {
    const existing = this.loadPublic();
    if (existing?.manifest.projectionDigest === projection.manifest.projectionDigest) return freeze({ kind: 'projection_stored' as const, idempotent: true, manifest: existing.manifest });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM corpus_projection_manifests WHERE projection_id = ?').run(PUBLIC_GLOBAL_PROJECTION_ID);
      this.db.prepare('INSERT INTO corpus_projection_manifests(projection_id, audience, scope, source_sequence, source_digest, projection_digest, knowledge_cutoff, manifest_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        projection.manifest.projectionId, projection.manifest.audience, projection.manifest.scope,
        projection.manifest.sourceSequence, projection.manifest.sourceDigest, projection.manifest.projectionDigest,
        projection.manifest.knowledgeCutoff, canonical(projection.manifest),
      );
      const insert = this.db.prepare('INSERT INTO corpus_projection_records(projection_id, ordinal, record_id, record_type, record_json) VALUES (?, ?, ?, ?, ?)');
      projection.records.forEach((record, index) => insert.run(PUBLIC_GLOBAL_PROJECTION_ID, index + 1, record.recordId, record.recordType, canonical(record)));
      this.db.exec('COMMIT');
      return freeze({ kind: 'projection_stored' as const, idempotent: false, manifest: projection.manifest });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  loadPublic(): CompiledCorpusProjection | null {
    const row = this.db.prepare('SELECT * FROM corpus_projection_manifests WHERE projection_id = ?').get(PUBLIC_GLOBAL_PROJECTION_ID) as ManifestRow | undefined;
    if (!row) return null;
    const manifest = parseManifest(row);
    const rows = this.db.prepare('SELECT record_json FROM corpus_projection_records WHERE projection_id = ? ORDER BY ordinal ASC').all(PUBLIC_GLOBAL_PROJECTION_ID) as ProjectionRecordRow[];
    const records = rows.map((item, index) => {
      let record: StoredCorpusRecord;
      try { record = JSON.parse(item.record_json) as StoredCorpusRecord; }
      catch { throw new Error(`CORPUS_PROJECTION_CORRUPT: record ${index + 1} has invalid JSON`); }
      if (!record || record.scope !== 'global' || typeof record.recordId !== 'string' || typeof record.recordType !== 'string' || !HASH.test(record.recordHash)) throw new Error(`CORPUS_PROJECTION_CORRUPT: record ${index + 1} has invalid identity`);
      return record;
    });
    if (records.length !== manifest.recordCount || projectionDigest(manifest, records) !== manifest.projectionDigest) throw new Error('CORPUS_PROJECTION_CORRUPT: projection digest does not match its records');
    return freeze({ kind: 'compiled_corpus_projection' as const, manifest, records });
  }

  findFacilities(materialRef: string, asOf?: string): FacilityDiscoveryResult {
    const projection = this.loadPublic();
    if (!projection) return { kind: 'refusal', code: 'MATERIAL_UNRESOLVED', detail: 'No public projection has been compiled.', remedy: 'Compile the public corpus projection before querying it.' };
    return findFacilitiesInRecords(materialRef, projection.records, { scope: 'global', asOf, knowledgeCutoff: projection.manifest.knowledgeCutoff });
  }
}

export function projectionMatchesSource(manifest: CorpusProjectionManifest, source: CorpusProjectionSource): boolean {
  return manifest.scope === source.scope && manifest.sourceSequence === source.sourceSequence && manifest.sourceDigest === source.sourceDigest;
}

export function compilePublicProjection(
  corpus: PhysicalEconomyCorpus,
  store: CorpusProjectionStore,
  knowledgeCutoff = new Date().toISOString(),
  compiledAt = new Date().toISOString(),
) {
  const projection = buildPublicProjection(corpus.projectionSource('global', knowledgeCutoff), compiledAt);
  return store.replace(projection);
}
