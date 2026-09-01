/**
 * Durable procurement workflow and physical-position projection.
 *
 * Requirement -> supplier set -> qualification -> frozen feasible set ->
 * selection -> purchase/position -> logistics -> receipt -> settlement.
 */

import { combineAttestations, type Attestation } from './attestation';
import {
  hashCommand,
  type PositionLogisticsRequirement,
  type PositionReceipt,
  type ProcurementEvent,
  type ProcurementEventStore,
  type ProcurementMoney,
  type ProcurementMoneyState,
  type ProcurementQuantity,
  type ProcurementRequirement,
  type ProcurementSettlement,
  type PurchaseCommitment,
  type StoredProcurementRecord,
  type SupplierAlternative,
  type SupplierAuthorization,
  type SupplierAuthorizationCheck,
  type SupplierAuthorizationCheckName,
} from './procurementStore';
import type { Hash, ISODateTime } from './types';

export type ProcurementPhase =
  | 'alternatives_pending'
  | 'authorization_pending'
  | 'authorization_blocked'
  | 'decision_freeze_pending'
  | 'selection_pending'
  | 'purchase_pending'
  | 'logistics_pending'
  | 'receipt_pending'
  | 'settlement_pending'
  | 'settled';

export type SupplierAlternativeState = {
  readonly alternative: SupplierAlternative;
  readonly authorization: SupplierAuthorization | null;
  readonly authorizationEventId: string | null;
};

