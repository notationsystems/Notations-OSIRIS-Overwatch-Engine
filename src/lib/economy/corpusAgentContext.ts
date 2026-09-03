/** Agent-native projections of an evidence-complete Payload ContextPackage. */

import type { CompiledCorpusProjection } from './corpusProjection';
import type { CorpusContextPackage, CorpusRetrievalPlan } from './corpusRetrieval';
import type {
  CorpusAssertionEvidenceRole,
  CorpusConfidence,
  CorpusEvidenceLocator,
  CorpusValueKind,
  StoredCorpusRecord,
} from './physicalEconomyCorpus';
import {
  buildVerificationEnvelope,
  corpusVerificationDigest,
  verifyCorpusRecordInclusion,
  type VerificationEnvelope,
  type VerificationLevel,
} from './corpusVerification';
import { buildCorpusWarrantGraph, markCorpusWarrantGraphAttested, type CorpusWarrantGraph } from './corpusWarrantGraph';
import { applyBuildAttestation, type CorpusBuildAttestation } from './corpusBuildAttestation';

export const CORPUS_EVIDENCE_LEVELS = Object.freeze(['FAST', 'GROUNDED', 'AUDIT', 'VERIFIED'] as const);
export type CorpusEvidenceLevel = typeof CORPUS_EVIDENCE_LEVELS[number];
export type NotationEpistemicClass = 'DECLARED' | 'REPORTED' | 'ESTIMATED' | 'DERIVED' | 'MIXED';

export type NotationAssertion = {
  readonly schema: 'notation.assertion.v1';
  readonly assertionId: string;
  readonly subject: { readonly canonicalId: string };
  readonly predicate: string;
  readonly value: number | string | boolean | Readonly<Record<string, unknown>>;
  readonly unit?: string;
  readonly epistemicClass: NotationEpistemicClass;
  readonly confidence: {
    readonly kind: 'LABEL';
    readonly value: CorpusConfidence;
    readonly calibratedProbability: false;
  };
  readonly uncertainty: {
    readonly status: 'SUPPORTED' | 'CONFLICTING' | 'INCOMPLETE';
    readonly contradictionObservationIds: readonly string[];
    readonly missingEvidenceRefs: readonly string[];
    readonly limitation: string;
  };
  readonly validTime: { readonly from: string; readonly to?: string };
  readonly knownAt: string;
  readonly provenance: {
    readonly assertionRecordId: string;
    readonly observations: readonly {
      readonly observationId: string;
      readonly recordId: string | null;
      readonly role: CorpusAssertionEvidenceRole;
      readonly valueKind: CorpusValueKind | null;
    }[];
    readonly evidenceIds: readonly string[];
    readonly sourceIds: readonly string[];
    readonly corpusBuildId: string;
    readonly contextId: string;
  };
  readonly verification: {
    readonly level: 'PROVENANCE';
    readonly sourceTruthClaimed: false;
  };
};

