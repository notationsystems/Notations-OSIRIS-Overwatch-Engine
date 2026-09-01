/** Replayable commercial-position workflow for inventory, allocations, sales, and fulfillment. */

import { createHash } from 'node:crypto';
import type {
  CommercialEvent,
  CommercialEventStore,
  CommercialMoney,
  CommercialMoneyState,
  CommercialQuantity,
  CustomerCommitment,
  CustomerDelivery,
  InventoryAllocation,
  InventoryLot,
  InventoryLotCostUpdate,
  SaleContract,
  SaleFulfillment,
  SaleSettlement,
  StoredCommercialRecord,
} from './commercialStore';
import { hashCommand } from './commercialStore';
import { stableValue } from './loadOperationsStore';
import type { ISODateTime } from './types';

export type CommercialRefusal = {
  readonly kind: 'refusal';
  readonly code:
    | 'COMMERCIAL_COMMAND_INVALID'
    | 'COMMERCIAL_EVENT_ID_CONFLICT'
    | 'COMMERCIAL_STORE_CONCURRENT_WRITE'
    | 'COMMERCIAL_STORE_CORRUPT'
    | 'COMMERCIAL_STORE_UNAVAILABLE'
    | 'INVENTORY_SOURCE_DUPLICATE'
    | 'INVENTORY_LOT_NOT_FOUND'
    | 'CUSTOMER_COMMITMENT_DUPLICATE'
    | 'CUSTOMER_COMMITMENT_NOT_FOUND'
    | 'INVENTORY_ALLOCATION_REFUSED'
    | 'SALE_CONTRACT_REFUSED'
    | 'SALE_FULFILLMENT_REFUSED'
    | 'CUSTOMER_DELIVERY_REFUSED'
    | 'SALE_SETTLEMENT_REFUSED';
  readonly detail: string;
  readonly remedy: string;
};

export type CommercialPhase =
  | 'allocation_pending'
  | 'contract_pending'
  | 'dispatch_pending'
  | 'delivery_pending'
  | 'delivery_exception'
  | 'settlement_pending'
  | 'settled';

export type InventoryLotSnapshot = {
  readonly lot: InventoryLot;
  readonly allocatedAmount: number;
  readonly availableAmount: number;
  readonly dispatchedAmount: number;
  readonly deliveredAmount: number;
};

export type MarginExposure =
  | {
      readonly kind: 'complete';
      readonly revenueMinor: number;
      readonly allocatedCostMinor: number;
      readonly grossMarginMinor: number;
      readonly currency: string;
      readonly revenueBasis: 'contracted' | 'settled_net';
      readonly costBasis: 'proportional_received_quantity';
      readonly rounding: 'nearest_minor_unit';
      readonly evidenceIds: readonly string[];
    }
  | {
      readonly kind: 'incomplete';
      readonly reason: 'cost_not_observed' | 'revenue_not_observed' | 'deductions_not_observed' | 'currency_conflict';
      readonly missingLotIds: readonly string[];
      readonly detail: string;
      readonly remedy: string;
      readonly evidenceIds: readonly string[];
    };

export type CustomerCommitmentSnapshot = {
  readonly commitment: CustomerCommitment;
  readonly phase: CommercialPhase;
  readonly allocations: readonly InventoryAllocation[];
  readonly allocatedAmount: number;
  readonly remainingAmount: number;
  readonly contract: SaleContract | null;
  readonly fulfillment: SaleFulfillment | null;
  readonly deliveries: readonly CustomerDelivery[];
  readonly acceptedDeliveryAmount: number;
  readonly settlement: SaleSettlement | null;
  readonly settlementEventId: string | null;
  readonly expectedMargin: MarginExposure | null;
  readonly realizedMargin: MarginExposure | null;
};

export type CommercialBookSnapshot = {
  readonly kind: 'commercial_book_snapshot';
  readonly durability: CommercialEventStore['durability'];
  readonly stateSnapshotId: string;
  readonly lots: readonly InventoryLotSnapshot[];
  readonly commitments: readonly CustomerCommitmentSnapshot[];
};

export type CommercialCommandResult =
  | { readonly kind: 'accepted'; readonly persistence: 'appended' | 'duplicate'; readonly book: CommercialBookSnapshot }
  | CommercialRefusal;

type CommercialCommandBase = {
  readonly eventId: string;
  readonly recordedAt: ISODateTime;
};

export type OpenInventoryLotCommand = CommercialCommandBase & { readonly lot: InventoryLot };
export type RefreshInventoryLotCostCommand = CommercialCommandBase & { readonly update: InventoryLotCostUpdate };
export type RegisterCustomerCommitmentCommand = CommercialCommandBase & { readonly commitment: CustomerCommitment };
export type ReserveInventoryCommand = CommercialCommandBase & { readonly allocation: InventoryAllocation; readonly stateSnapshotId: string };
export type CommitSaleContractCommand = CommercialCommandBase & { readonly contract: SaleContract };
export type DispatchSaleFulfillmentCommand = CommercialCommandBase & { readonly fulfillment: SaleFulfillment };
export type RecordCustomerDeliveryCommand = CommercialCommandBase & { readonly delivery: CustomerDelivery };
export type CaptureSaleSettlementCommand = CommercialCommandBase & { readonly settlement: SaleSettlement };

