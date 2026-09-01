import { describe, expect, it } from 'vitest';
import { ProcurementWorkflow } from './procurement';
import { ProcurementActions } from './procurementActions';
import { MemoryProcurementStore } from './procurementStore';

const actorId = 'desk:procurement';
let sequence = 0;

function action(actionName: string, submittedAt: string, payload: Record<string, unknown>) {
  sequence += 1;
  return { action: actionName, requestId: `request:procurement:${sequence}`, actorId, submittedAt, payload };
}

describe('PayloadOS procurement and physical-position workflow', () => {
  it('operates requirement through settlement, preserves missing costs, and appends a complete correction', async () => {
    let now = '2026-09-01T10:00:00.000Z';
    const workflow = new ProcurementWorkflow(new MemoryProcurementStore());
    const actions = new ProcurementActions(workflow, () => now);
    const requirement = action('register_requirement', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'rfq:001', materialId: 'material:polyethylene',
      specificationId: 'spec:hdpe:5502', quantity: 100, unit: 'tonne', destinationId: 'facility:customer:ontario',
      deliveryStart: '2026-10-01T00:00:00.000Z', deliveryEnd: '2026-10-15T00:00:00.000Z', currency: 'CAD',
      maximumLandedCostMinor: 13_000_000,
    });
    const registered = await actions.execute(requirement);
    expect(registered).toMatchObject({ kind: 'accepted', persistence: 'appended', procurement: { phase: 'alternatives_pending' } });

    now = '2026-09-01T10:05:00.000Z';
    const retry = await actions.execute(requirement);
    expect(retry).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });

    now = '2026-09-01T11:00:00.000Z';
    await actions.execute(action('add_supplier_alternative', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'quote:supplier-a:001', supplierId: 'supplier:a', facilityId: 'plant:a',
      quantity: 120, unit: 'tonne', quotedTotalMinor: 12_000_000, currency: 'CAD', incoterm: 'FCA supplier plant',
      availabilityStart: '2026-09-20T00:00:00.000Z', availabilityEnd: '2026-09-25T00:00:00.000Z', validUntil: '2026-09-10T00:00:00.000Z',
    }));
    let cockpit = await actions.inspect('procurement:polymer:001');
    expect(cockpit.kind).toBe('procurement_cockpit_snapshot');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    const supplierAction = cockpit.procurement.alternatives[0].alternative.actionId;

    now = '2026-09-01T12:00:00.000Z';
    await actions.execute(action('authorize_supplier', now, {
      procurementId: 'procurement:polymer:001', actionId: supplierAction, sourceReference: 'dossier:supplier-a:001',
      counterpartyEligibility: 'satisfied', sanctionsScreening: 'satisfied', specificationMatch: 'satisfied',
      creditTerms: 'satisfied', authorityToBuy: 'satisfied',
    }));
    await actions.execute(action('freeze_decision_set', now, { procurementId: 'procurement:polymer:001' }));
    await actions.execute(action('select_supplier', now, {
      procurementId: 'procurement:polymer:001', actionId: supplierAction,
      rationale: 'Only fully qualified supplier; covers required quantity and delivery window.',
    }));

    now = '2026-09-02T10:00:00.000Z';
    await actions.execute(action('commit_purchase', now, {
      procurementId: 'procurement:polymer:001', contractId: 'contract:purchase:001', sourceReference: 'contract:artifact:001',
      quantity: 100, unit: 'tonne', committedPriceMinor: 11_800_000, currency: 'CAD', incoterm: 'FCA supplier plant',
      titleTransferPoint: 'Supplier plant on carrier pickup', committedAt: now,
    }));
    cockpit = await actions.inspect('procurement:polymer:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    expect(cockpit.procurement).toMatchObject({ phase: 'logistics_pending', position: { materialId: 'material:polyethylene', ownershipState: 'committed' } });

    await actions.execute(action('create_logistics_requirement', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'routing:plan:001', originId: 'plant:a',
      readyStart: '2026-09-20T00:00:00.000Z', readyEnd: '2026-09-25T00:00:00.000Z',
      deliveryStart: '2026-10-01T00:00:00.000Z', deliveryEnd: '2026-10-15T00:00:00.000Z', handlingProfileId: 'handling:dry-bulk',
    }));
    now = '2026-10-05T12:00:00.000Z';
    await actions.execute(action('record_receipt', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'receipt:warehouse:001', quantity: 100, unit: 'tonne',
      receivedAt: '2026-10-05T10:00:00.000Z', locationId: 'facility:customer:ontario', disposition: 'accepted',
    }));

    const incomplete = await actions.execute(action('capture_settlement', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'settlement:001', currency: 'CAD',
      purchaseInvoiceMinor: 11_800_000, freightCostMinor: 900_000,
    }));
    expect(incomplete).toMatchObject({
      kind: 'accepted', procurement: {
        phase: 'settled',
        landedCost: { kind: 'incomplete', missingComponents: ['duty', 'insurance', 'storage', 'financing', 'loss'] },
      },
    });
    cockpit = await actions.inspect('procurement:polymer:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    expect(cockpit.actions.map(item => item.action)).toContain('capture_settlement');

    now = '2026-10-06T12:00:00.000Z';
    const corrected = await actions.execute(action('capture_settlement', now, {
      procurementId: 'procurement:polymer:001', sourceReference: 'settlement:002', currency: 'CAD',
      purchaseInvoiceMinor: 11_800_000, freightCostMinor: 900_000, dutyCostMinor: 200_000,
      insuranceCostMinor: 50_000, storageCostMinor: 0, financingCostMinor: 100_000, lossCostMinor: 0,
      saleRevenueMinor: 14_000_000,
    }));
    expect(corrected).toMatchObject({
      kind: 'accepted', procurement: {
        landedCost: {
          kind: 'complete', amountMinor: 13_050_000, currency: 'CAD', marginMinor: 950_000,
          budgetComparison: { kind: 'evaluated', maximumAmountMinor: 13_000_000, varianceMinor: 50_000, withinMaximum: false },
        },
        position: { ownershipState: 'settled', qualityState: 'accepted', logisticsState: 'received' },
      },
    });
    const stored = await workflow.get('procurement:polymer:001');
    if (stored.kind === 'refusal') throw new Error(stored.detail);
    expect(stored.settlementEventId).toMatch(/^procurement:capture_settlement:/);
  });

  it('will not freeze or select a supplier that failed qualification', async () => {
    const now = '2026-09-01T10:00:00.000Z';
    const actions = new ProcurementActions(new ProcurementWorkflow(new MemoryProcurementStore()), () => now);
    await actions.execute(action('register_requirement', now, {
      procurementId: 'procurement:blocked:001', sourceReference: 'rfq:blocked', materialId: 'material:x', specificationId: 'spec:x',
      quantity: 10, unit: 'unit', destinationId: 'facility:d', deliveryStart: now, deliveryEnd: '2026-09-03T10:00:00.000Z', currency: 'USD',
    }));
    await actions.execute(action('add_supplier_alternative', now, {
      procurementId: 'procurement:blocked:001', sourceReference: 'quote:blocked', supplierId: 'supplier:blocked', quantity: 10, unit: 'unit',
      quotedTotalMinor: 100_000, currency: 'USD', incoterm: 'DAP', availabilityStart: now, availabilityEnd: '2026-09-02T10:00:00.000Z', validUntil: '2026-09-02T10:00:00.000Z',
    }));
    const cockpit = await actions.inspect('procurement:blocked:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    await actions.execute(action('authorize_supplier', now, {
      procurementId: 'procurement:blocked:001', actionId: cockpit.procurement.alternatives[0].alternative.actionId,
      sourceReference: 'dossier:blocked', counterpartyEligibility: 'satisfied', sanctionsScreening: 'refused',
      specificationMatch: 'satisfied', creditTerms: 'satisfied', authorityToBuy: 'satisfied',
    }));
    const frozen = await actions.execute(action('freeze_decision_set', now, { procurementId: 'procurement:blocked:001' }));
    expect(frozen).toMatchObject({ kind: 'refusal', code: 'PROCUREMENT_NO_FEASIBLE_ACTION' });
  });

  it('excludes an otherwise authorized quote after its validity window closes', async () => {
    let now = '2026-09-01T10:00:00.000Z';
    const actions = new ProcurementActions(new ProcurementWorkflow(new MemoryProcurementStore()), () => now);
    await actions.execute(action('register_requirement', now, {
      procurementId: 'procurement:expired:001', sourceReference: 'rfq:expired', materialId: 'material:x', specificationId: 'spec:x',
      quantity: 10, unit: 'unit', destinationId: 'facility:d', deliveryStart: now, deliveryEnd: '2026-09-10T10:00:00.000Z', currency: 'USD',
    }));
    await actions.execute(action('add_supplier_alternative', now, {
      procurementId: 'procurement:expired:001', sourceReference: 'quote:expired', supplierId: 'supplier:expired', quantity: 10, unit: 'unit',
      quotedTotalMinor: 100_000, currency: 'USD', incoterm: 'DAP', availabilityStart: now,
      availabilityEnd: '2026-09-05T10:00:00.000Z', validUntil: '2026-09-02T10:00:00.000Z',
    }));
    const cockpit = await actions.inspect('procurement:expired:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    await actions.execute(action('authorize_supplier', now, {
      procurementId: 'procurement:expired:001', actionId: cockpit.procurement.alternatives[0].alternative.actionId,
      sourceReference: 'dossier:expired', counterpartyEligibility: 'satisfied', sanctionsScreening: 'satisfied',
      specificationMatch: 'satisfied', creditTerms: 'satisfied', authorityToBuy: 'satisfied',
    }));
    now = '2026-09-03T10:00:00.000Z';
    const frozen = await actions.execute(action('freeze_decision_set', now, { procurementId: 'procurement:expired:001' }));
    expect(frozen).toMatchObject({ kind: 'refusal', code: 'PROCUREMENT_NO_FEASIBLE_ACTION' });
  });

  it('rejects internal journal fields at the business-intent boundary', async () => {
    const now = '2026-09-01T10:00:00.000Z';
    const actions = new ProcurementActions(new ProcurementWorkflow(new MemoryProcurementStore()), () => now);
    const result = await actions.execute({
      ...action('register_requirement', now, {
        procurementId: 'procurement:injection', sourceReference: 'rfq:injection', materialId: 'material:x', specificationId: 'spec:x',
        quantity: 1, unit: 'unit', destinationId: 'facility:x', deliveryStart: now, deliveryEnd: now, currency: 'USD',
      }),
      commandHash: 'attacker-controlled',
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'PROCUREMENT_COMMAND_INVALID' });
  });
});
