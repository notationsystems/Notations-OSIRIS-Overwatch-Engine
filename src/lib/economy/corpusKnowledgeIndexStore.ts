/** SQLite/WAL read-model store for the deterministic corpus knowledge index. */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  compileCorpusKnowledgeIndex,
  corpusIndexTerms,
  verifyCompiledCorpusKnowledgeIndex,
  type CompiledCorpusKnowledgeIndex,
  type CorpusKnowledgeIndexDocument,
  type CorpusKnowledgeIndexManifest,
  type CorpusKnowledgeIndexPosting,
  type CorpusKnowledgeIndexSearchRequest,
  type CorpusKnowledgeIndexSearchResult,
} from './corpusKnowledgeIndex';
import type { CompiledCorpusProjection } from './corpusProjection';
import { canonicalCorpusJson, type CorpusEntityKind, type CorpusRecordType, type CorpusRelationshipPredicate } from './physicalEconomyCorpus';

type ManifestRow = {
  projection_id: string;
  corpus_build_id: string;
  projection_digest: string;
  index_digest: string;
  document_count: number;
  posting_count: number;
  manifest_json: string;
};

type DocumentRow = {
  document_id: string;
  sequence: number;
  record_id: string;
  record_type: CorpusRecordType;
  entity_id: string | null;
  entity_kind: CorpusEntityKind | null;
  source_id: string | null;
  predicate: CorpusRelationshipPredicate | null;
  subject_entity_id: string | null;
  object_entity_id: string | null;
  property_key: string | null;
  value_kind: string | null;
  confidence: string | null;
  known_at: string;
  valid_from: string | null;
  valid_to: string | null;
  longitude: number | null;
  latitude: number | null;
  document_hash: string;
  document_json: string;
};

type PostingRow = {
  term: string;
  document_id: string;
  field: CorpusKnowledgeIndexPosting['field'];
  frequency: number;
  weight: CorpusKnowledgeIndexPosting['weight'];
  posting_hash: string;
};

type SearchRow = DocumentRow & PostingRow;

const RECORD_TYPES = new Set<CorpusRecordType>(['evidence', 'evidence_unit', 'entity', 'alias', 'relationship', 'observation', 'assertion']);
const ENTITY_KINDS = new Set<CorpusEntityKind>(['organization', 'facility', 'material', 'commodity', 'supplier', 'port', 'vessel', 'infrastructure', 'process', 'network', 'market', 'flow', 'event', 'geography']);
const PREDICATES = new Set<CorpusRelationshipPredicate>(['operated_by', 'owned_by', 'located_in', 'produces', 'consumes', 'transforms', 'supplies', 'connects_to', 'ships_via', 'trades_in', 'substitutes_for', 'depends_on', 'calls_at', 'carries', 'loads_at', 'unloads_at', 'moves_between', 'routes_via', 'affected_by', 'observed_at', 'priced_by']);
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;
const MAX_CANDIDATE_ROWS = 10_000;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function parseDocument(row: DocumentRow): CorpusKnowledgeIndexDocument {
  let document: CorpusKnowledgeIndexDocument;
  try { document = JSON.parse(row.document_json) as CorpusKnowledgeIndexDocument; }
  catch { throw new Error(`CORPUS_INDEX_CORRUPT: document ${row.document_id} is not valid JSON`); }
  const locationMatches = document.location
    ? row.longitude === document.location.longitude && row.latitude === document.location.latitude
    : row.longitude === null && row.latitude === null;
  if (document.documentId !== row.document_id || document.recordId !== row.record_id || document.recordType !== row.record_type ||
      document.record.sequence !== Number(row.sequence) ||
      document.entityId !== row.entity_id || document.entityKind !== row.entity_kind || document.sourceId !== row.source_id ||
      document.predicate !== row.predicate || document.subjectEntityId !== row.subject_entity_id || document.objectEntityId !== row.object_entity_id ||
      document.propertyKey !== row.property_key || document.valueKind !== row.value_kind || document.confidence !== row.confidence ||
      document.knownAt !== row.known_at || document.validFrom !== row.valid_from || document.validTo !== row.valid_to ||
      document.documentHash !== row.document_hash || !locationMatches) {
    throw new Error(`CORPUS_INDEX_CORRUPT: document ${row.document_id} contradicts indexed metadata`);
  }
  return document;
}

function parsePosting(row: PostingRow): CorpusKnowledgeIndexPosting {
  return freeze({ term: row.term, documentId: row.document_id, field: row.field, frequency: Number(row.frequency), weight: Number(row.weight) as CorpusKnowledgeIndexPosting['weight'], postingHash: row.posting_hash });
}

