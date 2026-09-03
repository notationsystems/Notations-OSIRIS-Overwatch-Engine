import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compileCorpusKnowledgeIndex, corpusIndexTerms, verifyCompiledCorpusKnowledgeIndex } from './corpusKnowledgeIndex';
import { CorpusKnowledgeIndexStore } from './corpusKnowledgeIndexStore';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const at = '2026-09-02T18:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-knowledge-index-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  const records: CorpusRecordInput[] = [
    { ...common, recordId: 'record:evidence:index', recordType: 'evidence', evidenceId: 'evidence:index', sourceId: 'source:port-authority', title: 'Port authority terminal report', sourceUrl: 'https://example.test/report', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: 'record:evidence-unit:index', recordType: 'evidence_unit', evidenceUnitId: 'evidence-unit:index', artifactEvidenceId: 'evidence:index', modality: 'document', locator: { page: 4 }, extraction: { kind: 'parser', version: '1.0.0' }, contentSha256: 'b'.repeat(64), extractedText: 'Terminal throughput and storage capacity.' },
    { ...common, recordId: 'record:entity:port:index', recordType: 'entity', entityId: 'pe:port:index', entityKind: 'port', canonicalName: 'Control Port', countryCode: 'CA', location: { lng: -79.38, lat: 43.65, precision: 'site' }, evidenceIds: ['evidence-unit:index'] },
    { ...common, recordId: 'record:entity:facility:index', recordType: 'entity', entityId: 'pe:facility:index', entityKind: 'facility', canonicalName: 'Unlocated Polymer Terminal', evidenceIds: ['evidence-unit:index'] },
    { ...common, recordId: 'record:alias:index', recordType: 'alias', aliasId: 'alias:index', scheme: 'operator_name', value: 'CPT', entityId: 'pe:port:index', evidenceIds: ['evidence-unit:index'] },
    { ...common, recordId: 'record:relationship:index', recordType: 'relationship', relationshipId: 'relationship:index', subjectEntityId: 'pe:facility:index', predicate: 'depends_on', objectEntityId: 'pe:port:index', validFrom: '2026-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:index'] },
    { ...common, recordId: 'record:observation:index', recordType: 'observation', observationId: 'observation:index', entityId: 'pe:facility:index', observationType: 'capacity', metric: 'storage_capacity', value: 42000, unit: 't', validFrom: '2026-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:index'] },
    { ...common, recordId: 'record:assertion:index', recordType: 'assertion', assertionId: 'assertion:index', entityId: 'pe:facility:index', propertyKey: 'storage_capacity', selectedValue: 42000, unit: 't', status: 'accepted', selectionPolicy: 'reviewed-source-v1', validFrom: '2026-01-01T00:00:00.000Z', confidence: 'high', evidence: [{ observationId: 'observation:index', role: 'supports' }] },
  ];
  const appended = corpus.append('global', records, at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
  return { directory, corpus, projection };
}

describe('Corpus knowledge index', () => {
  it('compiles a reproducible lexical, structural, temporal, spatial, and provenance index', () => {
    const value = fixture();
    try {
      const first = compileCorpusKnowledgeIndex(value.projection, at);
      const second = compileCorpusKnowledgeIndex(value.projection, at);
      expect(first).toEqual(second);
      expect(() => verifyCompiledCorpusKnowledgeIndex(first)).not.toThrow();
      expect(first.manifest).toMatchObject({
        documentCount: 8,
        coverage: { spatial: { entityCount: 2, locatedEntityCount: 1, unlocatedEntityCount: 1, completeness: 0.5 } },
      });
      expect(first.manifest.coverage.signals).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'ENTITY_LOCATION_UNOBSERVED', entityIds: ['pe:facility:index'] }),
        expect.objectContaining({ code: 'SOURCE_HEALTH_UNOBSERVED', sourceIds: ['source:port-authority'] }),
      ]));
      expect(corpusIndexTerms('Control PORT control')).toEqual(['control', 'port', 'control']);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('persists, searches with physical-economy facets, and refuses tampered index rows on restart', () => {
    const value = fixture();
    const path = join(value.directory, 'index.sqlite');
    let store: CorpusKnowledgeIndexStore | undefined;
    try {
      store = new CorpusKnowledgeIndexStore(path);
      const stored = store.replace(value.projection, at);
      expect(stored).toMatchObject({ idempotent: false, manifest: { documentCount: 8 } });
      expect(store.replace(value.projection, '2026-09-02T18:01:00.000Z')).toMatchObject({ idempotent: true, manifest: { indexId: stored.manifest.indexId } });

      const named = store.search({ query: 'Control Port', recordTypes: ['entity'] });
      expect(named.hits[0]).toMatchObject({ recordId: 'record:entity:port:index', entityId: 'pe:port:index', score: { basis: 'deterministic_weighted_term_frequency_v1' } });
      const relation = store.search({ query: 'depends_on port', predicates: ['depends_on'], asOf: '2026-06-01T00:00:00.000Z' });
      expect(relation.hits).toEqual([expect.objectContaining({ recordId: 'record:relationship:index', recordType: 'relationship' })]);
      const located = store.search({ query: 'port', entityKinds: ['port'], bbox: { west: -80, south: 43, east: -79, north: 44 } });
      expect(located.hits.map(hit => hit.recordId)).toEqual(['record:entity:port:index']);
      store.close();
      store = undefined;

      const raw = new Database(path);
      raw.prepare("UPDATE corpus_knowledge_index_documents SET document_json = '{}' WHERE record_id = 'record:entity:port:index'").run();
      raw.close();
      expect(() => new CorpusKnowledgeIndexStore(path)).toThrow(/CORPUS_INDEX_CORRUPT/);
    } finally {
      store?.close();
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
