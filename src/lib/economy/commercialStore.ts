/** Append-only persistence contract for inventory, sales, and customer-commitment events. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Attestation } from './attestation';
import { hashCommand, stableValue } from './loadOperationsStore';
import { processSingleton } from './processSingleton';
import type {
  ProcurementMoney,
  ProcurementMoneyState,
  ProcurementQuantity,
  ProcurementQuantityUnit,
} from './procurementStore';
import type { Hash, ISODateTime } from './types';

export type CommercialQuantityUnit = ProcurementQuantityUnit;
export type CommercialQuantity = ProcurementQuantity;
export type CommercialMoney = ProcurementMoney;
export type CommercialMoneyState = ProcurementMoneyState;

export type InventoryLot = {
  readonly lotId: string;
  readonly sourceProcurementId: string;
  readonly sourcePositionId: string;
  readonly sourceSnapshotId: string;
  readonly materialId: string;
  readonly specificationId: string;
  readonly initialQuantity: CommercialQuantity;
  readonly locationId: string;
  readonly receivedAt: ISODateTime;
  readonly totalLandedCost: CommercialMoneyState;
  readonly openedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type InventoryLotCostUpdate = {
  readonly lotId: string;
  readonly sourceProcurementId: string;
  readonly sourcePositionId: string;
  readonly sourceSnapshotId: string;
  readonly totalLandedCost: CommercialMoney;
  readonly updatedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type CustomerCommitment = {
  readonly commitmentId: string;
  readonly customerId: string;
  readonly customerPurchaseOrderId: string;
  readonly materialId: string;
  readonly specificationId: string;
  readonly requiredQuantity: CommercialQuantity;
  readonly destinationId: string;
  readonly deliveryWindow: { readonly start: ISODateTime; readonly end: ISODateTime };
  readonly minimumRevenue: CommercialMoneyState;
  readonly requestedAt: ISODateTime;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type InventoryAllocation = {
  readonly allocationId: string;
  readonly commitmentId: string;
  readonly lotId: string;
  readonly quantity: CommercialQuantity;
  readonly reservedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type SaleContract = {
  readonly saleContractId: string;
  readonly commitmentId: string;
  readonly customerId: string;
  readonly allocationIds: readonly string[];
  readonly contractedQuantity: CommercialQuantity;
  readonly totalRevenue: CommercialMoney;
  readonly incoterm: string;
  readonly titleTransferPoint: string;
  readonly signedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type SaleFulfillment = {
  readonly fulfillmentId: string;
  readonly commitmentId: string;
  readonly saleContractId: string;
  readonly allocationIds: readonly string[];
  readonly originLocationIds: readonly string[];
  readonly destinationId: string;
  readonly loadOperationId: string;
  readonly dispatchedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type CustomerDelivery = {
  readonly deliveryId: string;
  readonly commitmentId: string;
  readonly fulfillmentId: string;
  readonly allocationId: string;
  readonly deliveredQuantity: CommercialQuantity;
  readonly deliveredAt: ISODateTime;
  readonly locationId: string;
  readonly disposition: 'accepted' | 'quarantined' | 'rejected';
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type SaleSettlement = {
  readonly commitmentId: string;
  readonly saleContractId: string;
  readonly grossRevenue: CommercialMoneyState;
  readonly deductions: CommercialMoneyState;
  readonly knownAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

type CommercialEventBase = {
  readonly eventId: string;
  /** Compatibility aggregate column used by the global event database. */
  readonly operationId: string;
  readonly recordedAt: ISODateTime;
  readonly commandHash: Hash;
};

export type InventoryLotOpenedEvent = CommercialEventBase & {
  readonly kind: 'inventory_lot_opened';
  readonly lot: InventoryLot;
};

export type CustomerCommitmentRegisteredEvent = CommercialEventBase & {
  readonly kind: 'customer_commitment_registered';
  readonly commitment: CustomerCommitment;
};

export type InventoryLotCostUpdatedEvent = CommercialEventBase & {
  readonly kind: 'inventory_lot_cost_updated';
  readonly update: InventoryLotCostUpdate;
  readonly supersedesEventId: string;
};

export type InventoryAllocationReservedEvent = CommercialEventBase & {
  readonly kind: 'inventory_allocation_reserved';
  readonly allocation: InventoryAllocation;
};

export type SaleContractCommittedEvent = CommercialEventBase & {
  readonly kind: 'sale_contract_committed';
  readonly contract: SaleContract;
};

export type SaleFulfillmentDispatchedEvent = CommercialEventBase & {
  readonly kind: 'sale_fulfillment_dispatched';
  readonly fulfillment: SaleFulfillment;
};

export type CustomerDeliveryRecordedEvent = CommercialEventBase & {
  readonly kind: 'customer_delivery_recorded';
  readonly delivery: CustomerDelivery;
};

export type SaleSettlementCapturedEvent = CommercialEventBase & {
  readonly kind: 'sale_settlement_captured';
  readonly settlement: SaleSettlement;
  readonly supersedesEventId: string | null;
};

export type CommercialEvent =
  | InventoryLotOpenedEvent
  | InventoryLotCostUpdatedEvent
  | CustomerCommitmentRegisteredEvent
  | InventoryAllocationReservedEvent
  | SaleContractCommittedEvent
  | SaleFulfillmentDispatchedEvent
  | CustomerDeliveryRecordedEvent
  | SaleSettlementCapturedEvent;

