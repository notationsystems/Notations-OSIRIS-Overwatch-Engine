import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAYLOAD_CORPUS_METHODOLOGY } from './corpusMethodology';
import { assertCorpusBuildPublicationAllowed, preflightPublicCorpusBuild } from './corpusPreflight';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const at = '2026-09-02T20:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-methodology-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const records: CorpusRecordInput[] = [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:methodology', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:methodology', sourceId: 'source:methodology', title: 'Methodology fixture', sourceUrl: 'https://example.test/methodology', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:methodology:one', recordType: 'entity', knownAt: at, entityId: 'pe:facility:methodology-one', entityKind: 'facility', canonicalName: 'Methodology One', evidenceIds: ['evidence:methodology'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:methodology:two', recordType: 'entity', knownAt: at, entityId: 'pe:facility:methodology-two', entityKind: 'facility', canonicalName: 'Methodology Two', evidenceIds: ['evidence:methodology'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:alias:methodology:one', recordType: 'alias', knownAt: at, aliasId: 'alias:methodology-one', scheme: 'common', value: 'Shared terminal', entityId: 'pe:facility:methodology-one', evidenceIds: ['evidence:methodology'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:alias:methodology:two', recordType: 'alias', knownAt: at, aliasId: 'alias:methodology-two', scheme: 'legacy', value: ' shared terminal ', entityId: 'pe:facility:methodology-two', evidenceIds: ['evidence:methodology'], access: OPEN_PUBLIC_CORPUS_ACCESS },
  ];
  const appended = corpus.append('global', records, at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const source = corpus.projectionSource('global', at);
  const projection = buildPublicProjection(source, at);
  return { directory, corpus, source, projection };
}

describe('inspectable corpus methodology and publication preflight', () => {
  it('publishes capability maturity and explicit negative boundaries under a stable digest', () => {
    expect(PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(PAYLOAD_CORPUS_METHODOLOGY.uncertaintySemantics.map(item => item.object)).toContain('entity_resolution');
    expect(PAYLOAD_CORPUS_METHODOLOGY.deliberateNonClaims).toContain('Payload does not interpret missing observations as zero.');
    expect(PAYLOAD_CORPUS_METHODOLOGY.capabilities).toContainEqual(expect.objectContaining({ capabilityId: 'internal-federation', status: 'PLANNED', implementation: 'NOT_IMPLEMENTED' }));
  });

  it('permits a valid build while surfacing alias ambiguity and unobserved live health', () => {
    const value = fixture();
    try {
      const preflight = preflightPublicCorpusBuild(value.source, value.projection);
      expect(preflight).toMatchObject({
        status: 'DEGRADED',
        publicationAllowed: true,
        identityRisks: [{ normalizedMention: 'shared terminal', conflictingEntityIds: ['pe:facility:methodology-one', 'pe:facility:methodology-two'], validationStatus: 'REVIEW_REQUIRED' }],
      });
      expect(preflight.checks).toContainEqual(expect.objectContaining({ checkId: 'alias-ambiguity', status: 'FAIL', blocking: false }));
      expect(preflight.checks).toContainEqual(expect.objectContaining({ checkId: 'live-source-health', status: 'UNOBSERVED', blocking: false }));
      expect(() => assertCorpusBuildPublicationAllowed(preflight)).not.toThrow();

      const replay = preflightPublicCorpusBuild(value.source, buildPublicProjection(value.source, '2026-09-02T21:00:00.000Z'));
      expect(replay.preflightDigest).toBe(preflight.preflightDigest);
      expect(replay.evaluatedAt).not.toBe(preflight.evaluatedAt);
    } finally { value.corpus.close(); rmSync(value.directory, { recursive: true, force: true }); }
  });

  it('blocks publication when the projection does not identify the supplied source state', () => {
    const value = fixture();
    try {
      const mismatched = { ...value.source, sourceDigest: '0'.repeat(64) };
      const preflight = preflightPublicCorpusBuild(mismatched, value.projection);
      expect(preflight).toMatchObject({ status: 'FAIL', publicationAllowed: false });
      expect(preflight.checks).toContainEqual(expect.objectContaining({ checkId: 'projection-source-equivalence', status: 'FAIL', blocking: true }));
      expect(() => assertCorpusBuildPublicationAllowed(preflight)).toThrow(/CORPUS_PREFLIGHT_FAILED/);
    } finally { value.corpus.close(); rmSync(value.directory, { recursive: true, force: true }); }
  });
});
