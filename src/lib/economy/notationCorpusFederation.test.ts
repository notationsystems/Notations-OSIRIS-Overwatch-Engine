import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNotationCorpusSyncPage, notationUri } from './notationCorpusFederation';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const at = '2026-09-02T19:00:00.000Z';

describe('Notation corpus federation', () => {
  it('emits deterministic, build-bound global identities and advances over policy gaps', () => {
    const directory = mkdtempSync(join(tmpdir(), 'payload-notation-sync-'));
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    try {
      const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at };
      const records: CorpusRecordInput[] = [
        { ...common, recordId: 'record:evidence:sync', recordType: 'evidence', evidenceId: 'evidence:sync', sourceId: 'source:sync', title: 'Public source', sourceUrl: 'https://example.test/sync', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
        { ...common, recordId: 'record:entity:sync', recordType: 'entity', entityId: 'pe:facility:sync', entityKind: 'facility', canonicalName: 'Sync Facility', evidenceIds: ['evidence:sync'], access: OPEN_PUBLIC_CORPUS_ACCESS },
        { ...common, recordId: 'record:evidence:private-gap', recordType: 'evidence', evidenceId: 'evidence:private-gap', sourceId: 'source:private', title: 'Internal source', sourceUrl: 'https://example.test/private', artifactSha256: 'b'.repeat(64), retrievedAt: at, access: { visibility: 'PAYLOAD_INTERNAL', licenseClass: 'PAYLOAD_PROPRIETARY', redistributionClass: 'PROHIBITED', retentionClass: 'PERMANENT', allowedUses: ['SEARCH', 'ANALYSIS', 'PROJECTION'] } },
      ];
      expect(corpus.append('global', records, at).kind).toBe('committed');
      const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
      const first = buildNotationCorpusSyncPage(projection, { limit: 1 });
      expect(first).toMatchObject({ schema: 'payload.notation.sync-page.v1', sourceNodeUri: 'notation://node/payload', afterSequence: 0, nextAfterSequence: 1, hasMore: true });
      expect(first.envelopes[0]).toMatchObject({ objectUri: notationUri('artifact', 'evidence:sync'), corpusBuildUri: notationUri('dataset', projection.manifest.corpusBuildId), operation: 'UPSERT_APPEND_ONLY' });
      const final = buildNotationCorpusSyncPage(projection, { afterSequence: first.nextAfterSequence, limit: 10 });
      expect(final).toMatchObject({ nextAfterSequence: 3, sourceSequence: 3, hasMore: false });
      expect(final.envelopes[0]).toMatchObject({ objectUri: notationUri('entity', 'pe:facility:sync'), referenceUris: [notationUri('artifact', 'evidence:sync')] });
      expect(buildNotationCorpusSyncPage(projection, { limit: 10 })).toEqual(buildNotationCorpusSyncPage(projection, { limit: 10 }));
    } finally {
      corpus.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
