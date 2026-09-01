/** Append-only persistence contract for constrained project-cargo execution. */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Attestation } from './attestation';
import { hashCommand, stableValue } from './loadOperationsStore';
import { processSingleton } from './processSingleton';
import type { CommercialMoney, CommercialMoneyState, CommercialQuantity } from './commercialStore';
import type { Hash, ISODateTime } from './types';

export type CargoCategory =
  | 'luxury_yacht'
  | 'technology_equipment'
  | 'medical_equipment'
  | 'heavy_machinery'
  | 'fine_art_collectible'
  | 'luxury_automobile'
  | 'luxury_furniture'
  | 'pharmaceutical_cold_chain'
  | 'international_electronics'
  | 'other_specialized';

export type CargoGeometry = {
  readonly lengthM: number;
  readonly widthM: number;
  readonly heightM: number;
  readonly grossWeightKg: number;
};

export type CargoConstraintProfile = {
  readonly temperature?: { readonly minimum: number; readonly maximum: number; readonly unit: 'Cel' };
  readonly relativeHumidity?: { readonly minimum: number; readonly maximum: number; readonly unit: '%' };
  readonly maximumShockG?: number;
  readonly maximumVibrationMmS?: number;
  readonly maximumTiltDegrees?: number;
  readonly allowedOrientations: readonly ('upright' | 'side' | 'inverted')[];
  readonly handlingRequirements: readonly string[];
  readonly securityRequirements: readonly string[];
  readonly regulatoryRequirements: readonly string[];
  readonly requiredDocumentTypes: readonly string[];
  readonly requiredTelemetrySignals: readonly TelemetrySignal[];
  readonly continuousCustodyRequired: boolean;
};

export type ProjectCargoItem = {
  readonly cargoItemId: string;
  readonly assetId: string;
  readonly category: CargoCategory;
  readonly description: string;
  readonly manufacturer?: string;
  readonly model?: string;
  readonly serialOrLotIds: readonly string[];
  readonly quantity: CommercialQuantity;
  readonly declaredValue: CommercialMoneyState;
  readonly geometry: CargoGeometry | null;
  readonly constraintProfile: CargoConstraintProfile;
  readonly evidenceIds: readonly string[];
};

