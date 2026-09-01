/** Append-only persistence contract for procurement and physical-position events. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Attestation } from './attestation';
import { hashCommand, stableValue } from './loadOperationsStore';
import { processSingleton } from './processSingleton';
import type { Hash, ISODateTime } from './types';

export type ProcurementQuantityUnit = 'kg' | 'tonne' | 'lb' | 'unit' | 'liter' | 'm3';

export type ProcurementQuantity = {
  readonly amount: number;
  readonly unit: ProcurementQuantityUnit;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type ProcurementMoney = {
  readonly amountMinor: number;
  readonly currency: string;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type ProcurementMoneyState =
  | { readonly kind: 'observed'; readonly value: ProcurementMoney }
  | {
      readonly kind: 'absent';
      readonly reason: 'not_observed' | 'pending' | 'not_applicable' | 'conflicting';
      readonly detail: string;
      readonly remedy: string;
      readonly evidenceIds: readonly string[];
    };

export type ProcurementRequirement = {
  readonly requirementId: string;
  readonly materialId: string;
  readonly specificationId: string;
  readonly quantity: ProcurementQuantity;
  readonly destinationId: string;
  readonly deliveryWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly maximumLandedCost: ProcurementMoneyState;
  readonly customerCommitmentId: string | null;
  readonly requestedAt: ISODateTime;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type SupplierAlternative = {
  readonly actionId: string;
  readonly supplierId: string;
  readonly facilityId: string | null;
  readonly materialId: string;
  readonly specificationId: string;
  readonly quantity: ProcurementQuantity;
  readonly quotedTotal: ProcurementMoney;
  readonly incoterm: string;
  readonly availabilityWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly validUntil: ISODateTime;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type SupplierAuthorizationCheckName =
  | 'counterparty_eligibility'
  | 'sanctions_screening'
  | 'specification_match'
  | 'credit_terms'
  | 'authority_to_buy';

export type SupplierAuthorizationCheck = {
  readonly name: SupplierAuthorizationCheckName;
  readonly state: 'satisfied' | 'refused' | 'undetermined';
  readonly detail: string;
  readonly evidenceIds: readonly string[];
};

export type SupplierAuthorization = {
  readonly decision: 'authorized' | 'refused' | 'undetermined';
  readonly evaluatedAt: ISODateTime;
  readonly checks: readonly SupplierAuthorizationCheck[];
  readonly evidenceIds: readonly string[];
};

export type PurchaseCommitment = {
  readonly contractId: string;
  readonly positionId: string;
  readonly actionId: string;
  readonly supplierId: string;
  readonly quantity: ProcurementQuantity;
  readonly committedPrice: ProcurementMoney;
  readonly incoterm: string;
  readonly titleTransferPoint: string;
  readonly committedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type PositionLogisticsRequirement = {
  readonly logisticsRequirementId: string;
  readonly positionId: string;
  readonly originId: string;
  readonly destinationId: string;
  readonly readyWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly deliveryWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly handlingProfileId: string | null;
  readonly evidenceIds: readonly string[];
};

export type PositionReceipt = {
  readonly positionId: string;
  readonly receivedQuantity: ProcurementQuantity;
  readonly receivedAt: ISODateTime;
  readonly locationId: string;
  readonly disposition: 'accepted' | 'quarantined' | 'rejected';
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type ProcurementSettlement = {
  readonly positionId: string;
  readonly purchaseInvoice: ProcurementMoneyState;
  readonly freightCost: ProcurementMoneyState;
  readonly dutyCost: ProcurementMoneyState;
  readonly insuranceCost: ProcurementMoneyState;
  readonly storageCost: ProcurementMoneyState;
  readonly financingCost: ProcurementMoneyState;
  readonly lossCost: ProcurementMoneyState;
  readonly saleRevenue: ProcurementMoneyState;
  readonly knownAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

type ProcurementEventBase = {
  readonly eventId: string;
  /** Compatibility aggregate key used by the shared ordered event substrate. */
  readonly operationId: string;
  readonly recordedAt: ISODateTime;
  readonly commandHash: Hash;
};

