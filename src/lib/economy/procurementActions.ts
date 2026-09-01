/** Business-intent adapter for the PayloadOS procurement cockpit. */

import { z } from 'zod';
import { attestationOf } from './attestation';
import {
  procurementStateSnapshotId,
  type ProcurementCommandResult,
  type ProcurementRefusal,
  type ProcurementSnapshot,
  type ProcurementWorkflow,
} from './procurement';
import { hashCommand, type ProcurementMoneyState, type ProcurementQuantityUnit, type SupplierAuthorizationCheck } from './procurementStore';
import type { ISODateTime } from './types';

const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/);
const businessText = z.string().trim().min(1).max(300);
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date and time.');
const amount = z.number().positive().max(1_000_000_000);
const moneyMinor = z.number().int().nonnegative().max(100_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const unit = z.enum(['kg', 'tonne', 'lb', 'unit', 'liter', 'm3']);
const checkState = z.enum(['satisfied', 'refused', 'undetermined']);
const envelope = { requestId: identifier, actorId: identifier, submittedAt: instant };

export const procurementActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('register_requirement'), payload: z.object({
    procurementId: identifier, sourceReference: identifier, materialId: identifier, specificationId: identifier,
    quantity: amount, unit, destinationId: identifier, deliveryStart: instant, deliveryEnd: instant,
    maximumLandedCostMinor: moneyMinor.optional(), currency, customerCommitmentId: identifier.optional(),
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('add_supplier_alternative'), payload: z.object({
    procurementId: identifier, sourceReference: identifier, supplierId: identifier, facilityId: identifier.optional(),
    quantity: amount, unit, quotedTotalMinor: moneyMinor, currency, incoterm: businessText,
    availabilityStart: instant, availabilityEnd: instant, validUntil: instant,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('authorize_supplier'), payload: z.object({
    procurementId: identifier, actionId: identifier, sourceReference: identifier,
    counterpartyEligibility: checkState, sanctionsScreening: checkState, specificationMatch: checkState,
    creditTerms: checkState, authorityToBuy: checkState,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('freeze_decision_set'), payload: z.object({ procurementId: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('select_supplier'), payload: z.object({ procurementId: identifier, actionId: identifier, rationale: businessText }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('commit_purchase'), payload: z.object({
    procurementId: identifier, contractId: identifier, sourceReference: identifier, quantity: amount, unit,
    committedPriceMinor: moneyMinor, currency, incoterm: businessText, titleTransferPoint: businessText, committedAt: instant,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('create_logistics_requirement'), payload: z.object({
    procurementId: identifier, sourceReference: identifier, originId: identifier,
    readyStart: instant, readyEnd: instant, deliveryStart: instant, deliveryEnd: instant,
    handlingProfileId: identifier.optional(),
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('record_receipt'), payload: z.object({
    procurementId: identifier, sourceReference: identifier, quantity: amount, unit,
    receivedAt: instant, locationId: identifier, disposition: z.enum(['accepted', 'quarantined', 'rejected']),
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('capture_settlement'), payload: z.object({
    procurementId: identifier, sourceReference: identifier, currency,
    purchaseInvoiceMinor: moneyMinor.optional(), freightCostMinor: moneyMinor.optional(), dutyCostMinor: moneyMinor.optional(),
    insuranceCostMinor: moneyMinor.optional(), storageCostMinor: moneyMinor.optional(), financingCostMinor: moneyMinor.optional(),
    lossCostMinor: moneyMinor.optional(), saleRevenueMinor: moneyMinor.optional(),
  }).strict() }).strict(),
]);

export type ProcurementActionRequest = z.infer<typeof procurementActionRequestSchema>;
export type ProcurementActionKind = ProcurementActionRequest['action'];

export type ProcurementActionDescriptor = {
  readonly action: ProcurementActionKind;
  readonly label: string;
  readonly summary: string;
  readonly recommended: boolean;
  readonly alternatives?: readonly { readonly actionId: string; readonly supplierId: string; readonly authorization: string }[];
};

export type ProcurementCockpitSnapshot = {
  readonly kind: 'procurement_cockpit_snapshot';
  readonly procurement: ProcurementSnapshot;
  readonly actions: readonly ProcurementActionDescriptor[];
};

export type ProcurementActionResult =
  | { readonly kind: 'accepted'; readonly action: ProcurementActionKind; readonly persistence: 'appended' | 'duplicate'; readonly procurement: ProcurementSnapshot }
  | ProcurementRefusal;

const LABELS: Record<ProcurementActionKind, [string, string]> = {
  register_requirement: ['Create procurement requirement', 'Define the material, specification, quantity, destination, and delivery constraint.'],
  add_supplier_alternative: ['Add supplier quote', 'Register an evidenced supplier, capacity window, commercial quote, and Incoterm.'],
  authorize_supplier: ['Qualify supplier', 'Evaluate eligibility, sanctions, specification, credit, and authority to buy.'],
  freeze_decision_set: ['Freeze feasible suppliers', 'Preserve the authorized supplier set and knowledge cutoff before selection.'],
  select_supplier: ['Select supplier', 'Record an operator decision against the frozen feasible set.'],
  commit_purchase: ['Commit purchase', 'Bind the signed contract to the selected supplier and open a physical position.'],
  create_logistics_requirement: ['Create logistics requirement', 'Bind origin, destination, windows, and handling policy to the purchased position.'],
  record_receipt: ['Record position receipt', 'Capture received quantity, location, time, and quality disposition.'],
  capture_settlement: ['Settle position', 'Record actual landed-cost components and revenue without inferring missing values.'],
};

function descriptor(action: ProcurementActionKind, recommended: boolean, alternatives?: ProcurementActionDescriptor['alternatives']): ProcurementActionDescriptor {
  return Object.freeze({ action, label: LABELS[action][0], summary: LABELS[action][1], recommended, ...(alternatives ? { alternatives } : {}) });
}

function eventId(request: ProcurementActionRequest): string {
  return `procurement:${request.action}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function derivedId(prefix: string, request: ProcurementActionRequest): string {
  return `${prefix}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function evidenceId(request: ProcurementActionRequest, sourceReference?: string): string {
  return `procurement-evidence:${hashCommand({ requestId: request.requestId, actorId: request.actorId, sourceReference: sourceReference ?? request.action })}`;
}

function reported(note: string) { return attestationOf('reported', 'medium', 'self_reported', note); }

function quantity(amountValue: number, unitValue: ProcurementQuantityUnit, evidence: string, note: string) {
  return { amount: amountValue, unit: unitValue, attestation: reported(note), evidenceIds: [evidence] };
}

function observedMoney(amountMinor: number, currencyCode: string, evidence: string, label: string): ProcurementMoneyState {
  return { kind: 'observed', value: { amountMinor, currency: currencyCode, attestation: reported(`${label} transcribed by the procurement cockpit.`), evidenceIds: [evidence] } };
}

function optionalMoney(amountMinor: number | undefined, currencyCode: string, evidence: string, label: string): ProcurementMoneyState {
  return amountMinor === undefined ? {
    kind: 'absent', reason: 'not_observed', detail: `${label} was not present in this settlement action.`,
    remedy: `Attach the ${label} record; enter an evidenced zero only when the actual cost is zero.`, evidenceIds: [evidence],
  } : observedMoney(amountMinor, currencyCode, evidence, label);
}

function result(action: ProcurementActionKind, value: ProcurementCommandResult): ProcurementActionResult {
  return value.kind === 'refusal' ? value : Object.freeze({ kind: 'accepted' as const, action, persistence: value.persistence, procurement: value.snapshot });
}

export class ProcurementActions {
  constructor(private readonly workflow: ProcurementWorkflow, private readonly clock: () => ISODateTime = () => new Date().toISOString()) {}

  async list(): Promise<readonly ProcurementSnapshot[] | ProcurementRefusal> { return this.workflow.list(); }

  async inspect(procurementId: string): Promise<ProcurementCockpitSnapshot | ProcurementRefusal> {
    const procurement = await this.workflow.get(procurementId);
    if (procurement.kind === 'refusal') return procurement;
    const alternatives = procurement.alternatives.map(item => ({ actionId: item.alternative.actionId, supplierId: item.alternative.supplierId, authorization: item.authorization?.decision ?? 'pending' }));
    const actions: ProcurementActionDescriptor[] = [];
    if (['alternatives_pending', 'authorization_pending', 'authorization_blocked'].includes(procurement.phase)) actions.push(descriptor('add_supplier_alternative', procurement.phase !== 'authorization_pending'));
    if (procurement.phase === 'authorization_pending') actions.push(descriptor('authorize_supplier', true, alternatives.filter(item => item.authorization === 'pending')));
    if (procurement.phase === 'decision_freeze_pending') actions.push(descriptor('freeze_decision_set', true));
    if (procurement.phase === 'selection_pending') actions.push(descriptor('select_supplier', true, alternatives.filter(item => item.authorization === 'authorized')));
    if (procurement.phase === 'purchase_pending') actions.push(descriptor('commit_purchase', true));
    if (procurement.phase === 'logistics_pending') actions.push(descriptor('create_logistics_requirement', true));
    if (procurement.phase === 'receipt_pending') actions.push(descriptor('record_receipt', true));
    if (procurement.phase === 'settlement_pending') actions.push(descriptor('capture_settlement', true));
    if (procurement.phase === 'settled' && procurement.landedCost?.kind === 'incomplete') actions.push(descriptor('capture_settlement', true));
    return Object.freeze({ kind: 'procurement_cockpit_snapshot' as const, procurement, actions: Object.freeze(actions) });
  }

  async execute(input: unknown): Promise<ProcurementActionResult> {
    const parsed = procurementActionRequestSchema.safeParse(input);
    if (!parsed.success) return { kind: 'refusal', code: 'PROCUREMENT_COMMAND_INVALID', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), remedy: 'Use the typed procurement cockpit; internal event identities are server-derived.' };
    const request = parsed.data;
    const recordedAt = this.clock();
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(request.submittedAt) > Date.parse(recordedAt) + 60_000) return { kind: 'refusal', code: 'PROCUREMENT_COMMAND_INVALID', detail: 'Server or submission time is invalid.', remedy: 'Restore the server clock and submit again.' };
    const id = eventId(request);
    switch (request.action) {
      case 'register_requirement': {
        const value = request.payload;
        const evidence = evidenceId(request, value.sourceReference);
        return result(request.action, await this.workflow.registerRequirement({
          procurementId: value.procurementId, eventId: id, recordedAt,
          requirement: {
            requirementId: derivedId('requirement', request), materialId: value.materialId, specificationId: value.specificationId,
            quantity: quantity(value.quantity, value.unit, evidence, 'Required quantity reported by the operator.'), destinationId: value.destinationId,
            deliveryWindow: { start: value.deliveryStart, end: value.deliveryEnd },
            maximumLandedCost: value.maximumLandedCostMinor === undefined
              ? { kind: 'absent', reason: 'not_observed', detail: 'Maximum landed cost was not supplied.', remedy: 'Attach the approved procurement budget before treating cost as constrained.', evidenceIds: [evidence] }
              : observedMoney(value.maximumLandedCostMinor, value.currency, evidence, 'Maximum landed cost'),
            customerCommitmentId: value.customerCommitmentId ?? null, requestedAt: request.submittedAt,
            attestation: reported('Procurement requirement entered by an authenticated operator.'), evidenceIds: [evidence],
          },
        }));
      }
      case 'add_supplier_alternative': {
        const value = request.payload;
        const current = await this.workflow.get(value.procurementId);
        if (current.kind === 'refusal') return current;
        const evidence = evidenceId(request, value.sourceReference);
        return result(request.action, await this.workflow.registerAlternative({ procurementId: value.procurementId, eventId: id, recordedAt, alternative: {
          actionId: derivedId('supplier-action', request), supplierId: value.supplierId, facilityId: value.facilityId ?? null,
          materialId: current.requirement.materialId, specificationId: current.requirement.specificationId,
          quantity: quantity(value.quantity, value.unit, evidence, 'Supplier available quantity reported in quote.'),
          quotedTotal: { amountMinor: value.quotedTotalMinor, currency: value.currency, attestation: reported('Supplier quote transcribed by the operator.'), evidenceIds: [evidence] },
          incoterm: value.incoterm, availabilityWindow: { start: value.availabilityStart, end: value.availabilityEnd }, validUntil: value.validUntil,
          attestation: reported('Supplier alternative transcribed from an identified quote.'), evidenceIds: [evidence],
        } }));
      }
      case 'authorize_supplier': {
        const value = request.payload;
        const evidence = evidenceId(request, value.sourceReference);
        const check = (name: SupplierAuthorizationCheck['name'], state: SupplierAuthorizationCheck['state']): SupplierAuthorizationCheck => ({ name, state, detail: `${name.replaceAll('_', ' ')} recorded as ${state} by ${request.actorId}.`, evidenceIds: [`${evidence}:${name}`] });
        return result(request.action, await this.workflow.recordAuthorization({ procurementId: value.procurementId, eventId: id, recordedAt, actionId: value.actionId, evaluatedAt: request.submittedAt, checks: [
          check('counterparty_eligibility', value.counterpartyEligibility), check('sanctions_screening', value.sanctionsScreening),
          check('specification_match', value.specificationMatch), check('credit_terms', value.creditTerms), check('authority_to_buy', value.authorityToBuy),
        ] }));
      }
      case 'freeze_decision_set': {
        const current = await this.workflow.get(request.payload.procurementId);
        if (current.kind === 'refusal') return current;
        return result(request.action, await this.workflow.freezeDecisionSet({ procurementId: current.procurementId, eventId: id, recordedAt, episodeId: derivedId('procurement-episode', request), knowledgeCutoff: request.submittedAt, stateSnapshotId: procurementStateSnapshotId(current), evidenceIds: [evidenceId(request)] }));
      }
      case 'select_supplier': {
        const current = await this.workflow.get(request.payload.procurementId);
        if (current.kind === 'refusal') return current;
        if (!current.decisionSet) return { kind: 'refusal', code: 'PROCUREMENT_SELECTION_REFUSED', detail: 'No frozen supplier decision set exists.', remedy: 'Freeze the authorized supplier set first.' };
        return result(request.action, await this.workflow.selectSupplier({ procurementId: current.procurementId, eventId: id, recordedAt, episodeId: current.decisionSet.episodeId, selectedActionId: request.payload.actionId, selectedBy: request.actorId, rationale: request.payload.rationale, evidenceIds: [evidenceId(request)] }));
      }
      case 'commit_purchase': {
        const value = request.payload;
        const current = await this.workflow.get(value.procurementId);
        if (current.kind === 'refusal') return current;
        const selected = current.selection && current.alternatives.find(item => item.alternative.actionId === current.selection!.selectedActionId)?.alternative;
        if (!selected) return { kind: 'refusal', code: 'PROCUREMENT_PURCHASE_REFUSED', detail: 'No selected supplier is available.', remedy: 'Select an authorized supplier first.' };
        const evidence = evidenceId(request, value.sourceReference);
        return result(request.action, await this.workflow.commitPurchase({ procurementId: value.procurementId, eventId: id, recordedAt, purchase: {
          contractId: value.contractId, positionId: derivedId('position', request), actionId: selected.actionId, supplierId: selected.supplierId,
          quantity: quantity(value.quantity, value.unit, evidence, 'Contracted purchase quantity.'),
          committedPrice: { amountMinor: value.committedPriceMinor, currency: value.currency, attestation: reported('Committed purchase price transcribed from signed contract.'), evidenceIds: [evidence] },
          incoterm: value.incoterm, titleTransferPoint: value.titleTransferPoint, committedAt: value.committedAt, authorizedBy: request.actorId, evidenceIds: [evidence],
        } }));
      }
      case 'create_logistics_requirement': {
        const value = request.payload;
        const current = await this.workflow.get(value.procurementId);
        if (current.kind === 'refusal') return current;
        if (!current.position) return { kind: 'refusal', code: 'PROCUREMENT_LOGISTICS_REFUSED', detail: 'No purchased position exists.', remedy: 'Commit the selected supplier contract first.' };
        return result(request.action, await this.workflow.createLogistics({ procurementId: value.procurementId, eventId: id, recordedAt, logistics: {
          logisticsRequirementId: derivedId('logistics-requirement', request), positionId: current.position.positionId,
          originId: value.originId, destinationId: current.requirement.destinationId, readyWindow: { start: value.readyStart, end: value.readyEnd },
          deliveryWindow: { start: value.deliveryStart, end: value.deliveryEnd }, handlingProfileId: value.handlingProfileId ?? null,
          evidenceIds: [evidenceId(request, value.sourceReference)],
        } }));
      }
      case 'record_receipt': {
        const value = request.payload;
        const current = await this.workflow.get(value.procurementId);
        if (current.kind === 'refusal') return current;
        if (!current.position) return { kind: 'refusal', code: 'PROCUREMENT_RECEIPT_REFUSED', detail: 'No purchased position exists.', remedy: 'Commit and create logistics for the position first.' };
        const evidence = evidenceId(request, value.sourceReference);
        return result(request.action, await this.workflow.recordReceipt({ procurementId: value.procurementId, eventId: id, recordedAt, receipt: {
          positionId: current.position.positionId, receivedQuantity: quantity(value.quantity, value.unit, evidence, 'Received quantity observed at custody transfer.'),
          receivedAt: value.receivedAt, locationId: value.locationId, disposition: value.disposition,
          attestation: reported('Receipt condition and location reported by the operator.'), evidenceIds: [evidence],
        } }));
      }
      case 'capture_settlement': {
        const value = request.payload;
        const current = await this.workflow.get(value.procurementId);
        if (current.kind === 'refusal') return current;
        if (!current.position) return { kind: 'refusal', code: 'PROCUREMENT_SETTLEMENT_REFUSED', detail: 'No physical position exists.', remedy: 'Complete purchase and receipt first.' };
        const evidence = evidenceId(request, value.sourceReference);
        return result(request.action, await this.workflow.captureSettlement({ procurementId: value.procurementId, eventId: id, recordedAt, settlement: {
          positionId: current.position.positionId, purchaseInvoice: optionalMoney(value.purchaseInvoiceMinor, value.currency, evidence, 'purchase invoice'),
          freightCost: optionalMoney(value.freightCostMinor, value.currency, evidence, 'freight cost'), dutyCost: optionalMoney(value.dutyCostMinor, value.currency, evidence, 'duty cost'),
          insuranceCost: optionalMoney(value.insuranceCostMinor, value.currency, evidence, 'insurance cost'), storageCost: optionalMoney(value.storageCostMinor, value.currency, evidence, 'storage cost'),
          financingCost: optionalMoney(value.financingCostMinor, value.currency, evidence, 'financing cost'), lossCost: optionalMoney(value.lossCostMinor, value.currency, evidence, 'loss cost'),
          saleRevenue: optionalMoney(value.saleRevenueMinor, value.currency, evidence, 'sale revenue'), knownAt: request.submittedAt, evidenceIds: [evidence],
        } }));
      }
    }
  }
}
