import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyBuildAttestation, corpusAttestationKeyId, signCorpusBuildAttestation, verifyCorpusBuildAttestation } from './corpusBuildAttestation';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';
import { buildCorpusCommitment, buildVerificationEnvelope, corpusVerificationDigest } from './corpusVerification';

const at = '2026-09-02T16:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-build-attestation-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const records: CorpusRecordInput[] = [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:attestation', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:attestation', sourceId: 'source:attestation', title: 'Attestation source', sourceUrl: 'https://example.test/attestation', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:attestation', recordType: 'entity', knownAt: at, entityId: 'pe:facility:attestation', entityKind: 'facility', canonicalName: 'Attested Facility', evidenceIds: ['evidence:attestation'], access: OPEN_PUBLIC_CORPUS_ACCESS },
  ];
  const appended = corpus.append('global', records, at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
  return { directory, corpus, projection };
}

describe('signed CorpusBuild attestations', () => {
  it('signs and independently verifies an exact Merkle commitment', () => {
    const value = fixture();
    try {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const commitment = buildCorpusCommitment(value.projection.manifest, value.projection.records);
      const attestation = signCorpusBuildAttestation({
        manifest: value.projection.manifest,
        commitment,
        signer: { keyId: corpusAttestationKeyId(privateKey), privateKey },
        signedAt: at,
      });
      expect(attestation).toMatchObject({
        statement: { corpusBuildId: value.projection.manifest.corpusBuildId, commitmentRoot: commitment.root, clockBasis: 'SIGNER_CLOCK', independentTimestamp: false, sourceTruthClaimed: false },
        signature: { algorithm: 'ed25519' },
      });
      const expectedPublicKeyDigest = createHash('sha256')
        .update(publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex');
      expect(attestation.statement.signer.publicKeySpkiSha256).toBe(expectedPublicKeyDigest);
      expect(attestation.statement.signer.keyId).toBe(`notation:ed25519:${expectedPublicKeyDigest}`);
      expect(verifyCorpusBuildAttestation(attestation)).toBe(true);
      expect(verifyCorpusBuildAttestation({ ...attestation, signature: { ...attestation.signature, valueBase64: Buffer.from('tampered').toString('base64') } })).toBe(false);

      const envelope = buildVerificationEnvelope({
        manifest: value.projection.manifest,
        projectionRecords: value.projection.records,
        basisRecords: value.projection.records,
        programId: 'notation:test', algorithmVersion: '1.0.0',
        inputDigest: corpusVerificationDigest({ input: true }), outputDigest: corpusVerificationDigest({ output: true }), parameters: {},
      });
      const elevated = applyBuildAttestation(envelope, attestation);
      expect(elevated).toMatchObject({ verificationLevel: 'ATTESTED', attestation: { status: 'ATTESTED', scheme: 'ed25519', anchorId: attestation.attestationId, signedAt: at }, zkProof: { status: 'NOT_GENERATED' } });
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('refuses a signature from a commitment belonging to another build', () => {
    const value = fixture();
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const commitment = buildCorpusCommitment(value.projection.manifest, value.projection.records);
      expect(() => signCorpusBuildAttestation({
        manifest: { ...value.projection.manifest, corpusBuildId: 'corpus-build:another' },
        commitment,
        signer: { keyId: corpusAttestationKeyId(privateKey), privateKey },
        signedAt: at,
      })).toThrow(/does not identify/);
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