export type ProjectCargo = {
  readonly projectId: string;
  readonly projectReference: string;
  readonly customerId: string;
  readonly customerCommitmentId: string | null;
  readonly originLocationId: string;
  readonly destinationLocationId: string;
  readonly cargoItems: readonly ProjectCargoItem[];
  readonly openedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type JourneyMode = 'road' | 'rail' | 'ocean' | 'air' | 'inland_waterway' | 'warehouse' | 'installation';
export type JourneyLegStatus = 'planned' | 'ready' | 'in_transit' | 'arrived' | 'completed' | 'blocked' | 'cancelled';

export type JourneyFacility = {
  readonly facilityId: string;
  readonly locationId: string;
  readonly facilityType: 'origin' | 'port' | 'airport' | 'rail_terminal' | 'warehouse' | 'border' | 'destination' | 'installation_site';
  readonly capabilities: readonly string[];
};

export type JourneyPermit = {
  readonly permitId: string;
  readonly permitType: string;
  readonly authority: string;
  readonly requiredForLegIds: readonly string[];
};

export type JourneyLeg = {
  readonly legId: string;
  readonly sequence: number;
  readonly mode: JourneyMode;
  readonly fromFacilityId: string;
  readonly toFacilityId: string;
  readonly providerId: string | null;
  readonly plannedStart: ISODateTime;
  readonly plannedEnd: ISODateTime;
  readonly dependsOnLegIds: readonly string[];
  readonly requiredPermitIds: readonly string[];
  readonly loadOperationId: string | null;
};

export type JourneyPlan = {
  readonly journeyId: string;
  readonly projectId: string;
  readonly version: number;
  readonly facilities: readonly JourneyFacility[];
  readonly permits: readonly JourneyPermit[];
  readonly legs: readonly JourneyLeg[];
  readonly plannedAt: ISODateTime;
  readonly authorizedBy: string;
  readonly evidenceIds: readonly string[];
};

export type PermitStatusUpdate = {
  readonly projectId: string;
  readonly journeyId: string;
  readonly permitId: string;
  readonly status: 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired';
  readonly validFrom: ISODateTime | null;
  readonly validThrough: ISODateTime | null;
  readonly updatedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type JourneyLegUpdate = {
  readonly projectId: string;
  readonly journeyId: string;
  readonly legId: string;
  readonly status: JourneyLegStatus;
  readonly locationId: string;
  readonly occurredAt: ISODateTime;
  readonly source: 'operator' | 'carrier' | 'edi';
  readonly evidenceIds: readonly string[];
};

export type CustodyTransfer = {
  readonly transferId: string;
  readonly projectId: string;
  readonly cargoItemIds: readonly string[];
  readonly fromCustodianId: string | null;
  readonly toCustodianId: string;
  readonly locationId: string;
  readonly transferredAt: ISODateTime;
  readonly sealId: string | null;
  readonly conditionNote: string;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
};

export type ProjectEvidence = {
  readonly evidenceId: string;
  readonly projectId: string;
  readonly cargoItemId: string | null;
  readonly evidenceType: 'condition_report' | 'photo' | 'document' | 'permit' | 'signature' | 'sensor_artifact' | 'invoice' | 'claim' | 'other';
  readonly documentType: string | null;
  readonly sha256: Hash;
  readonly capturedAt: ISODateTime;
  readonly sourceReference: string;
  readonly attestation: Attestation;
};

export type TelemetrySignal = 'temperature' | 'relative_humidity' | 'shock' | 'vibration' | 'tilt' | 'door' | 'seal' | 'location';
export type OTelAttributeValue = string | number | boolean | readonly string[] | readonly number[] | readonly boolean[];

/**
 * Logical OpenTelemetry LogRecord. Field names intentionally match the stable
 * OTLP log data model while project-specific semantics stay under payload.*.
 */
export type CargoTelemetryObservation = {
  readonly observationId: string;
  readonly projectId: string;
  readonly cargoItemId: string;
  readonly sensorId: string;
  readonly signal: TelemetrySignal;
  readonly numericValue: number | null;
  readonly textValue: string | null;
  readonly unit: string;
  readonly eventName: 'payload.cargo.condition.observed';
  readonly timestamp: ISODateTime;
  readonly observedTimestamp: ISODateTime;
  readonly severityNumber: number;
  readonly severityText: 'INFO' | 'WARN' | 'ERROR';
  readonly traceId: string | null;
  readonly spanId: string | null;
  readonly resource: { readonly attributes: Readonly<Record<string, OTelAttributeValue>> };
  readonly instrumentationScope: { readonly name: 'notationsystems.payload.project-cargo'; readonly version: '1.0.0' };
  readonly attributes: Readonly<Record<string, OTelAttributeValue>>;
  readonly body: string;
  readonly attestation: Attestation;
  readonly evidenceIds: readonly string[];
  readonly breaches: readonly ConditionBreach[];
};

export type ConditionBreach = {
  readonly exceptionId: string;
  readonly code: 'TEMPERATURE_LOW' | 'TEMPERATURE_HIGH' | 'HUMIDITY_LOW' | 'HUMIDITY_HIGH' | 'SHOCK_HIGH' | 'VIBRATION_HIGH' | 'TILT_HIGH' | 'UNEXPECTED_SIGNAL';
  readonly signal: TelemetrySignal;
  readonly observedValue: number;
  readonly limitValue: number;
  readonly unit: string;
};

export type ExceptionRemedyAuthorization = {
  readonly projectId: string;
  readonly exceptionId: string;
  readonly remedyCode: 'inspect' | 'quarantine' | 'recondition' | 'reroute' | 'replace_packaging' | 'notify_customer' | 'file_claim' | 'release';
  readonly instruction: string;
  readonly authorizedBy: string;
  readonly authorizedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type ExceptionRemedyCompletion = {
  readonly projectId: string;
  readonly exceptionId: string;
  readonly outcome: 'resolved' | 'contained' | 'failed';
  readonly completedBy: string;
  readonly completedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
};

export type ProjectEconomicEntry = {
  readonly entryId: string;
  readonly projectId: string;
  readonly category: 'customer_revenue' | 'freight' | 'handling' | 'insurance' | 'customs' | 'storage' | 'permit' | 'claim_loss' | 'claim_recovery' | 'other';
  readonly effect: 'revenue' | 'cost' | 'recovery';
  readonly amount: CommercialMoney;
  readonly incurredAt: ISODateTime;
  readonly sourceSystem: 'operator' | 'commercial' | 'accounting' | 'payment' | 'claims';
  readonly externalReference: string;
  readonly evidenceIds: readonly string[];
};

export type ProjectEconomicsClosure = {
  readonly closureId: string;
  readonly projectId: string;
  readonly closedAt: ISODateTime;
  readonly closedBy: string;
  readonly sourceSystemsReconciled: readonly ('commercial' | 'accounting' | 'payment' | 'claims')[];
  readonly evidenceIds: readonly string[];
};

export type ProjectIntegrationExchange = {
  readonly exchangeId: string;
  readonly projectId: string;
  readonly integration: 'carrier' | 'sensor' | 'edi' | 'accounting' | 'payment';
  readonly direction: 'inbound' | 'outbound';
  readonly status: 'accepted' | 'rejected' | 'pending';
  readonly externalReference: string;
  readonly occurredAt: ISODateTime;
  readonly metadata: Readonly<Record<string, string | number | boolean>>;
  readonly evidenceIds: readonly string[];
};

export type ProjectDeliveryVerification = {
  readonly verificationId: string;
  readonly projectId: string;
  readonly disposition: 'accepted' | 'quarantined' | 'rejected';
  readonly verifiedAt: ISODateTime;
  readonly locationId: string;
  readonly verifiedBy: string;
  readonly evidenceIds: readonly string[];
};

type ProjectCargoEventBase = {
  readonly eventId: string;
  readonly operationId: string;
  readonly recordedAt: ISODateTime;
  readonly commandHash: Hash;
};

export type ProjectCargoEvent =
  | (ProjectCargoEventBase & { readonly kind: 'project_registered'; readonly project: ProjectCargo })
  | (ProjectCargoEventBase & { readonly kind: 'journey_planned'; readonly plan: JourneyPlan })
  | (ProjectCargoEventBase & { readonly kind: 'permit_status_updated'; readonly update: PermitStatusUpdate })
  | (ProjectCargoEventBase & { readonly kind: 'journey_leg_updated'; readonly update: JourneyLegUpdate })
  | (ProjectCargoEventBase & { readonly kind: 'custody_transferred'; readonly transfer: CustodyTransfer })
  | (ProjectCargoEventBase & { readonly kind: 'project_evidence_attached'; readonly evidence: ProjectEvidence })
  | (ProjectCargoEventBase & { readonly kind: 'cargo_condition_observed'; readonly observation: CargoTelemetryObservation })
  | (ProjectCargoEventBase & { readonly kind: 'exception_remedy_authorized'; readonly authorization: ExceptionRemedyAuthorization })
  | (ProjectCargoEventBase & { readonly kind: 'exception_remedy_completed'; readonly completion: ExceptionRemedyCompletion })
  | (ProjectCargoEventBase & { readonly kind: 'project_economic_entry_recorded'; readonly entry: ProjectEconomicEntry })
  | (ProjectCargoEventBase & { readonly kind: 'project_economics_closed'; readonly closure: ProjectEconomicsClosure })
  | (ProjectCargoEventBase & { readonly kind: 'project_integration_recorded'; readonly exchange: ProjectIntegrationExchange })
  | (ProjectCargoEventBase & { readonly kind: 'project_delivery_verified'; readonly verification: ProjectDeliveryVerification });

export type StoredProjectCargoRecord = {
  readonly event: ProjectCargoEvent;
  readonly previousHash: Hash | null;
  readonly recordHash: Hash;
};

export type ProjectCargoStoreAppendResult =
  | { readonly kind: 'appended'; readonly record: StoredProjectCargoRecord }
  | { readonly kind: 'duplicate'; readonly record: StoredProjectCargoRecord }
  | {
      readonly kind: 'refusal';
      readonly code: 'PROJECT_CARGO_EVENT_ID_CONFLICT' | 'PROJECT_CARGO_STORE_CONCURRENT_WRITE' | 'PROJECT_CARGO_STORE_CORRUPT';
      readonly detail: string;
      readonly remedy: string;
    };

export type ProjectCargoEventStore = {
  readonly durability: 'memory' | 'local_jsonl_single_writer' | 'sqlite_wal';
  readAll(): Promise<readonly StoredProjectCargoRecord[]>;
  append(event: ProjectCargoEvent, expectedPreviousHash?: Hash | null): Promise<ProjectCargoStoreAppendResult>;
};

const DOMAIN = 'payload.project_cargo.record.v1';

export function projectCargoRecordHash(event: ProjectCargoEvent, previousHash: Hash | null): Hash {
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
  code: Extract<ProjectCargoStoreAppendResult, { kind: 'refusal' }>['code'],
  detail: string,
  remedy: string,
): Extract<ProjectCargoStoreAppendResult, { kind: 'refusal' }> {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

export function verifyProjectCargoRecords(records: readonly StoredProjectCargoRecord[]): string | null {
  let previous: Hash | null = null;
  const ids = new Set<string>();
  for (const record of records) {
    if (!record.event?.eventId || ids.has(record.event.eventId)) return `empty or duplicate project-cargo event id ${record.event?.eventId ?? '(missing)'}`;
    if (!record.event.operationId?.trim()) return `record ${record.event.eventId} has no project identity`;
    if (!/^[a-f0-9]{64}$/.test(record.event.commandHash)) return `record ${record.event.eventId} has an invalid command hash`;
    if (!Number.isFinite(Date.parse(record.event.recordedAt))) return `record ${record.event.eventId} has an invalid recordedAt`;
    if (record.previousHash !== previous) return `record ${record.event.eventId} does not extend the preceding hash`;
    if (record.recordHash !== projectCargoRecordHash(record.event, previous)) return `record ${record.event.eventId} hash does not match its canonical event`;
    ids.add(record.event.eventId);
    previous = record.recordHash;
  }
  return null;
}

function appendTo(
  records: StoredProjectCargoRecord[],
  event: ProjectCargoEvent,
  expectedPreviousHash?: Hash | null,
): ProjectCargoStoreAppendResult {
  const existing = records.find(record => record.event.eventId === event.eventId);
  if (existing) {
    return JSON.stringify(stableValue(existing.event)) === JSON.stringify(stableValue(event))
      ? { kind: 'duplicate', record: existing }
      : refusal('PROJECT_CARGO_EVENT_ID_CONFLICT', `Project-cargo event id ${event.eventId} already identifies different content.`, 'Retry the original action or use a new request identity.');
  }
  const previousHash = records.at(-1)?.recordHash ?? null;
  if (expectedPreviousHash !== undefined && expectedPreviousHash !== previousHash) {
    return refusal('PROJECT_CARGO_STORE_CONCURRENT_WRITE', `Project-cargo journal tail changed from ${expectedPreviousHash ?? 'GENESIS'} to ${previousHash ?? 'GENESIS'}.`, 'Reload state and retry the same idempotent action.');
  }
  const sealed = freeze(event);
  const record = freeze({ event: sealed, previousHash, recordHash: projectCargoRecordHash(sealed, previousHash) });
  records.push(record);
  return { kind: 'appended', record };
}

export class MemoryProjectCargoStore implements ProjectCargoEventStore {
  readonly durability = 'memory' as const;
  private readonly records: StoredProjectCargoRecord[] = [];
  async readAll(): Promise<readonly StoredProjectCargoRecord[]> { return Object.freeze([...this.records]); }
  async append(event: ProjectCargoEvent, expectedPreviousHash?: Hash | null): Promise<ProjectCargoStoreAppendResult> {
    return appendTo(this.records, event, expectedPreviousHash);
  }
}

type QueueRegistry = Map<string, Promise<unknown>>;
const queues = () => processSingleton<QueueRegistry>('project-cargo-file-queues', () => new Map());

async function serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
  const registry = queues();
  const prior = registry.get(path) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(work);
  registry.set(path, current);
  try { return await current; }
  finally { if (registry.get(path) === current) registry.delete(path); }
}

export class FileProjectCargoStore implements ProjectCargoEventStore {
  readonly durability = 'local_jsonl_single_writer' as const;
  readonly filePath: string;
  constructor(filePath: string) { this.filePath = resolve(filePath); }

  async readAll(): Promise<readonly StoredProjectCargoRecord[]> {
    let body: string;
    try { body = await readFile(this.filePath, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw error;
    }
    if (!body) return Object.freeze([]);
    if (!body.endsWith('\n')) throw new Error('PROJECT_CARGO_STORE_CORRUPT: journal ends with a partial record');
    const records: StoredProjectCargoRecord[] = [];
    for (const [index, line] of body.slice(0, -1).split('\n').entries()) {
      try { records.push(JSON.parse(line) as StoredProjectCargoRecord); }
      catch { throw new Error(`PROJECT_CARGO_STORE_CORRUPT: journal line ${index + 1} is not valid JSON`); }
    }
    const defect = verifyProjectCargoRecords(records);
    if (defect) throw new Error(`PROJECT_CARGO_STORE_CORRUPT: ${defect}`);
    return freeze(records);
  }

  async append(event: ProjectCargoEvent, expectedPreviousHash?: Hash | null): Promise<ProjectCargoStoreAppendResult> {
    return serialized(this.filePath, async () => {
      let records: StoredProjectCargoRecord[];
      try { records = [...await this.readAll()]; }
      catch (error) {
        return refusal('PROJECT_CARGO_STORE_CORRUPT', (error as Error).message, 'Restore the journal from a verified replica; never truncate invalid history.');
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
