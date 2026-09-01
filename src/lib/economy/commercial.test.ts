import { describe, expect, it } from 'vitest';
import { attestationOf } from './attestation';
import { CommercialWorkflow } from './commercial';
import { CommercialActions } from './commercialActions';
import { MemoryCommercialStore } from './commercialStore';
import type { ProcurementSnapshot } from './procurement';

const attestation = attestationOf('reported', 'medium', 'self_reported', 'test evidence');
let sequence = 0;

function action(actionName: string, submittedAt: string, payload: Record<string, unknown>) {
  sequence += 1;
  return { action: actionName, requestId: `request:commercial:${sequence}`, actorId: 'desk:commercial', submittedAt, payload };
}

function procurementSource(): ProcurementSnapshot {
  return {
    kind: 'procurement_snapshot', procurementId: 'procurement:source:001', phase: 'settled', durability: 'memory',
    requirement: {} as ProcurementSnapshot['requirement'], alternatives: [], decisionSet: null, selection: null,
    purchase: {
      contractId: 'purchase:source:001', positionId: 'position:source:001', actionId: 'supplier-action:source', supplierId: 'supplier:source',
      quantity: { amount: 100, unit: 'tonne', attestation, evidenceIds: ['evidence:purchase:quantity'] },
      committedPrice: { amountMinor: 900_000, currency: 'CAD', attestation, evidenceIds: ['evidence:purchase:price'] },
      incoterm: 'FCA', titleTransferPoint: 'supplier dock', committedAt: '2026-08-15T10:00:00.000Z',
      authorizedBy: 'desk:procurement', evidenceIds: ['evidence:purchase'],
    },
    logistics: null,
    receipts: [{
      positionId: 'position:source:001', receivedQuantity: { amount: 100, unit: 'tonne', attestation, evidenceIds: ['evidence:receipt:quantity'] },
      receivedAt: '2026-09-01T09:00:00.000Z', locationId: 'warehouse:toronto', disposition: 'accepted',
      attestation, evidenceIds: ['evidence:receipt'],
    }],
    settlement: null, settlementEventId: 'procurement:settlement:source',
    position: {
      positionId: 'position:source:001', materialId: 'material:polymer', specificationId: 'spec:hdpe', supplierId: 'supplier:source',
      quantity: { amount: 100, unit: 'tonne', attestation, evidenceIds: ['evidence:purchase:quantity'] },
      ownershipState: 'settled', logisticsState: 'received', qualityState: 'accepted', locationId: 'warehouse:toronto', customerCommitmentId: null,
    },
    landedCost: {
      kind: 'complete', amountMinor: 1_000_000, currency: 'CAD', marginMinor: null,
      evidenceIds: ['evidence:landed-cost'], attestation,
      budgetComparison: { kind: 'not_available', reason: 'maximum_not_observed' },
    },
  };
}

