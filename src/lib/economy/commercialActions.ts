/** Strict business-intent adapter for the PayloadOS commercial-position desk. */

import { z } from 'zod';
import { attestationOf } from './attestation';
import {
  type CommercialBookSnapshot,
  type CommercialCommandResult,
  type CommercialRefusal,
  type CommercialWorkflow,
  type CustomerCommitmentSnapshot,
} from './commercial';
import { hashCommand, type CommercialMoneyState, type CommercialQuantityUnit } from './commercialStore';
import type { ProcurementRefusal, ProcurementSnapshot } from './procurement';
import type { ISODateTime } from './types';

const identifier = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/);
const businessText = z.string().trim().min(1).max(300);
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date and time.');
const amount = z.number().positive().max(1_000_000_000);
const moneyMinor = z.number().int().nonnegative().max(100_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const unit = z.enum(['kg', 'tonne', 'lb', 'unit', 'liter', 'm3']);
const envelope = { requestId: identifier, actorId: identifier, submittedAt: instant };

export const commercialActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('open_inventory_lot'), payload: z.object({
    procurementId: identifier, sourceReference: identifier,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('refresh_inventory_cost'), payload: z.object({
    procurementId: identifier, sourceReference: identifier,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('register_customer_commitment'), payload: z.object({
    commitmentId: identifier, customerId: identifier, customerPurchaseOrderId: identifier,
    materialId: identifier, specificationId: identifier, quantity: amount, unit,
    destinationId: identifier, deliveryStart: instant, deliveryEnd: instant,
    minimumRevenueMinor: moneyMinor.optional(), currency,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('reserve_inventory'), payload: z.object({
    commitmentId: identifier, lotId: identifier, quantity: amount, unit, sourceReference: identifier,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('commit_sale'), payload: z.object({
    commitmentId: identifier, saleContractId: identifier, sourceReference: identifier,
    totalRevenueMinor: moneyMinor, currency, incoterm: businessText,
    titleTransferPoint: businessText, signedAt: instant,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('dispatch_sale'), payload: z.object({
    commitmentId: identifier, sourceReference: identifier, loadOperationId: identifier, dispatchedAt: instant,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('record_customer_delivery'), payload: z.object({
    commitmentId: identifier, allocationId: identifier, sourceReference: identifier,
    quantity: amount, unit, deliveredAt: instant, locationId: identifier,
    disposition: z.enum(['accepted', 'quarantined', 'rejected']),
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('capture_sale_settlement'), payload: z.object({
    commitmentId: identifier, sourceReference: identifier, currency,
    grossRevenueMinor: moneyMinor.optional(), deductionsMinor: moneyMinor.optional(),
  }).strict() }).strict(),
]);

export type CommercialActionRequest = z.infer<typeof commercialActionRequestSchema>;
export type CommercialActionKind = CommercialActionRequest['action'];

export type CommercialActionDescriptor = {
  readonly action: CommercialActionKind;
  readonly label: string;
  readonly summary: string;
  readonly recommended: boolean;
  readonly lots?: readonly { readonly lotId: string; readonly availableAmount: number; readonly unit: CommercialQuantityUnit; readonly locationId: string }[];
  readonly allocations?: readonly { readonly allocationId: string; readonly lotId: string; readonly undeliveredAmount: number; readonly unit: CommercialQuantityUnit }[];
};

export type CommercialCockpitSnapshot = {
  readonly kind: 'commercial_cockpit_snapshot';
  readonly commitment: CustomerCommitmentSnapshot;
  readonly book: CommercialBookSnapshot;
  readonly actions: readonly CommercialActionDescriptor[];
};

export type CommercialActionResult =
  | { readonly kind: 'accepted'; readonly action: CommercialActionKind; readonly persistence: 'appended' | 'duplicate'; readonly book: CommercialBookSnapshot }
  | CommercialRefusal;

export type ProcurementPositionReader = {
  get(procurementId: string): Promise<ProcurementSnapshot | ProcurementRefusal>;
};

const LABELS: Record<CommercialActionKind, [string, string]> = {
  open_inventory_lot: ['Receive procurement into inventory', 'Open one inventory lot from the exact accepted procurement position.'],
  refresh_inventory_cost: ['Refresh inventory cost', 'Append complete landed cost from a newer exact procurement snapshot.'],
  register_customer_commitment: ['Register customer demand', 'Capture the customer, purchase order, specification, quantity, destination, and delivery window.'],
  reserve_inventory: ['Reserve inventory', 'Allocate compatible available lot quantity without overselling inventory or customer demand.'],
  commit_sale: ['Commit sale contract', 'Bind the signed sale to the exact fully reserved allocation set.'],
  dispatch_sale: ['Dispatch customer fulfillment', 'Bind the contracted inventory to an identified freight operation.'],
  record_customer_delivery: ['Record customer delivery', 'Capture delivery quantity and disposition against one exact inventory allocation.'],
  capture_sale_settlement: ['Capture sale settlement', 'Record realized revenue and deductions without treating missing amounts as zero.'],
};

function descriptor(action: CommercialActionKind, recommended: boolean, extra: Partial<CommercialActionDescriptor> = {}): CommercialActionDescriptor {
  return Object.freeze({ action, label: LABELS[action][0], summary: LABELS[action][1], recommended, ...extra });
}

function eventId(request: CommercialActionRequest): string {
  return `commercial:${request.action}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function derivedId(prefix: string, request: CommercialActionRequest): string {
  return `${prefix}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function evidenceId(request: CommercialActionRequest, sourceReference?: string): string {
  return `commercial-evidence:${hashCommand({ requestId: request.requestId, actorId: request.actorId, sourceReference: sourceReference ?? request.action })}`;
}

function reported(note: string, interest: 'self_reported' | 'negotiating_position' = 'self_reported') {
  return attestationOf('reported', 'medium', interest, note);
}

function quantity(amountValue: number, unitValue: CommercialQuantityUnit, evidence: string, note: string) {
  return { amount: amountValue, unit: unitValue, attestation: reported(note), evidenceIds: [evidence] };
}

function observedMoney(amountMinor: number, currencyCode: string, evidence: string, label: string): CommercialMoneyState {
  return { kind: 'observed', value: { amountMinor, currency: currencyCode, attestation: reported(`${label} transcribed by the commercial desk.`, 'negotiating_position'), evidenceIds: [evidence] } };
}

function optionalMoney(amountMinor: number | undefined, currencyCode: string, evidence: string, label: string): CommercialMoneyState {
  return amountMinor === undefined ? {
    kind: 'absent', reason: 'not_observed', detail: `${label} was not present in this action.`,
    remedy: `Attach the ${label} record; enter an evidenced zero only when the actual value is zero.`, evidenceIds: [evidence],
  } : observedMoney(amountMinor, currencyCode, evidence, label);
}

function result(action: CommercialActionKind, value: CommercialCommandResult): CommercialActionResult {
  return value.kind === 'refusal' ? value : Object.freeze({ kind: 'accepted' as const, action, persistence: value.persistence, book: value.book });
}

function isCommercialRefusal(value: unknown): value is CommercialRefusal {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'refusal';
}

function latestAcceptedReceipt(source: ProcurementSnapshot) {
  return source.receipts.filter(receipt => receipt.disposition === 'accepted')
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))[0] ?? null;
}

function procurementPositionSnapshotId(source: ProcurementSnapshot): string {
  return `procurement-position-state:${hashCommand({
    procurementId: source.procurementId,
    purchase: source.purchase,
    position: source.position,
    receipts: source.receipts,
    settlementEventId: source.settlementEventId,
    landedCost: source.landedCost,
  })}`;
}

export class CommercialActions {
  constructor(
    private readonly workflow: CommercialWorkflow,
    private readonly procurement: ProcurementPositionReader,
    private readonly clock: () => ISODateTime = () => new Date().toISOString(),
  ) {}

  async list(): Promise<CommercialBookSnapshot | CommercialRefusal> { return this.workflow.getBook(); }

  async inspect(commitmentId: string): Promise<CommercialCockpitSnapshot | CommercialRefusal> {
    const book = await this.workflow.getBook();
    if (book.kind === 'refusal') return book;
    const commitment = book.commitments.find(item => item.commitment.commitmentId === commitmentId);
    if (!commitment) return { kind: 'refusal', code: 'CUSTOMER_COMMITMENT_NOT_FOUND', detail: `${commitmentId} is not registered.`, remedy: 'Register the customer commitment first.' };
    const actions: CommercialActionDescriptor[] = [];
    if (commitment.phase === 'allocation_pending') {
      const lots = book.lots.filter(item => item.availableAmount > 0 && item.lot.materialId === commitment.commitment.materialId && item.lot.specificationId === commitment.commitment.specificationId && item.lot.initialQuantity.unit === commitment.commitment.requiredQuantity.unit)
        .map(item => ({ lotId: item.lot.lotId, availableAmount: item.availableAmount, unit: item.lot.initialQuantity.unit, locationId: item.lot.locationId }));
      actions.push(descriptor('reserve_inventory', true, { lots }));
    }
    if (commitment.phase === 'contract_pending') actions.push(descriptor('commit_sale', true));
    if (commitment.phase === 'dispatch_pending') actions.push(descriptor('dispatch_sale', true));
    if (commitment.phase === 'delivery_pending' || commitment.phase === 'delivery_exception') {
      const allocations = commitment.allocations.map(allocation => ({
        allocationId: allocation.allocationId, lotId: allocation.lotId,
        undeliveredAmount: allocation.quantity.amount - commitment.deliveries.filter(delivery => delivery.allocationId === allocation.allocationId).reduce((sum, delivery) => sum + delivery.deliveredQuantity.amount, 0),
        unit: allocation.quantity.unit,
      })).filter(item => item.undeliveredAmount > 0);
      actions.push(descriptor('record_customer_delivery', true, { allocations }));
    }
    if (commitment.phase === 'settlement_pending') actions.push(descriptor('capture_sale_settlement', true));
    if (commitment.phase === 'settled' && commitment.realizedMargin?.kind === 'incomplete') actions.push(descriptor('capture_sale_settlement', true));
    return Object.freeze({ kind: 'commercial_cockpit_snapshot' as const, commitment, book, actions: Object.freeze(actions) });
  }

  async execute(input: unknown): Promise<CommercialActionResult> {
    const parsed = commercialActionRequestSchema.safeParse(input);
    if (!parsed.success) return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), remedy: 'Use the typed commercial desk; internal event identities are server-derived.' };
    const request = parsed.data;
    const recordedAt = this.clock();
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(request.submittedAt) > Date.parse(recordedAt) + 60_000) return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: 'Server or submission time is invalid.', remedy: 'Restore the server clock and submit again.' };
    const id = eventId(request);
    switch (request.action) {
      case 'open_inventory_lot': {
        const source = await this.procurement.get(request.payload.procurementId);
        if (source.kind === 'refusal') return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: `Source procurement is unavailable: ${source.detail}`, remedy: source.remedy };
        const purchase = source.purchase;
        const position = source.position;
        const receipt = latestAcceptedReceipt(source);
        const accepted = source.receipts.filter(item => item.disposition === 'accepted').reduce((sum, item) => sum + item.receivedQuantity.amount, 0);
        if (!purchase || !position || !receipt || position.logisticsState !== 'received' || position.qualityState !== 'accepted' || accepted < purchase.quantity.amount) return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: 'Procurement position has not been fully accepted into custody.', remedy: 'Complete the exact procurement receipt before opening inventory.' };
        const evidence = evidenceId(request, request.payload.sourceReference);
        const totalLandedCost: CommercialMoneyState = source.landedCost?.kind === 'complete'
          ? { kind: 'observed', value: { amountMinor: source.landedCost.amountMinor, currency: source.landedCost.currency, attestation: source.landedCost.attestation, evidenceIds: source.landedCost.evidenceIds } }
          : { kind: 'absent', reason: 'pending', detail: 'Source procurement landed cost is not complete.', remedy: 'Complete every procurement settlement cost component before treating inventory margin as known.', evidenceIds: source.landedCost?.evidenceIds ?? [evidence] };
        return result(request.action, await this.workflow.openLot({ eventId: id, recordedAt, lot: {
          lotId: `inventory-lot:${hashCommand({ sourcePositionId: position.positionId })}`,
          sourceProcurementId: source.procurementId, sourcePositionId: position.positionId,
          sourceSnapshotId: procurementPositionSnapshotId(source), materialId: position.materialId,
          specificationId: position.specificationId, initialQuantity: purchase.quantity,
          locationId: receipt.locationId, receivedAt: receipt.receivedAt, totalLandedCost,
          openedAt: request.submittedAt, evidenceIds: [...new Set([evidence, ...receipt.evidenceIds, ...purchase.evidenceIds])],
        } }));
      }
      case 'refresh_inventory_cost': {
        const source = await this.procurement.get(request.payload.procurementId);
        if (source.kind === 'refusal') return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: `Source procurement is unavailable: ${source.detail}`, remedy: source.remedy };
        if (!source.position || source.landedCost?.kind !== 'complete') return { kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID', detail: 'Source procurement does not yet have complete landed cost.', remedy: 'Capture every procurement cost component, including evidenced zeros, before refreshing inventory cost.' };
        const book = await this.workflow.getBook();
        if (book.kind === 'refusal') return book;
        const lot = book.lots.find(item => item.lot.sourceProcurementId === source.procurementId && item.lot.sourcePositionId === source.position!.positionId)?.lot;
        if (!lot) return { kind: 'refusal', code: 'INVENTORY_LOT_NOT_FOUND', detail: 'No inventory lot is bound to this procurement position.', remedy: 'Receive the accepted procurement position into inventory first.' };
        const evidence = evidenceId(request, request.payload.sourceReference);
        return result(request.action, await this.workflow.refreshLotCost({ eventId: id, recordedAt, update: {
          lotId: lot.lotId, sourceProcurementId: source.procurementId, sourcePositionId: source.position.positionId,
          sourceSnapshotId: procurementPositionSnapshotId(source),
          totalLandedCost: { amountMinor: source.landedCost.amountMinor, currency: source.landedCost.currency, attestation: source.landedCost.attestation, evidenceIds: source.landedCost.evidenceIds },
          updatedAt: request.submittedAt, evidenceIds: [...new Set([evidence, ...source.landedCost.evidenceIds])],
        } }));
      }
      case 'register_customer_commitment': {
        const value = request.payload;
        const evidence = evidenceId(request, value.customerPurchaseOrderId);
        return result(request.action, await this.workflow.registerCommitment({ eventId: id, recordedAt, commitment: {
          commitmentId: value.commitmentId, customerId: value.customerId, customerPurchaseOrderId: value.customerPurchaseOrderId,
          materialId: value.materialId, specificationId: value.specificationId,
          requiredQuantity: quantity(value.quantity, value.unit, evidence, 'Customer-required quantity transcribed from the purchase order.'),
          destinationId: value.destinationId, deliveryWindow: { start: value.deliveryStart, end: value.deliveryEnd },
          minimumRevenue: value.minimumRevenueMinor === undefined
            ? { kind: 'absent', reason: 'not_observed', detail: 'Minimum approved revenue was not supplied.', remedy: 'Attach commercial approval before treating the sale as revenue-constrained.', evidenceIds: [evidence] }
            : observedMoney(value.minimumRevenueMinor, value.currency, evidence, 'Minimum approved revenue'),
          requestedAt: request.submittedAt, attestation: reported('Customer commitment entered by an authenticated operator.', 'negotiating_position'), evidenceIds: [evidence],
        } }));
      }
      case 'reserve_inventory': {
        const book = await this.workflow.getBook();
        if (book.kind === 'refusal') return book;
        const evidence = evidenceId(request, request.payload.sourceReference);
        return result(request.action, await this.workflow.reserveInventory({ eventId: id, recordedAt, stateSnapshotId: book.stateSnapshotId, allocation: {
          allocationId: derivedId('inventory-allocation', request), commitmentId: request.payload.commitmentId,
          lotId: request.payload.lotId, quantity: quantity(request.payload.quantity, request.payload.unit, evidence, 'Inventory quantity reserved by the commercial operator.'),
          reservedAt: request.submittedAt, authorizedBy: request.actorId, evidenceIds: [evidence],
        } }));
      }
      case 'commit_sale': {
        const commitment = await this.workflow.getCommitment(request.payload.commitmentId);
        if (isCommercialRefusal(commitment)) return commitment;
        const evidence = evidenceId(request, request.payload.sourceReference);
        return result(request.action, await this.workflow.commitSale({ eventId: id, recordedAt, contract: {
          saleContractId: request.payload.saleContractId, commitmentId: commitment.commitment.commitmentId,
          customerId: commitment.commitment.customerId, allocationIds: commitment.allocations.map(item => item.allocationId),
          contractedQuantity: quantity(commitment.commitment.requiredQuantity.amount, commitment.commitment.requiredQuantity.unit, evidence, 'Contracted quantity bound to the complete allocation set.'),
          totalRevenue: { amountMinor: request.payload.totalRevenueMinor, currency: request.payload.currency, attestation: reported('Contract revenue transcribed from the signed sale.', 'negotiating_position'), evidenceIds: [evidence] },
          incoterm: request.payload.incoterm, titleTransferPoint: request.payload.titleTransferPoint,
          signedAt: request.payload.signedAt, authorizedBy: request.actorId, evidenceIds: [evidence],
        } }));
      }
      case 'dispatch_sale': {
        const commitment = await this.workflow.getCommitment(request.payload.commitmentId);
        if (isCommercialRefusal(commitment)) return commitment;
        if (!commitment.contract) return { kind: 'refusal', code: 'SALE_FULFILLMENT_REFUSED', detail: 'No committed sale contract exists.', remedy: 'Commit the sale first.' };
        const book = await this.workflow.getBook();
        if (book.kind === 'refusal') return book;
        const origins = [...new Set(commitment.allocations.map(allocation => book.lots.find(item => item.lot.lotId === allocation.lotId)!.lot.locationId))];
        return result(request.action, await this.workflow.dispatchFulfillment({ eventId: id, recordedAt, fulfillment: {
          fulfillmentId: derivedId('sale-fulfillment', request), commitmentId: commitment.commitment.commitmentId,
          saleContractId: commitment.contract.saleContractId, allocationIds: commitment.contract.allocationIds,
          originLocationIds: origins, destinationId: commitment.commitment.destinationId,
          loadOperationId: request.payload.loadOperationId, dispatchedAt: request.payload.dispatchedAt,
          authorizedBy: request.actorId, evidenceIds: [evidenceId(request, request.payload.sourceReference)],
        } }));
      }
      case 'record_customer_delivery': {
        const commitment = await this.workflow.getCommitment(request.payload.commitmentId);
        if (isCommercialRefusal(commitment)) return commitment;
        if (!commitment.fulfillment) return { kind: 'refusal', code: 'CUSTOMER_DELIVERY_REFUSED', detail: 'No dispatched fulfillment exists.', remedy: 'Dispatch the contracted fulfillment first.' };
        const evidence = evidenceId(request, request.payload.sourceReference);
        return result(request.action, await this.workflow.recordDelivery({ eventId: id, recordedAt, delivery: {
          deliveryId: derivedId('customer-delivery', request), commitmentId: commitment.commitment.commitmentId,
          fulfillmentId: commitment.fulfillment.fulfillmentId, allocationId: request.payload.allocationId,
          deliveredQuantity: quantity(request.payload.quantity, request.payload.unit, evidence, 'Customer-delivered quantity observed at the destination.'),
          deliveredAt: request.payload.deliveredAt, locationId: request.payload.locationId,
          disposition: request.payload.disposition, attestation: reported('Customer delivery disposition reported by the operator.'), evidenceIds: [evidence],
        } }));
      }
      case 'capture_sale_settlement': {
        const commitment = await this.workflow.getCommitment(request.payload.commitmentId);
        if (isCommercialRefusal(commitment)) return commitment;
        if (!commitment.contract) return { kind: 'refusal', code: 'SALE_SETTLEMENT_REFUSED', detail: 'No sale contract exists.', remedy: 'Commit and fulfill the sale first.' };
        const evidence = evidenceId(request, request.payload.sourceReference);
        return result(request.action, await this.workflow.captureSettlement({ eventId: id, recordedAt, settlement: {
          commitmentId: commitment.commitment.commitmentId, saleContractId: commitment.contract.saleContractId,
          grossRevenue: optionalMoney(request.payload.grossRevenueMinor, request.payload.currency, evidence, 'settled gross revenue'),
          deductions: optionalMoney(request.payload.deductionsMinor, request.payload.currency, evidence, 'settlement deductions'),
          knownAt: request.submittedAt, evidenceIds: [evidence],
        } }));
      }
    }
  }
}