export type ProcurementDecisionSet = {
  readonly episodeId: string;
  readonly knowledgeCutoff: ISODateTime;
  readonly stateSnapshotId: string;
  readonly feasibleActionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type ProcurementSelection = {
  readonly episodeId: string;
  readonly selectedActionId: string;
  readonly selectedBy: string;
  readonly rationale: string;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type LandedCostAnalysis =
  | {
      readonly kind: 'complete';
      readonly amountMinor: number;
      readonly currency: string;
      readonly marginMinor: number | null;
      readonly evidenceIds: readonly string[];
      readonly attestation: Attestation;
      readonly budgetComparison:
        | { readonly kind: 'evaluated'; readonly maximumAmountMinor: number; readonly varianceMinor: number; readonly withinMaximum: boolean }
        | { readonly kind: 'not_available'; readonly reason: 'maximum_not_observed' | 'currency_conflict' };
    }
  | {
      readonly kind: 'incomplete';
      readonly missingComponents: readonly string[];
      readonly detail: string;
      readonly remedy: string;
      readonly evidenceIds: readonly string[];
    };

export type PhysicalPositionSnapshot = {
  readonly positionId: string;
  readonly materialId: string;
  readonly specificationId: string;
  readonly supplierId: string;
  readonly quantity: ProcurementQuantity;
  readonly ownershipState: 'committed' | 'received' | 'settled';
  readonly logisticsState: 'pending' | 'required' | 'received';
  readonly qualityState: 'pending' | 'accepted' | 'quarantined' | 'rejected';
  readonly locationId: string | null;
  readonly customerCommitmentId: string | null;
};

export type ProcurementSnapshot = {
  readonly kind: 'procurement_snapshot';
  readonly procurementId: string;
  readonly phase: ProcurementPhase;
  readonly durability: ProcurementEventStore['durability'];
  readonly requirement: ProcurementRequirement;
  readonly alternatives: readonly SupplierAlternativeState[];
  readonly decisionSet: ProcurementDecisionSet | null;
  readonly selection: ProcurementSelection | null;
  readonly purchase: PurchaseCommitment | null;
  readonly position: PhysicalPositionSnapshot | null;
  readonly logistics: PositionLogisticsRequirement | null;
  readonly receipts: readonly PositionReceipt[];
  readonly settlement: ProcurementSettlement | null;
  readonly settlementEventId: string | null;
  readonly landedCost: LandedCostAnalysis | null;
};

export type ProcurementRefusalCode =
  | 'PROCUREMENT_COMMAND_INVALID'
  | 'PROCUREMENT_NOT_FOUND'
  | 'PROCUREMENT_ALREADY_REGISTERED'
  | 'PROCUREMENT_PHASE_INVALID'
  | 'PROCUREMENT_ALTERNATIVE_UNKNOWN'
  | 'PROCUREMENT_ALTERNATIVE_DUPLICATE'
  | 'PROCUREMENT_AUTHORIZATION_INVALID'
  | 'PROCUREMENT_NO_FEASIBLE_ACTION'
  | 'PROCUREMENT_SELECTION_REFUSED'
  | 'PROCUREMENT_PURCHASE_REFUSED'
  | 'PROCUREMENT_LOGISTICS_REFUSED'
  | 'PROCUREMENT_RECEIPT_REFUSED'
  | 'PROCUREMENT_SETTLEMENT_REFUSED'
  | 'PROCUREMENT_EVENT_ID_CONFLICT'
  | 'PROCUREMENT_STORE_CONCURRENT_WRITE'
  | 'PROCUREMENT_STORE_CORRUPT'
  | 'PROCUREMENT_STORE_UNAVAILABLE';

export type ProcurementRefusal = {
  readonly kind: 'refusal';
  readonly code: ProcurementRefusalCode;
  readonly detail: string;
  readonly remedy: string;
};

export type ProcurementCommandResult =
  | { readonly kind: 'accepted'; readonly persistence: 'appended' | 'duplicate'; readonly snapshot: ProcurementSnapshot }
  | ProcurementRefusal;

type CommandEnvelope = { readonly procurementId: string; readonly eventId: string; readonly recordedAt: ISODateTime };
export type RegisterProcurementRequirementCommand = CommandEnvelope & { readonly requirement: ProcurementRequirement };
export type RegisterSupplierAlternativeCommand = CommandEnvelope & { readonly alternative: SupplierAlternative };
export type RecordSupplierAuthorizationCommand = CommandEnvelope & {
  readonly actionId: string;
  readonly evaluatedAt: ISODateTime;
  readonly checks: readonly SupplierAuthorizationCheck[];
};
export type FreezeProcurementDecisionCommand = CommandEnvelope & {
  readonly episodeId: string;
  readonly knowledgeCutoff: ISODateTime;
  readonly stateSnapshotId: string;
  readonly evidenceIds: readonly string[];
};
export type SelectProcurementSupplierCommand = CommandEnvelope & {
  readonly episodeId: string;
  readonly selectedActionId: string;
  readonly selectedBy: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
};
export type CommitProcurementPurchaseCommand = CommandEnvelope & { readonly purchase: PurchaseCommitment };
export type CreatePositionLogisticsCommand = CommandEnvelope & { readonly logistics: PositionLogisticsRequirement };
export type RecordPositionReceiptCommand = CommandEnvelope & { readonly receipt: PositionReceipt };
export type CaptureProcurementSettlementCommand = CommandEnvelope & { readonly settlement: ProcurementSettlement };

type Projection = Omit<ProcurementSnapshot, 'kind' | 'durability' | 'phase' | 'procurementId' | 'position' | 'landedCost'>;

class ProjectionDefect extends Error {}

const AUTHORIZATION_CHECKS: readonly SupplierAuthorizationCheckName[] = [
  'counterparty_eligibility',
  'sanctions_screening',
  'specification_match',
  'credit_terms',
  'authority_to_buy',
];

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function refusal(code: ProcurementRefusalCode, detail: string, remedy: string): ProcurementRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function isRefusal(value: unknown): value is ProcurementRefusal {
  return !!value && typeof value === 'object' && 'kind' in value && value.kind === 'refusal';
}

function validIds(values: readonly string[]): boolean {
  return values.length > 0 && values.every(value => typeof value === 'string' && value.trim().length > 0);
}

function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }

function validAttestation(value: Attestation): boolean {
  return !!value && Number.isSafeInteger(value.inputCount) && value.inputCount > 0;
}

function quantityDefect(value: ProcurementQuantity): string | null {
  if (!value || !Number.isFinite(value.amount) || value.amount <= 0 || !value.unit) return 'quantity is missing, non-positive, or non-finite';
  if (!validAttestation(value.attestation) || !validIds(value.evidenceIds)) return 'quantity lacks attestation or evidence';
  return null;
}

function moneyDefect(value: ProcurementMoney): string | null {
  if (!value || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0 || !/^[A-Z]{3}$/.test(value.currency)) return 'money amount or currency is invalid';
  if (!validAttestation(value.attestation) || !validIds(value.evidenceIds)) return 'money lacks attestation or evidence';
  return null;
}

function moneyStateDefect(value: ProcurementMoneyState): string | null {
  if (!value || !['observed', 'absent'].includes(value.kind)) return 'money field has no observed/absent state';
  if (value.kind === 'observed') return moneyDefect(value.value);
  if (!value.detail?.trim() || !value.remedy?.trim() || !validIds(value.evidenceIds)) return 'money absence lacks detail, remedy, or evidence';
  return null;
}

function windowDefect(value: { start: ISODateTime; end: ISODateTime }): string | null {
  const start = Date.parse(value?.start);
  const end = Date.parse(value?.end);
  return Number.isFinite(start) && Number.isFinite(end) && start <= end ? null : 'time window is invalid or reversed';
}

function requirementDefect(value: ProcurementRequirement): string | null {
  if (!value?.requirementId?.trim() || !value.materialId?.trim() || !value.specificationId?.trim() || !value.destinationId?.trim()) return 'requirement identity is incomplete';
  return quantityDefect(value.quantity) ?? windowDefect(value.deliveryWindow) ?? moneyStateDefect(value.maximumLandedCost) ??
    (!validTime(value.requestedAt) || !validAttestation(value.attestation) || !validIds(value.evidenceIds) ? 'requirement timing, attestation, or evidence is invalid' : null);
}

function alternativeDefect(value: SupplierAlternative, requirement: ProcurementRequirement): string | null {
  if (!value?.actionId?.trim() || !value.supplierId?.trim() || !value.materialId?.trim() || !value.specificationId?.trim() || !value.incoterm?.trim()) return 'supplier alternative identity is incomplete';
  if (value.materialId !== requirement.materialId || value.specificationId !== requirement.specificationId) return 'supplier alternative does not match the required material/specification';
  const quantity = quantityDefect(value.quantity);
  if (quantity) return quantity;
  if (value.quantity.unit !== requirement.quantity.unit || value.quantity.amount < requirement.quantity.amount) return 'supplier alternative cannot cover the required quantity in the same unit';
  return moneyDefect(value.quotedTotal) ?? windowDefect(value.availabilityWindow) ??
    (!validTime(value.validUntil) || !validAttestation(value.attestation) || !validIds(value.evidenceIds) ? 'supplier quote timing, attestation, or evidence is invalid' : null);
}

function authorizationFrom(checks: readonly SupplierAuthorizationCheck[], evaluatedAt: ISODateTime): SupplierAuthorization | ProcurementRefusal {
  if (!validTime(evaluatedAt) || checks.length !== AUTHORIZATION_CHECKS.length) {
    return refusal('PROCUREMENT_AUTHORIZATION_INVALID', 'Supplier authorization must contain all five checks and a valid evaluation time.', 'Record eligibility, sanctions, specification, credit, and authority-to-buy checks.');
  }
  const byName = new Map(checks.map(check => [check.name, check]));
  if (byName.size !== AUTHORIZATION_CHECKS.length || AUTHORIZATION_CHECKS.some(name => !byName.has(name)) ||
      checks.some(check => !check.detail?.trim() || !validIds(check.evidenceIds))) {
    return refusal('PROCUREMENT_AUTHORIZATION_INVALID', 'Supplier authorization checks are duplicated or lack detail/evidence.', 'Provide each required check exactly once with evidence references.');
  }
  const decision = checks.some(check => check.state === 'refused') ? 'refused'
    : checks.every(check => check.state === 'satisfied') ? 'authorized' : 'undetermined';
  return freeze({
    decision,
    evaluatedAt,
    checks: [...checks],
    evidenceIds: [...new Set(checks.flatMap(check => check.evidenceIds))],
  });
}

function stateFingerprint(projection: Projection): string {
  return hashCommand({
    requirement: projection.requirement,
    alternatives: projection.alternatives,
    decisionSet: projection.decisionSet,
  });
}

function project(records: readonly StoredProcurementRecord[], procurementId: string): Projection | null {
  const events = records.map(record => record.event).filter(event => event.operationId === procurementId);
  if (events.length === 0) return null;
  if (events[0].kind !== 'procurement_requirement_registered') throw new ProjectionDefect(`${procurementId} does not begin with a requirement`);
  if (events.filter(event => event.kind === 'procurement_requirement_registered').length !== 1) throw new ProjectionDefect(`${procurementId} has multiple requirements`);

  const requirement = events[0].requirement;
  const requirementIssue = requirementDefect(requirement);
  if (requirementIssue) throw new ProjectionDefect(`${procurementId} requirement is invalid: ${requirementIssue}`);
  const alternatives = new Map<string, SupplierAlternativeState>();
  let decisionSet: ProcurementDecisionSet | null = null;
  let selection: ProcurementSelection | null = null;
  let purchase: PurchaseCommitment | null = null;
  let logistics: PositionLogisticsRequirement | null = null;
  const receipts: PositionReceipt[] = [];
  let settlement: ProcurementSettlement | null = null;
  let settlementEventId: string | null = null;
  let priorTime = -Infinity;

  for (const event of events) {
    const recorded = Date.parse(event.recordedAt);
    if (!Number.isFinite(recorded) || recorded < priorTime) throw new ProjectionDefect(`${event.eventId} violates journal recording order`);
    priorTime = recorded;
    if (event.kind === 'supplier_alternative_registered') {
      if (decisionSet) throw new ProjectionDefect(`${event.eventId} adds an alternative after the feasible set was frozen`);
      const issue = alternativeDefect(event.alternative, requirement);
      if (issue) throw new ProjectionDefect(`${event.eventId}: ${issue}`);
      if (alternatives.has(event.alternative.actionId)) throw new ProjectionDefect(`${event.alternative.actionId} is duplicated`);
      alternatives.set(event.alternative.actionId, { alternative: event.alternative, authorization: null, authorizationEventId: null });
    }
    if (event.kind === 'supplier_authorization_recorded') {
      if (decisionSet) throw new ProjectionDefect(`${event.eventId} authorizes after the feasible set was frozen`);
      const existing = alternatives.get(event.actionId);
      if (!existing || existing.authorization) throw new ProjectionDefect(`${event.eventId} targets an unknown or already evaluated supplier action`);
      alternatives.set(event.actionId, { ...existing, authorization: event.authorization, authorizationEventId: event.eventId });
    }
    if (event.kind === 'procurement_decision_set_frozen') {
      if (decisionSet) throw new ProjectionDefect(`${procurementId} freezes more than one decision set`);
      const feasible = [...alternatives.values()]
        .filter(value => value.authorization?.decision === 'authorized' && Date.parse(value.alternative.validUntil) >= Date.parse(event.knowledgeCutoff))
        .map(value => value.alternative.actionId).sort();
      if (!feasible.length || JSON.stringify(feasible) !== JSON.stringify([...event.feasibleActionIds].sort())) throw new ProjectionDefect(`${event.eventId} feasible set contradicts supplier authorizations`);
      decisionSet = { episodeId: event.episodeId, knowledgeCutoff: event.knowledgeCutoff, stateSnapshotId: event.stateSnapshotId, feasibleActionIds: event.feasibleActionIds, evidenceIds: event.evidenceIds };
    }
    if (event.kind === 'procurement_supplier_selected') {
      if (!decisionSet || selection || event.episodeId !== decisionSet.episodeId || !decisionSet.feasibleActionIds.includes(event.selectedActionId)) throw new ProjectionDefect(`${event.eventId} is not a selection from the frozen feasible set`);
      selection = { episodeId: event.episodeId, selectedActionId: event.selectedActionId, selectedBy: event.selectedBy, rationale: event.rationale, recordedAt: event.recordedAt, evidenceIds: event.evidenceIds };
    }
    if (event.kind === 'procurement_purchase_committed') {
      const candidate = alternatives.get(event.purchase.actionId)?.alternative;
      if (!selection || purchase || selection.selectedActionId !== event.purchase.actionId || !candidate || candidate.supplierId !== event.purchase.supplierId) throw new ProjectionDefect(`${event.eventId} purchase is not bound to the selected supplier`);
      if (quantityDefect(event.purchase.quantity) || moneyDefect(event.purchase.committedPrice) || !validTime(event.purchase.committedAt) || !validIds(event.purchase.evidenceIds)) throw new ProjectionDefect(`${event.eventId} purchase evidence is invalid`);
      if (event.purchase.quantity.unit !== requirement.quantity.unit || event.purchase.quantity.amount < requirement.quantity.amount || event.purchase.quantity.amount > candidate.quantity.amount) throw new ProjectionDefect(`${event.eventId} purchase quantity is outside the required/quoted range`);
      purchase = event.purchase;
    }
    if (event.kind === 'position_logistics_required') {
      if (!purchase || logistics || event.logistics.positionId !== purchase.positionId || event.logistics.destinationId !== requirement.destinationId || windowDefect(event.logistics.readyWindow) || windowDefect(event.logistics.deliveryWindow) || !validIds(event.logistics.evidenceIds)) throw new ProjectionDefect(`${event.eventId} logistics requirement is unbound or invalid`);
      logistics = event.logistics;
    }
    if (event.kind === 'position_receipt_recorded') {
      if (!purchase || !logistics || settlement || event.receipt.positionId !== purchase.positionId || quantityDefect(event.receipt.receivedQuantity) || event.receipt.receivedQuantity.unit !== purchase.quantity.unit || !validTime(event.receipt.receivedAt) || Date.parse(event.receipt.receivedAt) > recorded || Date.parse(event.receipt.receivedAt) < Date.parse(purchase.committedAt) || !validAttestation(event.receipt.attestation) || !validIds(event.receipt.evidenceIds)) throw new ProjectionDefect(`${event.eventId} receipt is unbound or invalid`);
      const total = receipts.reduce((sum, receipt) => sum + receipt.receivedQuantity.amount, 0) + event.receipt.receivedQuantity.amount;
      if (total > purchase.quantity.amount) throw new ProjectionDefect(`${event.eventId} causes received quantity to exceed the purchased position`);
      receipts.push(event.receipt);
    }
    if (event.kind === 'procurement_settlement_captured') {
      const latestReceiptAt = receipts.reduce((latest, receipt) => Math.max(latest, Date.parse(receipt.receivedAt)), -Infinity);
      if (!purchase || event.settlement.positionId !== purchase.positionId || !validTime(event.settlement.knownAt) || Date.parse(event.settlement.knownAt) < latestReceiptAt || Date.parse(event.settlement.knownAt) > recorded || !validIds(event.settlement.evidenceIds) || event.supersedesEventId !== settlementEventId) throw new ProjectionDefect(`${event.eventId} settlement is unbound or does not supersede the current revision`);
      const accepted = receipts.filter(receipt => receipt.disposition === 'accepted').reduce((sum, receipt) => sum + receipt.receivedQuantity.amount, 0);
      if (accepted < purchase.quantity.amount) throw new ProjectionDefect(`${event.eventId} settles before the full position is accepted`);
      const fields = [event.settlement.purchaseInvoice, event.settlement.freightCost, event.settlement.dutyCost, event.settlement.insuranceCost, event.settlement.storageCost, event.settlement.financingCost, event.settlement.lossCost, event.settlement.saleRevenue];
      const issue = fields.map(moneyStateDefect).find(value => value !== null);
      if (issue) throw new ProjectionDefect(`${event.eventId} settlement has invalid evidence: ${issue}`);
      settlement = event.settlement;
      settlementEventId = event.eventId;
    }
  }
  return freeze({ requirement, alternatives: [...alternatives.values()], decisionSet, selection, purchase, logistics, receipts, settlement, settlementEventId });
}

function landedCost(settlement: ProcurementSettlement | null, requirement: ProcurementRequirement): LandedCostAnalysis | null {
  if (!settlement) return null;
  const components: readonly [string, ProcurementMoneyState][] = [
    ['purchase_invoice', settlement.purchaseInvoice], ['freight', settlement.freightCost], ['duty', settlement.dutyCost],
    ['insurance', settlement.insuranceCost], ['storage', settlement.storageCost], ['financing', settlement.financingCost], ['loss', settlement.lossCost],
  ];
  const missing = components.filter(([, state]) => state.kind === 'absent').map(([name]) => name);
  if (missing.length) return freeze({
    kind: 'incomplete' as const,
    missingComponents: missing,
    detail: `Landed cost is unavailable because ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not observed.`,
    remedy: 'Attach each missing cost record, including an evidenced zero when the cost is truly zero.',
    evidenceIds: [...new Set(components.flatMap(([, state]) => state.kind === 'observed' ? state.value.evidenceIds : state.evidenceIds))],
  });
  const observed = components.map(([, state]) => (state as Extract<ProcurementMoneyState, { kind: 'observed' }>).value);
  const currencies = new Set(observed.map(value => value.currency));
  if (currencies.size !== 1) throw new ProjectionDefect(`settlement landed-cost components span currencies ${[...currencies].join(', ')}`);
  const currency = observed[0].currency;
  const amountMinor = observed.reduce((sum, value) => sum + value.amountMinor, 0);
  let marginMinor: number | null = null;
  if (settlement.saleRevenue.kind === 'observed') {
    if (settlement.saleRevenue.value.currency !== currency) throw new ProjectionDefect('settlement revenue currency conflicts with landed cost');
    marginMinor = settlement.saleRevenue.value.amountMinor - amountMinor;
  }
  const budgetComparison: Extract<LandedCostAnalysis, { kind: 'complete' }>['budgetComparison'] =
    requirement.maximumLandedCost.kind === 'absent'
      ? { kind: 'not_available', reason: 'maximum_not_observed' }
      : requirement.maximumLandedCost.value.currency !== currency
        ? { kind: 'not_available', reason: 'currency_conflict' }
        : {
            kind: 'evaluated',
            maximumAmountMinor: requirement.maximumLandedCost.value.amountMinor,
            varianceMinor: amountMinor - requirement.maximumLandedCost.value.amountMinor,
            withinMaximum: amountMinor <= requirement.maximumLandedCost.value.amountMinor,
          };
  return freeze({
    kind: 'complete' as const,
    amountMinor,
    currency,
    marginMinor,
    evidenceIds: [...new Set([...observed.flatMap(value => value.evidenceIds), ...(settlement.saleRevenue.kind === 'observed' ? settlement.saleRevenue.value.evidenceIds : [])])],
    attestation: combineAttestations(observed.map(value => value.attestation)),
    budgetComparison,
  });
}

function snapshot(projection: Projection, procurementId: string, durability: ProcurementEventStore['durability']): ProcurementSnapshot {
  const authorized = projection.alternatives.filter(item => item.authorization?.decision === 'authorized');
  const allEvaluated = projection.alternatives.length > 0 && projection.alternatives.every(item => item.authorization !== null);
  const accepted = projection.receipts.filter(receipt => receipt.disposition === 'accepted').reduce((sum, receipt) => sum + receipt.receivedQuantity.amount, 0);
  const fullReceipt = !!projection.purchase && accepted >= projection.purchase.quantity.amount;
  const phase: ProcurementPhase = projection.alternatives.length === 0 ? 'alternatives_pending'
    : !allEvaluated ? 'authorization_pending'
    : authorized.length === 0 ? 'authorization_blocked'
    : !projection.decisionSet ? 'decision_freeze_pending'
    : !projection.selection ? 'selection_pending'
    : !projection.purchase ? 'purchase_pending'
    : !projection.logistics ? 'logistics_pending'
    : !fullReceipt ? 'receipt_pending'
    : !projection.settlement ? 'settlement_pending' : 'settled';
  const latestReceipt = projection.receipts.at(-1) ?? null;
  const position: PhysicalPositionSnapshot | null = projection.purchase ? {
    positionId: projection.purchase.positionId,
    materialId: projection.requirement.materialId,
    specificationId: projection.requirement.specificationId,
    supplierId: projection.purchase.supplierId,
    quantity: projection.purchase.quantity,
    ownershipState: projection.settlement ? 'settled' : fullReceipt ? 'received' : 'committed',
    logisticsState: fullReceipt ? 'received' : projection.logistics ? 'required' : 'pending',
    qualityState: latestReceipt?.disposition ?? 'pending',
    locationId: latestReceipt?.locationId ?? projection.logistics?.originId ?? null,
    customerCommitmentId: projection.requirement.customerCommitmentId,
  } : null;
  return freeze({ kind: 'procurement_snapshot' as const, procurementId, phase, durability, ...projection, position, landedCost: landedCost(projection.settlement, projection.requirement) });
}

function commandIntent(command: CommandEnvelope & Record<string, unknown>): Hash {
  return hashCommand(Object.fromEntries(
    Object.entries(command).filter(([key]) => key !== 'eventId' && key !== 'recordedAt'),
  ));
}

export class ProcurementWorkflow {
  constructor(private readonly store: ProcurementEventStore) {}

  async get(procurementId: string): Promise<ProcurementSnapshot | ProcurementRefusal> {
    const loaded = await this.load(procurementId);
    if (isRefusal(loaded)) return loaded;
    if (!loaded.projection) return refusal('PROCUREMENT_NOT_FOUND', `${procurementId} is not registered.`, 'Create a typed procurement requirement first.');
    return snapshot(loaded.projection, procurementId, this.store.durability);
  }

  async list(): Promise<readonly ProcurementSnapshot[] | ProcurementRefusal> {
    let records: readonly StoredProcurementRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return refusal('PROCUREMENT_STORE_UNAVAILABLE', (error as Error).message, 'Restore the configured procurement store before continuing.'); }
    const ids = [...new Set(records.map(record => record.event.operationId))];
    try { return freeze(ids.map(id => snapshot(project(records, id)!, id, this.store.durability))); }
    catch (error) { return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Restore from a verified replica; do not skip contradictory history.'); }
  }

  async registerRequirement(command: RegisterProcurementRequirementCommand): Promise<ProcurementCommandResult> {
    if (!command.procurementId?.trim() || !command.eventId?.trim() || !validTime(command.recordedAt)) return refusal('PROCUREMENT_COMMAND_INVALID', 'Requirement command identity or time is invalid.', 'Provide stable procurement/event identities and an ISO recording time.');
    const issue = requirementDefect(command.requirement);
    if (issue) return refusal('PROCUREMENT_COMMAND_INVALID', `Requirement is invalid: ${issue}.`, 'Correct the business facts and attach evidence.');
    const loaded = await this.load(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RegisterProcurementRequirementCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'procurement_requirement_registered', intent);
    if (retry) return retry;
    if (loaded.projection) return refusal('PROCUREMENT_ALREADY_REGISTERED', `${command.procurementId} already exists.`, 'Open the existing procurement workflow.');
    return this.append(loaded.records, {
      kind: 'procurement_requirement_registered', eventId: command.eventId, operationId: command.procurementId,
      recordedAt: command.recordedAt, commandHash: intent, requirement: command.requirement,
    });
  }

  async registerAlternative(command: RegisterSupplierAlternativeCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RegisterSupplierAlternativeCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'supplier_alternative_registered', intent);
    if (retry) return retry;
    if (loaded.projection.decisionSet) return refusal('PROCUREMENT_PHASE_INVALID', 'The feasible supplier set is already frozen.', 'Open a new procurement requirement for a materially changed supplier set.');
    const issue = alternativeDefect(command.alternative, loaded.projection.requirement);
    if (issue) return refusal('PROCUREMENT_COMMAND_INVALID', `Supplier alternative is invalid: ${issue}.`, 'Correct the quote/specification and attach evidence.');
    if (loaded.projection.alternatives.some(item => item.alternative.actionId === command.alternative.actionId || item.alternative.supplierId === command.alternative.supplierId)) return refusal('PROCUREMENT_ALTERNATIVE_DUPLICATE', 'This supplier/action is already registered.', 'Evaluate the existing alternative or use a genuinely different supplier quote.');
    return this.append(loaded.records, { kind: 'supplier_alternative_registered', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, alternative: command.alternative });
  }

  async recordAuthorization(command: RecordSupplierAuthorizationCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RecordSupplierAuthorizationCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'supplier_authorization_recorded', intent);
    if (retry) return retry;
    const candidate = loaded.projection.alternatives.find(item => item.alternative.actionId === command.actionId);
    if (!candidate) return refusal('PROCUREMENT_ALTERNATIVE_UNKNOWN', `${command.actionId} is not registered.`, 'Select an alternative exposed by this procurement workflow.');
    if (candidate.authorization) return refusal('PROCUREMENT_PHASE_INVALID', `${command.actionId} was already evaluated.`, 'Add a new quote action if supplier facts materially changed.');
    const authorization = authorizationFrom(command.checks, command.evaluatedAt);
    if (isRefusal(authorization)) return authorization;
    return this.append(loaded.records, { kind: 'supplier_authorization_recorded', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, actionId: command.actionId, authorization });
  }

  async freezeDecisionSet(command: FreezeProcurementDecisionCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as FreezeProcurementDecisionCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'procurement_decision_set_frozen', intent);
    if (retry) return retry;
    if (loaded.projection.decisionSet || loaded.projection.alternatives.some(item => !item.authorization)) return refusal('PROCUREMENT_PHASE_INVALID', 'Every registered supplier must be evaluated before freezing the decision set.', 'Complete all five qualification checks for every supplier alternative.');
    if (Date.parse(command.knowledgeCutoff) > Date.parse(command.recordedAt)) return refusal('PROCUREMENT_COMMAND_INVALID', 'Knowledge cutoff is after the event recording time.', 'Use the current server-bounded knowledge time.');
    const feasible = loaded.projection.alternatives
      .filter(item => item.authorization?.decision === 'authorized' && Date.parse(item.alternative.validUntil) >= Date.parse(command.knowledgeCutoff))
      .map(item => item.alternative.actionId).sort();
    if (!feasible.length) return refusal('PROCUREMENT_NO_FEASIBLE_ACTION', 'No supplier passed all qualification checks.', 'Add or re-source a supplier alternative; do not select an undetermined or refused supplier.');
    const expectedSnapshot = `procurement-state:${stateFingerprint(loaded.projection)}`;
    if (command.stateSnapshotId !== expectedSnapshot || !validTime(command.knowledgeCutoff) || !validIds(command.evidenceIds)) return refusal('PROCUREMENT_COMMAND_INVALID', 'Decision snapshot identity, cutoff, or evidence is invalid.', 'Freeze the current cockpit state without editing internal identifiers.');
    return this.append(loaded.records, { kind: 'procurement_decision_set_frozen', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, episodeId: command.episodeId, knowledgeCutoff: command.knowledgeCutoff, stateSnapshotId: command.stateSnapshotId, feasibleActionIds: feasible, evidenceIds: command.evidenceIds });
  }

  async selectSupplier(command: SelectProcurementSupplierCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as SelectProcurementSupplierCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'procurement_supplier_selected', intent);
    if (retry) return retry;
    if (!loaded.projection.decisionSet || loaded.projection.selection || command.episodeId !== loaded.projection.decisionSet.episodeId || !loaded.projection.decisionSet.feasibleActionIds.includes(command.selectedActionId)) return refusal('PROCUREMENT_SELECTION_REFUSED', 'Selection is not an authorized action in the frozen decision set.', 'Select a feasible supplier action exposed by the current snapshot.');
    if (!command.selectedBy?.trim() || !command.rationale?.trim() || !validIds(command.evidenceIds)) return refusal('PROCUREMENT_COMMAND_INVALID', 'Selection actor, rationale, or evidence is missing.', 'Record who selected the supplier, why, and the supporting evidence.');
    return this.append(loaded.records, { kind: 'procurement_supplier_selected', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, episodeId: command.episodeId, selectedActionId: command.selectedActionId, selectedBy: command.selectedBy, rationale: command.rationale, evidenceIds: command.evidenceIds });
  }

  async commitPurchase(command: CommitProcurementPurchaseCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as CommitProcurementPurchaseCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'procurement_purchase_committed', intent);
    if (retry) return retry;
    const selected = loaded.projection.selection && loaded.projection.alternatives.find(item => item.alternative.actionId === loaded.projection.selection!.selectedActionId)?.alternative;
    if (!selected || loaded.projection.purchase || command.purchase.actionId !== selected.actionId || command.purchase.supplierId !== selected.supplierId) return refusal('PROCUREMENT_PURCHASE_REFUSED', 'Purchase is not exactly bound to the selected supplier action.', 'Commit the contract exposed by the selected, authorized supplier.');
    if (!command.purchase.contractId?.trim() || !command.purchase.positionId?.trim() || !command.purchase.authorizedBy?.trim() || !command.purchase.titleTransferPoint?.trim() || !validIds(command.purchase.evidenceIds) || Date.parse(command.purchase.committedAt) > Date.parse(command.recordedAt)) return refusal('PROCUREMENT_COMMAND_INVALID', 'Purchase contract, position, authority, title transfer, timing, or evidence is incomplete.', 'Provide the signed contract facts and authorization evidence; commitment time cannot be in the future.');
    return this.append(loaded.records, { kind: 'procurement_purchase_committed', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, purchase: command.purchase });
  }

  async createLogistics(command: CreatePositionLogisticsCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as CreatePositionLogisticsCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'position_logistics_required', intent);
    if (retry) return retry;
    if (!loaded.projection.purchase || loaded.projection.logistics || command.logistics.positionId !== loaded.projection.purchase.positionId || command.logistics.destinationId !== loaded.projection.requirement.destinationId || !command.logistics.originId?.trim() || !command.logistics.logisticsRequirementId?.trim() || windowDefect(command.logistics.readyWindow) || windowDefect(command.logistics.deliveryWindow) || !validIds(command.logistics.evidenceIds)) return refusal('PROCUREMENT_LOGISTICS_REFUSED', 'Logistics requirement is unbound, duplicated, or invalid.', 'Bind one origin-to-required-destination movement to the purchased position.');
    return this.append(loaded.records, { kind: 'position_logistics_required', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, logistics: command.logistics });
  }

  async recordReceipt(command: RecordPositionReceiptCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as RecordPositionReceiptCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'position_receipt_recorded', intent);
    if (retry) return retry;
    if (!loaded.projection.purchase || !loaded.projection.logistics || loaded.projection.settlement || command.receipt.positionId !== loaded.projection.purchase.positionId || !command.receipt.locationId?.trim() || quantityDefect(command.receipt.receivedQuantity) || !validTime(command.receipt.receivedAt) || Date.parse(command.receipt.receivedAt) > Date.parse(command.recordedAt) || Date.parse(command.receipt.receivedAt) < Date.parse(loaded.projection.purchase.committedAt) || !validAttestation(command.receipt.attestation) || !validIds(command.receipt.evidenceIds)) return refusal('PROCUREMENT_RECEIPT_REFUSED', 'Receipt is unbound, future-dated, precedes purchase, or lacks quantity/condition evidence.', 'Record a typed receipt against the exact purchased position and logistics requirement.');
    const prior = loaded.projection.receipts.reduce((sum, receipt) => sum + receipt.receivedQuantity.amount, 0);
    if (command.receipt.receivedQuantity.unit !== loaded.projection.purchase.quantity.unit || prior + command.receipt.receivedQuantity.amount > loaded.projection.purchase.quantity.amount) return refusal('PROCUREMENT_RECEIPT_REFUSED', 'Receipt unit differs or would exceed purchased quantity.', 'Correct the received quantity; never hide an overage in the position balance.');
    return this.append(loaded.records, { kind: 'position_receipt_recorded', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, receipt: command.receipt });
  }

  async captureSettlement(command: CaptureProcurementSettlementCommand): Promise<ProcurementCommandResult> {
    const loaded = await this.requireProjection(command.procurementId);
    if (isRefusal(loaded)) return loaded;
    const intent = commandIntent(command as CaptureProcurementSettlementCommand & Record<string, unknown>);
    const retry = this.retry(loaded.records, command.procurementId, command.eventId, 'procurement_settlement_captured', intent);
    if (retry) return retry;
    const purchase = loaded.projection.purchase;
    const accepted = loaded.projection.receipts.filter(receipt => receipt.disposition === 'accepted').reduce((sum, receipt) => sum + receipt.receivedQuantity.amount, 0);
    const latestReceiptAt = loaded.projection.receipts.reduce((latest, receipt) => Math.max(latest, Date.parse(receipt.receivedAt)), -Infinity);
    if (!purchase || command.settlement.positionId !== purchase.positionId || accepted < purchase.quantity.amount || !validTime(command.settlement.knownAt) || Date.parse(command.settlement.knownAt) < latestReceiptAt || Date.parse(command.settlement.knownAt) > Date.parse(command.recordedAt) || !validIds(command.settlement.evidenceIds)) return refusal('PROCUREMENT_SETTLEMENT_REFUSED', 'Settlement is unbound, precedes accepted receipt, or is future-dated.', 'Accept the complete purchased quantity before settling the position and preserve knowledge time.');
    const fields = [command.settlement.purchaseInvoice, command.settlement.freightCost, command.settlement.dutyCost, command.settlement.insuranceCost, command.settlement.storageCost, command.settlement.financingCost, command.settlement.lossCost, command.settlement.saleRevenue];
    const issue = fields.map(moneyStateDefect).find(value => value !== null);
    if (issue) return refusal('PROCUREMENT_SETTLEMENT_REFUSED', `Settlement evidence is invalid: ${issue}.`, 'Represent every amount as observed or a typed absence with evidence.');
    const costCurrencies = fields.slice(0, 7).filter((state): state is Extract<ProcurementMoneyState, { kind: 'observed' }> => state.kind === 'observed').map(state => state.value.currency);
    if (new Set(costCurrencies).size > 1) return refusal('PROCUREMENT_SETTLEMENT_REFUSED', `Landed-cost inputs span currencies ${[...new Set(costCurrencies)].join(', ')}.`, 'Supply a dated FX conversion basis before recording arithmetic in one currency.');
    if (command.settlement.saleRevenue.kind === 'observed' && costCurrencies.length > 0 && command.settlement.saleRevenue.value.currency !== costCurrencies[0]) return refusal('PROCUREMENT_SETTLEMENT_REFUSED', 'Sale revenue currency conflicts with landed-cost currency.', 'Supply a dated FX basis or keep margin unavailable.');
    return this.append(loaded.records, { kind: 'procurement_settlement_captured', eventId: command.eventId, operationId: command.procurementId, recordedAt: command.recordedAt, commandHash: intent, settlement: command.settlement, supersedesEventId: loaded.projection.settlementEventId });
  }

  private async load(procurementId: string): Promise<{ records: readonly StoredProcurementRecord[]; projection: Projection | null } | ProcurementRefusal> {
    let records: readonly StoredProcurementRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return refusal('PROCUREMENT_STORE_UNAVAILABLE', (error as Error).message, 'Restore the configured procurement store before continuing.'); }
    try { return { records, projection: project(records, procurementId) }; }
    catch (error) { return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Restore from a verified replica; never skip contradictory procurement history.'); }
  }

  private async requireProjection(procurementId: string): Promise<{ records: readonly StoredProcurementRecord[]; projection: Projection } | ProcurementRefusal> {
    const loaded = await this.load(procurementId);
    if (isRefusal(loaded)) return loaded;
    return loaded.projection ? { records: loaded.records, projection: loaded.projection }
      : refusal('PROCUREMENT_NOT_FOUND', `${procurementId} is not registered.`, 'Create a typed procurement requirement first.');
  }

  private async append(records: readonly StoredProcurementRecord[], event: ProcurementEvent): Promise<ProcurementCommandResult> {
    const existing = records.find(record => record.event.eventId === event.eventId);
    if (existing) {
      if (existing.event.kind !== event.kind || existing.event.commandHash !== event.commandHash) return refusal('PROCUREMENT_EVENT_ID_CONFLICT', `${event.eventId} identifies a different procurement intent.`, 'Use the original request or allocate a new request identity for changed facts.');
      try { return { kind: 'accepted', persistence: 'duplicate', snapshot: snapshot(project(records, event.operationId)!, event.operationId, this.store.durability) }; }
      catch (error) { return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Restore the procurement journal from a verified replica.'); }
    }
    const expected = records.at(-1)?.recordHash ?? null;
    const appended = await this.store.append(event, expected);
    if (appended.kind === 'refusal') return appended;
    const next = appended.kind === 'appended' ? [...records, appended.record] : records;
    try { return { kind: 'accepted', persistence: appended.kind, snapshot: snapshot(project(next, event.operationId)!, event.operationId, this.store.durability) }; }
    catch (error) { return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Stop writes and restore the procurement journal from a verified replica.'); }
  }

  private retry(
    records: readonly StoredProcurementRecord[],
    procurementId: string,
    eventId: string,
    kind: ProcurementEvent['kind'],
    commandHash: string,
  ): ProcurementCommandResult | null {
    const existing = records.find(record => record.event.eventId === eventId);
    if (!existing) return null;
    if (existing.event.kind !== kind || existing.event.commandHash !== commandHash) {
      return refusal('PROCUREMENT_EVENT_ID_CONFLICT', `${eventId} identifies a different procurement intent.`, 'Use the original request or allocate a new request identity for changed facts.');
    }
    try {
      return { kind: 'accepted', persistence: 'duplicate', snapshot: snapshot(project(records, procurementId)!, procurementId, this.store.durability) };
    } catch (error) {
      return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Restore the procurement journal from a verified replica.');
    }
  }
}

export function procurementStateSnapshotId(snapshot: ProcurementSnapshot): string {
  return `procurement-state:${hashCommand({ requirement: snapshot.requirement, alternatives: snapshot.alternatives, decisionSet: snapshot.decisionSet })}`;
}
