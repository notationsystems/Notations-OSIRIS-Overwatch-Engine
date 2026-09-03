/** Deterministic, build-bound index for processed physical-economy records. */

import type { CompiledCorpusProjection } from './corpusProjection';
import {
  corpusRecordReferenceIds,
  type CorpusEntityKind,
  type CorpusRecordType,
  type CorpusRelationshipPredicate,
  type CorpusValueKind,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';
import { corpusVerificationDigest } from './corpusVerification';

export const CORPUS_KNOWLEDGE_INDEX_SCHEMA = 'payload.corpus.knowledge-index.v1' as const;
export const CORPUS_KNOWLEDGE_INDEX_VERSION = '1.0.0' as const;

export type CorpusKnowledgeIndexDocument = {
  readonly schema: 'payload.corpus.index-document.v1';
  readonly documentId: string;
  readonly recordId: string;
  readonly recordHash: string;
  readonly recordType: CorpusRecordType;
  readonly entityId: string | null;
  readonly entityKind: CorpusEntityKind | null;
  readonly sourceId: string | null;
  readonly predicate: CorpusRelationshipPredicate | null;
  readonly subjectEntityId: string | null;
  readonly objectEntityId: string | null;
  readonly propertyKey: string | null;
  readonly valueKind: CorpusValueKind | null;
  readonly confidence: 'high' | 'medium' | 'low' | null;
  readonly knownAt: string;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly location: { readonly longitude: number; readonly latitude: number; readonly precision: string } | null;
  readonly provenanceRefs: readonly string[];
  readonly record: StoredCorpusRecord;
  readonly documentHash: string;
};

export type CorpusKnowledgeIndexPosting = {
  readonly term: string;
  readonly documentId: string;
  readonly field: 'identity' | 'name' | 'classification' | 'content' | 'relation' | 'measurement';
  readonly frequency: number;
  readonly weight: 2 | 3 | 4 | 6 | 8;
  readonly postingHash: string;
};

export type CorpusKnowledgeIndexCoverage = {
  readonly recordsByType: Readonly<Record<string, number>>;
  readonly entitiesByKind: Readonly<Record<string, number>>;
  readonly relationshipsByPredicate: Readonly<Record<string, number>>;
  readonly observationsByValueKind: Readonly<Record<string, number>>;
  readonly evidenceBySource: Readonly<Record<string, number>>;
  readonly spatial: {
    readonly entityCount: number;
    readonly locatedEntityCount: number;
    readonly unlocatedEntityCount: number;
    readonly completeness: number | null;
  };
  readonly temporal: {
    readonly earliestKnownAt: string | null;
    readonly latestKnownAt: string | null;
  };
  readonly signals: readonly {
    readonly code: 'ENTITY_LOCATION_UNOBSERVED' | 'SOURCE_HEALTH_UNOBSERVED';
    readonly count: number;
    readonly entityIds?: readonly string[];
    readonly sourceIds?: readonly string[];
    readonly interpretation: string;
  }[];
};

export type CorpusKnowledgeIndexManifest = {
  readonly schema: typeof CORPUS_KNOWLEDGE_INDEX_SCHEMA;
  readonly indexVersion: typeof CORPUS_KNOWLEDGE_INDEX_VERSION;
  readonly indexId: string;
  readonly corpusBuildId: string;
  readonly projectionId: string;
  readonly projectionDigest: string;
  readonly policyLineageId: string;
  readonly knowledgeCutoff: string;
  readonly sourceSequence: number;
  readonly builtAt: string;
  readonly documentCount: number;
  readonly postingCount: number;
  readonly indexDigest: string;
  readonly coverage: CorpusKnowledgeIndexCoverage;
  readonly limitations: readonly string[];
};

export type CompiledCorpusKnowledgeIndex = {
  readonly kind: 'compiled_corpus_knowledge_index';
  readonly manifest: CorpusKnowledgeIndexManifest;
  readonly documents: readonly CorpusKnowledgeIndexDocument[];
  readonly postings: readonly CorpusKnowledgeIndexPosting[];
};

export type CorpusKnowledgeIndexSearchRequest = {
  readonly query: string;
  readonly recordTypes?: readonly CorpusRecordType[];
  readonly entityKinds?: readonly CorpusEntityKind[];
  readonly predicates?: readonly CorpusRelationshipPredicate[];
  readonly sourceIds?: readonly string[];
  readonly asOf?: string;
  readonly knownAt?: string;
  readonly bbox?: { readonly west: number; readonly south: number; readonly east: number; readonly north: number };
  readonly limit?: number;
};

export type CorpusKnowledgeIndexSearchResult = {
  readonly kind: 'corpus_knowledge_index_search';
  readonly indexId: string;
  readonly corpusBuildId: string;
  readonly projectionDigest: string;
  readonly query: string;
  readonly queryTerms: readonly string[];
  readonly filters: Omit<CorpusKnowledgeIndexSearchRequest, 'query' | 'limit'>;
  readonly limit: number;
  readonly candidateRowsExamined: number;
  readonly candidateRowsTruncated: boolean;
  readonly hits: readonly {
    readonly documentId: string;
    readonly recordId: string;
    readonly recordType: CorpusRecordType;
    readonly entityId: string | null;
    readonly sourceId: string | null;
    readonly score: {
      readonly value: number;
      readonly basis: 'deterministic_weighted_term_frequency_v1';
      readonly matchedTermCount: number;
      readonly requestedTermCount: number;
      readonly exactIdentityMatch: boolean;
    };
    readonly matchedTerms: readonly string[];
    readonly provenanceRefs: readonly string[];
    readonly record: StoredCorpusRecord;
  }[];
  readonly limitations: readonly string[];
};

const HASH = /^[a-f0-9]{64}$/;
const FIELD_WEIGHTS: Readonly<Record<CorpusKnowledgeIndexPosting['field'], CorpusKnowledgeIndexPosting['weight']>> = {
  identity: 8,
  name: 6,
  relation: 4,
  measurement: 4,
  classification: 3,
  content: 2,
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function count(values: readonly (string | null | undefined)[]): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const value of values) if (value) result[value] = (result[value] ?? 0) + 1;
  return freeze(Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right))));
}