type Projection = {
  lots: Map<string, InventoryLot>;
  commitments: Map<string, CustomerCommitment>;
  allocations: InventoryAllocation[];
  contracts: Map<string, SaleContract>;
  fulfillments: Map<string, SaleFulfillment>;
  deliveries: CustomerDelivery[];
  settlements: Map<string, SaleSettlement>;
  settlementEventIds: Map<string, string>;
  lotCostEventIds: Map<string, string>;
};

class ProjectionDefect extends Error {}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function refusal(code: CommercialRefusal['code'], detail: string, remedy: string): CommercialRefusal {
  return freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function isRefusal<T>(value: T | CommercialRefusal): value is CommercialRefusal {
  return !!value && typeof value === 'object' && 'kind' in value && (value as { kind?: string }).kind === 'refusal';
}

function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function validIds(values: readonly string[]): boolean { return values.length > 0 && values.every(value => !!value?.trim()); }
function validCurrency(value: string): boolean { return /^[A-Z]{3}$/.test(value); }
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function quantityDefect(value: CommercialQuantity): string | null {
  if (!Number.isFinite(value.amount) || value.amount <= 0) return 'quantity must be positive and finite';
  if (!value.unit || !validIds(value.evidenceIds)) return 'quantity unit or evidence is missing';
  if (!Number.isSafeInteger(value.attestation?.inputCount) || value.attestation.inputCount < 1) return 'quantity attestation is missing';
  return null;
}

function moneyDefect(value: CommercialMoney): string | null {
  if (!Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0) return 'money must be a non-negative integer number of minor units';
  if (!validCurrency(value.currency) || !validIds(value.evidenceIds)) return 'money currency or evidence is invalid';
  if (!Number.isSafeInteger(value.attestation?.inputCount) || value.attestation.inputCount < 1) return 'money attestation is missing';
  return null;
}

function moneyStateDefect(value: CommercialMoneyState): string | null {
  if (value.kind === 'observed') return moneyDefect(value.value);
  return value.detail?.trim() && value.remedy?.trim() && validIds(value.evidenceIds) ? null : 'typed missing money lacks detail, remedy, or evidence';
}

function windowDefect(value: { start: ISODateTime; end: ISODateTime }): string | null {
  return validTime(value.start) && validTime(value.end) && Date.parse(value.start) <= Date.parse(value.end) ? null : 'time window is invalid';
}

function commandIntent(value: Record<string, unknown>): string {
  const stable = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'recordedAt'));
  return hashCommand(stable);
}

