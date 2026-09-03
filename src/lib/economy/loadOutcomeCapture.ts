/**
 * Operational settlement → decision outcome adapter.
 *
 * Source records enter with their own attestation. Durations and margin are
 * computed here, contamination propagates automatically, and unavailable
 * settlement fields become typed absences rather than zeros.
 */

import { combineAttestations, type Attestation } from './attestation';
import type { DecisionMetric, OutcomeAbsence, OutcomeAbsenceReason } from './decisionEpisode';
import type { CaptureOperationOutcomeCommand } from './loadOperations';
import type { ISODateTime } from './types';

export interface SettlementInstantEvidence {
  readonly instant: ISODateTime;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
}

export interface SettlementMoneyEvidence {
  readonly amountMinor: number;
  readonly currency: string;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
}

export interface SettlementBinaryEvidence {
  readonly value: 0 | 1;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
}

export interface SettlementAbsenceEvidence {
  readonly reason: OutcomeAbsenceReason;
  readonly detail: string;
  readonly remedy: string;
  readonly evidenceIds: readonly string[];
}

export type SettlementObservedOrAbsent<T> =
  | { readonly kind: 'observed'; readonly evidence: T }
  | { readonly kind: 'absent'; readonly absence: SettlementAbsenceEvidence };

export interface SettlementDwellInterval {
  readonly arrivedAt: SettlementInstantEvidence;
  readonly departedAt: SettlementInstantEvidence;
}

export interface OperationalSettlementEvidence {
  readonly operationId: string;
  readonly eventId: string;
  readonly pickupAt: SettlementInstantEvidence;
  readonly deliveredAt: SettlementInstantEvidence;
  readonly originDwell: SettlementObservedOrAbsent<SettlementDwellInterval>;
  readonly destinationDwell: SettlementObservedOrAbsent<SettlementDwellInterval>;
  readonly carrierInvoice: SettlementObservedOrAbsent<SettlementMoneyEvidence>;
  readonly accessorialCost: SettlementObservedOrAbsent<SettlementMoneyEvidence>;
  readonly shipperRevenue: SettlementObservedOrAbsent<SettlementMoneyEvidence>;
  readonly damageCost: SettlementObservedOrAbsent<SettlementMoneyEvidence>;
  readonly rejected: SettlementObservedOrAbsent<SettlementBinaryEvidence>;
  readonly knownAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export type SettlementCaptureResult =
  | { readonly kind: 'captured'; readonly command: CaptureOperationOutcomeCommand }
  | {
      readonly kind: 'refusal';
      readonly code:
        | 'SETTLEMENT_INPUT_INVALID'
        | 'SETTLEMENT_TIME_INVALID'
        | 'SETTLEMENT_CURRENCY_CONFLICT';
      readonly detail: string;
      readonly remedy: string;
    };

function nonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && values.every(value => value.trim().length > 0);
}