export type CorpusAgentContext = {
  readonly schema: 'notation.agent-context.v1';
  readonly agentContextId: string;
  readonly evidenceBudget: {
    readonly requestedLevel: CorpusEvidenceLevel;
    readonly includedSections: readonly string[];
    readonly omittedSections: readonly string[];
    readonly assuranceAvailable: VerificationLevel;
    readonly sourceTruthClaimed: false;
  };
  readonly query: CorpusContextPackage['query'];
  readonly corpus: {
    readonly corpusEngineId: string;
    readonly corpusEngineVersion: string;
    readonly productId: string;
    readonly corpusDefinitionId: string;
    readonly corpusBuildId: string;
    readonly ontologyVersion: string;
    readonly projectionId: string;
    readonly projectionDigest: string;
  };
  readonly entities: readonly {
    readonly recordId: string;
    readonly canonicalId: string;
    readonly kind: string;
    readonly name: string;
    readonly knownAt: string;
    readonly evidenceIds: readonly string[];
    readonly countryCode?: string;
    readonly location?: { readonly lat: number; readonly lng: number; readonly precision: string };
  }[];
  readonly relationships: readonly {
    readonly recordId: string;
    readonly relationshipId: string;
    readonly subject: string;
    readonly predicate: string;
    readonly object: string;
    readonly validTime: { readonly from?: string; readonly to?: string };
    readonly knownAt: string;
    readonly epistemicClass: 'REPORTED' | 'ESTIMATED' | 'DERIVED';
    readonly confidence: { readonly kind: 'LABEL'; readonly value: CorpusConfidence; readonly calibratedProbability: false };
    readonly evidenceIds: readonly string[];
  }[];
  readonly assertions: readonly NotationAssertion[];
  readonly inspection: {
    readonly operations: readonly {
      readonly operation: 'get_provenance' | 'get_evidence';
      readonly subjectId: string;
      readonly method: 'GET';
      readonly path: string;
    }[];
  };
  readonly evidence?: {
    readonly artifacts: CorpusContextPackage['artifacts'];
  };
  readonly audit?: {
    readonly observations: readonly {
      readonly recordId: string;
      readonly observationId: string;
      readonly subject: string;
      readonly metric: string;
      readonly value: number | string | boolean;
      readonly unit?: string;
      readonly basis?: string;
      readonly valueKind: CorpusValueKind;
      readonly epistemicClass: 'REPORTED' | 'ESTIMATED' | 'DERIVED';
      readonly confidence: { readonly kind: 'LABEL'; readonly value: CorpusConfidence; readonly calibratedProbability: false };
      readonly validTime: { readonly from?: string; readonly to?: string };
      readonly knownAt: string;
      readonly evidenceIds: readonly string[];
    }[];
    readonly evidenceUnits: readonly {
      readonly recordId: string;
      readonly evidenceUnitId: string;
      readonly artifactEvidenceId: string;
      readonly modality: string;
      readonly locator: CorpusEvidenceLocator;
      readonly extraction: {
        readonly kind: string;
        readonly version: string;
        readonly adapter?: string;
        readonly model?: string;
        readonly confidence?: { readonly kind: 'EXTRACTOR_SCORE'; readonly value: number; readonly calibratedProbability: false };
      };
      readonly contentSha256: string;
      readonly extractedText?: string;
    }[];
    readonly contradictions: CorpusContextPackage['contradictions'];
    readonly missingEvidence: CorpusContextPackage['missingEvidence'];
    readonly retrievalTrace: CorpusContextPackage['retrievalTrace'];
  };
  readonly proof?: {
    readonly envelope: VerificationEnvelope;
    readonly warrantGraph: CorpusWarrantGraph;
    readonly membershipProofsVerified: true;
    readonly buildAttestation?: CorpusBuildAttestation;
  };
};