export type ProcurementRequirementRegisteredEvent = ProcurementEventBase & {
  readonly kind: 'procurement_requirement_registered';
  readonly requirement: ProcurementRequirement;
};

export type SupplierAlternativeRegisteredEvent = ProcurementEventBase & {
  readonly kind: 'supplier_alternative_registered';
  readonly alternative: SupplierAlternative;
};

export type SupplierAuthorizationRecordedEvent = ProcurementEventBase & {
  readonly kind: 'supplier_authorization_recorded';
  readonly actionId: string;
  readonly authorization: SupplierAuthorization;
};

export type ProcurementDecisionSetFrozenEvent = ProcurementEventBase & {
  readonly kind: 'procurement_decision_set_frozen';
  readonly episodeId: string;
  readonly knowledgeCutoff: ISODateTime;
  readonly stateSnapshotId: string;
  readonly feasibleActionIds: readonly string[];
  readonly evidenceIds: readonly string[];
};

export type ProcurementSupplierSelectedEvent = ProcurementEventBase & {
  readonly kind: 'procurement_supplier_selected';
  readonly episodeId: string;
  readonly selectedActionId: string;
  readonly selectedBy: string;
  readonly rationale: string;
  readonly evidenceIds: readonly string[];
};

export type ProcurementPurchaseCommittedEvent = ProcurementEventBase & {
  readonly kind: 'procurement_purchase_committed';
  readonly purchase: PurchaseCommitment;
};

export type PositionLogisticsRequiredEvent = ProcurementEventBase & {
  readonly kind: 'position_logistics_required';
  readonly logistics: PositionLogisticsRequirement;
};

export type PositionReceiptRecordedEvent = ProcurementEventBase & {
  readonly kind: 'position_receipt_recorded';
  readonly receipt: PositionReceipt;
};

export type ProcurementSettlementCapturedEvent = ProcurementEventBase & {
  readonly kind: 'procurement_settlement_captured';
  readonly settlement: ProcurementSettlement;
  readonly supersedesEventId: string | null;
};

export type ProcurementEvent =
  | ProcurementRequirementRegisteredEvent
  | SupplierAlternativeRegisteredEvent
  | SupplierAuthorizationRecordedEvent
  | ProcurementDecisionSetFrozenEvent
  | ProcurementSupplierSelectedEvent
  | ProcurementPurchaseCommittedEvent
  | PositionLogisticsRequiredEvent
  | PositionReceiptRecordedEvent
  | ProcurementSettlementCapturedEvent;

export type StoredProcurementRecord = {
  readonly event: ProcurementEvent;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
};

export type ProcurementStoreAppendResult =
  | { readonly kind: 'appended'; readonly record: StoredProcurementRecord }
  | { readonly kind: 'duplicate'; readonly record: StoredProcurementRecord }
  | {
      readonly kind: 'refusal';
      readonly code: 'PROCUREMENT_EVENT_ID_CONFLICT' | 'PROCUREMENT_STORE_CONCURRENT_WRITE' | 'PROCUREMENT_STORE_CORRUPT';
      readonly detail: string;
      readonly remedy: string;
    };

export type ProcurementEventStore = {
  readonly durability: 'memory' | 'local_jsonl_single_writer' | 'sqlite_wal';
  readAll(): Promise<readonly StoredProcurementRecord[]>;
  append(event: ProcurementEvent, expectedPreviousHash?: Hash | null): Promise<ProcurementStoreAppendResult>;
};

const DOMAIN = 'payload.procurement.record.v1';

export function procurementRecordHash(event: ProcurementEvent, previousHash: Hash | null): Hash {
  return createHash('sha256')
    .update(`${DOMAIN}|${previousHash ?? 'GENESIS'}|${JSON.stringify(stableValue(event))}`)
    .digest('hex');
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function refusal(
  code: Extract<ProcurementStoreAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<ProcurementStoreAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

export function verifyProcurementRecords(records: readonly StoredProcurementRecord[]): string | null {
  let previous: Hash | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.event?.eventId || ids.has(record.event.eventId)) return `empty or duplicate procurement event id ${record.event?.eventId ?? '(missing)'}`;
    if (!record.event.operationId?.trim()) return `record ${record.event.eventId} has no aggregate identity`;
    if (!/^[a-f0-9]{64}$/.test(record.event.commandHash)) return `record ${record.event.eventId} has an invalid command hash`;
    if (!Number.isFinite(Date.parse(record.event.recordedAt))) return `record ${record.event.eventId} has an invalid recordedAt`;
    if (record.previousHash !== previous) return `record ${record.event.eventId} does not extend the preceding hash`;
    if (record.recordHash !== procurementRecordHash(record.event, previous)) return `record ${record.event.eventId} hash does not match its canonical event`;
    ids.add(record.event.eventId);
    previous = record.recordHash;
  }
  return null;
}

