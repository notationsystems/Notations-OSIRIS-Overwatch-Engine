import { describe, expect, it } from 'vitest';
import { OcrCandidateInbox, type OcrCanonicalStateCandidate } from './ocrCandidateInbox';

const at = '2026-08-31T12:00:00.000Z';
const later = '2026-08-31T12:05:00.000Z';

function candidate(overrides: Partial<OcrCanonicalStateCandidate> = {}): OcrCanonicalStateCandidate {
  const extraction = {
    modelProvider: 'fixture', model: 'fixture-ocr', modelVersion: 'fixture-1',
    promptVersion: 'rate_confirmation.v1', schemaVersion: 'rate_confirmation.v1',
    pipelineVersion: 'pipeline.v1', executionKey: 'execution:abc', executionId: 'run:1',
  };
  return {
    kind: 'canonical_state_candidate',
    adjudication: 'pending',
    requiredPath: ['EvidencePool', 'EntityResolution', 'Validation'],
    bundle: {
      bundleId: 'bundle:1',
      artifact: {
        artifactId: 'artifact:1', contentHash: 'a'.repeat(64), mimeType: 'application/pdf',
        fileSizeBytes: 12, receivedAt: at, source: { system: 'test' },
      },
      documentType: 'RATE_CONFIRMATION',
      observations: [{
        observationId: 'observation:rate', field: 'rate_confirmation/total_rate',
        value: { kind: 'value', raw: '$1,850.00', normalized: 1850, unit: 'USD' },
        status: 'EXTRACTED', sourceReliability: 'unassessed', verificationStatus: 'UNVERIFIED',
        location: { artifactId: 'artifact:1' },
        temporal: { documentReceivedAt: at, knownAt: at, extractedAt: later }, extraction,
      }],
      conflicts: [], refusals: [], extraction,
      temporal: { documentReceivedAt: at, knownAt: at, extractedAt: later },
    },
    ...overrides,
  };
}

describe('OCR candidate inbox', () => {
  it('assigns evidence ids while keeping a warrant-complete candidate out of operations', () => {
    const inbox = new OcrCandidateInbox();
    const result = inbox.register(candidate(), later);
    expect(result.kind).toBe('registered');
    if (result.kind !== 'registered') return;
    expect(result.value.receipt.evidenceIds).toEqual(['evidence:ocr:observation:rate']);
    expect(result.value.admittedToOperations).toBe(false);
    expect(result.value.reviewState).toBe('awaiting_entity_resolution');
  });

  it('is idempotent under the OCR artifact and execution identity', () => {
    const inbox = new OcrCandidateInbox();
    inbox.register(candidate(), later);
    const again = inbox.register(candidate(), '2026-08-31T13:00:00.000Z');
    expect(again.kind).toBe('registered');
    if (again.kind !== 'registered') return;
    expect(again.value.receipt.deduplicated).toBe(true);
    expect(again.value.receipt.registeredAt).toBe(later);
    expect(inbox.pending()).toHaveLength(1);
  });

  it('rejects a candidate that skips the required adjudication path', () => {
    const inbox = new OcrCandidateInbox();
    const result = inbox.register(candidate({ requiredPath: ['EvidencePool', 'Validation'] }), later);
    expect(result).toMatchObject({ kind: 'refusal', code: 'OCR_CANDIDATE_PATH_INVALID' });
  });

  it('rejects an observation whose warrant names a different artifact', () => {
    const inbox = new OcrCandidateInbox();
    const bad = candidate();
    const first = bad.bundle.observations[0];
    const observation = { ...first, location: { artifactId: 'artifact:other' } };
    const result = inbox.register({ ...bad, bundle: { ...bad.bundle, observations: [observation] } }, later);
    expect(result).toMatchObject({ kind: 'refusal', code: 'OCR_CANDIDATE_WARRANT_INVALID' });
  });

  it('stages conflicting documents for review without choosing a winner', () => {
    const inbox = new OcrCandidateInbox();
    const base = candidate();
    const second = {
      ...base.bundle.observations[0],
      observationId: 'observation:rate:second',
      value: { kind: 'value' as const, raw: '$1,950.00', normalized: 1950, unit: 'USD' },
    };
    const result = inbox.register({
      ...base,
      bundle: {
        ...base.bundle,
        observations: [...base.bundle.observations, second],
        conflicts: [{
          conflictId: 'conflict:1', observationIds: ['observation:rate', 'observation:rate:second'], relation: 'contradiction',
          detail: 'Two rates disagree.', remedy: 'Review both source documents.',
        }],
      },
    }, later);
    expect(result.kind).toBe('registered');
    if (result.kind !== 'registered') return;
    expect(result.value.reviewState).toBe('blocked_by_conflict');
    expect(result.value.candidate.bundle.conflicts[0].relation).toBe('contradiction');
  });

  it('seals a registered candidate so later code cannot alter the evidence', () => {
    const inbox = new OcrCandidateInbox();
    const input = candidate();
    inbox.register(input, later);
    expect(() => { (input.bundle as { documentType: string }).documentType = 'INVOICE'; }).toThrow();
  });
});
