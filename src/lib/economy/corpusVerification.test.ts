import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import {
  PhysicalEconomyCorpus,
  type CorpusRecordInput,
} from './physicalEconomyCorpus';
import {
  buildCorpusCommitment,
  buildVerificationEnvelope,
  corpusVerificationDigest,
  proveCorpusRecordInclusion,
  verifyCorpusCommitmentManifest,
  verifyCorpusRecordInclusion,
} from './corpusVerification';
import { buildCorpusWarrantGraph, selectCorpusWarrantBasis } from './corpusWarrantGraph';

const at = '2026-09-02T12:00:00.000Z';

function records(): CorpusRecordInput[] {
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  return [
    { ...common, recordId: 'record:evidence:warrant', recordType: 'evidence', evidenceId: 'evidence:warrant', sourceId: 'source:warrant', title: 'Warrant test source', sourceUrl: 'https://example.test/warrant', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: 'record:entity:warrant', recordType: 'entity', entityId: 'pe:facility:warrant', entityKind: 'facility', canonicalName: 'Warrant Facility', evidenceIds: ['evidence:warrant'] },
    { ...common, recordId: 'record:observation:supports', recordType: 'observation', observationId: 'observation:supports', entityId: 'pe:facility:warrant', metric: 'capacity', value: 800, unit: 'kt/y', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence:warrant'] },
    { ...common, recordId: 'record:observation:contradicts', recordType: 'observation', observationId: 'observation:contradicts', entityId: 'pe:facility:warrant', metric: 'capacity', value: 620, unit: 'kt/y', valueKind: 'reported', confidence: 'medium', evidenceIds: ['evidence:warrant'] },
    { ...common, recordId: 'record:assertion:warrant', recordType: 'assertion', assertionId: 'assertion:warrant', entityId: 'pe:facility:warrant', propertyKey: 'capacity', selectedValue: 800, unit: 'kt/y', status: 'accepted', selectionPolicy: 'prefer-primary-source-v1', validFrom: at, confidence: 'medium', evidence: [{ observationId: 'observation:supports', role: 'supports' }, { observationId: 'observation:contradicts', role: 'contradicts' }] },
  ];
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-verification-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const appended = corpus.append('global', records(), at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
  return { directory, corpus, projection };
}

describe('proof-carrying corpus verification', () => {
  it('creates and verifies inclusion proofs, including an odd promoted leaf', () => {
    const value = fixture();
    try {
      const commitment = buildCorpusCommitment(value.projection.manifest, value.projection.records);
      expect(commitment).toMatchObject({ leafCount: 5, algorithm: 'sha256_binary_merkle_promote_odd_v1' });
      expect(verifyCorpusCommitmentManifest(commitment)).toBe(true);
      const included = proveCorpusRecordInclusion(value.projection.manifest, value.projection.records, value.projection.records.map(record => record.recordId));
      expect(included.commitment).toEqual(commitment);
      expect(included.proofs.every(proof => verifyCorpusRecordInclusion(commitment, proof))).toBe(true);
      const altered = { ...included.proofs[0], recordHash: 'f'.repeat(64) };
      expect(verifyCorpusRecordInclusion(commitment, altered)).toBe(false);
      const changedManifest = { ...commitment, projectionDigest: 'f'.repeat(64) };
      expect(verifyCorpusCommitmentManifest(changedManifest)).toBe(false);
      expect(verifyCorpusRecordInclusion(changedManifest, included.proofs[0])).toBe(false);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('separates provenance, reproducibility, attestation, and zk verification honestly', () => {
    const value = fixture();
    try {
      const basis = selectCorpusWarrantBasis(value.projection.records, { entityId: 'pe:facility:warrant' });
      const inputDigest = corpusVerificationDigest({ entityId: 'pe:facility:warrant' });
      const outputDigest = corpusVerificationDigest({ selectedValue: 800, unit: 'kt/y' });
      const envelope = buildVerificationEnvelope({
        manifest: value.projection.manifest,
        projectionRecords: value.projection.records,
        basisRecords: basis,
        programId: 'payload:test-capacity-selection',
        algorithmVersion: '1.0.0',
        inputDigest,
        outputDigest,
        parameters: { policy: 'prefer-primary-source-v1' },
      });
      expect(envelope).toMatchObject({
        verificationLevel: 'REPRODUCIBLE',
        provenanceStatus: 'COMPLETE',
        sourceTruthClaimed: false,
        attestation: { status: 'NOT_ATTESTED' },
        zkProof: { status: 'NOT_GENERATED' },
      });
      expect(envelope.inclusionProofs).toHaveLength(5);
      expect(envelope.inclusionProofs.every(proof => verifyCorpusRecordInclusion(envelope.commitment, proof))).toBe(true);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('renders disagreement as separate structural edges and never as a trust score', () => {
    const value = fixture();
    try {
      const basis = selectCorpusWarrantBasis(value.projection.records, { entityId: 'pe:facility:warrant' });
      const inputDigest = corpusVerificationDigest({ entityId: 'pe:facility:warrant' });
      const outputDigest = corpusVerificationDigest(basis.map(record => record.recordHash));
      const verification = buildVerificationEnvelope({ manifest: value.projection.manifest, projectionRecords: value.projection.records, basisRecords: basis, programId: 'payload:warrant-walk', algorithmVersion: '1.0.0', inputDigest, outputDigest, parameters: {} });
      const graph = buildCorpusWarrantGraph({ statement: 'Why Payload holds this capacity', basisRecords: basis, manifest: value.projection.manifest, verification });
      expect(graph.scorePolicy).toBe('NO_COMPOSITE_TRUST_SCORE');
      expect(graph.edges.some(edge => edge.kind === 'supported_by')).toBe(true);
      expect(graph.edges.some(edge => edge.kind === 'contradicted_by')).toBe(true);
      expect(graph.nodes.filter(node => node.recordType === 'observation').map(node => node.label)).toEqual(expect.arrayContaining(['capacity: 800 kt/y', 'capacity: 620 kt/y']));
      expect(graph).toEqual(buildCorpusWarrantGraph({ statement: 'Why Payload holds this capacity', basisRecords: basis, manifest: value.projection.manifest, verification }));
      expect(JSON.stringify(graph)).not.toContain('trustScore');
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