function appendTo(
  records: StoredProcurementRecord[],
  event: ProcurementEvent,
  expectedPreviousHash?: Hash | null,
): ProcurementStoreAppendResult {
  const existing = records.find(record => record.event.eventId === event.eventId);
  if (existing) {
    return JSON.stringify(stableValue(existing.event)) === JSON.stringify(stableValue(event))
      ? { kind: 'duplicate', record: existing }
      : refusal('PROCUREMENT_EVENT_ID_CONFLICT', `Procurement event id ${event.eventId} already identifies different content.`, 'Retry the original action or use a new request identity.');
  }
  const previousHash = records.at(-1)?.recordHash ?? null;
  if (expectedPreviousHash !== undefined && expectedPreviousHash !== previousHash) {
    return refusal('PROCUREMENT_STORE_CONCURRENT_WRITE', `Procurement journal tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'}.`, 'Reload state and retry the same idempotent action.');
  }
  const sealed = freeze(event);
  const record = freeze({ event: sealed, previousHash, recordHash: procurementRecordHash(sealed, previousHash) });
  records.push(record);
  return { kind: 'appended', record };
}

export class MemoryProcurementStore implements ProcurementEventStore {
  readonly durability = 'memory' as const;
  private readonly records: StoredProcurementRecord[] = [];
  async readAll(): Promise<readonly StoredProcurementRecord[]> { return Object.freeze([...this.records]); }
  async append(event: ProcurementEvent, expectedPreviousHash?: Hash | null): Promise<ProcurementStoreAppendResult> {
    return appendTo(this.records, event, expectedPreviousHash);
  }
}

type QueueRegistry = Map<string, Promise<unknown>>;
const queues = () => processSingleton<QueueRegistry>('procurement-file-queues', () => new Map());

async function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const registry = queues();
  const prior = registry.get(path) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  registry.set(path, current);
  try { return await current; }
  finally { if (registry.get(path) === current) registry.delete(path); }
}

export class FileProcurementStore implements ProcurementEventStore {
  readonly durability = 'local_jsonl_single_writer' as const;
  readonly filePath: string;
  constructor(filePath: string) { this.filePath = resolve(filePath); }

  async readAll(): Promise<readonly StoredProcurementRecord[]> {
    let body: string;
    try { body = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!body) return Object.freeze([]);
    if (!body.endsWith('\n')) throw new Error('PROCUREMENT_STORE_CORRUPT: journal ends with a partial record');
    const records: StoredProcurementRecord[] = [];
    for (const [index, line] of body.slice(0, -1).split('\n').entries()) {
      try { records.push(JSON.parse(line) as StoredProcurementRecord); }
      catch { throw new Error(`PROCUREMENT_STORE_CORRUPT: journal line ${index + 1} is not valid JSON`); }
    }
    const defect = verifyProcurementRecords(records);
    if (defect) throw new Error(`PROCUREMENT_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  async append(event: ProcurementEvent, expectedPreviousHash?: Hash | null): Promise<ProcurementStoreAppendResult> {
    return serialized(this.filePath, async () => {
      let records: StoredProcurementRecord[];
      try { records = [...await this.readAll()]; }
      catch (error) {
        return refusal('PROCUREMENT_STORE_CORRUPT', (error as Error).message, 'Restore the journal from a verified replica; never truncate invalid history.');
      }
      const result = appendTo(records, event, expectedPreviousHash);
      if (result.kind !== 'appended') return result;
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(result.record)}\n`, { encoding: 'utf8', flag: 'a' });
      return result;
    });
  }
}

export { hashCommand };
