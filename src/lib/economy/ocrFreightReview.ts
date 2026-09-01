/**
 * Operator review projection for OCR-extracted rate confirmations.
 *
 * This is a view over registered evidence, not a freight-book constructor.
 * It gives an operator the smallest useful brokerage surface — parties, lane,
 * timing, equipment, weight and rate — while retaining the evidence identity
 * behind every cell. Missing, absent and duplicated readings remain different
 * states, and no branch here admits anything to operations.
 */

import type {
  OcrAbsenceReason,
  OcrObservation,
  RegisteredOcrCandidate,
} from './ocrCandidateInbox';

export const RATE_CONFIRMATION_REVIEW_FIELDS = {
  shipmentReference: 'rate_confirmation/shipment_reference',
  loadReference: 'rate_confirmation/load_reference',
  shipperName: 'rate_confirmation/shipper/name',
  consigneeName: 'rate_confirmation/consignee/name',
  carrierName: 'rate_confirmation/carrier/name',
  originCity: 'rate_confirmation/origin/city',
  destinationCity: 'rate_confirmation/destination/city',
  pickupDate: 'rate_confirmation/pickup_date',
  deliveryDate: 'rate_confirmation/delivery_date',
  equipment: 'rate_confirmation/equipment',
  commodity: 'rate_confirmation/commodity',
  weight: 'rate_confirmation/weight',
  pieces: 'rate_confirmation/pieces',
  miles: 'rate_confirmation/miles',
  linehaul: 'rate_confirmation/linehaul',
  fuel: 'rate_confirmation/fuel',
  totalRate: 'rate_confirmation/total_rate',
} as const;

export type RateConfirmationReviewFieldName = keyof typeof RATE_CONFIRMATION_REVIEW_FIELDS;

export type FreightReviewField =
  | {
      readonly state: 'candidate';
      readonly observationId: string;
      readonly evidenceId: string;
      readonly raw: string;
      readonly normalized: unknown;
      readonly unit?: string;
      readonly verificationStatus: 'UNVERIFIED';
    }
  | {
      readonly state: 'absent';
      readonly observationId: string;
      readonly evidenceId: string;
      readonly reason: OcrAbsenceReason;
      readonly note?: string;
    }
  | {
      readonly state: 'missing';
      readonly field: string;
      readonly remedy: string;
    }
  | {
      readonly state: 'contested';
      readonly field: string;
      readonly observationIds: readonly string[];
      readonly evidenceIds: readonly string[];
      readonly remedy: string;
    };

export type RateConfirmationReviewState =
  | 'ready_for_entity_resolution'
  | 'blocked_by_required_field'
  | 'blocked_by_document_conflict';

export interface RateConfirmationReview {
  readonly bundleId: string;
  readonly artifactId: string;
  readonly documentType: 'RATE_CONFIRMATION';
  readonly fields: Readonly<Record<RateConfirmationReviewFieldName, FreightReviewField>>;
  readonly reviewState: RateConfirmationReviewState;
  readonly blockedOn: readonly RateConfirmationReviewFieldName[];
  /** The projection is evidence for a decision, never the decision itself. */
  readonly admittedToOperations: false;
}

export interface FreightReviewRefusal {
  readonly kind: 'refusal';
  readonly code: 'OCR_DOCUMENT_TYPE_UNSUPPORTED' | 'OCR_EVIDENCE_ALIGNMENT_INVALID';
  readonly detail: string;
  readonly remedy: string;
}

export type RateConfirmationReviewResult =
  | { readonly kind: 'review'; readonly value: RateConfirmationReview }
  | FreightReviewRefusal;

const REQUIRED: readonly RateConfirmationReviewFieldName[] = [
  'shipmentReference', 'carrierName', 'originCity', 'destinationCity',
  'pickupDate', 'deliveryDate', 'equipment', 'totalRate',
];

