import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalCorpusBatch } from './corpusBuilder';
import { createCorpusDefinition } from './corpusDefinition';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION } from './payloadCorpusDefinition';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Corpus Builder canonical-write boundary', () => {
  it('returns a deterministic commit manifest without claiming upstream acquisition', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-corpus-builder-'));
    directories.push(directory);
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    const at = '2026-09-02T12:00:00.000Z';
    const records = [{ schema: 'payload.corpus.record.v1' as const, recordId: 'record:evidence:builder', recordType: 'evidence' as const, knownAt: at, evidenceId: 'evidence:builder', sourceId: 'source:builder', title: 'Builder evidence', sourceUrl: 'https://example.test/builder', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS }];
    try {
      const first = buildCanonicalCorpusBatch(corpus, 'global', records, at);
      const replay = buildCanonicalCorpusBatch(corpus, 'global', records, at);
      expect(first).toMatchObject({
        kind: 'committed', idempotent: false,
        builderManifest: {
          builderRunId: expect.stringMatching(/^corpus-builder:[a-f0-9]{64}$/),
          corpusEngineId: 'notation-systems.payloados.corpus-engine',
          corpusDefinitionId: 'payload.corpus-definition.physical-economy.v1',
          corpusDefinitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          productId: 'notation-systems.product.payload',
          coverage: 'CANONICAL_WRITE_ONLY', upstreamAcquisitionAttested: false,
          recordIds: ['record:evidence:builder'], evidenceIds: ['evidence:builder'], claimRecordIds: [],
          firstSequence: 1, lastSequence: 1,
        },
      });
      expect(replay).toMatchObject({ kind: 'committed', idempotent: true, builderManifest: { builderRunId: first.kind === 'committed' ? first.builderManifest.builderRunId : '' } });
    } finally { corpus.close(); }
  });

  it('refuses a forged domain fingerprint before canonical state changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-corpus-builder-domain-'));
    directories.push(directory);
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    const invalidDomain = { ...PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION, definitionFingerprint: '0'.repeat(64) };
    try {
      expect(() => buildCanonicalCorpusBatch(corpus, 'global', [], undefined, invalidDomain)).toThrow(/CORPUS_DEFINITION_INVALID/);
      const otherDomain = createCorpusDefinition({
        definitionId: 'other.corpus-definition.v1',
        product: { productId: 'notation-systems.product.other', productName: 'Other', corpusName: 'Other Corpus' },
        domainId: 'other-domain',
        ontology: { ontologyId: 'other.ontology', ontologyVersion: 'other.ontology.v1' },
        entityTypes: ['object'], relationTypes: ['relates_to'], observationTypes: ['metric'],
        sourceRegistry: { admission: 'REGISTERED_SOURCES_ONLY', sourceClasses: ['reviewed_document'] },
        extractionRules: ['other.extraction.v1'], resolutionRules: ['other.resolution.v1'], validationRules: ['other.validation.v1'], miningPrograms: ['other.mining.rule@1.0.0'],
        accessPolicy: { profileId: 'other.policy.v1', informationFlow: 'MOST_RESTRICTIVE_JOIN' },
        publicationContract: { contractId: 'other.publication.v1', audiences: ['internal'], representations: ['relational'], evidenceRequired: true },
      });
      expect(() => buildCanonicalCorpusBatch(corpus, 'global', [], undefined, otherDomain)).toThrow(/CORPUS_BUILDER_DOMAIN_UNSUPPORTED/);
      const mismatchedRecord = { recordType: 'entity', entityKind: 'building' } as unknown as CorpusRecordInput;
      expect(() => buildCanonicalCorpusBatch(corpus, 'global', [mismatchedRecord])).toThrow(/CORPUS_BUILDER_DEFINITION_MISMATCH/);
      expect(corpus.summary().lastSequence).toBe(0);
    } finally { corpus.close(); }
  });
});
