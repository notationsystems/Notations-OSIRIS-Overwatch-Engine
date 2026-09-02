import { describe, expect, it } from 'vitest';
import { buildFacilityAnswerWarrant } from './corpusAnswer';
import type { CorpusAccess } from './corpusPolicy';
import type { CorpusProjectionManifest } from './corpusProjection';
import type { FacilityDiscoveryResult, StoredCorpusRecord } from './physicalEconomyCorpus';

const knownAt = '2026-09-02T12:00:00.000Z';
const internal: CorpusAccess = {
  visibility: 'PAYLOAD_INTERNAL',
  licenseClass: 'PAYLOAD_PROPRIETARY',
  redistributionClass: 'PROHIBITED',
  retentionClass: 'PERMANENT',
  allowedUses: ['ANALYSIS', 'DERIVATION'],
  derivationPolicy: 'INTERNAL_ONLY',
};

function stored(record: Record<string, unknown>, sequence: number): StoredCorpusRecord {
  return {
    schema: 'payload.corpus.record.v1',
    knownAt,
    access: internal,
    scope: 'global',
    sequence,
    recordedAt: knownAt,
    previousHash: null,
    recordHash: String(sequence).repeat(64).slice(0, 64),
    ...record,
  } as StoredCorpusRecord;
}

describe('corpus answer emission policy', () => {
  it('refuses an otherwise computable answer whose joined policy prohibits external release', () => {
    const records = [
      stored({ recordId: 'record:material', recordType: 'entity', entityId: 'pe:material:pp', entityKind: 'material', canonicalName: 'Polypropylene', evidenceIds: ['evidence:internal'] }, 1),
      stored({ recordId: 'record:facility', recordType: 'entity', entityId: 'pe:facility:plant', entityKind: 'facility', canonicalName: 'Internal Plant', evidenceIds: ['evidence:internal'] }, 2),
      stored({ recordId: 'record:relationship', recordType: 'relationship', relationshipId: 'relationship:plant-produces-pp', subjectEntityId: 'pe:facility:plant', predicate: 'produces', objectEntityId: 'pe:material:pp', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence:internal'] }, 3),
      stored({ recordId: 'record:evidence', recordType: 'evidence', evidenceId: 'evidence:internal', sourceId: 'source:internal', title: 'Internal evidence', sourceUrl: 'https://example.test/internal', artifactSha256: 'a'.repeat(64), retrievedAt: knownAt }, 4),
    ];
    const result: Extract<FacilityDiscoveryResult, { kind: 'facility_discovery' }> = {
      kind: 'facility_discovery',
      material: { entityId: 'pe:material:pp', name: 'Polypropylene' },
      scope: 'global',
      asOf: knownAt,
      knowledgeCutoff: knownAt,
      facilities: [{ entityId: 'pe:facility:plant', name: 'Internal Plant', relationshipId: 'relationship:plant-produces-pp', confidence: 'high', evidence: [] }],
    };
    expect(buildFacilityAnswerWarrant('pe:material:pp', result, records, {} as CorpusProjectionManifest)).toMatchObject({
      kind: 'refusal',
      code: 'CORPUS_OUTPUT_POLICY_DENIED',
    });
  });
});
