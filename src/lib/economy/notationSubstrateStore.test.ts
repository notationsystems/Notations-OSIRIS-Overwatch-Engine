import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildNotationCorpusSyncPage } from './notationCorpusFederation';
import { NotationSubstrateStore } from './notationSubstrateStore';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const at = '2026-09-02T20:00:00.000Z';

function projection(directory: string, collision = false) {
  const corpus = new PhysicalEconomyCorpus(join(directory, collision ? 'collision-corpus.sqlite' : 'corpus.sqlite'));
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  const records: CorpusRecordInput[] = [
    { ...common, recordId: `record:evidence:${collision ? 'collision' : 'substrate'}`, recordType: 'evidence', evidenceId: `evidence:${collision ? 'collision' : 'substrate'}`, sourceId: 'source:substrate', title: 'Substrate source', sourceUrl: 'https://example.test/substrate', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: `record:entity:${collision ? 'one' : 'substrate'}`, recordType: 'entity', entityId: `pe:facility:${collision ? 'one' : 'substrate'}`, entityKind: 'facility', canonicalName: 'Substrate Facility', evidenceIds: [`evidence:${collision ? 'collision' : 'substrate'}`] },
  ];
  if (collision) records.push(
    { ...common, recordId: 'record:entity:two', recordType: 'entity', entityId: 'pe:facility:two', entityKind: 'facility', canonicalName: 'Second Facility', evidenceIds: ['evidence:collision'] },
    { ...common, recordId: 'record:alias:collision', recordType: 'alias', aliasId: 'claim:collision', scheme: 'source_name', value: 'Collision', entityId: 'pe:facility:one', evidenceIds: ['evidence:collision'] },
    { ...common, recordId: 'record:relationship:collision', recordType: 'relationship', relationshipId: 'claim:collision', subjectEntityId: 'pe:facility:one', predicate: 'depends_on', objectEntityId: 'pe:facility:two', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence:collision'] },
  );
  const result = corpus.append('global', records, at);
  if (result.kind !== 'committed') throw new Error(`${result.code}: ${result.detail}`);
  const built = buildPublicProjection(corpus.projectionSource('global', at), at);
  corpus.close();
  return built;
}

describe('NotationSubstrateStore', () => {
  it('ingests idempotently, persists acknowledgements and lag, and projects semantic/vector state', () => {
    const directory = mkdtempSync(join(tmpdir(), 'notation-substrate-'));
    const path = join(directory, 'substrate.sqlite');
    let store: NotationSubstrateStore | undefined;
    try {
      const page = buildNotationCorpusSyncPage(projection(directory), { limit: 10 });
      store = new NotationSubstrateStore(path);
      const first = store.ingest(page, at);
      expect(first).toMatchObject({ idempotent: false, acknowledgement: { appliedRecords: 2, existingRecords: 0, acknowledgedSequence: 2 }, lag: { canonicalSequenceLag: 0, remainingEnvelopeCount: 0, publicTimeLagMs: 0 } });
      expect(store.ingest(page, '2026-09-02T20:01:00.000Z')).toEqual({ ...first, idempotent: true });
      expect(store.status()).toMatchObject({ counts: { identities: 2, records: 2, semanticDocuments: 2, vectorProjections: 0, acknowledgements: 1, lagSamples: 1 }, channels: [{ acknowledgementLag: 2 }] });

      const document = store.semanticDocuments().find(item => item.recordType === 'entity')!;
      expect(document.text).toContain('Substrate Facility');
      const vector = store.putVector({ documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0], generatedAt: at });
      expect(vector).toMatchObject({ idempotent: false });
      expect(store.putVector({ documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0], generatedAt: at })).toMatchObject({ idempotent: true, projectionId: vector.projectionId });
      expect(() => store!.putVector({ documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [0, 1], generatedAt: at })).toThrow(/NOTATION_VECTOR_CONFLICT/);
      expect(store.vectorSearch({ modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0] })).toMatchObject({ hits: [{ documentUri: document.documentUri, score: { value: 1, basis: 'cosine_similarity' } }] });
      expect(store.markUpstreamAcknowledged('payload:public:global', 2, at)).toMatchObject({ last_upstream_ack_sequence: 2 });
      store.close(); store = undefined;

      store = new NotationSubstrateStore(path);
      expect(store.status()).toMatchObject({ counts: { vectorProjections: 1 }, channels: [{ acknowledgementLag: 0 }] });
      store.close(); store = undefined;
      const raw = new Database(path);
      raw.prepare("UPDATE notation_vector_projections SET vector_json='[0,1]'").run(); raw.close();
      expect(() => new NotationSubstrateStore(path)).toThrow(/NOTATION_SUBSTRATE_CORRUPT/);
    } finally {
      store?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('refuses two record classes attempting to bind the same global object identity', () => {
    const directory = mkdtempSync(join(tmpdir(), 'notation-collision-'));
    const store = new NotationSubstrateStore(join(directory, 'substrate.sqlite'));
    try {
      const page = buildNotationCorpusSyncPage(projection(directory, true), { limit: 10 });
      expect(() => store.ingest(page, at)).toThrow(/NOTATION_IDENTITY_COLLISION/);
      expect(store.status().counts.records).toBe(0);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
