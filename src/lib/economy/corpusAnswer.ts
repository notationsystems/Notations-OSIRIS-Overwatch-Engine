/** Proof-carrying metadata for PayloadOS corpus answers. */

import { createHash } from 'node:crypto';
import { stableValue } from './loadOperationsStore';
import { joinCorpusPolicies, type CorpusPolicyLineage } from './corpusPolicy';
import type { CorpusProjectionManifest } from './corpusProjection';
import { corpusEvidenceClosure } from './physicalEconomyCorpus';
import type {
  CorpusEvidenceRecord,
  FacilityDiscoveryResult,
  StoredCorpusRecord,
} from './physicalEconomyCorpus';

type FacilityDiscovery = Extract<FacilityDiscoveryResult, { kind: 'facility_discovery' }>;

export type PublicCorpusBuildReference = {
  readonly corpusBuildId: string;
  readonly projectionId: string;
  readonly projectionDigest: string;
  readonly recordSchemaVersion: string;
  readonly ontologyVersion: string;
  readonly policyVersion: string;
  readonly compilerVersion: string;
  readonly embeddingVersion: string | null;
  readonly generatedAt: string;
};

export type FacilityAnswerWarrant = {
  readonly schema: 'payload.corpus.answer-warrant.v1';
  readonly basis: 'evidence_linked_canonical_records';
  readonly canonicalIdentities: readonly string[];
  readonly knownAt: string;
  readonly evidence: readonly {
    readonly evidenceId: string;
    readonly sourceId: string;
    readonly artifactSha256: string;
    readonly retrievedAt: string;
  }[];
  readonly computation: readonly [{
    readonly operation: 'facility_discovery';
    readonly version: '1.0.0';
    readonly inputDigest: string;
    readonly outputDigest: string;
  }];
  readonly uncertainty: {
    readonly kind: 'reported_confidence';
    readonly facilityCounts: Readonly<Record<'high' | 'medium' | 'low', number>>;
    readonly limitation: string;
  };
  readonly policy: CorpusPolicyLineage;
  readonly corpusBuild: PublicCorpusBuildReference;
  /** V0 compatibility fields; corpusBuild is the durable contract. */
  readonly projectionId: string;
  readonly projectionDigest: string;
  readonly projectionRecordCount: number;
  readonly compilerVersion: string;
  readonly compiledAt: string;
};

