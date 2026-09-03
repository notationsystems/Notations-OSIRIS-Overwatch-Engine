import { describe, expect, it } from 'vitest';
import {
  OcrCandidateInbox,
  type OcrCanonicalStateCandidate,
  type OcrObservation,
  type RegisteredOcrCandidate,
} from './ocrCandidateInbox';
import { projectRateConfirmation } from './ocrFreightReview';

const receivedAt = '2026-08-31T10:15:00.000Z';
const extractedAt = '2026-08-31T14:32:00.000Z';
const registeredAt = '2026-08-31T14:33:00.000Z';
const extraction = {
  modelProvider: 'fixture', model: 'fixture-ocr', modelVersion: 'fixture-1',
  promptVersion: 'extract_rate_confirmation.v1', schemaVersion: 'rate_confirmation.v1',
  pipelineVersion: 'payload-ocr-pipeline.v1', executionKey: 'execution:ratecon', executionId: 'run:1',
};
const temporal = { documentReceivedAt: receivedAt, knownAt: receivedAt, extractedAt };

function observation(field: string, normalized: unknown, raw = String(normalized), unit?: string): OcrObservation {
  return {
    observationId: `obs:${field.replace(/\//g, ':')}`,
    field,
    value: { kind: 'value', raw, normalized, ...(unit !== undefined ? { unit } : {}) },
    status: 'EXTRACTED', sourceReliability: 'unassessed', verificationStatus: 'UNVERIFIED',
    location: { artifactId: 'art:ratecon' }, temporal, extraction,
  };
}

function sourceCandidate(observations: readonly OcrObservation[], overrides: {
  documentType?: string;
  conflicts?: OcrCanonicalStateCandidate['bundle']['conflicts'];
} = {}): OcrCanonicalStateCandidate {
  return {
    kind: 'canonical_state_candidate', adjudication: 'pending',
    requiredPath: ['EvidencePool', 'EntityResolution', 'Validation'],
    bundle: {
      bundleId: 'bnd:ratecon',
      artifact: {
        artifactId: 'art:ratecon', contentHash: 'f'.repeat(64), mimeType: 'application/pdf',
        fileSizeBytes: 20, receivedAt, source: { system: 'test' },
      },
      documentType: overrides.documentType ?? 'RATE_CONFIRMATION',
      observations,
      conflicts: overrides.conflicts ?? [], refusals: [], extraction, temporal,
    },
  };
}

const requiredObservations = (): OcrObservation[] => [
  observation('rate_confirmation/shipment_reference', '48192'),
  observation('rate_confirmation/carrier/name', 'ABC Logistics'),
  observation('rate_confirmation/origin/city', 'Brampton'),
  observation('rate_confirmation/destination/city', 'Detroit'),
  observation('rate_confirmation/pickup_date', { iso: '2026-09-03', precision: 'day', zone: 'unstated' }, 'Sep 3'),
  observation('rate_confirmation/delivery_date', { iso: '2026-09-04', precision: 'day', zone: 'unstated' }, 'Sep 4'),
  observation('rate_confirmation/equipment', "53' Dry Van"),
  observation('rate_confirmation/total_rate', 1850, '$1,850.00 USD', 'USD'),
];

function register(candidate: OcrCanonicalStateCandidate): RegisteredOcrCandidate {
  const result = new OcrCandidateInbox().register(candidate, registeredAt);
  if (result.kind !== 'registered') throw new Error(`${result.code}: ${result.detail}`);
  return result.value;
}

describe('OCR rate-confirmation review projection', () => {
  it('renders a brokerage-ready proposal with field-level evidence and no operational admission', () => {
    const result = projectRateConfirmation(register(sourceCandidate(requiredObservations())));
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') return;
    expect(result.value.reviewState).toBe('ready_for_entity_resolution');
    expect(result.value.admittedToOperations).toBe(false);
    expect(result.value.fields.totalRate).toMatchObject({
      state: 'candidate', raw: '$1,850.00 USD', normalized: 1850, unit: 'USD',
      evidenceId: 'evidence:ocr:obs:rate_confirmation:total_rate', verificationStatus: 'UNVERIFIED',
    });
  });

  it('names every missing required field instead of inventing completeness', () => {
    const onlyReference = [observation('rate_confirmation/shipment_reference', '48192')];
    const result = projectRateConfirmation(register(sourceCandidate(onlyReference)));
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') return;
    expect(result.value.reviewState).toBe('blocked_by_required_field');
    expect(result.value.blockedOn).toEqual([
      'carrierName', 'originCity', 'destinationCity', 'pickupDate',
      'deliveryDate', 'equipment', 'totalRate',
    ]);
    expect(result.value.fields.totalRate.state).toBe('missing');
  });

  it('keeps duplicate readings contested and chooses neither', () => {
    const observations = requiredObservations();
    observations.push({
      ...observation('rate_confirmation/total_rate', 1950, '$1,950.00 USD', 'USD'),
      observationId: 'obs:rate_confirmation:total_rate:second',
    });
    const result = projectRateConfirmation(register(sourceCandidate(observations)));
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') return;
    expect(result.value.reviewState).toBe('blocked_by_document_conflict');
    expect(result.value.fields.totalRate).toMatchObject({
      state: 'contested',
      observationIds: ['obs:rate_confirmation:total_rate', 'obs:rate_confirmation:total_rate:second'],
    });
  });

  it('honours an OCR conflict record without resolving it by confidence or recency', () => {
    const observations = requiredObservations();
    const result = projectRateConfirmation(register(sourceCandidate(observations, {
      conflicts: [{
        conflictId: 'conflict:rate', relation: 'contradiction',
        observationIds: [observations[0].observationId, observations[7].observationId],
        detail: 'Document readings conflict.', remedy: 'Review the source.',
      }],
    })));
    expect(result.kind).toBe('review');
    if (result.kind !== 'review') return;
    expect(result.value.reviewState).toBe('blocked_by_document_conflict');
    expect(result.value.admittedToOperations).toBe(false);
  });

  it('refuses a different document schema rather than coercing it into a rate confirmation', () => {
    const result = projectRateConfirmation(register(sourceCandidate([], { documentType: 'INVOICE' })));
    expect(result).toMatchObject({ kind: 'refusal', code: 'OCR_DOCUMENT_TYPE_UNSUPPORTED' });
  });
});
