import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildCanonicalCorpusBatch } from './corpusBuilder';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { PhysicalEconomyCorpus } from './physicalEconomyCorpus';

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
          coverage: 'CANONICAL_WRITE_ONLY', upstreamAcquisitionAttested: false,
          recordIds: ['record:evidence:builder'], evidenceIds: ['evidence:builder'], claimRecordIds: [],
          firstSequence: 1, lastSequence: 1,
        },
      });
      expect(replay).toMatchObject({ kind: 'committed', idempotent: true, builderManifest: { builderRunId: first.kind === 'committed' ? first.builderManifest.builderRunId : '' } });
    } finally { corpus.close(); }
  });
});