function validInstant(value: string | undefined): boolean {
  return value === undefined || Number.isFinite(Date.parse(value));
}

function unique<T extends string>(values: readonly T[] | undefined): readonly T[] {
  return freeze([...new Set(values ?? [])].sort());
}

export class CorpusKnowledgeIndexStore {
  readonly backend = 'sqlite' as const;
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
      CREATE TABLE IF NOT EXISTS corpus_knowledge_index_manifest (
        singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
        projection_id TEXT NOT NULL,
        corpus_build_id TEXT NOT NULL,
        projection_digest TEXT NOT NULL,
        index_digest TEXT NOT NULL,
        document_count INTEGER NOT NULL,
        posting_count INTEGER NOT NULL,
        manifest_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corpus_knowledge_index_documents (
        document_id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL,
        record_id TEXT NOT NULL UNIQUE,
        record_type TEXT NOT NULL,
        entity_id TEXT,
        entity_kind TEXT,
        source_id TEXT,
        predicate TEXT,
        subject_entity_id TEXT,
        object_entity_id TEXT,
        property_key TEXT,
        value_kind TEXT,
        confidence TEXT,
        known_at TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        longitude REAL,
        latitude REAL,
        document_hash TEXT NOT NULL UNIQUE,
        document_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corpus_knowledge_index_postings (
        term TEXT NOT NULL,
        document_id TEXT NOT NULL REFERENCES corpus_knowledge_index_documents(document_id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        frequency INTEGER NOT NULL CHECK(frequency > 0),
        weight INTEGER NOT NULL CHECK(weight IN (2,3,4,6,8)),
        posting_hash TEXT NOT NULL UNIQUE,
        PRIMARY KEY(term, document_id, field)
      );
      CREATE INDEX IF NOT EXISTS corpus_index_documents_entity ON corpus_knowledge_index_documents(entity_id, record_type);
      CREATE INDEX IF NOT EXISTS corpus_index_documents_source ON corpus_knowledge_index_documents(source_id, known_at);
      CREATE INDEX IF NOT EXISTS corpus_index_documents_relation ON corpus_knowledge_index_documents(predicate, subject_entity_id, object_entity_id);
      CREATE INDEX IF NOT EXISTS corpus_index_documents_time ON corpus_knowledge_index_documents(known_at, valid_from, valid_to);
      CREATE INDEX IF NOT EXISTS corpus_index_documents_space ON corpus_knowledge_index_documents(longitude, latitude) WHERE longitude IS NOT NULL AND latitude IS NOT NULL;
      CREATE INDEX IF NOT EXISTS corpus_index_postings_document ON corpus_knowledge_index_postings(document_id, term);
    `);
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('CORPUS_INDEX_CORRUPT: SQLite quick_check did not return ok'); }
    try { this.load(); } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  replace(projection: CompiledCorpusProjection, builtAt = new Date().toISOString()): { readonly kind: 'corpus_knowledge_index_stored'; readonly idempotent: boolean; readonly manifest: CorpusKnowledgeIndexManifest } {
    const compiled = compileCorpusKnowledgeIndex(projection, builtAt);
    const current = this.load();
    if (current?.manifest.indexDigest === compiled.manifest.indexDigest) return freeze({ kind: 'corpus_knowledge_index_stored' as const, idempotent: true, manifest: current.manifest });
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM corpus_knowledge_index_postings').run();
      this.db.prepare('DELETE FROM corpus_knowledge_index_documents').run();
      this.db.prepare('DELETE FROM corpus_knowledge_index_manifest').run();
      const insertDocument = this.db.prepare(`
        INSERT INTO corpus_knowledge_index_documents(
          document_id,sequence,record_id,record_type,entity_id,entity_kind,source_id,predicate,subject_entity_id,object_entity_id,
          property_key,value_kind,confidence,known_at,valid_from,valid_to,longitude,latitude,document_hash,document_json
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `);
      for (const document of compiled.documents) insertDocument.run(
        document.documentId, document.record.sequence, document.recordId, document.recordType, document.entityId, document.entityKind, document.sourceId,
        document.predicate, document.subjectEntityId, document.objectEntityId, document.propertyKey, document.valueKind,
        document.confidence, document.knownAt, document.validFrom, document.validTo, document.location?.longitude ?? null,
        document.location?.latitude ?? null, document.documentHash, canonicalCorpusJson(document),
      );
      const insertPosting = this.db.prepare('INSERT INTO corpus_knowledge_index_postings(term,document_id,field,frequency,weight,posting_hash) VALUES (?,?,?,?,?,?)');
      for (const posting of compiled.postings) insertPosting.run(posting.term, posting.documentId, posting.field, posting.frequency, posting.weight, posting.postingHash);
      this.db.prepare(`
        INSERT INTO corpus_knowledge_index_manifest(singleton,projection_id,corpus_build_id,projection_digest,index_digest,document_count,posting_count,manifest_json)
        VALUES (1,?,?,?,?,?,?,?)
      `).run(compiled.manifest.projectionId, compiled.manifest.corpusBuildId, compiled.manifest.projectionDigest, compiled.manifest.indexDigest, compiled.manifest.documentCount, compiled.manifest.postingCount, canonicalCorpusJson(compiled.manifest));
      this.db.exec('COMMIT');
      return freeze({ kind: 'corpus_knowledge_index_stored' as const, idempotent: false, manifest: compiled.manifest });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  load(): CompiledCorpusKnowledgeIndex | null {
    const row = this.db.prepare('SELECT * FROM corpus_knowledge_index_manifest WHERE singleton = 1').get() as ManifestRow | undefined;
    const documentRows = this.db.prepare('SELECT * FROM corpus_knowledge_index_documents ORDER BY sequence ASC, record_id ASC').all() as DocumentRow[];
    const postingRows = this.db.prepare('SELECT * FROM corpus_knowledge_index_postings ORDER BY term ASC, document_id ASC, field ASC').all() as PostingRow[];
    if (!row) {
      if (documentRows.length || postingRows.length) throw new Error('CORPUS_INDEX_CORRUPT: indexed rows exist without a manifest');
      return null;
    }
    let manifest: CorpusKnowledgeIndexManifest;
    try { manifest = JSON.parse(row.manifest_json) as CorpusKnowledgeIndexManifest; }
    catch { throw new Error('CORPUS_INDEX_CORRUPT: manifest is not valid JSON'); }
    if (manifest.projectionId !== row.projection_id || manifest.corpusBuildId !== row.corpus_build_id ||
        manifest.projectionDigest !== row.projection_digest || manifest.indexDigest !== row.index_digest ||
        manifest.documentCount !== Number(row.document_count) || manifest.postingCount !== Number(row.posting_count)) {
      throw new Error('CORPUS_INDEX_CORRUPT: manifest contradicts indexed metadata');
    }
    const postings = postingRows.map(parsePosting).sort((left, right) => left.term.localeCompare(right.term) || left.documentId.localeCompare(right.documentId) || left.field.localeCompare(right.field));
    const compiled = freeze({ kind: 'compiled_corpus_knowledge_index' as const, manifest, documents: documentRows.map(parseDocument), postings });
    verifyCompiledCorpusKnowledgeIndex(compiled);
    return compiled;
  }

  manifest(): CorpusKnowledgeIndexManifest | null { return this.load()?.manifest ?? null; }

  search(request: CorpusKnowledgeIndexSearchRequest): CorpusKnowledgeIndexSearchResult {
    const index = this.load();
    if (!index) throw new Error('CORPUS_INDEX_NOT_BUILT: compile the current public CorpusBuild before querying it');
    const query = request.query?.normalize('NFKC').trim();
    const queryTerms = [...new Set(corpusIndexTerms(query ?? ''))].slice(0, 16);
    const recordTypes = unique(request.recordTypes);
    const entityKinds = unique(request.entityKinds);
    const predicates = unique(request.predicates);
    const sourceIds = unique(request.sourceIds);
    const limit = request.limit ?? 25;
    const bbox = request.bbox;
    if (!query || query.length < 2 || query.length > 500 || !queryTerms.length || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
        recordTypes.some(value => !RECORD_TYPES.has(value)) || entityKinds.some(value => !ENTITY_KINDS.has(value)) || predicates.some(value => !PREDICATES.has(value)) || sourceIds.some(value => !ID.test(value)) ||
        !validInstant(request.asOf) || !validInstant(request.knownAt) || bbox && (!Number.isFinite(bbox.west) || !Number.isFinite(bbox.south) || !Number.isFinite(bbox.east) || !Number.isFinite(bbox.north) || bbox.west < -180 || bbox.east > 180 || bbox.south < -90 || bbox.north > 90 || bbox.west > bbox.east || bbox.south > bbox.north)) {
      throw new Error('CORPUS_INDEX_QUERY_INVALID: query, facets, time, bounding box, or limit is invalid');
    }
    const parameters: Array<string | number> = [...queryTerms];
    const conditions = [`p.term IN (${queryTerms.map(() => '?').join(',')})`];
    const list = (column: string, values: readonly string[]) => {
      if (!values.length) return;
      conditions.push(`${column} IN (${values.map(() => '?').join(',')})`);
      parameters.push(...values);
    };
    list('d.record_type', recordTypes);
    list('d.entity_kind', entityKinds);
    list('d.predicate', predicates);
    list('d.source_id', sourceIds);
    if (request.knownAt) { conditions.push('julianday(d.known_at) <= julianday(?)'); parameters.push(request.knownAt); }
    if (request.asOf) {
      conditions.push('(d.valid_from IS NULL OR julianday(d.valid_from) <= julianday(?))');
      conditions.push('(d.valid_to IS NULL OR julianday(?) < julianday(d.valid_to))');
      parameters.push(request.asOf, request.asOf);
    }
    if (bbox) {
      conditions.push('d.longitude IS NOT NULL AND d.latitude IS NOT NULL AND d.longitude BETWEEN ? AND ? AND d.latitude BETWEEN ? AND ?');
      parameters.push(bbox.west, bbox.east, bbox.south, bbox.north);
    }
    parameters.push(MAX_CANDIDATE_ROWS + 1);
    const rows = this.db.prepare(`
      SELECT d.*, p.term, p.document_id, p.field, p.frequency, p.weight, p.posting_hash
      FROM corpus_knowledge_index_postings p
      JOIN corpus_knowledge_index_documents d ON d.document_id = p.document_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY d.document_id ASC, p.term ASC, p.field ASC
      LIMIT ?
    `).all(...parameters) as SearchRow[];
    const truncated = rows.length > MAX_CANDIDATE_ROWS;
    const grouped = new Map<string, { document: CorpusKnowledgeIndexDocument; score: number; terms: Set<string> }>();
    for (const row of rows.slice(0, MAX_CANDIDATE_ROWS)) {
      const prior = grouped.get(row.document_id) ?? { document: parseDocument(row), score: 0, terms: new Set<string>() };
      prior.score += Number(row.weight) * Number(row.frequency);
      prior.terms.add(row.term);
      grouped.set(row.document_id, prior);
    }
    const normalizedQuery = query.toLocaleLowerCase('en-US');
    const hits = [...grouped.values()].map(entry => {
      const exactIdentityMatch = [entry.document.recordId, entry.document.entityId, entry.document.sourceId]
        .some(value => value?.toLocaleLowerCase('en-US') === normalizedQuery);
      const matchedTerms = [...entry.terms].sort();
      return freeze({
        documentId: entry.document.documentId,
        recordId: entry.document.recordId,
        recordType: entry.document.recordType,
        entityId: entry.document.entityId,
        sourceId: entry.document.sourceId,
        score: {
          value: entry.score + (exactIdentityMatch ? 1_000 : 0),
          basis: 'deterministic_weighted_term_frequency_v1' as const,
          matchedTermCount: matchedTerms.length,
          requestedTermCount: queryTerms.length,
          exactIdentityMatch,
        },
        matchedTerms,
        provenanceRefs: entry.document.provenanceRefs,
        record: entry.document.record,
      });
    }).sort((left, right) => Number(right.score.exactIdentityMatch) - Number(left.score.exactIdentityMatch)
      || right.score.matchedTermCount - left.score.matchedTermCount
      || right.score.value - left.score.value
      || left.recordId.localeCompare(right.recordId)).slice(0, limit);
    return freeze({
      kind: 'corpus_knowledge_index_search' as const,
      indexId: index.manifest.indexId,
      corpusBuildId: index.manifest.corpusBuildId,
      projectionDigest: index.manifest.projectionDigest,
      query,
      queryTerms,
      filters: {
        ...(recordTypes.length ? { recordTypes } : {}),
        ...(entityKinds.length ? { entityKinds } : {}),
        ...(predicates.length ? { predicates } : {}),
        ...(sourceIds.length ? { sourceIds } : {}),
        ...(request.asOf ? { asOf: request.asOf } : {}),
        ...(request.knownAt ? { knownAt: request.knownAt } : {}),
        ...(bbox ? { bbox } : {}),
      },
      limit,
      candidateRowsExamined: Math.min(rows.length, MAX_CANDIDATE_ROWS),
      candidateRowsTruncated: truncated,
      hits,
      limitations: [
        'Ranking is deterministic lexical relevance over the policy-filtered index; it is not a confidence or truth score.',
        'A missing hit means absent from this index under these filters, not absent from the physical world.',
      ],
    });
  }
}
