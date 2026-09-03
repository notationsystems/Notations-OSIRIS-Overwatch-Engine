/** Ed25519 signatures over exact, deterministic CorpusBuild commitments. */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CorpusProjectionManifest } from './corpusProjection';
import {
  corpusVerificationDigest,
  verifyCorpusCommitmentManifest,
  type CorpusCommitmentManifest,
  type VerificationEnvelope,
} from './corpusVerification';
import { canonicalCorpusJson } from './physicalEconomyCorpus';
import { env } from './envCompat';

export type CorpusBuildAttestation = {
  readonly schema: 'payload.corpus.build-attestation.v1';
  readonly attestationId: string;
  readonly statement: {
    readonly schema: 'payload.corpus.build-attestation.statement.v1';
    readonly corpusBuildId: string;
    readonly projectionId: string;
    readonly projectionDigest: string;
    readonly commitmentId: string;
    readonly commitmentRoot: string;
    readonly leafCount: number;
    readonly signedAt: string;
    readonly signer: {
      readonly keyId: string;
      readonly algorithm: 'ed25519';
      readonly publicKeySpkiSha256: string;
    };
    readonly clockBasis: 'SIGNER_CLOCK';
    readonly independentTimestamp: false;
    readonly sourceTruthClaimed: false;
  };
  readonly signature: {
    readonly algorithm: 'ed25519';
    readonly keyId: string;
    readonly publicKeySpkiBase64: string;
    readonly valueBase64: string;
  };
  readonly limitations: readonly string[];
};

export type CorpusAttestationSigner = {
  readonly keyId: string;
  readonly privateKey: KeyObject;
};

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function publicKeyBytes(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer;
}

function publicKeyDigest(publicKey: Buffer): string {
  return createHash('sha256').update(publicKey).digest('hex');
}

export function corpusAttestationKeyId(privateKey: KeyObject): string {
  return `notation:ed25519:${publicKeyDigest(publicKeyBytes(privateKey))}`;
}

export function loadCorpusAttestationSigner(): CorpusAttestationSigner | null {
  const configuredPath = env('PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH')?.trim();
  if (!configuredPath) return null;
  const privateKey = createPrivateKey(readFileSync(resolve(/* turbopackIgnore: true */ process.cwd(), configuredPath), 'utf8'));
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('CORPUS_ATTESTATION_KEY_INVALID: signing key must be Ed25519');
  const derived = corpusAttestationKeyId(privateKey);
  const configuredId = env('PAYLOAD_CORPUS_ATTESTATION_KEY_ID')?.trim();
  if (configuredId && configuredId !== derived) throw new Error('CORPUS_ATTESTATION_KEY_INVALID: configured key id does not match the Ed25519 public key');
  return freeze({ keyId: derived, privateKey });
}

export function signCorpusBuildAttestation(input: {
  readonly manifest: CorpusProjectionManifest;
  readonly commitment: CorpusCommitmentManifest;
  readonly signer: CorpusAttestationSigner;
  readonly signedAt?: string;
}): CorpusBuildAttestation {
  const signedAt = input.signedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(signedAt)) || !ID.test(input.signer.keyId) || input.signer.privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('CORPUS_ATTESTATION_INPUT_INVALID: signer identity, key, or time is invalid');
  }
  if (!verifyCorpusCommitmentManifest(input.commitment) ||
      input.commitment.corpusBuildId !== input.manifest.corpusBuildId ||
      input.commitment.projectionId !== input.manifest.projectionId ||
      input.commitment.projectionDigest !== input.manifest.projectionDigest) {
    throw new Error('CORPUS_ATTESTATION_INPUT_INVALID: commitment does not identify the supplied CorpusBuild');
  }
  const publicBytes = publicKeyBytes(input.signer.privateKey);
  const publicKeySpkiSha256 = publicKeyDigest(publicBytes);
  const statement: CorpusBuildAttestation['statement'] = {
    schema: 'payload.corpus.build-attestation.statement.v1',
    corpusBuildId: input.manifest.corpusBuildId,
    projectionId: input.manifest.projectionId,
    projectionDigest: input.manifest.projectionDigest,
    commitmentId: input.commitment.commitmentId,
    commitmentRoot: input.commitment.root,
    leafCount: input.commitment.leafCount,
    signedAt,
    signer: { keyId: input.signer.keyId, algorithm: 'ed25519', publicKeySpkiSha256 },
    clockBasis: 'SIGNER_CLOCK',
    independentTimestamp: false,
    sourceTruthClaimed: false,
  };
  const signatureValue = signBytes(null, Buffer.from(canonicalCorpusJson(statement)), input.signer.privateKey).toString('base64');
  const signature: CorpusBuildAttestation['signature'] = {
    algorithm: 'ed25519',
    keyId: input.signer.keyId,
    publicKeySpkiBase64: publicBytes.toString('base64'),
    valueBase64: signatureValue,
  };
  const basis = {
    schema: 'payload.corpus.build-attestation.v1' as const,
    statement,
    signature,
    limitations: [
      'The signature authenticates this exact CorpusBuild commitment; it does not establish that source observations are true.',
      'signedAt is the signer clock, not an independent timestamp authority or public-chain anchor.',
      'A build signature is not an SP1 proof of compiler execution.',
    ],
  };
  const result = freeze({ ...basis, attestationId: `corpus-attestation:${corpusVerificationDigest(basis)}` });
  if (!verifyCorpusBuildAttestation(result)) throw new Error('CORPUS_ATTESTATION_SIGNING_FAILED: generated signature did not verify');
  return result;
}