function project(records: readonly StoredCommercialRecord[]): Projection {
  const projection: Projection = {
    lots: new Map(), commitments: new Map(), allocations: [], contracts: new Map(), fulfillments: new Map(),
    deliveries: [], settlements: new Map(), settlementEventIds: new Map(), lotCostEventIds: new Map(),
  };
  const allocationIds = new Set<string>();
  const saleContractIds = new Set<string>();
  const fulfillmentIds = new Set<string>();
  const deliveryIds = new Set<string>();
  for (const record of records) {
    const event = record.event;
    if (!validTime(event.recordedAt) || !/^[a-f0-9]{64}$/.test(event.commandHash)) throw new ProjectionDefect(`${event.eventId} has invalid event metadata`);
    const recorded = Date.parse(event.recordedAt);
    if (event.kind === 'inventory_lot_opened') {
      const lot = event.lot;
      if (projection.lots.has(lot.lotId) || [...projection.lots.values()].some(item => item.sourcePositionId === lot.sourcePositionId) ||
          !lot.sourceProcurementId?.trim() || !lot.sourcePositionId?.trim() || !lot.sourceSnapshotId?.trim() || !lot.materialId?.trim() ||
          !lot.specificationId?.trim() || !lot.locationId?.trim() || quantityDefect(lot.initialQuantity) || !validTime(lot.receivedAt) ||
          !validTime(lot.openedAt) || Date.parse(lot.receivedAt) > Date.parse(lot.openedAt) || Date.parse(lot.openedAt) > recorded ||
          moneyStateDefect(lot.totalLandedCost) || !validIds(lot.evidenceIds)) throw new ProjectionDefect(`${event.eventId} inventory lot is duplicate or invalid`);
      projection.lots.set(lot.lotId, lot);
      projection.lotCostEventIds.set(lot.lotId, event.eventId);
    }
    if (event.kind === 'inventory_lot_cost_updated') {
      const update = event.update;
      const lot = projection.lots.get(update.lotId);
      if (!lot || update.sourceProcurementId !== lot.sourceProcurementId || update.sourcePositionId !== lot.sourcePositionId ||
          !update.sourceSnapshotId?.trim() || update.sourceSnapshotId === lot.sourceSnapshotId || moneyDefect(update.totalLandedCost) ||
          !validTime(update.updatedAt) || Date.parse(update.updatedAt) > recorded || !validIds(update.evidenceIds) ||
          event.supersedesEventId !== projection.lotCostEventIds.get(update.lotId)) {
        throw new ProjectionDefect(`${event.eventId} inventory cost update is unbound or does not supersede the current source snapshot`);
      }
      projection.lots.set(update.lotId, freeze({
        ...lot,
        sourceSnapshotId: update.sourceSnapshotId,
        totalLandedCost: { kind: 'observed' as const, value: update.totalLandedCost },
        evidenceIds: [...new Set([...lot.evidenceIds, ...update.evidenceIds])],
      }));
      projection.lotCostEventIds.set(update.lotId, event.eventId);
    }
    if (event.kind === 'customer_commitment_registered') {
      const commitment = event.commitment;
      if (projection.commitments.has(commitment.commitmentId) || !commitment.customerId?.trim() || !commitment.customerPurchaseOrderId?.trim() ||
          !commitment.materialId?.trim() || !commitment.specificationId?.trim() || !commitment.destinationId?.trim() ||
          quantityDefect(commitment.requiredQuantity) || windowDefect(commitment.deliveryWindow) || moneyStateDefect(commitment.minimumRevenue) ||
          !validTime(commitment.requestedAt) || Date.parse(commitment.requestedAt) > recorded || !validIds(commitment.evidenceIds)) {
        throw new ProjectionDefect(`${event.eventId} customer commitment is duplicate or invalid`);
      }
      projection.commitments.set(commitment.commitmentId, commitment);
    }
    if (event.kind === 'inventory_allocation_reserved') {
      const allocation = event.allocation;
      const lot = projection.lots.get(allocation.lotId);
      const commitment = projection.commitments.get(allocation.commitmentId);
      const lotAllocated = projection.allocations.filter(item => item.lotId === allocation.lotId).reduce((sum, item) => sum + item.quantity.amount, 0);
      const commitmentAllocated = projection.allocations.filter(item => item.commitmentId === allocation.commitmentId).reduce((sum, item) => sum + item.quantity.amount, 0);
      if (!lot || !commitment || allocationIds.has(allocation.allocationId) || projection.contracts.has(allocation.commitmentId) ||
          lot.materialId !== commitment.materialId || lot.specificationId !== commitment.specificationId ||
          allocation.quantity.unit !== lot.initialQuantity.unit || allocation.quantity.unit !== commitment.requiredQuantity.unit ||
          quantityDefect(allocation.quantity) || lotAllocated + allocation.quantity.amount > lot.initialQuantity.amount ||
          commitmentAllocated + allocation.quantity.amount > commitment.requiredQuantity.amount || !allocation.authorizedBy?.trim() ||
          !validTime(allocation.reservedAt) || Date.parse(allocation.reservedAt) > recorded || !validIds(allocation.evidenceIds)) {
        throw new ProjectionDefect(`${event.eventId} allocation is unbound, stale, or exceeds an inventory/customer balance`);
      }
      allocationIds.add(allocation.allocationId);
      projection.allocations.push(allocation);
    }
    if (event.kind === 'sale_contract_committed') {
      const contract = event.contract;
      const commitment = projection.commitments.get(contract.commitmentId);
      const allocations = projection.allocations.filter(item => item.commitmentId === contract.commitmentId);
      const allocated = allocations.reduce((sum, item) => sum + item.quantity.amount, 0);
      if (!commitment || projection.contracts.has(contract.commitmentId) || saleContractIds.has(contract.saleContractId) ||
          contract.customerId !== commitment.customerId || !sameIds(contract.allocationIds, allocations.map(item => item.allocationId)) ||
          allocated !== commitment.requiredQuantity.amount || contract.contractedQuantity.amount !== allocated ||
          contract.contractedQuantity.unit !== commitment.requiredQuantity.unit || quantityDefect(contract.contractedQuantity) ||
          moneyDefect(contract.totalRevenue) || !contract.incoterm?.trim() || !contract.titleTransferPoint?.trim() ||
          !contract.authorizedBy?.trim() || !validTime(contract.signedAt) || Date.parse(contract.signedAt) < Date.parse(commitment.requestedAt) ||
          Date.parse(contract.signedAt) > recorded || !validIds(contract.evidenceIds) ||
          (commitment.minimumRevenue.kind === 'observed' && (commitment.minimumRevenue.value.currency !== contract.totalRevenue.currency || commitment.minimumRevenue.value.amountMinor > contract.totalRevenue.amountMinor))) {
        throw new ProjectionDefect(`${event.eventId} sale contract is not exactly bound to the fulfilled customer requirement`);
      }
      saleContractIds.add(contract.saleContractId);
      projection.contracts.set(contract.commitmentId, contract);
    }
    if (event.kind === 'sale_fulfillment_dispatched') {
      const fulfillment = event.fulfillment;
      const commitment = projection.commitments.get(fulfillment.commitmentId);
      const contract = projection.contracts.get(fulfillment.commitmentId);
      const allocationLots = contract?.allocationIds.map(id => projection.allocations.find(item => item.allocationId === id)!) ?? [];
      const expectedOrigins = [...new Set(allocationLots.map(item => projection.lots.get(item.lotId)!.locationId))];
      if (!commitment || !contract || projection.fulfillments.has(fulfillment.commitmentId) || fulfillmentIds.has(fulfillment.fulfillmentId) ||
          fulfillment.saleContractId !== contract.saleContractId || !sameIds(fulfillment.allocationIds, contract.allocationIds) ||
          !sameIds(fulfillment.originLocationIds, expectedOrigins) || fulfillment.destinationId !== commitment.destinationId ||
          !fulfillment.loadOperationId?.trim() || !fulfillment.authorizedBy?.trim() || !validTime(fulfillment.dispatchedAt) ||
          Date.parse(fulfillment.dispatchedAt) < Date.parse(contract.signedAt) || Date.parse(fulfillment.dispatchedAt) > recorded ||
          !validIds(fulfillment.evidenceIds)) throw new ProjectionDefect(`${event.eventId} fulfillment is unbound or invalid`);
      fulfillmentIds.add(fulfillment.fulfillmentId);
      projection.fulfillments.set(fulfillment.commitmentId, fulfillment);
    }
    if (event.kind === 'customer_delivery_recorded') {
      const delivery = event.delivery;
      const commitment = projection.commitments.get(delivery.commitmentId);
      const fulfillment = projection.fulfillments.get(delivery.commitmentId);
      const allocation = projection.allocations.find(item => item.allocationId === delivery.allocationId);
      const prior = projection.deliveries.filter(item => item.allocationId === delivery.allocationId).reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
      if (!commitment || !fulfillment || !allocation || !fulfillment.allocationIds.includes(delivery.allocationId) || deliveryIds.has(delivery.deliveryId) ||
          delivery.fulfillmentId !== fulfillment.fulfillmentId || delivery.deliveredQuantity.unit !== allocation.quantity.unit ||
          quantityDefect(delivery.deliveredQuantity) || prior + delivery.deliveredQuantity.amount > allocation.quantity.amount ||
          delivery.locationId !== commitment.destinationId || !validTime(delivery.deliveredAt) ||
          Date.parse(delivery.deliveredAt) < Date.parse(fulfillment.dispatchedAt) || Date.parse(delivery.deliveredAt) > recorded ||
          !validIds(delivery.evidenceIds)) throw new ProjectionDefect(`${event.eventId} customer delivery is unbound, future-dated, or exceeds its allocation`);
      deliveryIds.add(delivery.deliveryId);
      projection.deliveries.push(delivery);
    }
    if (event.kind === 'sale_settlement_captured') {
      const settlement = event.settlement;
      const contract = projection.contracts.get(settlement.commitmentId);
      const accepted = projection.deliveries.filter(item => item.commitmentId === settlement.commitmentId && item.disposition === 'accepted')
        .reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
      const latestAccepted = projection.deliveries.filter(item => item.commitmentId === settlement.commitmentId && item.disposition === 'accepted')
        .reduce((latest, item) => Math.max(latest, Date.parse(item.deliveredAt)), -Infinity);
      const priorEventId = projection.settlementEventIds.get(settlement.commitmentId) ?? null;
      if (!contract || settlement.saleContractId !== contract.saleContractId || accepted < contract.contractedQuantity.amount ||
          moneyStateDefect(settlement.grossRevenue) || moneyStateDefect(settlement.deductions) || !validTime(settlement.knownAt) ||
          Date.parse(settlement.knownAt) < latestAccepted || Date.parse(settlement.knownAt) > recorded ||
          event.supersedesEventId !== priorEventId || !validIds(settlement.evidenceIds)) throw new ProjectionDefect(`${event.eventId} settlement is unbound or does not supersede the current revision`);
      if (settlement.grossRevenue.kind === 'observed' && settlement.grossRevenue.value.currency !== contract.totalRevenue.currency) throw new ProjectionDefect(`${event.eventId} settlement revenue currency conflicts with the sale contract`);
      if (settlement.grossRevenue.kind === 'observed' && settlement.deductions.kind === 'observed' && settlement.grossRevenue.value.currency !== settlement.deductions.value.currency) throw new ProjectionDefect(`${event.eventId} settlement revenue and deductions use different currencies`);
      projection.settlements.set(settlement.commitmentId, settlement);
      projection.settlementEventIds.set(settlement.commitmentId, event.eventId);
    }
  }
  return projection;
}

