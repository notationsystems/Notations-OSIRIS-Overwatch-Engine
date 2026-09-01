/** Strict business-intent adapter for the PayloadOS project-cargo desk. */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { attestationOf } from './attestation';
import {
  detectConditionBreaches,
  type ProjectCargoCommandResult,
  type ProjectCargoPortfolio,
  type ProjectCargoRefusal,
  type ProjectCargoSnapshot,
  type ProjectCargoWorkflow,
} from './projectCargo';
import { hashCommand, type CargoConstraintProfile, type CargoTelemetryObservation, type OTelAttributeValue } from './projectCargoStore';
import type { ISODateTime } from './types';

const identifier = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/);
const businessText = z.string().trim().min(1).max(500);
const optionalBusinessText = z.string().trim().max(500).optional();
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date and time.');
const positive = z.number().positive().max(1_000_000_000);
const nonnegative = z.number().nonnegative().max(1_000_000_000);
const moneyMinor = z.number().int().nonnegative().max(100_000_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);
const quantityUnit = z.enum(['kg', 'tonne', 'lb', 'unit', 'liter', 'm3']);
const envelope = { requestId: identifier, actorId: identifier, submittedAt: instant };
const evidenceRefs = z.array(identifier).max(100).default([]);

const constraints = z.object({
  temperatureMinimumCel: z.number().min(-273.15).max(200).optional(),
  temperatureMaximumCel: z.number().min(-273.15).max(200).optional(),
  humidityMinimumPercent: z.number().min(0).max(100).optional(),
  humidityMaximumPercent: z.number().min(0).max(100).optional(),
  maximumShockG: nonnegative.optional(),
  maximumVibrationMmS: nonnegative.optional(),
  maximumTiltDegrees: z.number().min(0).max(180).optional(),
  allowedOrientations: z.array(z.enum(['upright', 'side', 'inverted'])).min(1).max(3),
  handlingRequirements: z.array(businessText).max(50).default([]),
  securityRequirements: z.array(businessText).max(50).default([]),
  regulatoryRequirements: z.array(businessText).max(50).default([]),
  requiredDocumentTypes: z.array(identifier).max(50).default([]),
  requiredTelemetrySignals: z.array(z.enum(['temperature', 'relative_humidity', 'shock', 'vibration', 'tilt', 'door', 'seal', 'location'])).max(8).default([]),
  continuousCustodyRequired: z.boolean(),
}).strict().superRefine((value, context) => {
  if ((value.temperatureMinimumCel === undefined) !== (value.temperatureMaximumCel === undefined)) context.addIssue({ code: 'custom', message: 'Supply both temperature bounds or neither.' });
  if ((value.humidityMinimumPercent === undefined) !== (value.humidityMaximumPercent === undefined)) context.addIssue({ code: 'custom', message: 'Supply both humidity bounds or neither.' });
});

const cargoItem = z.object({
  cargoItemId: identifier,
  assetId: identifier,
  category: z.enum(['luxury_yacht', 'technology_equipment', 'medical_equipment', 'heavy_machinery', 'fine_art_collectible', 'luxury_automobile', 'luxury_furniture', 'pharmaceutical_cold_chain', 'international_electronics', 'other_specialized']),
  description: businessText,
  manufacturer: optionalBusinessText,
  model: optionalBusinessText,
  serialOrLotIds: z.array(identifier).max(100).default([]),
  quantity: positive,
  quantityUnit,
  declaredValueMinor: moneyMinor.optional(),
  declaredValueCurrency: currency,
  geometry: z.object({ lengthM: positive, widthM: positive, heightM: positive, grossWeightKg: positive }).strict().optional(),
  constraints,
  sourceReference: identifier,
}).strict();

const facility = z.object({ facilityId: identifier, locationId: identifier, facilityType: z.enum(['origin', 'port', 'airport', 'rail_terminal', 'warehouse', 'border', 'destination', 'installation_site']), capabilities: z.array(businessText).max(50).default([]) }).strict();
const permit = z.object({ permitId: identifier, permitType: businessText, authority: businessText, requiredForLegIds: z.array(identifier).min(1).max(100) }).strict();
const leg = z.object({
  legId: identifier, sequence: z.number().int().positive().max(1000), mode: z.enum(['road', 'rail', 'ocean', 'air', 'inland_waterway', 'warehouse', 'installation']),
  fromFacilityId: identifier, toFacilityId: identifier, providerId: identifier.optional(), plannedStart: instant, plannedEnd: instant,
  dependsOnLegIds: z.array(identifier).max(100).default([]), requiredPermitIds: z.array(identifier).max(100).default([]), loadOperationId: identifier.optional(),
}).strict();

