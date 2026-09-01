/**
 * OCR candidate intake for Payload Terminal.
 *
 * The OCR Agent owns document perception, not operational truth. This module
 * is the Terminal-side EvidencePool boundary: it accepts only a pending OCR
 * candidate, checks that its warrant survived the crossing, assigns local
 * evidence identities, and stages it for EntityResolution and Validation.
 *
 * Registration is deliberately not a write to the freight book. A rate
 * confirmation that says a carrier is assigned remains a document claim until
 * the host's resolution and validation gates have decided what, if anything,
 * it may change.
 */

import type { ISODateTime } from './types';

export type OcrPerceptionState = 'OBSERVED' | 'EXTRACTED' | 'INFERRED';
export type OcrAbsenceReason =
  | 'NOT_PRESENT'
  | 'NOT_READABLE'
  | 'NOT_EXTRACTED'
  | 'NOT_APPLICABLE'
  | 'UNKNOWN'
  | 'CONFLICTING';

export interface OcrArtifact {
  readonly artifactId: string;
  readonly contentHash: string;
  readonly mimeType: string;
  readonly fileSizeBytes: number;
  readonly receivedAt: ISODateTime;
  readonly source: { readonly system: string; readonly ref?: string };
}

export interface OcrTemporalFrame {
  readonly documentReceivedAt: ISODateTime;
  readonly knownAt: ISODateTime;
  readonly extractedAt: ISODateTime;
}

export interface OcrExtractionMeta {
  readonly modelProvider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly promptVersion: string;
  readonly schemaVersion: string;
  readonly pipelineVersion: string;
  readonly executionKey: string;
  readonly executionId: string;
}

export type OcrObservedValue =
  | { readonly kind: 'value'; readonly raw: string; readonly normalized: unknown; readonly unit?: string }
  | { readonly kind: 'absent'; readonly reason: OcrAbsenceReason; readonly note?: string };

export interface OcrObservation {
  readonly observationId: string;
  readonly field: string;
  readonly value: OcrObservedValue;
  readonly status: OcrPerceptionState;
  readonly sourceReliability: 'unassessed';
  readonly verificationStatus: 'UNVERIFIED';
  readonly location: { readonly artifactId: string };
  readonly temporal: OcrTemporalFrame;
  readonly extraction: OcrExtractionMeta;
}

export interface OcrConflict {
  readonly conflictId: string;
  readonly observationIds: readonly string[];
  readonly relation: 'contradiction' | 'supersession_candidate' | 'under_determined';
  readonly detail: string;
  readonly remedy: string;
}

export interface OcrObservationBundle {
  readonly bundleId: string;
  readonly artifact: OcrArtifact;
  readonly documentType: string;
  readonly observations: readonly OcrObservation[];
  readonly conflicts: readonly OcrConflict[];
  readonly refusals: readonly { readonly code: string; readonly stage: string; readonly detail: string }[];
  readonly extraction: OcrExtractionMeta;
  readonly temporal: OcrTemporalFrame;
}

/** The only OCR Agent shape this host accepts. It is intentionally structural:
 * Terminal depends on the published boundary, never the OCR package runtime. */
export interface OcrCanonicalStateCandidate {
  readonly kind: 'canonical_state_candidate';
  readonly adjudication: 'pending';
  readonly bundle: OcrObservationBundle;
  readonly requiredPath: readonly string[];
}

export type OcrCandidateRefusalCode =
  | 'OCR_CANDIDATE_SHAPE_INVALID'
  | 'OCR_CANDIDATE_WARRANT_INVALID'
  | 'OCR_CANDIDATE_PATH_INVALID';

export interface OcrCandidateRefusal {
  readonly kind: 'refusal';
  readonly code: OcrCandidateRefusalCode;
  readonly detail: string;
  readonly remedy: string;
}

export interface OcrEvidenceReceipt {
  readonly bundleId: string;
  /** Terminal-assigned evidence ids, aligned with bundle.observations. */
  readonly evidenceIds: readonly string[];
  readonly deduplicated: boolean;
  readonly registeredAt: ISODateTime;
}

export type OcrCandidateReviewState =
  | 'awaiting_entity_resolution'
  | 'blocked_by_conflict';

export interface RegisteredOcrCandidate {
  readonly candidate: OcrCanonicalStateCandidate;
  readonly receipt: OcrEvidenceReceipt;
  /** Always false here: this boundary does not mutate the freight book. */
  readonly admittedToOperations: false;
  readonly reviewState: OcrCandidateReviewState;
}

export type OcrRegistrationResult =
  | { readonly kind: 'registered'; readonly value: RegisteredOcrCandidate }
  | OcrCandidateRefusal;

const REQUIRED_PATH = ['EvidencePool', 'EntityResolution', 'Validation'] as const;
const PERCEPTION_STATES: ReadonlySet<string> = new Set(['OBSERVED', 'EXTRACTED', 'INFERRED']);

function refusal(
  code: OcrCandidateRefusalCode,
  detail: string,
  remedy: string,
): OcrCandidateRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function samePath(path: readonly string[]): boolean {
  return path.length === REQUIRED_PATH.length && path.every((step, index) => step === REQUIRED_PATH[index]);
}

function coherent(frame: OcrTemporalFrame): boolean {
  return frame.documentReceivedAt <= frame.knownAt && frame.knownAt <= frame.extractedAt;
}