/** Search normalization is deliberately lexical and versioned; no embedding is implied. */
export function corpusIndexTerms(value: string): readonly string[] {
  const terms = value.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}][\p{L}\p{N}._/-]{0,63}/gu) ?? [];
  return freeze(terms.filter(term => term.length > 1 && !/^[a-f0-9]{48,64}$/.test(term)).slice(0, 256));
}

function common() {
  return {
    entityId: null as string | null,
    entityKind: null as CorpusEntityKind | null,
    sourceId: null as string | null,
    predicate: null as CorpusRelationshipPredicate | null,
    subjectEntityId: null as string | null,
    objectEntityId: null as string | null,
    propertyKey: null as string | null,
    valueKind: null as CorpusValueKind | null,
    confidence: null as 'high' | 'medium' | 'low' | null,
    validFrom: null as string | null,
    validTo: null as string | null,
    location: null as CorpusKnowledgeIndexDocument['location'],
  };
}

function documentFields(record: StoredCorpusRecord): {
  readonly metadata: ReturnType<typeof common>;
  readonly fields: readonly { readonly field: CorpusKnowledgeIndexPosting['field']; readonly text: string }[];
} {
  const metadata = common();
  const fields: { field: CorpusKnowledgeIndexPosting['field']; text: string }[] = [
    { field: 'identity', text: record.recordId },
    { field: 'classification', text: record.recordType },
  ];
  switch (record.recordType) {
    case 'evidence':
      metadata.sourceId = record.sourceId;
      fields.push({ field: 'identity', text: `${record.evidenceId} ${record.sourceId}` }, { field: 'name', text: record.title });
      break;
    case 'evidence_unit':
      fields.push({ field: 'identity', text: `${record.evidenceUnitId} ${record.artifactEvidenceId}` }, { field: 'classification', text: `${record.modality} ${record.extraction.kind}` });
      if (record.extractedText) fields.push({ field: 'content', text: record.extractedText });
      break;
    case 'entity':
      metadata.entityId = record.entityId;
      metadata.entityKind = record.entityKind;
      metadata.location = record.location ? { longitude: record.location.lng, latitude: record.location.lat, precision: record.location.precision } : null;
      fields.push({ field: 'identity', text: record.entityId }, { field: 'name', text: record.canonicalName }, { field: 'classification', text: `${record.entityKind} ${record.countryCode ?? ''}` });
      if (record.description) fields.push({ field: 'content', text: record.description });
      break;
    case 'alias':
      metadata.entityId = record.entityId;
      fields.push({ field: 'identity', text: `${record.aliasId} ${record.entityId}` }, { field: 'name', text: record.value }, { field: 'classification', text: record.scheme });
      break;
    case 'relationship':
      metadata.entityId = record.subjectEntityId;
      metadata.predicate = record.predicate;
      metadata.subjectEntityId = record.subjectEntityId;
      metadata.objectEntityId = record.objectEntityId;
      metadata.valueKind = record.valueKind;
      metadata.confidence = record.confidence;
      metadata.validFrom = record.validFrom ?? null;
      metadata.validTo = record.validTo ?? null;
      fields.push({ field: 'identity', text: record.relationshipId }, { field: 'relation', text: `${record.subjectEntityId} ${record.predicate} ${record.objectEntityId}` }, { field: 'classification', text: `${record.valueKind} ${record.confidence}` });
      break;
    case 'observation':
      metadata.entityId = record.entityId;
      metadata.propertyKey = record.metric;
      metadata.valueKind = record.valueKind;
      metadata.confidence = record.confidence;
      metadata.validFrom = record.validFrom ?? record.period?.start ?? null;
      metadata.validTo = record.validTo ?? record.period?.end ?? null;
      fields.push({ field: 'identity', text: `${record.observationId} ${record.entityId}` }, { field: 'measurement', text: `${record.observationType ?? 'metric'} ${record.metric} ${String(record.value)} ${record.unit ?? ''} ${record.basis ?? ''}` }, { field: 'classification', text: `${record.valueKind} ${record.confidence}` });
      break;
    case 'assertion':
      metadata.entityId = record.entityId;
      metadata.propertyKey = record.propertyKey;
      metadata.confidence = record.confidence;
      metadata.validFrom = record.validFrom;
      metadata.validTo = record.validTo ?? null;
      fields.push({ field: 'identity', text: `${record.assertionId} ${record.entityId}` }, { field: 'measurement', text: `${record.propertyKey} ${typeof record.selectedValue === 'object' ? '' : String(record.selectedValue)} ${record.unit ?? ''}` }, { field: 'classification', text: `${record.status} ${record.confidence} ${record.selectionPolicy}` });
      break;
  }
  return { metadata, fields };
}