function stateId(projection: Projection): string {
  const state = {
    lots: [...projection.lots.values()], commitments: [...projection.commitments.values()], allocations: projection.allocations,
    contracts: [...projection.contracts.values()], fulfillments: [...projection.fulfillments.values()], deliveries: projection.deliveries,
    settlements: [...projection.settlements.values()], lotCostEventIds: [...projection.lotCostEventIds.entries()],
  };
  return `commercial-state:${createHash('sha256').update(JSON.stringify(stableValue(state))).digest('hex')}`;
}

function allocatedCost(projection: Projection, allocations: readonly InventoryAllocation[], revenue: CommercialMoney): MarginExposure {
  const missingLotIds: string[] = [];
  const costs: { amountMinor: number; currency: string; evidenceIds: readonly string[] }[] = [];
  for (const allocation of allocations) {
    const lot = projection.lots.get(allocation.lotId)!;
    if (lot.totalLandedCost.kind === 'absent') { missingLotIds.push(lot.lotId); continue; }
    costs.push({
      amountMinor: Math.round(lot.totalLandedCost.value.amountMinor * allocation.quantity.amount / lot.initialQuantity.amount),
      currency: lot.totalLandedCost.value.currency,
      evidenceIds: lot.totalLandedCost.value.evidenceIds,
    });
  }
  const evidenceIds = [...new Set([...revenue.evidenceIds, ...costs.flatMap(item => item.evidenceIds)])];
  if (missingLotIds.length) return freeze({
    kind: 'incomplete' as const, reason: 'cost_not_observed' as const, missingLotIds,
    detail: `Allocated landed cost is not observed for ${missingLotIds.join(', ')}.`,
    remedy: 'Complete the source procurement settlement before treating margin as known.', evidenceIds,
  });
  const currencies = new Set(costs.map(item => item.currency));
  if (currencies.size !== 1 || !currencies.has(revenue.currency)) return freeze({
    kind: 'incomplete' as const, reason: 'currency_conflict' as const, missingLotIds: [],
    detail: 'Contract revenue and allocated inventory cost do not share one evidenced currency.',
    remedy: 'Attach a dated FX conversion basis before calculating margin.', evidenceIds,
  });
  const allocatedCostMinor = costs.reduce((sum, item) => sum + item.amountMinor, 0);
  return freeze({
    kind: 'complete' as const, revenueMinor: revenue.amountMinor, allocatedCostMinor,
    grossMarginMinor: revenue.amountMinor - allocatedCostMinor, currency: revenue.currency,
    revenueBasis: 'contracted' as const, costBasis: 'proportional_received_quantity' as const,
    rounding: 'nearest_minor_unit' as const, evidenceIds,
  });
}