export const projectCargoActionRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...envelope, action: z.literal('register_project'), payload: z.object({
    projectId: identifier, projectReference: identifier, customerId: identifier, customerCommitmentId: identifier.optional(), originLocationId: identifier, destinationLocationId: identifier, cargoItems: z.array(cargoItem).min(1).max(250), sourceReference: identifier,
  }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('plan_journey'), payload: z.object({ projectId: identifier, journeyId: identifier, version: z.number().int().positive(), facilities: z.array(facility).min(2).max(500), permits: z.array(permit).max(500), legs: z.array(leg).min(1).max(1000), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('update_permit'), payload: z.object({ projectId: identifier, permitId: identifier, status: z.enum(['pending', 'submitted', 'approved', 'rejected', 'expired']), validFrom: instant.optional(), validThrough: instant.optional(), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('update_leg'), payload: z.object({ projectId: identifier, legId: identifier, status: z.enum(['ready', 'in_transit', 'arrived', 'completed', 'blocked', 'cancelled']), locationId: identifier, source: z.enum(['operator', 'carrier', 'edi']), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('transfer_custody'), payload: z.object({ projectId: identifier, cargoItemIds: z.array(identifier).min(1).max(250), fromCustodianId: identifier.optional(), toCustodianId: identifier, locationId: identifier, sealId: identifier.optional(), conditionNote: businessText, sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('attach_evidence'), payload: z.object({ projectId: identifier, cargoItemId: identifier.optional(), evidenceType: z.enum(['condition_report', 'photo', 'document', 'permit', 'signature', 'sensor_artifact', 'invoice', 'claim', 'other']), documentType: identifier.optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/), capturedAt: instant, sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('ingest_telemetry'), payload: z.object({ projectId: identifier, cargoItemId: identifier, sensorId: identifier, signal: z.enum(['temperature', 'relative_humidity', 'shock', 'vibration', 'tilt', 'door', 'seal', 'location']), numericValue: z.number().finite().optional(), textValue: z.string().trim().min(1).max(500).optional(), unit: z.string().trim().max(30), measuredAt: instant, traceId: z.string().regex(/^[a-f0-9]{32}$/).optional(), spanId: z.string().regex(/^[a-f0-9]{16}$/).optional(), attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('authorize_remedy'), payload: z.object({ projectId: identifier, exceptionId: identifier, remedyCode: z.enum(['inspect', 'quarantine', 'recondition', 'reroute', 'replace_packaging', 'notify_customer', 'file_claim', 'release']), instruction: businessText, sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('complete_remedy'), payload: z.object({ projectId: identifier, exceptionId: identifier, outcome: z.enum(['resolved', 'contained', 'failed']), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('record_economic_entry'), payload: z.object({ projectId: identifier, entryId: identifier, category: z.enum(['customer_revenue', 'freight', 'handling', 'insurance', 'customs', 'storage', 'permit', 'claim_loss', 'claim_recovery', 'other']), effect: z.enum(['revenue', 'cost', 'recovery']), amountMinor: moneyMinor, currency, incurredAt: instant, sourceSystem: z.enum(['operator', 'commercial', 'accounting', 'payment', 'claims']), externalReference: identifier, sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('close_economics'), payload: z.object({ projectId: identifier, sourceSystemsReconciled: z.array(z.enum(['commercial', 'accounting', 'payment', 'claims'])).min(1).max(4), sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('record_integration'), payload: z.object({ projectId: identifier, integration: z.enum(['carrier', 'sensor', 'edi', 'accounting', 'payment']), direction: z.enum(['inbound', 'outbound']), status: z.enum(['accepted', 'rejected', 'pending']), externalReference: identifier, metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}), evidenceReferences: evidenceRefs, sourceReference: identifier }).strict() }).strict(),
  z.object({ ...envelope, action: z.literal('verify_delivery'), payload: z.object({ projectId: identifier, disposition: z.enum(['accepted', 'quarantined', 'rejected']), locationId: identifier, evidenceReferences: z.array(identifier).min(1).max(100), sourceReference: identifier }).strict() }).strict(),
]);

export type ProjectCargoActionRequest = z.infer<typeof projectCargoActionRequestSchema>;
export type ProjectCargoActionKind = ProjectCargoActionRequest['action'];

export type ProjectCargoActionDescriptor = {
  readonly action: ProjectCargoActionKind;
  readonly label: string;
  readonly summary: string;
  readonly recommended: boolean;
};

export type ProjectCargoCockpitSnapshot = {
  readonly kind: 'project_cargo_cockpit_snapshot';
  readonly project: ProjectCargoSnapshot;
  readonly actions: readonly ProjectCargoActionDescriptor[];
};

export type ProjectCargoActionResult =
  | { readonly kind: 'accepted'; readonly action: ProjectCargoActionKind; readonly persistence: 'appended' | 'duplicate'; readonly project: ProjectCargoSnapshot }
  | ProjectCargoRefusal;

const LABELS: Record<ProjectCargoActionKind, [string, string]> = {
  register_project: ['Register project cargo', 'Create canonical cargo identities, value, geometry, and constraint profiles.'],
  plan_journey: ['Plan multimodal journey', 'Bind facilities, permits, dependencies, providers, and load operations into an ordered plan.'],
  update_permit: ['Update permit', 'Record the current authority status and validity window of a required permit.'],
  update_leg: ['Advance journey leg', 'Record the next physical leg state without skipping dependencies or permits.'],
  transfer_custody: ['Transfer custody', 'Move exact cargo items from their current custodian to the next accountable party.'],
  attach_evidence: ['Attach evidence', 'Bind an immutable artifact digest to the project or an exact cargo item.'],
  ingest_telemetry: ['Record condition telemetry', 'Ingest a source-timed observation and derive constraint breaches automatically.'],
  authorize_remedy: ['Authorize exception remedy', 'Select and authorize a typed intervention for a physical exception.'],
  complete_remedy: ['Complete exception remedy', 'Record the evidenced outcome of the authorized intervention.'],
  record_economic_entry: ['Record project economics', 'Add an un-netted revenue, cost, insurance, handling, or claims entry.'],
  close_economics: ['Close project economics', 'Attest that source systems have been reconciled after delivery verification.'],
  record_integration: ['Record integration exchange', 'Bind a carrier, sensor, EDI, accounting, or payment exchange to its external identity.'],
  verify_delivery: ['Verify project delivery', 'Close physical execution only after journey, custody, evidence, telemetry, and exceptions pass.'],
};

function descriptor(action: ProjectCargoActionKind, recommended = false): ProjectCargoActionDescriptor {
  return Object.freeze({ action, label: LABELS[action][0], summary: LABELS[action][1], recommended });
}

function eventId(request: ProjectCargoActionRequest): string {
  return `project-cargo:${request.action}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function derivedId(prefix: string, request: ProjectCargoActionRequest): string {
  return `${prefix}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function evidenceId(request: ProjectCargoActionRequest, sourceReference: string): string {
  return `project-evidence-ref:${hashCommand({ requestId: request.requestId, actorId: request.actorId, sourceReference })}`;
}

function operatorAttestation(note: string) { return attestationOf('reported', 'medium', 'self_reported', note); }
function instrumentAttestation(note: string) { return attestationOf('reported', 'high', 'disinterested', note); }

function profile(value: z.infer<typeof constraints>): CargoConstraintProfile {
  return Object.freeze({
    temperature: value.temperatureMinimumCel === undefined ? undefined : { minimum: value.temperatureMinimumCel, maximum: value.temperatureMaximumCel!, unit: 'Cel' as const },
    relativeHumidity: value.humidityMinimumPercent === undefined ? undefined : { minimum: value.humidityMinimumPercent, maximum: value.humidityMaximumPercent!, unit: '%' as const },
    maximumShockG: value.maximumShockG,
    maximumVibrationMmS: value.maximumVibrationMmS,
    maximumTiltDegrees: value.maximumTiltDegrees,
    allowedOrientations: value.allowedOrientations,
    handlingRequirements: value.handlingRequirements,
    securityRequirements: value.securityRequirements,
    regulatoryRequirements: value.regulatoryRequirements,
    requiredDocumentTypes: value.requiredDocumentTypes,
    requiredTelemetrySignals: value.requiredTelemetrySignals,
    continuousCustodyRequired: value.continuousCustodyRequired,
  });
}

function result(action: ProjectCargoActionKind, value: ProjectCargoCommandResult): ProjectCargoActionResult {
  return value.kind === 'refusal' ? value : Object.freeze({ kind: 'accepted' as const, action, persistence: value.persistence, project: value.project });
}

function actionsFor(project: ProjectCargoSnapshot): readonly ProjectCargoActionDescriptor[] {
  const actions: ProjectCargoActionDescriptor[] = [descriptor('attach_evidence'), descriptor('transfer_custody'), descriptor('ingest_telemetry'), descriptor('record_economic_entry'), descriptor('record_integration')];
  if (project.phase === 'planning') actions.unshift(descriptor('plan_journey', true));
  if (project.phase === 'permits_pending') actions.unshift(descriptor('update_permit', true));
  if (project.phase === 'ready' || project.phase === 'executing') actions.unshift(descriptor('update_leg', true));
  if (project.phase === 'exception') {
    if (project.exceptions.some(item => item.status === 'open' || item.status === 'failed')) actions.unshift(descriptor('authorize_remedy', true));
    if (project.exceptions.some(item => item.status === 'authorized')) actions.unshift(descriptor('complete_remedy', true));
  }
  if (project.phase === 'verification_pending') actions.unshift(descriptor('verify_delivery', true));
  if (project.phase === 'economics_pending') actions.unshift(descriptor('close_economics', true));
  return Object.freeze(actions);
}

export class ProjectCargoActions {
  constructor(private readonly workflow: ProjectCargoWorkflow, private readonly clock: () => ISODateTime = () => new Date().toISOString()) {}

  async list(): Promise<ProjectCargoPortfolio | ProjectCargoRefusal> { return this.workflow.list(); }

  async inspect(projectId: string): Promise<ProjectCargoCockpitSnapshot | ProjectCargoRefusal> {
    const project = await this.workflow.get(projectId);
    return project.kind === 'refusal' ? project : Object.freeze({ kind: 'project_cargo_cockpit_snapshot' as const, project, actions: actionsFor(project) });
  }

  async execute(input: unknown): Promise<ProjectCargoActionResult> {
    const parsed = projectCargoActionRequestSchema.safeParse(input);
    if (!parsed.success) return { kind: 'refusal', code: 'PROJECT_CARGO_COMMAND_INVALID', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '), remedy: 'Use the typed project-cargo desk; internal event, exception, and evidence bindings are server-derived.' };
    const request = parsed.data;
    const recordedAt = this.clock();
    if (!Number.isFinite(Date.parse(recordedAt)) || Date.parse(request.submittedAt) > Date.parse(recordedAt) + 60_000) return { kind: 'refusal', code: 'PROJECT_CARGO_COMMAND_INVALID', detail: 'Server or submission time is invalid.', remedy: 'Restore the server clock and submit again.' };
    const id = eventId(request);
    const evidence = evidenceId(request, request.payload.sourceReference);
    switch (request.action) {
      case 'register_project':
        return result(request.action, await this.workflow.register({ eventId: id, recordedAt, value: {
          projectId: request.payload.projectId, projectReference: request.payload.projectReference, customerId: request.payload.customerId, customerCommitmentId: request.payload.customerCommitmentId ?? null, originLocationId: request.payload.originLocationId, destinationLocationId: request.payload.destinationLocationId,
          cargoItems: request.payload.cargoItems.map(item => {
            const itemEvidence = evidenceId(request, item.sourceReference);
            return {
              cargoItemId: item.cargoItemId, assetId: item.assetId, category: item.category, description: item.description, manufacturer: item.manufacturer, model: item.model, serialOrLotIds: item.serialOrLotIds,
              quantity: { amount: item.quantity, unit: item.quantityUnit, attestation: operatorAttestation('Project cargo quantity entered from the customer specification.'), evidenceIds: [itemEvidence] },
              declaredValue: item.declaredValueMinor === undefined ? { kind: 'absent' as const, reason: 'not_observed' as const, detail: 'Declared cargo value was not supplied.', remedy: 'Attach a valuation or insurance declaration before treating value exposure as known.', evidenceIds: [itemEvidence] } : { kind: 'observed' as const, value: { amountMinor: item.declaredValueMinor, currency: item.declaredValueCurrency, attestation: operatorAttestation('Declared cargo value entered from the source record.'), evidenceIds: [itemEvidence] } },
              geometry: item.geometry ?? null, constraintProfile: profile(item.constraints), evidenceIds: [itemEvidence],
            };
          }),
          openedAt: request.submittedAt, authorizedBy: request.actorId, evidenceIds: [evidence],
        } }));
      case 'plan_journey':
        return result(request.action, await this.workflow.planJourney({ eventId: id, recordedAt, value: {
          journeyId: request.payload.journeyId, projectId: request.payload.projectId, version: request.payload.version,
          facilities: request.payload.facilities,
          permits: request.payload.permits,
          legs: request.payload.legs.map(item => ({ ...item, providerId: item.providerId ?? null, loadOperationId: item.loadOperationId ?? null })),
          plannedAt: request.submittedAt, authorizedBy: request.actorId, evidenceIds: [evidence],
        } }));
      case 'update_permit': {
        const state = await this.workflow.get(request.payload.projectId); if (state.kind === 'refusal') return state;
        if (!state.journey) return { kind: 'refusal', code: 'PERMIT_UPDATE_REFUSED', detail: 'No active journey exists.', remedy: 'Plan the journey first.' };
        return result(request.action, await this.workflow.updatePermit({ eventId: id, recordedAt, value: { projectId: request.payload.projectId, journeyId: state.journey.journeyId, permitId: request.payload.permitId, status: request.payload.status, validFrom: request.payload.validFrom ?? null, validThrough: request.payload.validThrough ?? null, updatedAt: request.submittedAt, evidenceIds: [evidence] } }));
      }
      case 'update_leg': {
        const state = await this.workflow.get(request.payload.projectId); if (state.kind === 'refusal') return state;
        if (!state.journey) return { kind: 'refusal', code: 'JOURNEY_LEG_UPDATE_REFUSED', detail: 'No active journey exists.', remedy: 'Plan the journey first.' };
        return result(request.action, await this.workflow.updateLeg({ eventId: id, recordedAt, value: { projectId: request.payload.projectId, journeyId: state.journey.journeyId, legId: request.payload.legId, status: request.payload.status, locationId: request.payload.locationId, occurredAt: request.submittedAt, source: request.payload.source, evidenceIds: [evidence] } }));
      }
      case 'transfer_custody':
        return result(request.action, await this.workflow.transferCustody({ eventId: id, recordedAt, value: { transferId: derivedId('custody-transfer', request), projectId: request.payload.projectId, cargoItemIds: request.payload.cargoItemIds, fromCustodianId: request.payload.fromCustodianId ?? null, toCustodianId: request.payload.toCustodianId, locationId: request.payload.locationId, transferredAt: request.submittedAt, sealId: request.payload.sealId ?? null, conditionNote: request.payload.conditionNote, attestation: operatorAttestation('Custody transfer recorded by the authenticated project operator.'), evidenceIds: [evidence] } }));
      case 'attach_evidence':
        return result(request.action, await this.workflow.attachEvidence({ eventId: id, recordedAt, value: { evidenceId: derivedId('project-evidence', request), projectId: request.payload.projectId, cargoItemId: request.payload.cargoItemId ?? null, evidenceType: request.payload.evidenceType, documentType: request.payload.documentType ?? null, sha256: request.payload.sha256, capturedAt: request.payload.capturedAt, sourceReference: request.payload.sourceReference, attestation: operatorAttestation('Immutable evidence digest attached by the authenticated project operator.') } }));
      case 'ingest_telemetry': {
        const state = await this.workflow.get(request.payload.projectId); if (state.kind === 'refusal') return state;
        const item = state.project.cargoItems.find(candidate => candidate.cargoItemId === request.payload.cargoItemId);
        if (!item) return { kind: 'refusal', code: 'TELEMETRY_OBSERVATION_REFUSED', detail: 'Cargo item is not part of the project.', remedy: 'Select an exact cargo item from the registered project.' };
        const observationId = derivedId('cargo-observation', request);
        const breaches = detectConditionBreaches(request.payload.projectId, observationId, item, request.payload.signal, request.payload.numericValue ?? null, request.payload.unit);
        const attrs: Record<string, OTelAttributeValue> = { 'payload.telemetry.signal': request.payload.signal, 'payload.telemetry.unit': request.payload.unit, 'payload.source.reference': request.payload.sourceReference, ...(request.payload.attributes ?? {}) };
        const observation: CargoTelemetryObservation = {
          observationId, projectId: request.payload.projectId, cargoItemId: request.payload.cargoItemId, sensorId: request.payload.sensorId, signal: request.payload.signal, numericValue: request.payload.numericValue ?? null, textValue: request.payload.textValue ?? null, unit: request.payload.unit,
          eventName: 'payload.cargo.condition.observed', timestamp: request.payload.measuredAt, observedTimestamp: recordedAt, severityNumber: breaches.length ? 13 : 9, severityText: breaches.length ? 'WARN' : 'INFO', traceId: request.payload.traceId ?? null, spanId: request.payload.spanId ?? null,
          resource: { attributes: { 'payload.project.id': request.payload.projectId, 'payload.cargo.item.id': request.payload.cargoItemId, 'device.id': request.payload.sensorId } },
          instrumentationScope: { name: 'notationsystems.payload.project-cargo', version: '1.0.0' }, attributes: attrs, body: `${request.payload.signal} observation from ${request.payload.sensorId}`, attestation: instrumentAttestation('Sensor observation received through the authenticated project telemetry adapter.'), evidenceIds: [evidence], breaches,
        };
        return result(request.action, await this.workflow.observeCondition({ eventId: id, recordedAt, value: observation }));
      }
      case 'authorize_remedy':
        return result(request.action, await this.workflow.authorizeRemedy({ eventId: id, recordedAt, value: { projectId: request.payload.projectId, exceptionId: request.payload.exceptionId, remedyCode: request.payload.remedyCode, instruction: request.payload.instruction, authorizedBy: request.actorId, authorizedAt: request.submittedAt, evidenceIds: [evidence] } }));
      case 'complete_remedy':
        return result(request.action, await this.workflow.completeRemedy({ eventId: id, recordedAt, value: { projectId: request.payload.projectId, exceptionId: request.payload.exceptionId, outcome: request.payload.outcome, completedBy: request.actorId, completedAt: request.submittedAt, evidenceIds: [evidence] } }));
      case 'record_economic_entry':
        return result(request.action, await this.workflow.recordEconomicEntry({ eventId: id, recordedAt, value: { entryId: request.payload.entryId, projectId: request.payload.projectId, category: request.payload.category, effect: request.payload.effect, amount: { amountMinor: request.payload.amountMinor, currency: request.payload.currency, attestation: operatorAttestation('Project economic entry received from the named source system.'), evidenceIds: [evidence] }, incurredAt: request.payload.incurredAt, sourceSystem: request.payload.sourceSystem, externalReference: request.payload.externalReference, evidenceIds: [evidence] } }));
      case 'close_economics':
        return result(request.action, await this.workflow.closeEconomics({ eventId: id, recordedAt, value: { closureId: derivedId('project-economics-closure', request), projectId: request.payload.projectId, closedAt: request.submittedAt, closedBy: request.actorId, sourceSystemsReconciled: request.payload.sourceSystemsReconciled, evidenceIds: [evidence] } }));
      case 'record_integration':
        return result(request.action, await this.workflow.recordIntegration({ eventId: id, recordedAt, value: { exchangeId: derivedId('project-integration', request), projectId: request.payload.projectId, integration: request.payload.integration, direction: request.payload.direction, status: request.payload.status, externalReference: request.payload.externalReference, occurredAt: request.submittedAt, metadata: request.payload.metadata, evidenceIds: [...new Set([evidence, ...request.payload.evidenceReferences])] } }));
      case 'verify_delivery':
        return result(request.action, await this.workflow.verifyDelivery({ eventId: id, recordedAt, value: { verificationId: derivedId('project-delivery-verification', request), projectId: request.payload.projectId, disposition: request.payload.disposition, verifiedAt: request.submittedAt, locationId: request.payload.locationId, verifiedBy: request.actorId, evidenceIds: [...new Set([evidence, ...request.payload.evidenceReferences])] } }));
    }
  }
}

/** Deterministic event identity for OTLP retries; the raw record body is never stored twice. */
export function otlpRequestIdentity(sourceReference: string, payload: unknown): string {
  return `otlp:${createHash('sha256').update(`${sourceReference}|${JSON.stringify(payload)}`).digest('hex')}`;
}