export class CorpusAgentContextError extends Error {
  constructor(readonly code: 'CORPUS_EVIDENCE_LEVEL_INVALID' | 'CORPUS_AGENT_CONTEXT_INVALID', message: string) {
    super(message);
    this.name = 'CorpusAgentContextError';
  }
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function atLeast(level: CorpusEvidenceLevel, required: CorpusEvidenceLevel): boolean {
  return CORPUS_EVIDENCE_LEVELS.indexOf(level) >= CORPUS_EVIDENCE_LEVELS.indexOf(required);
}

function valueEpistemicClass(valueKind: CorpusValueKind): 'REPORTED' | 'ESTIMATED' | 'DERIVED' {
  return valueKind.toUpperCase() as 'REPORTED' | 'ESTIMATED' | 'DERIVED';
}

export function parseCorpusEvidenceLevel(value: unknown): CorpusEvidenceLevel {
  if (value === undefined) return 'GROUNDED';
  if (typeof value !== 'string' || !CORPUS_EVIDENCE_LEVELS.includes(value as CorpusEvidenceLevel)) {
    throw new CorpusAgentContextError('CORPUS_EVIDENCE_LEVEL_INVALID', 'evidenceLevel must be FAST, GROUNDED, AUDIT, or VERIFIED.');
  }
  return value as CorpusEvidenceLevel;
}

function assertionEpistemicClass(valueKinds: readonly CorpusValueKind[]): NotationEpistemicClass {
  const classes = unique(valueKinds.map(valueEpistemicClass));
  if (classes.length === 0) return 'DECLARED';
  return classes.length === 1 ? classes[0] as NotationEpistemicClass : 'MIXED';
}

function notationAssertions(context: CorpusContextPackage): readonly NotationAssertion[] {
  const observations = new Map(context.observations.map(observation => [observation.observationId, observation]));
  const evidenceUnits = new Map(context.evidenceUnits.map(unit => [unit.evidenceUnitId, unit]));
  const artifacts = new Map(context.artifacts.map(artifact => [artifact.evidenceId, artifact]));
  return context.assertions.map(assertion => {
    const linked = assertion.evidence.map(link => ({ link, observation: observations.get(link.observationId) }));
    const supportBasis = linked.some(item => item.link.role === 'supports')
      ? linked.filter(item => item.link.role === 'supports')
      : linked;
    const evidenceIds = unique(linked.flatMap(item => item.observation?.evidenceIds ?? []));
    const artifactIds = unique(evidenceIds.flatMap(evidenceId => {
      const unit = evidenceUnits.get(evidenceId);
      return unit ? [unit.artifactEvidenceId] : artifacts.has(evidenceId) ? [evidenceId] : [];
    }));
    const sourceIds = unique(artifactIds.flatMap(evidenceId => artifacts.get(evidenceId)?.sourceId ? [artifacts.get(evidenceId)!.sourceId] : []));
    const contradictionObservationIds = unique(assertion.evidence.filter(link => link.role === 'contradicts').map(link => link.observationId));
    const missingEvidenceRefs = unique(context.missingEvidence.filter(item => item.recordId === assertion.recordId || assertion.evidence.some(link => link.observationId === item.missingReferenceId)).map(item => item.missingReferenceId));
    const status = missingEvidenceRefs.length ? 'INCOMPLETE' as const : contradictionObservationIds.length ? 'CONFLICTING' as const : 'SUPPORTED' as const;
    return freeze({
      schema: 'notation.assertion.v1' as const,
      assertionId: assertion.assertionId,
      subject: { canonicalId: assertion.entityId },
      predicate: assertion.propertyKey,
      value: assertion.selectedValue,
      ...(assertion.unit ? { unit: assertion.unit } : {}),
      epistemicClass: assertionEpistemicClass(supportBasis.flatMap(item => item.observation ? [item.observation.valueKind] : [])),
      confidence: { kind: 'LABEL' as const, value: assertion.confidence, calibratedProbability: false as const },
      uncertainty: {
        status,
        contradictionObservationIds,
        missingEvidenceRefs,
        limitation: 'Confidence is a source-review label, not a calibrated probability; the selected value does not erase contradictory observations.',
      },
      validTime: { from: assertion.validFrom, ...(assertion.validTo ? { to: assertion.validTo } : {}) },
      knownAt: assertion.knownAt,
      provenance: {
        assertionRecordId: assertion.recordId,
        observations: assertion.evidence.map(link => {
          const observation = observations.get(link.observationId);
          return { observationId: link.observationId, recordId: observation?.recordId ?? null, role: link.role, valueKind: observation?.valueKind ?? null };
        }),
        evidenceIds,
        sourceIds,
        corpusBuildId: context.retrievalTrace.corpusBuildId,
        contextId: context.contextId,
      },
      verification: { level: 'PROVENANCE' as const, sourceTruthClaimed: false as const },
    });
  });
}

function contextBasisRecords(projection: CompiledCorpusProjection, context: CorpusContextPackage): readonly StoredCorpusRecord[] {
  const ids = new Set([
    ...context.entities.map(record => record.recordId),
    ...context.relationships.map(record => record.recordId),
    ...context.assertions.map(record => record.recordId),
    ...context.observations.map(record => record.recordId),
    ...context.evidenceUnits.map(record => record.recordId),
    ...context.artifacts.map(record => record.recordId),
  ]);
  return projection.records.filter(record => ids.has(record.recordId)).sort((left, right) => left.sequence - right.sequence);
}

function inspectionOperations(context: CorpusContextPackage): CorpusAgentContext['inspection']['operations'] {
  const assertions = context.assertions.map(assertion => ({
    operation: 'get_provenance' as const,
    subjectId: assertion.assertionId,
    method: 'GET' as const,
    path: `/api/corpus/warrants?recordId=${encodeURIComponent(assertion.recordId)}`,
  }));
  const evidence = [...context.evidenceUnits, ...context.artifacts].map(item => ({
    operation: 'get_evidence' as const,
    subjectId: 'evidenceUnitId' in item ? item.evidenceUnitId : item.evidenceId,
    method: 'GET' as const,
    path: `/api/corpus/warrants?recordId=${encodeURIComponent(item.recordId)}`,
  }));
  return [...assertions, ...evidence];
}

export function compileCorpusAgentContext(
  projection: CompiledCorpusProjection,
  plan: CorpusRetrievalPlan,
  context: CorpusContextPackage,
  evidenceLevel: CorpusEvidenceLevel,
): CorpusAgentContext {
  if (plan.planId !== context.retrievalTrace.planId || plan.corpusBuildId !== projection.manifest.corpusBuildId || context.retrievalTrace.corpusBuildId !== projection.manifest.corpusBuildId) {
    throw new CorpusAgentContextError('CORPUS_AGENT_CONTEXT_INVALID', 'Plan, ContextPackage, and projection do not identify the same CorpusBuild.');
  }
  const includeEvidence = atLeast(evidenceLevel, 'GROUNDED');
  const includeAudit = atLeast(evidenceLevel, 'AUDIT');
  const includeProof = atLeast(evidenceLevel, 'VERIFIED');
  const includedSections = ['canonical_state', 'assertion_provenance_ids', 'inspection_operations'];
  if (includeEvidence) includedSections.push('evidence_references');
  if (includeAudit) includedSections.push('observations', 'contradictions', 'evidence_units', 'retrieval_trace', 'missing_evidence');
  if (includeProof) includedSections.push('verification_envelope', 'merkle_inclusion_proofs', 'warrant_graph');
  const allSections = ['canonical_state', 'assertion_provenance_ids', 'inspection_operations', 'evidence_references', 'observations', 'contradictions', 'evidence_units', 'retrieval_trace', 'missing_evidence', 'verification_envelope', 'merkle_inclusion_proofs', 'warrant_graph'];
  const core = {
    schema: 'notation.agent-context.v1' as const,
    evidenceBudget: {
      requestedLevel: evidenceLevel,
      includedSections: freeze(includedSections),
      omittedSections: freeze(allSections.filter(section => !includedSections.includes(section))),
      assuranceAvailable: includeAudit ? 'REPRODUCIBLE' as const : 'PROVENANCE' as const,
      sourceTruthClaimed: false as const,
    },
    query: context.query,
    corpus: {
      corpusEngineId: projection.manifest.corpusEngineId,
      corpusEngineVersion: projection.manifest.corpusEngineVersion,
      productId: projection.manifest.productId,
      corpusDefinitionId: projection.manifest.corpusDefinitionId,
      corpusBuildId: projection.manifest.corpusBuildId,
      ontologyVersion: projection.manifest.ontologyVersion,
      projectionId: projection.manifest.projectionId,
      projectionDigest: projection.manifest.projectionDigest,
    },
    entities: context.entities.map(record => ({
      recordId: record.recordId, canonicalId: record.entityId, kind: record.entityKind,
      name: record.canonicalName, knownAt: record.knownAt, evidenceIds: unique(record.evidenceIds),
      ...(record.countryCode ? { countryCode: record.countryCode } : {}),
      ...(record.location ? { location: record.location } : {}),
    })),
    relationships: context.relationships.map(record => ({
      recordId: record.recordId, relationshipId: record.relationshipId,
      subject: record.subjectEntityId, predicate: record.predicate, object: record.objectEntityId,
      validTime: { ...(record.validFrom ? { from: record.validFrom } : {}), ...(record.validTo ? { to: record.validTo } : {}) },
      knownAt: record.knownAt, epistemicClass: valueEpistemicClass(record.valueKind),
      confidence: { kind: 'LABEL' as const, value: record.confidence, calibratedProbability: false as const },
      evidenceIds: unique(record.evidenceIds),
    })),
    assertions: notationAssertions(context),
    inspection: { operations: inspectionOperations(context) },
    ...(includeEvidence ? { evidence: { artifacts: context.artifacts } } : {}),
    ...(includeAudit ? { audit: {
      observations: context.observations.map(record => ({
        recordId: record.recordId, observationId: record.observationId, subject: record.entityId,
        metric: record.metric, value: record.value, ...(record.unit ? { unit: record.unit } : {}),
        ...(record.basis ? { basis: record.basis } : {}), valueKind: record.valueKind,
        epistemicClass: valueEpistemicClass(record.valueKind),
        confidence: { kind: 'LABEL' as const, value: record.confidence, calibratedProbability: false as const },
        validTime: { ...(record.validFrom ? { from: record.validFrom } : {}), ...(record.validTo ? { to: record.validTo } : {}) },
        knownAt: record.knownAt, evidenceIds: unique(record.evidenceIds),
      })),
      evidenceUnits: context.evidenceUnits.map(record => ({
        recordId: record.recordId, evidenceUnitId: record.evidenceUnitId,
        artifactEvidenceId: record.artifactEvidenceId, modality: record.modality,
        locator: record.locator,
        extraction: {
          kind: record.extraction.kind, version: record.extraction.version,
          ...(record.extraction.adapter ? { adapter: record.extraction.adapter } : {}),
          ...(record.extraction.model ? { model: record.extraction.model } : {}),
          ...(record.extraction.confidence !== undefined ? { confidence: { kind: 'EXTRACTOR_SCORE' as const, value: record.extraction.confidence, calibratedProbability: false as const } } : {}),
        },
        contentSha256: record.contentSha256,
        ...(record.extractedText ? { extractedText: record.extractedText } : {}),
      })),
      contradictions: context.contradictions,
      missingEvidence: context.missingEvidence,
      retrievalTrace: context.retrievalTrace,
    } } : {}),
  };
  const outputDigest = corpusVerificationDigest(core);
  const agentContextId = `agent-context:${outputDigest}`;
  if (!includeProof) return freeze({ ...core, agentContextId });
  const basisRecords = contextBasisRecords(projection, context);
  const envelope = buildVerificationEnvelope({
    manifest: projection.manifest,
    projectionRecords: projection.records,
    basisRecords,
    programId: 'notation:agent-context-compiler',
    algorithmVersion: '1.0.0',
    inputDigest: corpusVerificationDigest({ planId: plan.planId, contextId: context.contextId, evidenceLevel }),
    outputDigest,
    parameters: { evidenceLevel },
  });
  if (!envelope.inclusionProofs.every(proof => verifyCorpusRecordInclusion(envelope.commitment, proof))) {
    throw new CorpusAgentContextError('CORPUS_AGENT_CONTEXT_INVALID', 'Generated corpus membership proof did not verify.');
  }
  const warrantGraph = buildCorpusWarrantGraph({
    statement: `Agent context: ${plan.query}`,
    basisRecords,
    manifest: projection.manifest,
    verification: envelope,
  });
  return freeze({
    ...core,
    agentContextId,
    evidenceBudget: { ...core.evidenceBudget, assuranceAvailable: envelope.verificationLevel },
    proof: { envelope, warrantGraph, membershipProofsVerified: true as const },
  });
}

/** Elevate only a VERIFIED context whose exact build commitment was signed. */
export function attestCorpusAgentContext(
  context: CorpusAgentContext,
  attestation: CorpusBuildAttestation,
): CorpusAgentContext {
  if (!context.proof) throw new CorpusAgentContextError('CORPUS_AGENT_CONTEXT_INVALID', 'Only a VERIFIED context carries the build commitment required for attestation.');
  const envelope = applyBuildAttestation(context.proof.envelope, attestation);
  return freeze({
    ...context,
    evidenceBudget: { ...context.evidenceBudget, assuranceAvailable: envelope.verificationLevel },
    proof: {
      ...context.proof,
      envelope,
      warrantGraph: markCorpusWarrantGraphAttested(context.proof.warrantGraph, envelope.commitment.commitmentId, attestation.attestationId),
      buildAttestation: attestation,
    },
  });
}