export function corpusIndexDocument(record: StoredCorpusRecord): { readonly document: CorpusKnowledgeIndexDocument; readonly postings: readonly CorpusKnowledgeIndexPosting[] } {
  const { metadata, fields } = documentFields(record);
  const documentBasis = {
    schema: 'payload.corpus.index-document.v1' as const,
    documentId: `index-document:${record.recordId}`,
    recordId: record.recordId,
    recordHash: record.recordHash,
    recordType: record.recordType,
    ...metadata,
    knownAt: record.knownAt,
    provenanceRefs: [...new Set(corpusRecordReferenceIds(record))].sort(),
    record,
  };
  const document = freeze({ ...documentBasis, documentHash: corpusVerificationDigest(documentBasis) });
  const grouped = new Map<string, { field: CorpusKnowledgeIndexPosting['field']; frequency: number }>();
  for (const entry of fields) {
    for (const term of corpusIndexTerms(entry.text)) {
      const key = `${entry.field}\0${term}`;
      const prior = grouped.get(key);
      grouped.set(key, { field: entry.field, frequency: (prior?.frequency ?? 0) + 1 });
    }
  }
  const postings = [...grouped.entries()].map(([key, value]) => {
    const term = key.slice(key.indexOf('\0') + 1);
    const basis = { term, documentId: document.documentId, field: value.field, frequency: value.frequency, weight: FIELD_WEIGHTS[value.field] };
    return freeze({ ...basis, postingHash: corpusVerificationDigest(basis) });
  }).sort((left, right) => left.term.localeCompare(right.term) || left.documentId.localeCompare(right.documentId) || left.field.localeCompare(right.field));
  return freeze({ document, postings });
}