function candidateDefect(candidate: OcrCanonicalStateCandidate): OcrCandidateRefusal | null {
  if (candidate.kind !== 'canonical_state_candidate' || candidate.adjudication !== 'pending') {
    return refusal(
      'OCR_CANDIDATE_SHAPE_INVALID',
      'OCR intake accepts only a canonical_state_candidate with adjudication pending.',
      'Send the OCR Agent candidate unchanged; adjudication belongs to Payload Terminal.',
    );
  }
  if (!samePath(candidate.requiredPath)) {
    return refusal(
      'OCR_CANDIDATE_PATH_INVALID',
      `OCR candidate path is ${candidate.requiredPath.join(' → ') || '(empty)'}, not ${REQUIRED_PATH.join(' → ')}.`,
      'Route the candidate through EvidencePool, EntityResolution, and Validation in that order.',
    );
  }

  const { bundle } = candidate;
  if (!bundle.bundleId || !bundle.artifact.artifactId || !bundle.artifact.contentHash || !bundle.extraction.executionKey) {
    return refusal(
      'OCR_CANDIDATE_SHAPE_INVALID',
      'OCR candidate is missing a bundle id, artifact identity, content hash, or execution key.',
      'Rebuild the candidate from a complete OCR ObservationBundle.',
    );
  }
  if (!coherent(bundle.temporal)) {
    return refusal(
      'OCR_CANDIDATE_WARRANT_INVALID',
      `Bundle ${bundle.bundleId} has incoherent documentReceivedAt, knownAt, and extractedAt timestamps.`,
      'Correct the OCR temporal frame; do not infer a replacement timestamp in Terminal.',
    );
  }

  const seen = new Set<string>();
  for (const observation of bundle.observations) {
    if (!observation.observationId || !observation.field) {
      return refusal(
        'OCR_CANDIDATE_SHAPE_INVALID',
        `Bundle ${bundle.bundleId} contains an observation without an id or field name.`,
        'Rebuild the OCR bundle so every observation has stable identity and a subject field.',
      );
    }
    if (seen.has(observation.observationId)) {
      return refusal(
        'OCR_CANDIDATE_SHAPE_INVALID',
        `Bundle ${bundle.bundleId} repeats observation id ${observation.observationId}.`,
        'Preserve one observation per deterministic observation identity.',
      );
    }
    seen.add(observation.observationId);
    if (observation.location.artifactId !== bundle.artifact.artifactId) {
      return refusal(
        'OCR_CANDIDATE_WARRANT_INVALID',
        `Observation ${observation.observationId} cites ${observation.location.artifactId}, but the bundle carries ${bundle.artifact.artifactId}.`,
        'Return the observation to OCR; an evidence location must name the artifact that produced it.',
      );
    }
    if (!PERCEPTION_STATES.has(observation.status)) {
      return refusal(
        'OCR_CANDIDATE_WARRANT_INVALID',
        `Observation ${observation.observationId} has non-perception status ${observation.status}.`,
        'Only OBSERVED, EXTRACTED, and INFERRED claims may enter Terminal from OCR.',
      );
    }
    if (observation.sourceReliability !== 'unassessed' || observation.verificationStatus !== 'UNVERIFIED') {
      return refusal(
        'OCR_CANDIDATE_WARRANT_INVALID',
        `Observation ${observation.observationId} claims reliability or verification OCR cannot grant.`,
        'Remove the claimed adjudication and send the candidate through Terminal validation.',
      );
    }
    if (observation.extraction.executionKey !== bundle.extraction.executionKey) {
      return refusal(
        'OCR_CANDIDATE_WARRANT_INVALID',
        `Observation ${observation.observationId} has a different execution key from bundle ${bundle.bundleId}.`,
        'Keep all observations in a bundle bound to the same extraction execution.',
      );
    }
    if (!coherent(observation.temporal)) {
      return refusal(
        'OCR_CANDIDATE_WARRANT_INVALID',
        `Observation ${observation.observationId} has an incoherent temporal frame.`,
        'Correct the OCR observation frame without manufacturing timestamp precision.',
      );
    }
  }
  return null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function evidenceIdFor(observation: OcrObservation): string {
  return `evidence:ocr:${observation.observationId}`;
}

/**
 * Terminal's in-process EvidencePool adapter for OCR candidates.
 *
 * Persistence is intentionally outside this pure module. A database adapter
 * can persist records returned by this class without changing its policy:
 * duplicate `(contentHash, executionKey)` registrations return the original
 * receipt, and no registration can make an operational mutation.
 */
export class OcrCandidateInbox {
  private readonly byExecution = new Map<string, RegisteredOcrCandidate>();

  register(candidate: OcrCanonicalStateCandidate, registeredAt: ISODateTime): OcrRegistrationResult {
    const defect = candidateDefect(candidate);
    if (defect) return defect;

    const key = `${candidate.bundle.artifact.contentHash}|${candidate.bundle.extraction.executionKey}`;
    const existing = this.byExecution.get(key);
    if (existing) {
      return {
        kind: 'registered',
        value: {
          ...existing,
          receipt: { ...existing.receipt, deduplicated: true },
        },
      };
    }

    deepFreeze(candidate);
    const receipt = Object.freeze({
      bundleId: candidate.bundle.bundleId,
      evidenceIds: Object.freeze(candidate.bundle.observations.map(evidenceIdFor)),
      deduplicated: false,
      registeredAt,
    });
    const record = Object.freeze({
      candidate,
      receipt,
      admittedToOperations: false as const,
      reviewState: candidate.bundle.conflicts.length > 0
        ? 'blocked_by_conflict' as const
        : 'awaiting_entity_resolution' as const,
    });
    this.byExecution.set(key, record);
    return { kind: 'registered', value: record };
  }

  pending(): readonly RegisteredOcrCandidate[] {
    return Object.freeze([...this.byExecution.values()]);
  }
}
