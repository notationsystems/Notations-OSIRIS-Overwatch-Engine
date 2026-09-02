import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { mineSharedDependencies } from './corpusMining';
import { buildPublicProjection, type CompiledCorpusProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const directories: string[] = [];
const knownAt = '2026-09-03T00:00:00.000Z';
const executedAt = '2026-09-03T00:10:00.000Z';

function records(): CorpusRecordInput[] {
  const evidenceId = 'evidence:shared-dependency';
  return [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:shared', recordType: 'evidence', knownAt, evidenceId, sourceId: 'source:public-network', title: 'Public dependency network', sourceUrl: 'https://example.test/network', artifactSha256: 'a'.repeat(64), retrievedAt: knownAt, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:manufacturer-a', recordType: 'entity', knownAt, entityId: 'pe:organization:manufacturer-a', entityKind: 'organization', canonicalName: 'Manufacturer A', evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:manufacturer-b', recordType: 'entity', knownAt, entityId: 'pe:organization:manufacturer-b', entityKind: 'organization', canonicalName: 'Manufacturer B', evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:feedstock', recordType: 'entity', knownAt, entityId: 'pe:facility:feedstock', entityKind: 'facility', canonicalName: 'Shared Feedstock Facility', evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:relationship:a-depends', recordType: 'relationship', knownAt, relationshipId: 'relationship:a-depends-feedstock', subjectEntityId: 'pe:organization:manufacturer-a', predicate: 'depends_on', objectEntityId: 'pe:facility:feedstock', valueKind: 'reported', confidence: 'high', evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:relationship:b-depends', recordType: 'relationship', knownAt, relationshipId: 'relationship:b-depends-feedstock', subjectEntityId: 'pe:organization:manufacturer-b', predicate: 'depends_on', objectEntityId: 'pe:facility:feedstock', valueKind: 'reported', confidence: 'medium', evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS },
  ];
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'payload-miner-test-'));
  directories.push(directory);
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  expect(corpus.append('global', records(), knownAt).kind).toBe('committed');
  return { corpus, projection: buildPublicProjection(corpus.projectionSource('global', knownAt), executedAt) };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Payload Miner shared-dependency discovery', () => {
  it('emits a policy- and evidence-linked candidate without mutating canonical truth', async () => {
    const { corpus, projection } = await setup();
    try {
      const before = corpus.summary();
      const mined = mineSharedDependencies(projection, { minimumDependents: 2, executedAt });
      expect(mined).toMatchObject({
        kind: 'corpus_mining_result',
        run: {
          corpusBuildId: projection.manifest.corpusBuildId,
          algorithm: 'shared_dependency_fan_in',
          parameters: { minimumDependents: 2 },
          outputPatternIds: [expect.stringMatching(/^pattern:[a-f0-9]{64}$/)],
        },
        candidates: [{
          patternType: 'SHARED_DEPENDENCY',
          focalEntityId: 'pe:facility:feedstock',
          entityIds: ['pe:facility:feedstock', 'pe:organization:manufacturer-a', 'pe:organization:manufacturer-b'],
          relationshipIds: ['relationship:a-depends-feedstock', 'relationship:b-depends-feedstock'],
          evidenceIds: ['evidence:shared-dependency'],
          score: { metric: 'distinct_dependents', value: 2 },
          validationStatus: 'CANDIDATE',
          policy: { effective: { classification: 'PUBLIC', externalRelease: 'PERMITTED' } },
        }],
      });
      expect(corpus.summary()).toEqual(before);
    } finally { corpus.close(); }
  });

  it('is deterministic for an exact run and does not invent a pattern below threshold', async () => {
    const { corpus, projection } = await setup();
    try {
      expect(mineSharedDependencies(projection, { executedAt })).toEqual(mineSharedDependencies(projection, { executedAt }));
      expect(mineSharedDependencies(projection, { minimumDependents: 3, executedAt })).toMatchObject({ candidates: [], run: { outputPatternIds: [] } });
    } finally { corpus.close(); }
  });

  it('refuses a projection whose product-domain binding does not authorize the rule', async () => {
    const { corpus, projection } = await setup();
    try {
      const forged = {
        ...projection,
        manifest: { ...projection.manifest, corpusDefinitionFingerprint: '0'.repeat(64) },
      } as CompiledCorpusProjection;
      expect(() => mineSharedDependencies(forged, { executedAt })).toThrow(/CORPUS_MINING_DOMAIN_MISMATCH/);
    } finally { corpus.close(); }
  });
});