function coverage(documents: readonly CorpusKnowledgeIndexDocument[]): CorpusKnowledgeIndexCoverage {
  const entities = documents.filter(document => document.recordType === 'entity');
  const unlocated = entities.filter(document => !document.location).map(document => document.entityId!).sort();
  const sources = [...new Set(documents.map(document => document.sourceId).filter((value): value is string => Boolean(value)))].sort();
  const known = documents.map(document => document.knownAt).sort();
  return freeze({
    recordsByType: count(documents.map(document => document.recordType)),
    entitiesByKind: count(entities.map(document => document.entityKind)),
    relationshipsByPredicate: count(documents.filter(document => document.recordType === 'relationship').map(document => document.predicate)),
    observationsByValueKind: count(documents.filter(document => document.recordType === 'observation').map(document => document.valueKind)),
    evidenceBySource: count(documents.filter(document => document.recordType === 'evidence').map(document => document.sourceId)),
    spatial: {
      entityCount: entities.length,
      locatedEntityCount: entities.length - unlocated.length,
      unlocatedEntityCount: unlocated.length,
      completeness: entities.length ? (entities.length - unlocated.length) / entities.length : null,
    },
    temporal: { earliestKnownAt: known.at(0) ?? null, latestKnownAt: known.at(-1) ?? null },
    signals: [
      ...(unlocated.length ? [{ code: 'ENTITY_LOCATION_UNOBSERVED' as const, count: unlocated.length, entityIds: unlocated, interpretation: 'These canonical entities have no observed location in this CorpusBuild; the index does not impute coordinates.' }] : []),
      ...(sources.length ? [{ code: 'SOURCE_HEALTH_UNOBSERVED' as const, count: sources.length, sourceIds: sources, interpretation: 'Evidence names these sources, but source availability and acquisition health are not observations in this index.' }] : []),
    ],
  });
}

export function compileCorpusKnowledgeIndex(projection: CompiledCorpusProjection, builtAt = new Date().toISOString()): CompiledCorpusKnowledgeIndex {
  if (!Number.isFinite(Date.parse(builtAt)) || !HASH.test(projection.manifest.projectionDigest)) throw new Error('CORPUS_INDEX_INPUT_INVALID: build time or projection identity is invalid');
  const compiled = [...projection.records].sort((left, right) => left.sequence - right.sequence || left.recordId.localeCompare(right.recordId)).map(corpusIndexDocument);
  const documents = compiled.map(entry => entry.document);
  const postings = compiled.flatMap(entry => entry.postings).sort((left, right) => left.term.localeCompare(right.term) || left.documentId.localeCompare(right.documentId) || left.field.localeCompare(right.field));
  const indexDigest = corpusVerificationDigest({
    schema: CORPUS_KNOWLEDGE_INDEX_SCHEMA,
    indexVersion: CORPUS_KNOWLEDGE_INDEX_VERSION,
    corpusBuildId: projection.manifest.corpusBuildId,
    projectionDigest: projection.manifest.projectionDigest,
    documents: documents.map(document => ({ documentId: document.documentId, documentHash: document.documentHash })),
    postings: postings.map(posting => posting.postingHash),
  });
  const manifestBasis = {
    schema: CORPUS_KNOWLEDGE_INDEX_SCHEMA,
    indexVersion: CORPUS_KNOWLEDGE_INDEX_VERSION,
    corpusBuildId: projection.manifest.corpusBuildId,
    projectionId: projection.manifest.projectionId,
    projectionDigest: projection.manifest.projectionDigest,
    policyLineageId: projection.manifest.policyLineageId,
    knowledgeCutoff: projection.manifest.knowledgeCutoff,
    sourceSequence: projection.manifest.sourceSequence,
    builtAt,
    documentCount: documents.length,
    postingCount: postings.length,
    indexDigest,
    coverage: coverage(documents),
    limitations: [
      'This is a lexical/faceted projection of one policy-filtered CorpusBuild, not a second source of canonical truth.',
      'Term scores rank indexed records; they are not confidence, truth, materiality, or investment scores.',
      'Coverage signals describe absent fields in this CorpusBuild and do not establish absence in the physical world.',
    ],
  };
  const manifest = freeze({ ...manifestBasis, indexId: `corpus-index:${corpusVerificationDigest(manifestBasis)}` });
  return freeze({ kind: 'compiled_corpus_knowledge_index' as const, manifest, documents, postings });
}

