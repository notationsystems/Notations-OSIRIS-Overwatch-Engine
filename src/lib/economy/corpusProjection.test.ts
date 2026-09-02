import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS, type CorpusAccess } from './corpusPolicy';
import { buildPublicProjection, compilePublicProjection, CorpusProjectionStore, projectionMatchesSource } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const directories: string[] = [];
const knownAt = '2026-04-01T00:00:00.000Z';
const recordedAt = '2026-04-01T00:01:00.000Z';
const internal: CorpusAccess = {
  visibility: 'PAYLOAD_INTERNAL', licenseClass: 'PAYLOAD_PROPRIETARY', redistributionClass: 'PROHIBITED', retentionClass: 'PERMANENT',
  allowedUses: ['SEARCH', 'ANALYSIS', 'PROJECTION'],
};

function records(): CorpusRecordInput[] {
  return [
    { schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:public:v1', recordType: 'evidence', knownAt, evidenceId: 'evidence:public', sourceId: 'source:public', title: 'Public directory', sourceUrl: 'https://example.test/public', artifactSha256: 'a'.repeat(64), retrievedAt: knownAt, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:material:pp:v1', recordType: 'entity', knownAt, entityId: 'pe:material:pp', entityKind: 'material', canonicalName: 'Polypropylene', evidenceIds: ['evidence:public'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:alias:pp:v1', recordType: 'alias', knownAt, aliasId: 'alias:pp', scheme: 'common', value: 'polypropylene', entityId: 'pe:material:pp', evidenceIds: ['evidence:public'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:facility:public:v1', recordType: 'entity', knownAt, entityId: 'pe:facility:public', entityKind: 'facility', canonicalName: 'Public PP Plant', countryCode: 'CA', location: { lat: 43, lng: -82, precision: 'site' }, evidenceIds: ['evidence:public'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:public-produces-pp:v1', recordType: 'relationship', knownAt, relationshipId: 'relationship:public-produces-pp', subjectEntityId: 'pe:facility:public', predicate: 'produces', objectEntityId: 'pe:material:pp', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence:public'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:internal:v1', recordType: 'evidence', knownAt, evidenceId: 'evidence:internal', sourceId: 'source:internal', title: 'Internal source', sourceUrl: 'https://example.test/internal', artifactSha256: 'b'.repeat(64), retrievedAt: knownAt, access: internal },
    { schema: 'payload.corpus.record.v1', recordId: 'rec:facility:internal:v1', recordType: 'entity', knownAt, entityId: 'pe:facility:internal', entityKind: 'facility', canonicalName: 'Private Plant', evidenceIds: ['evidence:internal'], access: internal },
  ];
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'payload-projection-test-'));
  directories.push(directory);
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const store = new CorpusProjectionStore(join(directory, 'read-model.sqlite'));
  expect(corpus.append('global', records(), recordedAt).kind).toBe('committed');
  return { directory, corpus, store };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Corpus Compiler public projection', () => {
  it('builds a deterministic, policy-filtered read model and answers from it', async () => {
    const { corpus, store } = await setup();
    try {
      const first = compilePublicProjection(corpus, store, recordedAt, '2026-04-01T00:02:00.000Z');
      expect(first).toMatchObject({
        kind: 'projection_stored',
        idempotent: false,
        manifest: {
          recordCount: 5,
          excludedRecords: 2,
          sourceSequence: 7,
          canonicalStateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          corpusBuildId: expect.stringMatching(/^corpus-build:[a-f0-9]{64}$/),
          recordSchemaVersion: 'payload.corpus.record.v1',
          ontologyVersion: 'payload.physical-economy.v1',
          policyVersion: 'payload.corpus.policy.v1',
          embeddingVersion: null,
          representationSpecification: {
            outputs: ['search_index', 'spatial_projection', 'statistics'],
            omitted: ['graph_projection', 'semantic_index', 'summaries'],
          },
          policyInputCount: 5,
          effectivePolicy: { classification: 'PUBLIC', externalRelease: 'PERMITTED' },
        },
      });
      expect(first.manifest.exclusions).toContainEqual({ code: 'CORPUS_PERMISSION_DENIED', count: 2 });
      const replay = compilePublicProjection(corpus, store, recordedAt, '2026-04-01T00:03:00.000Z');
      expect(replay).toMatchObject({ idempotent: true, manifest: { projectionDigest: first.manifest.projectionDigest, compiledAt: '2026-04-01T00:02:00.000Z' } });
      const loaded = store.loadPublic();
      expect(loaded?.records.some(record => record.recordId.includes('internal'))).toBe(false);
      expect(store.findFacilities('polypropylene', recordedAt)).toMatchObject({ kind: 'facility_discovery', facilities: [{ entityId: 'pe:facility:public', evidence: [{ evidenceId: 'evidence:public' }] }] });
      expect(projectionMatchesSource(first.manifest, corpus.projectionSource('global', recordedAt))).toBe(true);
    } finally { store.close(); corpus.close(); }
  });

  it('marks the projection stale after canonical global state advances', async () => {
    const { corpus, store } = await setup();
    try {
      const compiled = compilePublicProjection(corpus, store, recordedAt, '2026-04-01T00:02:00.000Z');
      expect(corpus.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:new:v1', recordType: 'evidence', knownAt: '2026-04-02T00:00:00.000Z', evidenceId: 'evidence:new', sourceId: 'source:new', title: 'New public source', sourceUrl: 'https://example.test/new', artifactSha256: 'c'.repeat(64), retrievedAt: '2026-04-02T00:00:00.000Z', access: OPEN_PUBLIC_CORPUS_ACCESS }], '2026-04-02T00:01:00.000Z').kind).toBe('committed');
      expect(projectionMatchesSource(compiled.manifest, corpus.projectionSource('global', '2026-04-03T00:00:00.000Z'))).toBe(false);
    } finally { store.close(); corpus.close(); }
  });

  it('detects semantic tampering in the disposable projection', async () => {
    const { directory, corpus, store } = await setup();
    compilePublicProjection(corpus, store, recordedAt, '2026-04-01T00:02:00.000Z');
    store.close(); corpus.close();
    const path = join(directory, 'read-model.sqlite');
    const raw = new Database(path);
    raw.prepare("UPDATE corpus_projection_records SET record_json = '{}' WHERE ordinal = 2").run();
    raw.close();
    expect(() => new CorpusProjectionStore(path)).toThrow(/CORPUS_PROJECTION_CORRUPT/);
  });

  it('derives the same digest from identical source and cutoff regardless of compile time', async () => {
    const { corpus, store } = await setup();
    try {
      const source = corpus.projectionSource('global', recordedAt);
      const one = buildPublicProjection(source, '2026-04-01T00:02:00.000Z');
      const two = buildPublicProjection(source, '2026-04-01T00:03:00.000Z');
      expect(one.manifest.projectionDigest).toBe(two.manifest.projectionDigest);
      expect(one.manifest.corpusBuildId).toBe(two.manifest.corpusBuildId);
      expect(one.manifest.generatedAt).not.toBe(two.manifest.generatedAt);
    } finally { store.close(); corpus.close(); }
  });
});