export type FacilityAnswerWarrantResult =
  | { readonly kind: 'answer_warrant'; readonly warrant: FacilityAnswerWarrant }
  | { readonly kind: 'refusal'; readonly code: 'CORPUS_OUTPUT_POLICY_DENIED'; readonly detail: string; readonly remedy: string };

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function normalized(value: string): string { return value.normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function frozen<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) frozen((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function publicCorpusBuildReference(manifest: CorpusProjectionManifest): PublicCorpusBuildReference {
  return frozen({
    corpusBuildId: manifest.corpusBuildId,
    projectionId: manifest.projectionId,
    projectionDigest: manifest.projectionDigest,
    recordSchemaVersion: manifest.recordSchemaVersion,
    ontologyVersion: manifest.ontologyVersion,
    policyVersion: manifest.policyVersion,
    compilerVersion: manifest.compilerVersion,
    embeddingVersion: manifest.embeddingVersion,
    generatedAt: manifest.generatedAt,
  });
}

function answerBasis(materialRef: string, result: FacilityDiscovery, records: readonly StoredCorpusRecord[]): readonly StoredCorpusRecord[] {
  const canonicalIds = new Set<string>([
    result.material.entityId,
    ...result.facilities.flatMap(facility => [facility.entityId, ...(facility.operator ? [facility.operator.entityId] : [])]),
  ]);
  const facilityIds = new Set(result.facilities.map(facility => facility.entityId));
  const operatorIds = new Set(result.facilities.flatMap(facility => facility.operator ? [facility.operator.entityId] : []));
  const relationshipIds = new Set(result.facilities.map(facility => facility.relationshipId));
  const initial = records.filter(record => {
    if (record.recordType === 'entity') return canonicalIds.has(record.entityId);
    if (record.recordType === 'alias') return record.entityId === result.material.entityId && normalized(record.value) === normalized(materialRef);
    if (record.recordType === 'relationship') {
      return relationshipIds.has(record.relationshipId)
        || (record.predicate === 'operated_by' && facilityIds.has(record.subjectEntityId) && operatorIds.has(record.objectEntityId));
    }
    return false;
  });
  const evidence = corpusEvidenceClosure(records, initial);
  return [...initial, ...evidence]
    .filter((record, index, all) => all.findIndex(candidate => candidate.recordId === record.recordId) === index)
    .sort((a, b) => a.sequence - b.sequence);
}

export function buildFacilityAnswerWarrant(
  materialRef: string,
  result: FacilityDiscovery,
  records: readonly StoredCorpusRecord[],
  manifest: CorpusProjectionManifest,
): FacilityAnswerWarrantResult {
  const basis = answerBasis(materialRef, result, records);
  const joined = joinCorpusPolicies(basis);
  if (joined.kind === 'refusal' || joined.lineage.effective.externalRelease !== 'PERMITTED') {
    const detail = joined.kind === 'refusal'
      ? `${joined.code}: ${joined.detail}`
      : `Effective policy ${joined.lineage.lineageId} prohibits external release.`;
    return frozen({
      kind: 'refusal' as const,
      code: 'CORPUS_OUTPUT_POLICY_DENIED' as const,
      detail,
      remedy: 'Use only inputs whose joined derivation and redistribution policies permit this API response, or keep the computation on an authorized internal surface.',
    });
  }
  const evidence = basis
    .filter((record): record is StoredCorpusRecord & CorpusEvidenceRecord => record.recordType === 'evidence')
    .map(record => ({ evidenceId: record.evidenceId, sourceId: record.sourceId, artifactSha256: record.artifactSha256, retrievedAt: record.retrievedAt }));
  const identities = [...new Set([
    result.material.entityId,
    ...result.facilities.flatMap(facility => [facility.entityId, ...(facility.operator ? [facility.operator.entityId] : [])]),
  ])].sort();
  const confidence = { high: 0, medium: 0, low: 0 };
  for (const facility of result.facilities) confidence[facility.confidence] += 1;
  const inputDigest = digest({
    materialRef,
    asOf: result.asOf,
    knowledgeCutoff: result.knowledgeCutoff,
    records: basis.map(record => ({ recordId: record.recordId, recordHash: record.recordHash })),
  });
  const outputDigest = digest(result);
  const knownAt = basis.reduce((latest, record) => Date.parse(record.knownAt) > Date.parse(latest) ? record.knownAt : latest, basis[0]?.knownAt ?? result.knowledgeCutoff);
  const corpusBuild = publicCorpusBuildReference(manifest);
  return frozen({
    kind: 'answer_warrant' as const,
    warrant: {
      schema: 'payload.corpus.answer-warrant.v1' as const,
      basis: 'evidence_linked_canonical_records' as const,
      canonicalIdentities: identities,
      knownAt,
      evidence,
      computation: [{ operation: 'facility_discovery' as const, version: '1.0.0' as const, inputDigest, outputDigest }],
      uncertainty: {
        kind: 'reported_confidence' as const,
        facilityCounts: confidence,
        limitation: 'Confidence labels are evidence assessments, not calibrated probabilities; absence from this result is not evidence of non-existence.',
      },
      policy: joined.lineage,
      corpusBuild,
      projectionId: manifest.projectionId,
      projectionDigest: manifest.projectionDigest,
      projectionRecordCount: manifest.recordCount,
      compilerVersion: manifest.compilerVersion,
      compiledAt: manifest.compiledAt,
    },
  });
}