function realizedMargin(expected: MarginExposure | null, settlement: SaleSettlement | null): MarginExposure | null {
  if (!settlement) return null;
  const evidenceIds = [...new Set([
    ...(settlement.grossRevenue.kind === 'observed' ? settlement.grossRevenue.value.evidenceIds : settlement.grossRevenue.evidenceIds),
    ...(settlement.deductions.kind === 'observed' ? settlement.deductions.value.evidenceIds : settlement.deductions.evidenceIds),
    ...(expected?.evidenceIds ?? []),
  ])];
  if (settlement.grossRevenue.kind === 'absent') return freeze({ kind: 'incomplete' as const, reason: 'revenue_not_observed' as const, missingLotIds: [], detail: 'Settled gross revenue is not observed.', remedy: 'Attach remittance or receivable evidence.', evidenceIds });
  if (settlement.deductions.kind === 'absent') return freeze({ kind: 'incomplete' as const, reason: 'deductions_not_observed' as const, missingLotIds: [], detail: 'Settlement deductions are not observed.', remedy: 'Attach deductions evidence, including an evidenced zero.', evidenceIds });
  if (!expected || expected.kind === 'incomplete') return expected;
  if (settlement.grossRevenue.value.currency !== settlement.deductions.value.currency || settlement.grossRevenue.value.currency !== expected.currency) return freeze({ kind: 'incomplete' as const, reason: 'currency_conflict' as const, missingLotIds: [], detail: 'Settled revenue, deductions, and inventory cost use different currencies.', remedy: 'Attach a dated FX basis before calculating realized margin.', evidenceIds });
  const revenueMinor = settlement.grossRevenue.value.amountMinor - settlement.deductions.value.amountMinor;
  return freeze({ ...expected, revenueMinor, grossMarginMinor: revenueMinor - expected.allocatedCostMinor, revenueBasis: 'settled_net' as const, evidenceIds });
}

function snapshot(projection: Projection, durability: CommercialEventStore['durability']): CommercialBookSnapshot {
  const lots = [...projection.lots.values()].map(lot => {
    const allocations = projection.allocations.filter(item => item.lotId === lot.lotId);
    const allocatedAmount = allocations.reduce((sum, item) => sum + item.quantity.amount, 0);
    const dispatchedIds = new Set([...projection.fulfillments.values()].flatMap(item => item.allocationIds));
    const dispatchedAmount = allocations.filter(item => dispatchedIds.has(item.allocationId)).reduce((sum, item) => sum + item.quantity.amount, 0);
    const deliveredAmount = projection.deliveries.filter(item => allocations.some(allocation => allocation.allocationId === item.allocationId))
      .reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
    return freeze({ lot, allocatedAmount, availableAmount: lot.initialQuantity.amount - allocatedAmount, dispatchedAmount, deliveredAmount });
  });
  const commitments = [...projection.commitments.values()].map(commitment => {
    const allocations = projection.allocations.filter(item => item.commitmentId === commitment.commitmentId);
    const allocatedAmount = allocations.reduce((sum, item) => sum + item.quantity.amount, 0);
    const contract = projection.contracts.get(commitment.commitmentId) ?? null;
    const fulfillment = projection.fulfillments.get(commitment.commitmentId) ?? null;
    const deliveries = projection.deliveries.filter(item => item.commitmentId === commitment.commitmentId);
    const acceptedDeliveryAmount = deliveries.filter(item => item.disposition === 'accepted').reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
    const hasException = deliveries.some(item => item.disposition !== 'accepted');
    const settlement = projection.settlements.get(commitment.commitmentId) ?? null;
    const phase: CommercialPhase = allocatedAmount < commitment.requiredQuantity.amount ? 'allocation_pending'
      : !contract ? 'contract_pending' : !fulfillment ? 'dispatch_pending'
        : acceptedDeliveryAmount < commitment.requiredQuantity.amount ? hasException ? 'delivery_exception' : 'delivery_pending'
          : !settlement ? 'settlement_pending' : 'settled';
    const expectedMargin = contract ? allocatedCost(projection, allocations, contract.totalRevenue) : null;
    return freeze({
      commitment, phase, allocations, allocatedAmount,
      remainingAmount: commitment.requiredQuantity.amount - allocatedAmount,
      contract, fulfillment, deliveries, acceptedDeliveryAmount, settlement,
      settlementEventId: projection.settlementEventIds.get(commitment.commitmentId) ?? null,
      expectedMargin, realizedMargin: realizedMargin(expectedMargin, settlement),
    });
  });
  return freeze({ kind: 'commercial_book_snapshot' as const, durability, stateSnapshotId: stateId(projection), lots, commitments });
}

export class CommercialWorkflow {
  constructor(private readonly store: CommercialEventStore) {}

