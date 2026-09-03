/**
 * Verification contracts for proof-carrying corpus answers.
 *
 * Provenance describes why Payload holds a value. Reproducibility binds a
 * deterministic computation to exact inputs and output. An external
 * attestation or SP1 proof may strengthen that statement, but neither proves
 * that the source observation was true.
 */

import { createHash } from 'node:crypto';
import type { CorpusProjectionManifest } from './corpusProjection';
import {
  canonicalCorpusJson,
  corpusRecordReferenceIds,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';

export type VerificationLevel = 'PROVENANCE' | 'REPRODUCIBLE' | 'ATTESTED' | 'ZK_VERIFIED';

export interface CorpusCommitmentManifest {
  readonly schema: 'payload.corpus.commitment.v1';
  readonly commitmentId: string;
  readonly corpusBuildId: string;
  readonly projectionId: string;
  readonly projectionDigest: string;
  readonly algorithm: 'sha256_binary_merkle_promote_odd_v1';
  readonly leafDomain: typeof CORPUS_COMMITMENT_LEAF_DOMAIN;
  readonly nodeDomain: typeof CORPUS_COMMITMENT_NODE_DOMAIN;
  readonly root: string;
  readonly leafCount: number;
  readonly committedAt: string;
}

export interface CorpusMerkleInclusionProof {
  readonly schema: 'payload.corpus.inclusion-proof.v1';
  readonly commitmentId: string;
  readonly recordId: string;
  readonly recordHash: string;
  readonly sequence: number;
  readonly leafIndex: number;
  readonly leafCount: number;
  readonly leafHash: string;
  readonly siblings: readonly {
    readonly side: 'left' | 'right';
    readonly hash: string;
  }[];
}

export type DeterministicComputationReference = {
  readonly computationId: string;
  readonly programId: string;
  readonly algorithmVersion: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly parametersDigest: string;
};

export type VerificationEnvelope = {
  readonly schema: 'payload.verification-envelope.v1';
  readonly verificationLevel: VerificationLevel;
  readonly provenanceStatus: 'COMPLETE' | 'PARTIAL';
  readonly sourceTruthClaimed: false;
  readonly recordRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly corpusBuildId: string;
  readonly contentHash: string;
  readonly computation: DeterministicComputationReference;
  readonly commitment: CorpusCommitmentManifest;
  readonly inclusionProofs: readonly CorpusMerkleInclusionProof[];
  readonly attestation:
    | { readonly status: 'NOT_ATTESTED'; readonly reason: string }
    | { readonly status: 'ATTESTED'; readonly scheme: string; readonly anchorId: string; readonly signedAt: string };
  readonly zkProof:
    | { readonly status: 'NOT_GENERATED'; readonly reason: string }
    | {
        readonly status: 'VERIFIED';
        readonly system: 'sp1';
        readonly programId: string;
        readonly verificationKey: `0x${string}`;
        readonly proofId: string;
        readonly publicInputsDigest: string;
      };
  readonly limitations: readonly string[];
};

export const CORPUS_COMMITMENT_LEAF_DOMAIN = 'payload.corpus.commitment.leaf.v1';
export const CORPUS_COMMITMENT_NODE_DOMAIN = 'payload.corpus.commitment.node.v1';
const HASH = /^[a-f0-9]{64}$/;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function corpusVerificationDigest(value: unknown): string {
  return sha(canonicalCorpusJson(value));
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function orderedRecords(records: readonly StoredCorpusRecord[]): StoredCorpusRecord[] {
  const ordered = [...records].sort((left, right) => left.sequence - right.sequence || left.recordId.localeCompare(right.recordId));
  const ids = new Set<string>();
  for (const record of ordered) {
    if (!Number.isSafeInteger(record.sequence) || record.sequence < 1 || ids.has(record.recordId) || !HASH.test(record.recordHash)) {
      throw new Error('CORPUS_COMMITMENT_INPUT_INVALID: records must have unique identities, safe sequences, and canonical hashes');
    }
    ids.add(record.recordId);
  }
  return ordered;
}

export function corpusCommitmentLeaf(record: Pick<StoredCorpusRecord, 'sequence' | 'recordId' | 'recordHash'>): string {
  return sha(canonicalCorpusJson({
    domain: CORPUS_COMMITMENT_LEAF_DOMAIN,
    sequence: record.sequence,
    recordId: record.recordId,
    recordHash: record.recordHash,
  }));
}

function parentHash(left: string, right: string): string {
  return sha(canonicalCorpusJson({ domain: CORPUS_COMMITMENT_NODE_DOMAIN, left, right }));
}

function merkleLevels(records: readonly StoredCorpusRecord[]): string[][] {
  const levels = [records.map(corpusCommitmentLeaf)];
  if (levels[0].length === 0) levels[0].push(sha(`${CORPUS_COMMITMENT_LEAF_DOMAIN}|empty`));
  while (levels.at(-1)!.length > 1) {
    const prior = levels.at(-1)!;
    const next: string[] = [];
    for (let index = 0; index < prior.length; index += 2) {
      next.push(index + 1 < prior.length ? parentHash(prior[index], prior[index + 1]) : prior[index]);
    }
    levels.push(next);
  }
  return levels;
}

export function buildCorpusCommitment(
  manifest: CorpusProjectionManifest,
  records: readonly StoredCorpusRecord[],
): CorpusCommitmentManifest {
  const ordered = orderedRecords(records);
  if (ordered.length !== manifest.recordCount) throw new Error('CORPUS_COMMITMENT_INPUT_INVALID: projection record count contradicts its manifest');
  const root = merkleLevels(ordered).at(-1)![0];
  const basis: Omit<CorpusCommitmentManifest, 'commitmentId'> = {
    schema: 'payload.corpus.commitment.v1' as const,
    corpusBuildId: manifest.corpusBuildId,
    projectionId: manifest.projectionId,
    projectionDigest: manifest.projectionDigest,
    algorithm: 'sha256_binary_merkle_promote_odd_v1' as const,
    leafDomain: CORPUS_COMMITMENT_LEAF_DOMAIN,
    nodeDomain: CORPUS_COMMITMENT_NODE_DOMAIN,
    root,
    leafCount: ordered.length,
    committedAt: manifest.generatedAt,
  };
  return freeze({ ...basis, commitmentId: `corpus-commitment:${corpusVerificationDigest(basis)}` });
}

export function verifyCorpusCommitmentManifest(commitment: CorpusCommitmentManifest): boolean {
  const { commitmentId, ...basis } = commitment;
  return commitment.schema === 'payload.corpus.commitment.v1'
    && commitment.algorithm === 'sha256_binary_merkle_promote_odd_v1'
    && commitment.leafDomain === CORPUS_COMMITMENT_LEAF_DOMAIN
    && commitment.nodeDomain === CORPUS_COMMITMENT_NODE_DOMAIN
    && Number.isSafeInteger(commitment.leafCount)
    && commitment.leafCount >= 0
    && HASH.test(commitment.root)
    && HASH.test(commitment.projectionDigest)
    && commitmentId === `corpus-commitment:${corpusVerificationDigest(basis)}`;
}

export function proveCorpusRecordInclusion(
  manifest: CorpusProjectionManifest,
  records: readonly StoredCorpusRecord[],
  recordIds: readonly string[],
): { readonly commitment: CorpusCommitmentManifest; readonly proofs: readonly CorpusMerkleInclusionProof[] } {
  const ordered = orderedRecords(records);
  const commitment = buildCorpusCommitment(manifest, ordered);
  const levels = merkleLevels(ordered);
  const indexById = new Map(ordered.map((record, index) => [record.recordId, index]));
  const requested = [...new Set(recordIds)].sort();
  const missing = requested.find(recordId => !indexById.has(recordId));
  if (missing) throw new Error(`CORPUS_COMMITMENT_RECORD_MISSING: ${missing} is absent from ${manifest.corpusBuildId}`);
  const proofs = requested.map(recordId => {
    const record = ordered[indexById.get(recordId)!];
    let index = indexById.get(recordId)!;
    const siblings: Array<{ side: 'left' | 'right'; hash: string }> = [];
    for (let level = 0; level < levels.length - 1; level += 1) {
      const row = levels[level];
      const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
      if (siblingIndex < row.length) siblings.push({ side: siblingIndex < index ? 'left' : 'right', hash: row[siblingIndex] });
      index = Math.floor(index / 2);
    }
    return freeze({
      schema: 'payload.corpus.inclusion-proof.v1' as const,
      commitmentId: commitment.commitmentId,
      recordId: record.recordId,
      recordHash: record.recordHash,
      sequence: record.sequence,
      leafIndex: indexById.get(recordId)!,
      leafCount: ordered.length,
      leafHash: corpusCommitmentLeaf(record),
      siblings,
    });
  });
  return freeze({ commitment, proofs });
}

export function verifyCorpusRecordInclusion(
  commitment: CorpusCommitmentManifest,
  proof: CorpusMerkleInclusionProof,
): boolean {
  if (!verifyCorpusCommitmentManifest(commitment) || proof.schema !== 'payload.corpus.inclusion-proof.v1' || proof.commitmentId !== commitment.commitmentId || proof.leafCount !== commitment.leafCount || !Number.isSafeInteger(proof.sequence) || proof.sequence < 1 || !Number.isSafeInteger(proof.leafIndex) || proof.leafIndex < 0 || proof.leafIndex >= proof.leafCount || proof.leafHash !== corpusCommitmentLeaf(proof) || !HASH.test(proof.recordHash)) return false;
  let hash = proof.leafHash;
  let index = proof.leafIndex;
  let width = proof.leafCount;
  let siblingCursor = 0;
  while (width > 1) {
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    if (siblingIndex < width) {
      const sibling = proof.siblings[siblingCursor++];
      const expectedSide = siblingIndex < index ? 'left' : 'right';
      if (!sibling || sibling.side !== expectedSide || !HASH.test(sibling.hash)) return false;
      hash = sibling.side === 'left' ? parentHash(sibling.hash, hash) : parentHash(hash, sibling.hash);
    }
    index = Math.floor(index / 2);
    width = Math.ceil(width / 2);
  }
  return siblingCursor === proof.siblings.length && hash === commitment.root;
}

function provenanceStatus(records: readonly StoredCorpusRecord[]): VerificationEnvelope['provenanceStatus'] {
  const supportIds = new Set(records.flatMap(record => record.recordType === 'evidence'
    ? [record.evidenceId]
    : record.recordType === 'evidence_unit'
      ? [record.evidenceUnitId]
      : record.recordType === 'observation'
        ? [record.observationId]
        : []));
  return records.every(record => corpusRecordReferenceIds(record).every(reference => supportIds.has(reference))) ? 'COMPLETE' : 'PARTIAL';
}

export function buildVerificationEnvelope(input: {
  readonly manifest: CorpusProjectionManifest;
  readonly projectionRecords: readonly StoredCorpusRecord[];
  readonly basisRecords: readonly StoredCorpusRecord[];
  readonly programId: string;
  readonly algorithmVersion: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly parameters: unknown;
}): VerificationEnvelope {
  const recordRefs = [...new Set(input.basisRecords.map(record => record.recordId))].sort();
  const evidenceRefs = [...new Set(input.basisRecords.flatMap(record => record.recordType === 'evidence'
    ? [record.evidenceId]
    : record.recordType === 'evidence_unit'
      ? [record.evidenceUnitId]
      : []))].sort();
  const { commitment, proofs } = proveCorpusRecordInclusion(input.manifest, input.projectionRecords, recordRefs);
  const computationBasis = {
    programId: input.programId,
    algorithmVersion: input.algorithmVersion,
    inputDigest: input.inputDigest,
    outputDigest: input.outputDigest,
    parametersDigest: corpusVerificationDigest(input.parameters),
    corpusBuildId: input.manifest.corpusBuildId,
  };
  return freeze({
    schema: 'payload.verification-envelope.v1' as const,
    verificationLevel: 'REPRODUCIBLE' as const,
    provenanceStatus: provenanceStatus(input.basisRecords),
    sourceTruthClaimed: false as const,
    recordRefs,
    evidenceRefs,
    corpusBuildId: input.manifest.corpusBuildId,
    contentHash: input.outputDigest,
    computation: {
      computationId: `computation:${corpusVerificationDigest(computationBasis)}`,
      ...computationBasis,
    },
    commitment,
    inclusionProofs: proofs,
    attestation: {
      status: 'NOT_ATTESTED' as const,
      reason: 'This build has a deterministic internal commitment but no independently signed or externally anchored timestamp.',
    },
    zkProof: {
      status: 'NOT_GENERATED' as const,
      reason: 'No SP1 proof was requested for this answer; its deterministic computation remains locally reproducible.',
    },
    limitations: [
      'Merkle inclusion establishes membership relative to this CorpusBuild commitment; it does not prove that a source observation is true.',
      'Without an external signature or timestamp anchor, the commitment does not independently establish when the build existed.',
      'The computation digest covers the declared deterministic program, inputs, parameters, and output; free-form interpretation is outside this envelope.',
    ],
  });
}