export type StoredCommercialRecord = {
  readonly event: CommercialEvent;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
};

export type CommercialStoreAppendResult =
  | { readonly kind: 'appended'; readonly record: StoredCommercialRecord }
  | { readonly kind: 'duplicate'; readonly record: StoredCommercialRecord }
  | {
      readonly kind: 'refusal';
      readonly code: 'COMMERCIAL_EVENT_ID_CONFLICT' | 'COMMERCIAL_STORE_CONCURRENT_WRITE' | 'COMMERCIAL_STORE_CORRUPT';
      readonly detail: string;
      readonly remedy: string;
    };

export type CommercialEventStore = {
  readonly durability: 'memory' | 'local_jsonl_single_writer' | 'sqlite_wal';
  readAll(): Promise<readonly StoredCommercialRecord[]>;
  append(event: CommercialEvent, expectedPreviousHash?: Hash | null): Promise<CommercialStoreAppendResult>;
};

const DOMAIN = 'payload.commercial.record.v1';

export function commercialRecordHash(event: CommercialEvent, previousHash: Hash | null): Hash {
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
  code: Extract<CommercialStoreAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<CommercialStoreAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

export function verifyCommercialRecords(records: readonly StoredCommercialRecord[]): string | null {
  let previous: Hash | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.event?.eventId || ids.has(record.event.eventId)) return `empty or duplicate commercial event id ${record.event?.eventId ?? '(missing)'}`;
    if (!record.event.operationId?.trim()) return `record ${record.event.eventId} has no aggregate identity`;
    if (!/^[a-f0-9]{64}$/.test(record.event.commandHash)) return `record ${record.event.eventId} has an invalid command hash`;
    if (!Number.isFinite(Date.parse(record.event.recordedAt))) return `record ${record.event.eventId} has an invalid recordedAt`;
    if (record.previousHash !== previous) return `record ${record.event.eventId} does not extend the preceding hash`;
    if (record.recordHash !== commercialRecordHash(record.event, previous)) return `record ${record.event.eventId} hash does not match its canonical event`;
    ids.add(record.event.eventId);
    previous = record.recordHash;
  }
  return null;
}

function appendTo(
  records: StoredCommercialRecord[],
  event: CommercialEvent,
  expectedPreviousHash?: Hash | null,
): CommercialStoreAppendResult {
  const existing = records.find(record => record.event.eventId === event.eventId);
  if (existing) {
    return JSON.stringify(stableValue(existing.event)) === JSON.stringify(stableValue(event))
      ? { kind: 'duplicate', record: existing }
      : refusal('COMMERCIAL_EVENT_ID_CONFLICT', `Commercial event id ${event.eventId} already identifies different content.`, 'Retry the original action or use a new request identity.');
  }
  const previousHash = records.at(-1)?.recordHash ?? null;
  if (expectedPreviousHash !== undefined && expectedPreviousHash !== previousHash) {
    return refusal('COMMERCIAL_STORE_CONCURRENT_WRITE', `Commercial journal tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'}.`, 'Reload state and retry the same idempotent action.');
  }
  const sealed = freeze(event);
  const record = freeze({ event: sealed, previousHash, recordHash: commercialRecordHash(sealed, previousHash) });
  records.push(record);
  return { kind: 'appended', record };
}

export class MemoryCommercialStore implements CommercialEventStore {
  readonly durability = 'memory' as const;
  private readonly records: StoredCommercialRecord[] = [];
  async readAll(): Promise<readonly StoredCommercialRecord[]> { return Object.freeze([...this.records]); }
  async append(event: CommercialEvent, expectedPreviousHash?: Hash | null): Promise<CommercialStoreAppendResult> {
    return appendTo(this.records, event, expectedPreviousHash);
  }
}

type QueueRegistry = Map<string, Promise<unknown>>;
const queues = () => processSingleton<QueueRegistry>('commercial-file-queues', () => new Map());

async function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const registry = queues();
  const prior = registry.get(path) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  registry.set(path, current);
  try { return await current; }
  finally { if (registry.get(path) === current) registry.delete(path); }
}

export class FileCommercialStore implements CommercialEventStore {
  readonly durability = 'local_jsonl_single_writer' as const;
  readonly filePath: string;
  constructor(filePath: string) { this.filePath = resolve(filePath); }

  async readAll(): Promise<readonly StoredCommercialRecord[]> {
    let body: string;
    try { body = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!body) return Object.freeze([]);
    if (!body.endsWith('\n')) throw new Error('COMMERCIAL_STORE_CORRUPT: journal ends with a partial record');
    const records: StoredCommercialRecord[] = [];
    for (const [index, line] of body.slice(0, -1).split('\n').entries()) {
      try { records.push(JSON.parse(line) as StoredCommercialRecord); }
      catch { throw new Error(`COMMERCIAL_STORE_CORRUPT: journal line ${index + 1} is not valid JSON`); }
    }
    const defect = verifyCommercialRecords(records);
    if (defect) throw new Error(`COMMERCIAL_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  async append(event: CommercialEvent, expectedPreviousHash?: Hash | null): Promise<CommercialStoreAppendResult> {
    return serialized(this.filePath, async () => {
      let records: StoredCommercialRecord[];
      try { records = [...await this.readAll()]; }
      catch (error) {
        return refusal('COMMERCIAL_STORE_CORRUPT', (error as Error).message, 'Restore the journal from a verified replica; never truncate invalid history.');
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