function refusal(
  code: Extract<SettlementCaptureResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<SettlementCaptureResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function metric(
  name: DecisionMetric['name'],
  value: number,
  unit: DecisionMetric['unit'],
  attestation: Attestation,
  evidenceIds: readonly string[],
  currency?: string,
): DecisionMetric {
  return Object.freeze({
    name, value, unit,
    ...(currency ? { currency } : {}),
    attestation,
    evidenceIds: Object.freeze([...new Set(evidenceIds)]),
  });
}

function absence(
  name: DecisionMetric['name'],
  evidence: SettlementAbsenceEvidence,
): OutcomeAbsence {
  return Object.freeze({ metric: name, ...evidence });
}

function instantDefect(evidence: SettlementInstantEvidence): string | null {
  if (!evidence || !Number.isFinite(Date.parse(evidence.instant))) return 'invalid instant';
  if (!evidence.attestation || evidence.attestation.inputCount < 1 || !nonEmpty(evidence.evidenceIds)) {
    return 'instant lacks evidence or attestation';
  }
  return null;
}

function moneyDefect(evidence: SettlementMoneyEvidence): string | null {
  if (!evidence || !Number.isFinite(evidence.amountMinor) || evidence.amountMinor < 0) return 'money is negative or not finite';
  if (!evidence.currency?.trim() || !evidence.attestation || evidence.attestation.inputCount < 1 ||
      !nonEmpty(evidence.evidenceIds)) {
    return 'money lacks currency, evidence, or attestation';
  }
  return null;
}

function absentDefect(evidence: SettlementAbsenceEvidence): string | null {
  if (!evidence || !evidence.detail?.trim() || !evidence.remedy?.trim() || !nonEmpty(evidence.evidenceIds)) {
    return 'typed absence lacks detail, remedy, or evidence';
  }
  return null;
}

function validateObservedOrAbsent<T>(
  value: SettlementObservedOrAbsent<T>,
  observed: (evidence: T) => string | null,
): string | null {
  if (!value || (value.kind !== 'observed' && value.kind !== 'absent')) return 'field has no observed/absent state';
  return value.kind === 'observed' ? observed(value.evidence) : absentDefect(value.absence);
}

function dwellDefect(value: SettlementObservedOrAbsent<SettlementDwellInterval>): string | null {
  return validateObservedOrAbsent(value, interval => {
    const arrival = instantDefect(interval?.arrivedAt);
    const departure = instantDefect(interval?.departedAt);
    if (arrival || departure) return arrival ?? departure;
    return Date.parse(interval.departedAt.instant) < Date.parse(interval.arrivedAt.instant)
      ? 'dwell departure precedes arrival'
      : null;
  });
}

function mergeAbsences(
  name: DecisionMetric['name'],
  values: readonly SettlementAbsenceEvidence[],
): OutcomeAbsence {
  const priority: Readonly<Record<OutcomeAbsenceReason, number>> = {
    conflicting: 3, pending: 2, not_observed: 1, not_applicable: 0,
  };
  const reason = [...values].sort((left, right) => priority[right.reason] - priority[left.reason])[0].reason;
  return Object.freeze({
    metric: name,
    reason,
    detail: values.map(value => value.detail).join('; '),
    remedy: values.map(value => value.remedy).join('; '),
    evidenceIds: Object.freeze([...new Set(values.flatMap(value => value.evidenceIds))]),
  });
}

/** Convert one settled physical load into a workflow outcome-capture command. */
export function settlementOutcomeCommand(
  settlement: OperationalSettlementEvidence,
): SettlementCaptureResult {
  if (!settlement?.operationId?.trim() || !settlement.eventId?.trim() || !nonEmpty(settlement.evidenceIds)) {
    return refusal(
      'SETTLEMENT_INPUT_INVALID', 'Settlement identity or envelope evidence is incomplete.',
      'Name the operation/event and attach the settlement, POD, telematics, or claim records.',
    );
  }
  const sourceDefects = [
    instantDefect(settlement.pickupAt),
    instantDefect(settlement.deliveredAt),
    dwellDefect(settlement.originDwell),
    dwellDefect(settlement.destinationDwell),
    validateObservedOrAbsent(settlement.carrierInvoice, moneyDefect),
    validateObservedOrAbsent(settlement.accessorialCost, moneyDefect),
    validateObservedOrAbsent(settlement.shipperRevenue, moneyDefect),
    validateObservedOrAbsent(settlement.damageCost, moneyDefect),
    validateObservedOrAbsent(settlement.rejected, evidence =>
      evidence?.attestation?.inputCount >= 1 && nonEmpty(evidence.evidenceIds) &&
      (evidence.value === 0 || evidence.value === 1) ? null : 'binary lacks valid value, evidence, or attestation'),
  ].filter((value): value is string => value !== null);
  if (sourceDefects.length) {
    return refusal(
      'SETTLEMENT_INPUT_INVALID', `Settlement evidence is invalid: ${sourceDefects.join('; ')}.`,
      'Correct the source record or represent the unavailable value as a typed absence.',
    );
  }
  const pickup = Date.parse(settlement.pickupAt.instant);
  const delivered = Date.parse(settlement.deliveredAt.instant);
  const known = Date.parse(settlement.knownAt);
  const recorded = Date.parse(settlement.recordedAt);
  if (![pickup, delivered, known, recorded].every(Number.isFinite) ||
      delivered < pickup || known < delivered || recorded < known) {
    return refusal(
      'SETTLEMENT_TIME_INVALID',
      'Settlement violates pickup ≤ delivery/occurrence ≤ knownAt ≤ recordedAt.',
      'Preserve physical, knowledge, and recording clocks; do not collapse them into settlement time.',
    );
  }

  const observedMoney = [settlement.carrierInvoice, settlement.accessorialCost, settlement.shipperRevenue]
    .filter((value): value is { kind: 'observed'; evidence: SettlementMoneyEvidence } => value.kind === 'observed')
    .map(value => value.evidence);
  const currencies = new Set(observedMoney.map(value => value.currency));
  if (currencies.size > 1) {
    return refusal(
      'SETTLEMENT_CURRENCY_CONFLICT',
      `Settlement arithmetic spans currencies ${[...currencies].join(', ')}.`,
      'Supply a dated FX basis or keep margin absent; no conversion is inferred.',
    );
  }

  const metrics: DecisionMetric[] = [];
  const absences: OutcomeAbsence[] = [];
  metrics.push(metric(
    'actual_transit_hours',
    (delivered - pickup) / 3_600_000,
    'hours',
    combineAttestations([settlement.pickupAt.attestation, settlement.deliveredAt.attestation]),
    [...settlement.pickupAt.evidenceIds, ...settlement.deliveredAt.evidenceIds],
  ));

  if (settlement.originDwell.kind === 'observed' && settlement.destinationDwell.kind === 'observed') {
    const intervals = [settlement.originDwell.evidence, settlement.destinationDwell.evidence];
    const value = intervals.reduce((sum, interval) =>
      sum + (Date.parse(interval.departedAt.instant) - Date.parse(interval.arrivedAt.instant)) / 60_000, 0);
    metrics.push(metric(
      'actual_dwell_minutes', value, 'minutes',
      combineAttestations(intervals.flatMap(interval => [
        interval.arrivedAt.attestation, interval.departedAt.attestation,
      ])),
      intervals.flatMap(interval => [...interval.arrivedAt.evidenceIds, ...interval.departedAt.evidenceIds]),
    ));
  } else {
    const missing = [settlement.originDwell, settlement.destinationDwell]
      .filter((value): value is { kind: 'absent'; absence: SettlementAbsenceEvidence } => value.kind === 'absent')
      .map(value => value.absence);
    absences.push(mergeAbsences('actual_dwell_minutes', missing));
  }

  const moneyFields: ReadonlyArray<[
    DecisionMetric['name'],
    SettlementObservedOrAbsent<SettlementMoneyEvidence>,
  ]> = [
    ['carrier_invoice', settlement.carrierInvoice],
    ['actual_accessorial_cost', settlement.accessorialCost],
    ['damage_cost', settlement.damageCost],
  ];
  for (const [name, value] of moneyFields) {
    if (value.kind === 'observed') {
      metrics.push(metric(
        name, value.evidence.amountMinor, 'money_minor', value.evidence.attestation,
        value.evidence.evidenceIds, value.evidence.currency,
      ));
    } else absences.push(absence(name, value.absence));
  }

  if (settlement.rejected.kind === 'observed') {
    metrics.push(metric(
      'rejection_indicator', settlement.rejected.evidence.value, 'binary',
      settlement.rejected.evidence.attestation, settlement.rejected.evidence.evidenceIds,
    ));
  } else absences.push(absence('rejection_indicator', settlement.rejected.absence));

  if (settlement.carrierInvoice.kind === 'observed' &&
      settlement.accessorialCost.kind === 'observed' &&
      settlement.shipperRevenue.kind === 'observed') {
    const invoice = settlement.carrierInvoice.evidence;
    const accessorial = settlement.accessorialCost.evidence;
    const revenue = settlement.shipperRevenue.evidence;
    metrics.push(metric(
      'gross_margin', revenue.amountMinor - invoice.amountMinor - accessorial.amountMinor,
      'money_minor',
      combineAttestations([revenue.attestation, invoice.attestation, accessorial.attestation]),
      [...revenue.evidenceIds, ...invoice.evidenceIds, ...accessorial.evidenceIds],
      revenue.currency,
    ));
  } else {
    const missing = [settlement.carrierInvoice, settlement.accessorialCost, settlement.shipperRevenue]
      .filter((value): value is { kind: 'absent'; absence: SettlementAbsenceEvidence } => value.kind === 'absent')
      .map(value => value.absence);
    absences.push(mergeAbsences('gross_margin', missing));
  }

  return Object.freeze({
    kind: 'captured' as const,
    command: Object.freeze({
      operationId: settlement.operationId,
      eventId: settlement.eventId,
      occurredAt: settlement.deliveredAt.instant,
      knownAt: settlement.knownAt,
      recordedAt: settlement.recordedAt,
      metrics: Object.freeze(metrics),
      absences: Object.freeze(absences),
      evidenceIds: Object.freeze([...settlement.evidenceIds]),
    }),
  });
}
