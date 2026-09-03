import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import {
  settlementOutcomeCommand,
  type OperationalSettlementEvidence,
  type SettlementAbsenceEvidence,
  type SettlementInstantEvidence,
  type SettlementMoneyEvidence,
} from './loadOutcomeCapture';

const reported = attestationOf('reported', 'high', 'disinterested', 'operational system record');
const invoiced = attestationOf('reported', 'high', 'self_reported', 'carrier invoice');

const instant = (value: string, id: string): SettlementInstantEvidence => ({
  instant: value, attestation: reported, evidenceIds: [id],
});

const money = (
  amountMinor: number,
  id: string,
  currency = 'CAD',
  attestation = reported,
): SettlementMoneyEvidence => ({ amountMinor, currency, attestation, evidenceIds: [id] });

const pending = (id: string): SettlementAbsenceEvidence => ({
  reason: 'pending', detail: 'Settlement source has not closed.',
  remedy: 'Re-evaluate when the source closes.', evidenceIds: [id],
});

function settlement(): OperationalSettlementEvidence {
  return {
    operationId: 'opportunity:1',
    eventId: 'event:settlement:1',
    pickupAt: instant('2026-09-01T14:00:00.000Z', 'dispatch:load:1'),
    deliveredAt: instant('2026-09-02T18:00:00.000Z', 'pod:load:1'),
    originDwell: {
      kind: 'observed',
      evidence: {
        arrivedAt: instant('2026-09-01T13:45:00.000Z', 'geofence:origin:arrival'),
        departedAt: instant('2026-09-01T14:15:00.000Z', 'geofence:origin:departure'),
      },
    },
    destinationDwell: {
      kind: 'observed',
      evidence: {
        arrivedAt: instant('2026-09-02T17:45:00.000Z', 'geofence:destination:arrival'),
        departedAt: instant('2026-09-02T18:30:00.000Z', 'geofence:destination:departure'),
      },
    },
    carrierInvoice: { kind: 'observed', evidence: money(150000, 'invoice:load:1', 'CAD', invoiced) },
    accessorialCost: { kind: 'observed', evidence: money(10000, 'accessorial:load:1') },
    shipperRevenue: { kind: 'observed', evidence: money(220000, 'shipper-invoice:load:1') },
    damageCost: { kind: 'absent', absence: pending('claim-window:load:1') },
    rejected: {
      kind: 'observed',
      evidence: { value: 0, attestation: reported, evidenceIds: ['delivery-acceptance:load:1'] },
    },
    knownAt: '2026-09-02T18:35:00.000Z',
    recordedAt: '2026-09-02T18:36:00.000Z',
    evidenceIds: ['settlement:load:1'],
  };
}

describe('automatic settlement outcome capture', () => {
  it('computes transit, complete dwell, and gross margin with propagated attestation', () => {
    const result = settlementOutcomeCommand(settlement());
    expect(result.kind).toBe('captured');
    if (result.kind !== 'captured') return;
    const byName = new Map(result.command.metrics.map(metric => [metric.name, metric]));
    expect(byName.get('actual_transit_hours')?.value).toBe(28);
    expect(byName.get('actual_dwell_minutes')?.value).toBe(75);
    expect(byName.get('carrier_invoice')?.value).toBe(150000);
    expect(byName.get('actual_accessorial_cost')?.value).toBe(10000);
    expect(byName.get('gross_margin')?.value).toBe(60000);
    expect(byName.get('rejection_indicator')?.value).toBe(0);
    expect(byName.get('gross_margin')?.attestation).toMatchObject({
      restsOnInterested: true,
      interest: 'self_reported',
      inputCount: 3,
    });
    expect(result.command.absences).toEqual([
      expect.objectContaining({ metric: 'damage_cost', reason: 'pending' }),
    ]);
  });

  it('turns an unavailable invoice into explicit invoice and margin absences', () => {
    const input = settlement();
    const result = settlementOutcomeCommand({
      ...input,
      carrierInvoice: { kind: 'absent', absence: pending('invoice-status:load:1') },
    });
    expect(result.kind).toBe('captured');
    if (result.kind !== 'captured') return;
    expect(result.command.metrics.map(metric => metric.name)).not.toContain('carrier_invoice');
    expect(result.command.metrics.map(metric => metric.name)).not.toContain('gross_margin');
    expect(result.command.absences).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'carrier_invoice', reason: 'pending' }),
      expect.objectContaining({ metric: 'gross_margin', reason: 'pending' }),
    ]));
  });

  it('refuses margin arithmetic across currencies instead of inferring FX', () => {
    const input = settlement();
    expect(settlementOutcomeCommand({
      ...input,
      carrierInvoice: { kind: 'observed', evidence: money(110000, 'invoice:usd', 'USD', invoiced) },
    })).toMatchObject({ kind: 'refusal', code: 'SETTLEMENT_CURRENCY_CONFLICT' });
  });

  it('does not report partial dwell as total dwell', () => {
    const input = settlement();
    const result = settlementOutcomeCommand({
      ...input,
      destinationDwell: { kind: 'absent', absence: {
        reason: 'not_observed', detail: 'Destination geofence was offline.',
        remedy: 'Reconcile against receiver timestamps.', evidenceIds: ['geofence-status:destination'],
      } },
    });
    expect(result.kind).toBe('captured');
    if (result.kind !== 'captured') return;
    expect(result.command.metrics.map(metric => metric.name)).not.toContain('actual_dwell_minutes');
    expect(result.command.absences).toContainEqual(expect.objectContaining({
      metric: 'actual_dwell_minutes', reason: 'not_observed',
    }));
  });

  it('keeps physical, knowledge, and recording clocks ordered', () => {
    expect(settlementOutcomeCommand({
      ...settlement(), knownAt: '2026-09-02T17:59:00.000Z',
    })).toMatchObject({ kind: 'refusal', code: 'SETTLEMENT_TIME_INVALID' });
  });
});