export function verifyCompiledCorpusKnowledgeIndex(index: CompiledCorpusKnowledgeIndex): void {
  const rebuiltDocuments = index.documents.map(document => corpusIndexDocument(document.record));
  const documents = rebuiltDocuments.map(entry => entry.document);
  const postings = rebuiltDocuments.flatMap(entry => entry.postings).sort((left, right) => left.term.localeCompare(right.term) || left.documentId.localeCompare(right.documentId) || left.field.localeCompare(right.field));
  const digest = corpusVerificationDigest({
    schema: CORPUS_KNOWLEDGE_INDEX_SCHEMA,
    indexVersion: CORPUS_KNOWLEDGE_INDEX_VERSION,
    corpusBuildId: index.manifest.corpusBuildId,
    projectionDigest: index.manifest.projectionDigest,
    documents: documents.map(document => ({ documentId: document.documentId, documentHash: document.documentHash })),
    postings: postings.map(posting => posting.postingHash),
  });
  const manifestBasis: Record<string, unknown> = { ...index.manifest };
  delete manifestBasis.indexId;
  const expectedIndexId = `corpus-index:${corpusVerificationDigest(manifestBasis)}`;
  const expectedCoverage = coverage(documents);
  const defects = [
    index.kind !== 'compiled_corpus_knowledge_index' ? 'kind' : null,
    index.manifest.schema !== CORPUS_KNOWLEDGE_INDEX_SCHEMA ? 'schema' : null,
    index.manifest.indexVersion !== CORPUS_KNOWLEDGE_INDEX_VERSION ? 'version' : null,
    index.documents.length !== index.manifest.documentCount ? 'document_count' : null,
    index.postings.length !== index.manifest.postingCount ? 'posting_count' : null,
    digest !== index.manifest.indexDigest ? 'index_digest' : null,
    index.manifest.indexId !== expectedIndexId ? 'index_id' : null,
    corpusVerificationDigest(index.manifest.coverage) !== corpusVerificationDigest(expectedCoverage) ? 'coverage' : null,
    !HASH.test(index.manifest.projectionDigest) || !HASH.test(index.manifest.indexDigest) ? 'digest_format' : null,
    !Number.isSafeInteger(index.manifest.sourceSequence) || index.manifest.sourceSequence < 0 || !Number.isFinite(Date.parse(index.manifest.builtAt)) ? 'manifest_values' : null,
    documents.some((document, position) => document.documentHash !== index.documents[position]?.documentHash) ? 'document_hash' : null,
    postings.some((posting, position) => posting.postingHash !== index.postings[position]?.postingHash) ? 'posting_hash' : null,
  ].filter((value): value is string => Boolean(value));
  if (defects.length) throw new Error(`CORPUS_INDEX_CORRUPT: persisted index does not reproduce its manifest (${defects.join(',')})`);
}