export function verifyCorpusBuildAttestation(attestation: CorpusBuildAttestation): boolean {
  try {
    const { attestationId, ...basis } = attestation;
    if (attestation.schema !== 'payload.corpus.build-attestation.v1' ||
        attestation.statement.schema !== 'payload.corpus.build-attestation.statement.v1' ||
        attestation.statement.signer.algorithm !== 'ed25519' ||
        attestation.signature.algorithm !== 'ed25519' ||
        attestation.signature.keyId !== attestation.statement.signer.keyId ||
        !ID.test(attestation.signature.keyId) ||
        !HASH.test(attestation.statement.projectionDigest) ||
        !HASH.test(attestation.statement.commitmentRoot) ||
        !HASH.test(attestation.statement.signer.publicKeySpkiSha256) ||
        !Number.isSafeInteger(attestation.statement.leafCount) || attestation.statement.leafCount < 0 ||
        !Number.isFinite(Date.parse(attestation.statement.signedAt)) ||
        attestation.statement.clockBasis !== 'SIGNER_CLOCK' ||
        attestation.statement.independentTimestamp !== false ||
        attestation.statement.sourceTruthClaimed !== false ||
        attestationId !== `corpus-attestation:${corpusVerificationDigest(basis)}`) return false;
    const publicBytes = Buffer.from(attestation.signature.publicKeySpkiBase64, 'base64');
    if (publicKeyDigest(publicBytes) !== attestation.statement.signer.publicKeySpkiSha256) return false;
    const publicKey = createPublicKey({ key: publicBytes, type: 'spki', format: 'der' });
    if (publicKey.asymmetricKeyType !== 'ed25519') return false;
    return verifyBytes(
      null,
      Buffer.from(canonicalCorpusJson(attestation.statement)),
      publicKey,
      Buffer.from(attestation.signature.valueBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

export function applyBuildAttestation(
  envelope: VerificationEnvelope,
  attestation: CorpusBuildAttestation,
): VerificationEnvelope {
  if (!verifyCorpusBuildAttestation(attestation) ||
      envelope.corpusBuildId !== attestation.statement.corpusBuildId ||
      envelope.commitment.commitmentId !== attestation.statement.commitmentId ||
      envelope.commitment.root !== attestation.statement.commitmentRoot ||
      envelope.commitment.projectionDigest !== attestation.statement.projectionDigest) {
    throw new Error('CORPUS_ATTESTATION_MISMATCH: attestation does not bind this verification envelope');
  }
  return freeze({
    ...envelope,
    verificationLevel: 'ATTESTED' as const,
    attestation: {
      status: 'ATTESTED' as const,
      scheme: 'ed25519',
      anchorId: attestation.attestationId,
      signedAt: attestation.statement.signedAt,
    },
    limitations: [
      'Merkle inclusion establishes membership relative to this signed CorpusBuild commitment; it does not prove that a source observation is true.',
      'The Ed25519 signature authenticates the build signer, while signedAt remains signer-clock time without an independent timestamp anchor.',
      'The computation digest covers the declared deterministic program, inputs, parameters, and output; free-form interpretation is outside this envelope.',
    ],
  });
}