function refusal(
  code: FreightReviewRefusal['code'],
  detail: string,
  remedy: string,
): FreightReviewRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function fieldProjection(
  field: string,
  observations: readonly OcrObservation[],
  evidenceByObservation: ReadonlyMap<string, string>,
): FreightReviewField | FreightReviewRefusal {
  const matching = observations.filter(observation => observation.field === field);
  if (matching.length === 0) {
    return Object.freeze({
      state: 'missing' as const,
      field,
      remedy: 'Re-extract the document with the rate-confirmation schema or enter the field through operator review.',
    });
  }
  const evidenceIds = matching.map(observation => evidenceByObservation.get(observation.observationId));
  if (evidenceIds.some(id => id === undefined)) {
    return refusal(
      'OCR_EVIDENCE_ALIGNMENT_INVALID',
      `One or more ${field} observations have no aligned Terminal evidence identity.`,
      'Re-register the complete OCR bundle before projecting it for review.',
    );
  }
  if (matching.length > 1) {
    return Object.freeze({
      state: 'contested' as const,
      field,
      observationIds: Object.freeze(matching.map(observation => observation.observationId)),
      evidenceIds: Object.freeze(evidenceIds as string[]),
      remedy: 'Review every cited reading; this projection will not choose one by order or confidence.',
    });
  }

  const observation = matching[0];
  const evidenceId = evidenceIds[0] as string;
  if (observation.value.kind === 'absent') {
    return Object.freeze({
      state: 'absent' as const,
      observationId: observation.observationId,
      evidenceId,
      reason: observation.value.reason,
      ...(observation.value.note !== undefined ? { note: observation.value.note } : {}),
    });
  }
  return Object.freeze({
    state: 'candidate' as const,
    observationId: observation.observationId,
    evidenceId,
    raw: observation.value.raw,
    normalized: observation.value.normalized,
    ...(observation.value.unit !== undefined ? { unit: observation.value.unit } : {}),
    verificationStatus: observation.verificationStatus,
  });
}

/** Build the operator-facing proposal after EvidencePool registration. */
export function projectRateConfirmation(record: RegisteredOcrCandidate): RateConfirmationReviewResult {
  const { bundle } = record.candidate;
  if (bundle.documentType !== 'RATE_CONFIRMATION') {
    return refusal(
      'OCR_DOCUMENT_TYPE_UNSUPPORTED',
      `Bundle ${bundle.bundleId} is ${bundle.documentType}, not RATE_CONFIRMATION.`,
      'Route it to the matching document review projection; do not coerce schemas.',
    );
  }
  if (record.receipt.evidenceIds.length !== bundle.observations.length) {
    return refusal(
      'OCR_EVIDENCE_ALIGNMENT_INVALID',
      `Bundle ${bundle.bundleId} has ${bundle.observations.length} observations but ${record.receipt.evidenceIds.length} evidence ids.`,
      'Re-register the complete bundle so evidence ids remain aligned by observation index.',
    );
  }

  const evidenceByObservation = new Map<string, string>();
  bundle.observations.forEach((observation, index) => {
    evidenceByObservation.set(observation.observationId, record.receipt.evidenceIds[index]);
  });

  const fields = {} as Record<RateConfirmationReviewFieldName, FreightReviewField>;
  for (const [name, field] of Object.entries(RATE_CONFIRMATION_REVIEW_FIELDS) as Array<
    [RateConfirmationReviewFieldName, string]
  >) {
    const projected = fieldProjection(field, bundle.observations, evidenceByObservation);
    if (!('state' in projected)) return projected;
    fields[name] = projected;
  }

  const blockedOn = REQUIRED.filter(name => fields[name].state !== 'candidate');
  const hasContestedField = Object.values(fields).some(field => field.state === 'contested');
  const reviewState: RateConfirmationReviewState =
    record.reviewState === 'blocked_by_conflict' || hasContestedField
      ? 'blocked_by_document_conflict'
      : blockedOn.length > 0
        ? 'blocked_by_required_field'
        : 'ready_for_entity_resolution';

  return {
    kind: 'review',
    value: Object.freeze({
      bundleId: bundle.bundleId,
      artifactId: bundle.artifact.artifactId,
      documentType: 'RATE_CONFIRMATION' as const,
      fields: Object.freeze(fields),
      reviewState,
      blockedOn: Object.freeze(blockedOn),
      admittedToOperations: false as const,
    }),
  };
}