  async getBook(): Promise<CommercialBookSnapshot | CommercialRefusal> {
    const loaded = await this.load();
    return isRefusal(loaded) ? loaded : snapshot(loaded.projection, this.store.durability);
  }

  async getCommitment(commitmentId: string): Promise<CustomerCommitmentSnapshot | CommercialRefusal> {
    const book = await this.getBook();
    if (isRefusal(book)) return book;
    return book.commitments.find(item => item.commitment.commitmentId === commitmentId)
      ?? refusal('CUSTOMER_COMMITMENT_NOT_FOUND', `${commitmentId} is not registered.`, 'Register the customer commitment first.');
  }

  async openLot(command: OpenInventoryLotCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as OpenInventoryLotCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'inventory_lot_opened', intent, loaded.projection);
    if (retry) return retry;
    const lot = command.lot;
    if (loaded.projection.lots.has(lot.lotId) || [...loaded.projection.lots.values()].some(item => item.sourcePositionId === lot.sourcePositionId)) return refusal('INVENTORY_SOURCE_DUPLICATE', 'This procurement position already opened an inventory lot.', 'Operate the existing lot; one source position cannot be counted twice.');
    if (!lot.lotId?.trim() || !lot.sourceProcurementId?.trim() || !lot.sourcePositionId?.trim() || !lot.sourceSnapshotId?.trim() || !lot.materialId?.trim() || !lot.specificationId?.trim() || !lot.locationId?.trim() || quantityDefect(lot.initialQuantity) || !validTime(lot.receivedAt) || !validTime(lot.openedAt) || Date.parse(lot.receivedAt) > Date.parse(lot.openedAt) || Date.parse(lot.openedAt) > Date.parse(command.recordedAt) || moneyStateDefect(lot.totalLandedCost) || !validIds(lot.evidenceIds)) return refusal('COMMERCIAL_COMMAND_INVALID', 'Inventory lot source, quantity, timing, cost basis, or evidence is invalid.', 'Open the lot only from the exact accepted procurement position snapshot.');
    return this.append(loaded.records, { kind: 'inventory_lot_opened', eventId: command.eventId, operationId: lot.lotId, recordedAt: command.recordedAt, commandHash: intent, lot });
  }

  async refreshLotCost(command: RefreshInventoryLotCostCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RefreshInventoryLotCostCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'inventory_lot_cost_updated', intent, loaded.projection);
    if (retry) return retry;
    const update = command.update;
    const lot = loaded.projection.lots.get(update.lotId);
    if (!lot) return refusal('INVENTORY_LOT_NOT_FOUND', `${update.lotId} is not registered.`, 'Open the accepted procurement position as inventory first.');
    if (update.sourceProcurementId !== lot.sourceProcurementId || update.sourcePositionId !== lot.sourcePositionId ||
        !update.sourceSnapshotId?.trim() || update.sourceSnapshotId === lot.sourceSnapshotId || moneyDefect(update.totalLandedCost) ||
        !validTime(update.updatedAt) || Date.parse(update.updatedAt) > Date.parse(command.recordedAt) || !validIds(update.evidenceIds)) {
      return refusal('COMMERCIAL_COMMAND_INVALID', 'Inventory cost refresh is stale, unbound, or lacks complete landed-cost evidence.', 'Refresh from a newer complete procurement snapshot for the exact source position.');
    }
    return this.append(loaded.records, {
      kind: 'inventory_lot_cost_updated', eventId: command.eventId, operationId: update.lotId,
      recordedAt: command.recordedAt, commandHash: intent, update,
      supersedesEventId: loaded.projection.lotCostEventIds.get(update.lotId)!,
    });
  }

  async registerCommitment(command: RegisterCustomerCommitmentCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RegisterCustomerCommitmentCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'customer_commitment_registered', intent, loaded.projection);
    if (retry) return retry;
    const value = command.commitment;
    if (loaded.projection.commitments.has(value.commitmentId)) return refusal('CUSTOMER_COMMITMENT_DUPLICATE', `${value.commitmentId} already exists.`, 'Operate the existing customer commitment or use a new canonical identity.');
    if (!value.commitmentId?.trim() || !value.customerId?.trim() || !value.customerPurchaseOrderId?.trim() || !value.materialId?.trim() || !value.specificationId?.trim() || !value.destinationId?.trim() || quantityDefect(value.requiredQuantity) || windowDefect(value.deliveryWindow) || moneyStateDefect(value.minimumRevenue) || !validTime(value.requestedAt) || Date.parse(value.requestedAt) > Date.parse(command.recordedAt) || !validIds(value.evidenceIds)) return refusal('COMMERCIAL_COMMAND_INVALID', 'Customer, material, quantity, delivery, revenue, timing, or evidence is invalid.', 'Correct the customer commitment before accepting demand into the book.');
    return this.append(loaded.records, { kind: 'customer_commitment_registered', eventId: command.eventId, operationId: value.commitmentId, recordedAt: command.recordedAt, commandHash: intent, commitment: value });
  }

  async reserveInventory(command: ReserveInventoryCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as ReserveInventoryCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'inventory_allocation_reserved', intent, loaded.projection);
    if (retry) return retry;
    const allocation = command.allocation;
    const lot = loaded.projection.lots.get(allocation.lotId);
    const commitment = loaded.projection.commitments.get(allocation.commitmentId);
    if (!lot) return refusal('INVENTORY_LOT_NOT_FOUND', `${allocation.lotId} is not registered.`, 'Choose an inventory lot exposed by the commercial desk.');
    if (!commitment) return refusal('CUSTOMER_COMMITMENT_NOT_FOUND', `${allocation.commitmentId} is not registered.`, 'Choose a registered customer commitment.');
    const lotAllocated = loaded.projection.allocations.filter(item => item.lotId === allocation.lotId).reduce((sum, item) => sum + item.quantity.amount, 0);
    const commitmentAllocated = loaded.projection.allocations.filter(item => item.commitmentId === allocation.commitmentId).reduce((sum, item) => sum + item.quantity.amount, 0);
    if (command.stateSnapshotId !== stateId(loaded.projection) || loaded.projection.contracts.has(allocation.commitmentId) || lot.materialId !== commitment.materialId || lot.specificationId !== commitment.specificationId || allocation.quantity.unit !== lot.initialQuantity.unit || allocation.quantity.unit !== commitment.requiredQuantity.unit || quantityDefect(allocation.quantity) || lotAllocated + allocation.quantity.amount > lot.initialQuantity.amount || commitmentAllocated + allocation.quantity.amount > commitment.requiredQuantity.amount || !allocation.authorizedBy?.trim() || !validTime(allocation.reservedAt) || Date.parse(allocation.reservedAt) > Date.parse(command.recordedAt) || !validIds(allocation.evidenceIds)) return refusal('INVENTORY_ALLOCATION_REFUSED', 'Allocation is stale, incompatible, or exceeds available inventory/customer demand.', 'Reload the commercial book and reserve only the visible compatible balance.');
    return this.append(loaded.records, { kind: 'inventory_allocation_reserved', eventId: command.eventId, operationId: allocation.commitmentId, recordedAt: command.recordedAt, commandHash: intent, allocation });
  }

  async commitSale(command: CommitSaleContractCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as CommitSaleContractCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'sale_contract_committed', intent, loaded.projection);
    if (retry) return retry;
    const contract = command.contract;
    const commitment = loaded.projection.commitments.get(contract.commitmentId);
    const allocations = loaded.projection.allocations.filter(item => item.commitmentId === contract.commitmentId);
    const allocated = allocations.reduce((sum, item) => sum + item.quantity.amount, 0);
    if (!commitment || loaded.projection.contracts.has(contract.commitmentId) || contract.customerId !== commitment.customerId || !sameIds(contract.allocationIds, allocations.map(item => item.allocationId)) || allocated !== commitment.requiredQuantity.amount || contract.contractedQuantity.amount !== allocated || contract.contractedQuantity.unit !== commitment.requiredQuantity.unit || quantityDefect(contract.contractedQuantity) || moneyDefect(contract.totalRevenue) || !contract.incoterm?.trim() || !contract.titleTransferPoint?.trim() || !contract.authorizedBy?.trim() || !validTime(contract.signedAt) || Date.parse(contract.signedAt) < Date.parse(commitment.requestedAt) || Date.parse(contract.signedAt) > Date.parse(command.recordedAt) || !validIds(contract.evidenceIds) || (commitment.minimumRevenue.kind === 'observed' && (commitment.minimumRevenue.value.currency !== contract.totalRevenue.currency || commitment.minimumRevenue.value.amountMinor > contract.totalRevenue.amountMinor))) return refusal('SALE_CONTRACT_REFUSED', 'Sale contract is not exactly bound to the fully allocated commitment or violates the revenue floor.', 'Complete allocation and bind the signed customer contract to the exact reservation set.');
    return this.append(loaded.records, { kind: 'sale_contract_committed', eventId: command.eventId, operationId: contract.commitmentId, recordedAt: command.recordedAt, commandHash: intent, contract });
  }

  async dispatchFulfillment(command: DispatchSaleFulfillmentCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as DispatchSaleFulfillmentCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'sale_fulfillment_dispatched', intent, loaded.projection);
    if (retry) return retry;
    const value = command.fulfillment;
    const commitment = loaded.projection.commitments.get(value.commitmentId);
    const contract = loaded.projection.contracts.get(value.commitmentId);
    const allocations = loaded.projection.allocations.filter(item => item.commitmentId === value.commitmentId);
    const origins = [...new Set(allocations.map(item => loaded.projection.lots.get(item.lotId)!.locationId))];
    if (!commitment || !contract || loaded.projection.fulfillments.has(value.commitmentId) || value.saleContractId !== contract.saleContractId || !sameIds(value.allocationIds, contract.allocationIds) || !sameIds(value.originLocationIds, origins) || value.destinationId !== commitment.destinationId || !value.loadOperationId?.trim() || !value.authorizedBy?.trim() || !validTime(value.dispatchedAt) || Date.parse(value.dispatchedAt) < Date.parse(contract.signedAt) || Date.parse(value.dispatchedAt) > Date.parse(command.recordedAt) || !validIds(value.evidenceIds)) return refusal('SALE_FULFILLMENT_REFUSED', 'Dispatch is not exactly bound to the sale contract, allocations, route, or load operation.', 'Dispatch the current contracted allocation set through one identified load operation.');
    return this.append(loaded.records, { kind: 'sale_fulfillment_dispatched', eventId: command.eventId, operationId: value.commitmentId, recordedAt: command.recordedAt, commandHash: intent, fulfillment: value });
  }

  async recordDelivery(command: RecordCustomerDeliveryCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RecordCustomerDeliveryCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'customer_delivery_recorded', intent, loaded.projection);
    if (retry) return retry;
    const value = command.delivery;
    const commitment = loaded.projection.commitments.get(value.commitmentId);
    const fulfillment = loaded.projection.fulfillments.get(value.commitmentId);
    const allocation = loaded.projection.allocations.find(item => item.allocationId === value.allocationId);
    const prior = loaded.projection.deliveries.filter(item => item.allocationId === value.allocationId).reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
    if (!commitment || !fulfillment || !allocation || !fulfillment.allocationIds.includes(value.allocationId) || value.fulfillmentId !== fulfillment.fulfillmentId || value.deliveredQuantity.unit !== allocation.quantity.unit || quantityDefect(value.deliveredQuantity) || prior + value.deliveredQuantity.amount > allocation.quantity.amount || value.locationId !== commitment.destinationId || !validTime(value.deliveredAt) || Date.parse(value.deliveredAt) < Date.parse(fulfillment.dispatchedAt) || Date.parse(value.deliveredAt) > Date.parse(command.recordedAt) || !validIds(value.evidenceIds)) return refusal('CUSTOMER_DELIVERY_REFUSED', 'Delivery is unbound, future-dated, at the wrong destination, or exceeds its allocation.', 'Capture delivery against the exact allocation and fulfillment displayed by the commercial desk.');
    return this.append(loaded.records, { kind: 'customer_delivery_recorded', eventId: command.eventId, operationId: value.commitmentId, recordedAt: command.recordedAt, commandHash: intent, delivery: value });
  }

  async captureSettlement(command: CaptureSaleSettlementCommand): Promise<CommercialCommandResult> {
    const loaded = await this.load();
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as CaptureSaleSettlementCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.eventId, 'sale_settlement_captured', intent, loaded.projection);
    if (retry) return retry;
    const value = command.settlement;
    const contract = loaded.projection.contracts.get(value.commitmentId);
    const acceptedDeliveries = loaded.projection.deliveries.filter(item => item.commitmentId === value.commitmentId && item.disposition === 'accepted');
    const accepted = acceptedDeliveries.reduce((sum, item) => sum + item.deliveredQuantity.amount, 0);
    const latest = acceptedDeliveries.reduce((time, item) => Math.max(time, Date.parse(item.deliveredAt)), -Infinity);
    if (!contract || value.saleContractId !== contract.saleContractId || accepted < contract.contractedQuantity.amount || moneyStateDefect(value.grossRevenue) || moneyStateDefect(value.deductions) || !validTime(value.knownAt) || Date.parse(value.knownAt) < latest || Date.parse(value.knownAt) > Date.parse(command.recordedAt) || !validIds(value.evidenceIds) || (value.grossRevenue.kind === 'observed' && value.grossRevenue.value.currency !== contract.totalRevenue.currency) || (value.grossRevenue.kind === 'observed' && value.deductions.kind === 'observed' && value.grossRevenue.value.currency !== value.deductions.value.currency)) return refusal('SALE_SETTLEMENT_REFUSED', 'Settlement is unbound, precedes accepted delivery, or has incomplete/conflicting evidence.', 'Complete accepted delivery and capture gross revenue and deductions with one evidenced currency.');
    return this.append(loaded.records, { kind: 'sale_settlement_captured', eventId: command.eventId, operationId: value.commitmentId, recordedAt: command.recordedAt, commandHash: intent, settlement: value, supersedesEventId: loaded.projection.settlementEventIds.get(value.commitmentId) ?? null });
  }

  private async load(): Promise<{ records: readonly StoredCommercialRecord[]; projection: Projection } | CommercialRefusal> {
    let records: readonly StoredCommercialRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return refusal('COMMERCIAL_STORE_UNAVAILABLE', (error as Error).message, 'Restore the configured commercial store before continuing.'); }
    try { return { records, projection: project(records) }; }
    catch (error) { return refusal('COMMERCIAL_STORE_CORRUPT', (error as Error).message, 'Restore from a verified replica; never skip contradictory commercial history.'); }
  }

  private retry(records: readonly StoredCommercialRecord[], eventId: string, kind: CommercialEvent['kind'], intent: string, projection: Projection): CommercialCommandResult | null {
    const existing = records.find(record => record.event.eventId === eventId);
    if (!existing) return null;
    if (existing.event.kind !== kind || existing.event.commandHash !== intent) return refusal('COMMERCIAL_EVENT_ID_CONFLICT', `${eventId} identifies a different commercial intent.`, 'Retry the original request or use a new request identity for changed facts.');
    return { kind: 'accepted', persistence: 'duplicate', book: snapshot(projection, this.store.durability) };
  }

  private async append(records: readonly StoredCommercialRecord[], event: CommercialEvent): Promise<CommercialCommandResult> {
    const appended = await this.store.append(event, records.at(-1)?.recordHash ?? null);
    if (appended.kind === 'refusal') return refusal(appended.code, appended.detail, appended.remedy);
    let next: Projection;
    try { next = project([...records, appended.record]); }
    catch (error) { return refusal('COMMERCIAL_STORE_CORRUPT', (error as Error).message, 'Stop writes and restore from the last verified commercial record.'); }
    return { kind: 'accepted', persistence: appended.kind, book: snapshot(next, this.store.durability) };
  }
}

export function commercialStateSnapshotId(book: CommercialBookSnapshot): string { return book.stateSnapshotId; }