describe('PayloadOS commercial positions', () => {
  it('moves accepted procurement inventory through allocation, sale, fulfillment, and realized margin', async () => {
    let now = '2026-09-01T10:00:00.000Z';
    const workflow = new CommercialWorkflow(new MemoryCommercialStore());
    const actions = new CommercialActions(workflow, { get: async () => procurementSource() }, () => now);
    const open = action('open_inventory_lot', now, { procurementId: 'procurement:source:001', sourceReference: 'warehouse-receipt:001' });
    const opened = await actions.execute(open);
    expect(opened).toMatchObject({ kind: 'accepted', persistence: 'appended', book: { lots: [{ availableAmount: 100 }] } });
    now = '2026-09-01T10:30:00.000Z';
    expect(await actions.execute(open)).toMatchObject({ kind: 'accepted', persistence: 'duplicate' });

    await actions.execute(action('register_customer_commitment', now, {
      commitmentId: 'customer-commitment:001', customerId: 'customer:alpha', customerPurchaseOrderId: 'po:alpha:001',
      materialId: 'material:polymer', specificationId: 'spec:hdpe', quantity: 60, unit: 'tonne',
      destinationId: 'customer-facility:alpha', deliveryStart: '2026-09-10T00:00:00.000Z', deliveryEnd: '2026-09-15T00:00:00.000Z',
      minimumRevenueMinor: 1_200_000, currency: 'CAD',
    }));
    let cockpit = await actions.inspect('customer-commitment:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    const lotId = cockpit.book.lots[0].lot.lotId;
    await actions.execute(action('reserve_inventory', now, {
      commitmentId: 'customer-commitment:001', lotId, quantity: 60, unit: 'tonne', sourceReference: 'allocation:approval:001',
    }));

    await actions.execute(action('register_customer_commitment', now, {
      commitmentId: 'customer-commitment:002', customerId: 'customer:beta', customerPurchaseOrderId: 'po:beta:001',
      materialId: 'material:polymer', specificationId: 'spec:hdpe', quantity: 50, unit: 'tonne',
      destinationId: 'customer-facility:beta', deliveryStart: '2026-09-10T00:00:00.000Z', deliveryEnd: '2026-09-15T00:00:00.000Z', currency: 'CAD',
    }));
    const oversell = await actions.execute(action('reserve_inventory', now, {
      commitmentId: 'customer-commitment:002', lotId, quantity: 50, unit: 'tonne', sourceReference: 'allocation:approval:oversell',
    }));
    expect(oversell).toMatchObject({ kind: 'refusal', code: 'INVENTORY_ALLOCATION_REFUSED' });

    now = '2026-09-02T10:00:00.000Z';
    const contracted = await actions.execute(action('commit_sale', now, {
      commitmentId: 'customer-commitment:001', saleContractId: 'sale-contract:001', sourceReference: 'signed-sale:001',
      totalRevenueMinor: 1_500_000, currency: 'CAD', incoterm: 'DAP customer facility',
      titleTransferPoint: 'accepted customer delivery', signedAt: now,
    }));
    expect(contracted.kind).toBe('accepted');
    if (contracted.kind === 'refusal') throw new Error(contracted.detail);
    expect(contracted.book.commitments.find(item => item.commitment.commitmentId === 'customer-commitment:001')).toMatchObject({
      phase: 'dispatch_pending',
      expectedMargin: { kind: 'complete', revenueMinor: 1_500_000, allocatedCostMinor: 600_000, grossMarginMinor: 900_000 },
    });

    await actions.execute(action('dispatch_sale', now, {
      commitmentId: 'customer-commitment:001', sourceReference: 'dispatch:001', loadOperationId: 'load-operation:customer:001', dispatchedAt: now,
    }));
    cockpit = await actions.inspect('customer-commitment:001');
    if (cockpit.kind === 'refusal') throw new Error(cockpit.detail);
    const allocationId = cockpit.commitment.allocations[0].allocationId;

    now = '2026-09-12T15:00:00.000Z';
    await actions.execute(action('record_customer_delivery', now, {
      commitmentId: 'customer-commitment:001', allocationId, sourceReference: 'pod:001', quantity: 60, unit: 'tonne',
      deliveredAt: '2026-09-12T14:00:00.000Z', locationId: 'customer-facility:alpha', disposition: 'accepted',
    }));
    const incomplete = await actions.execute(action('capture_sale_settlement', now, {
      commitmentId: 'customer-commitment:001', sourceReference: 'remittance:001', currency: 'CAD', grossRevenueMinor: 1_500_000,
    }));
    expect(incomplete.kind).toBe('accepted');
    if (incomplete.kind === 'refusal') throw new Error(incomplete.detail);
    expect(incomplete.book.commitments.find(item => item.commitment.commitmentId === 'customer-commitment:001')).toMatchObject({
      phase: 'settled', realizedMargin: { kind: 'incomplete', reason: 'deductions_not_observed' },
    });

    now = '2026-09-13T10:00:00.000Z';
    const corrected = await actions.execute(action('capture_sale_settlement', now, {
      commitmentId: 'customer-commitment:001', sourceReference: 'remittance:002', currency: 'CAD',
      grossRevenueMinor: 1_500_000, deductionsMinor: 0,
    }));
    expect(corrected.kind).toBe('accepted');
    if (corrected.kind === 'refusal') throw new Error(corrected.detail);
    expect(corrected.book.lots[0]).toMatchObject({ allocatedAmount: 60, availableAmount: 40, dispatchedAmount: 60, deliveredAmount: 60 });
    expect(corrected.book.commitments.find(item => item.commitment.commitmentId === 'customer-commitment:001')).toMatchObject({
      realizedMargin: { kind: 'complete', revenueMinor: 1_500_000, allocatedCostMinor: 600_000, grossMarginMinor: 900_000, revenueBasis: 'settled_net' },
    });
  });

  it('refuses a sale contract below the evidenced customer revenue floor', async () => {
    const now = '2026-09-01T10:00:00.000Z';
    const workflow = new CommercialWorkflow(new MemoryCommercialStore());
    const actions = new CommercialActions(workflow, { get: async () => procurementSource() }, () => now);
    await actions.execute(action('open_inventory_lot', now, { procurementId: 'procurement:source:001', sourceReference: 'receipt:floor' }));
    await actions.execute(action('register_customer_commitment', now, {
      commitmentId: 'customer-commitment:floor', customerId: 'customer:floor', customerPurchaseOrderId: 'po:floor',
      materialId: 'material:polymer', specificationId: 'spec:hdpe', quantity: 10, unit: 'tonne', destinationId: 'customer-facility:floor',
      deliveryStart: now, deliveryEnd: '2026-09-10T00:00:00.000Z', minimumRevenueMinor: 300_000, currency: 'CAD',
    }));
    const book = await actions.list();
    if (book.kind === 'refusal') throw new Error(book.detail);
    await actions.execute(action('reserve_inventory', now, {
      commitmentId: 'customer-commitment:floor', lotId: book.lots[0].lot.lotId, quantity: 10, unit: 'tonne', sourceReference: 'allocation:floor',
    }));
    const refused = await actions.execute(action('commit_sale', now, {
      commitmentId: 'customer-commitment:floor', saleContractId: 'sale-contract:floor', sourceReference: 'sale:floor',
      totalRevenueMinor: 250_000, currency: 'CAD', incoterm: 'DAP', titleTransferPoint: 'delivery', signedAt: now,
    }));
    expect(refused).toMatchObject({ kind: 'refusal', code: 'SALE_CONTRACT_REFUSED' });
  });

  it('appends a newer procurement cost snapshot and closes previously missing margin evidence', async () => {
    const now = '2026-09-01T10:00:00.000Z';
    const complete = procurementSource();
    let current: ProcurementSnapshot = {
      ...complete,
      landedCost: {
        kind: 'incomplete', missingComponents: ['freight'], detail: 'Freight invoice is pending.',
        remedy: 'Attach the freight invoice.', evidenceIds: ['evidence:cost:pending'],
      },
    };
    const workflow = new CommercialWorkflow(new MemoryCommercialStore());
    const actions = new CommercialActions(workflow, { get: async () => current }, () => now);
    await actions.execute(action('open_inventory_lot', now, { procurementId: current.procurementId, sourceReference: 'receipt:pending-cost' }));
    await actions.execute(action('register_customer_commitment', now, {
      commitmentId: 'customer-commitment:cost-refresh', customerId: 'customer:cost-refresh', customerPurchaseOrderId: 'po:cost-refresh',
      materialId: 'material:polymer', specificationId: 'spec:hdpe', quantity: 10, unit: 'tonne', destinationId: 'customer-facility:cost-refresh',
      deliveryStart: now, deliveryEnd: '2026-09-10T00:00:00.000Z', currency: 'CAD',
    }));
    let book = await actions.list();
    if (book.kind === 'refusal') throw new Error(book.detail);
    await actions.execute(action('reserve_inventory', now, {
      commitmentId: 'customer-commitment:cost-refresh', lotId: book.lots[0].lot.lotId, quantity: 10, unit: 'tonne', sourceReference: 'allocation:cost-refresh',
    }));
    await actions.execute(action('commit_sale', now, {
      commitmentId: 'customer-commitment:cost-refresh', saleContractId: 'sale-contract:cost-refresh', sourceReference: 'sale:cost-refresh',
      totalRevenueMinor: 200_000, currency: 'CAD', incoterm: 'DAP', titleTransferPoint: 'delivery', signedAt: now,
    }));
    book = await actions.list();
    if (book.kind === 'refusal') throw new Error(book.detail);
    expect(book.commitments[0].expectedMargin).toMatchObject({ kind: 'incomplete', reason: 'cost_not_observed' });

    current = complete;
    const refreshed = await actions.execute(action('refresh_inventory_cost', now, { procurementId: current.procurementId, sourceReference: 'cost-reconciliation:complete' }));
    if (refreshed.kind === 'refusal') throw new Error(refreshed.detail);
    expect(refreshed.kind).toBe('accepted');
    expect(refreshed.book.commitments[0].expectedMargin).toMatchObject({
      kind: 'complete', revenueMinor: 200_000, allocatedCostMinor: 100_000, grossMarginMinor: 100_000,
    });
  });

  it('rejects hand-built internal journal fields at the business boundary', async () => {
    const now = '2026-09-01T10:00:00.000Z';
    const actions = new CommercialActions(new CommercialWorkflow(new MemoryCommercialStore()), { get: async () => procurementSource() }, () => now);
    const result = await actions.execute({
      ...action('register_customer_commitment', now, {
        commitmentId: 'customer-commitment:injection', customerId: 'customer:x', customerPurchaseOrderId: 'po:x',
        materialId: 'material:x', specificationId: 'spec:x', quantity: 1, unit: 'unit', destinationId: 'facility:x',
        deliveryStart: now, deliveryEnd: now, currency: 'USD',
      }),
      commandHash: 'attacker-controlled',
    });
    expect(result).toMatchObject({ kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID' });
  });
});
