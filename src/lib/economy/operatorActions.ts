/**
 * Operator cockpit intents.
 *
 * The browser submits business facts, never journal commands. This adapter
 * resolves every durable identity from current state, constructs the typed
 * command and then delegates to the existing guarded workflows. It therefore
 * cannot bypass authorization, feasible-set, dispatch-binding, or evidence
 * requirements.
 */

import { z } from 'zod';
import { attestationOf } from './attestation';
import {
  type CarrierCommunicationCommandResult,
  type CarrierCommunicationRefusal,
  type CarrierCommunicationSnapshot,
  type CarrierCommunicationsWorkflow,
} from './carrierCommunications';
import type { DecisionMetric, DecisionRecordedEvent } from './decisionEpisode';
import { intakeEmail, type ExtractedFields, type ModelProvider } from './intake';
import {
  type LoadOperationCommandResult,
  type LoadOperationRefusal,
  type LoadOperationSnapshot,
  type LoadOperationsWorkflow,
} from './loadOperations';
import { settlementOutcomeCommand, type OperationalSettlementEvidence } from './loadOutcomeCapture';
import { hashCommand } from './loadOperationsStore';
import type { ISODateTime } from './types';

const identifier = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/, 'Use letters, numbers, colon, dash, underscore, period, or slash.');
const businessText = z.string().trim().min(1).max(240);
const optionalText = z.string().trim().max(240).optional();
const instant = z.string().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO date and time.');
const moneyMinor = z.number().int().nonnegative().max(10_000_000_000);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/);

const envelope = {
  requestId: identifier,
  actorId: identifier,
};

export const operatorActionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    ...envelope,
    action: z.literal('create_opportunity'),
    payload: z.object({
      operationId: identifier,
      sourceReference: identifier,
      origin: businessText,
      destination: businessText,
      equipment: businessText,
      pickupStart: instant,
      pickupEnd: instant,
      deliveryStart: instant.optional(),
      deliveryEnd: instant.optional(),
      commodity: optionalText,
      weightLbs: z.number().positive().max(200_000).optional(),
      targetRate: z.number().nonnegative().max(100_000_000).optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('add_carrier_alternative'),
    payload: z.object({
      operationId: identifier,
      sourceReference: identifier,
      carrierId: identifier,
      laneId: identifier,
      departureStart: instant,
      departureEnd: instant,
      quotedCostMinor: moneyMinor,
      currency,
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('authorize_carrier'),
    payload: z.object({
      operationId: identifier,
      actionId: identifier,
      sourceReference: identifier,
      loadId: identifier,
      bolCarrierId: identifier,
      declaredValueMinor: moneyMinor.optional(),
      currency,
      insuranceExpiresAt: instant,
      cargoCoverAmountMinor: moneyMinor,
      authorityGrantedAt: instant,
      authorityRevokedAt: instant.optional(),
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('open_decision_episode'),
    payload: z.object({ operationId: identifier }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('assign_carrier'),
    payload: z.object({
      operationId: identifier,
      actionId: identifier,
      rationale: businessText,
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('dispatch_load'),
    payload: z.object({ operationId: identifier }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('send_tender'),
    payload: z.object({ operationId: identifier }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('record_carrier_acknowledgement'),
    payload: z.object({
      operationId: identifier,
      status: z.enum(['accepted', 'rejected']),
      occurredAt: instant,
      sourceReference: identifier,
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('record_tracking'),
    payload: z.object({
      operationId: identifier,
      status: z.enum(['picked_up', 'in_transit', 'arrived', 'delivered', 'exception']),
      occurredAt: instant,
      sourceReference: identifier,
    }).strict(),
  }).strict(),
  z.object({
    ...envelope,
    action: z.literal('capture_settlement'),
    payload: z.object({
      operationId: identifier,
      sourceReference: identifier,
      pickupAt: instant,
      deliveredAt: instant,
      currency,
      carrierInvoiceMinor: moneyMinor.optional(),
      accessorialCostMinor: moneyMinor.optional(),
      shipperRevenueMinor: moneyMinor.optional(),
      damageCostMinor: moneyMinor.optional(),
      rejected: z.boolean(),
      originArrivedAt: instant.optional(),
      originDepartedAt: instant.optional(),
      destinationArrivedAt: instant.optional(),
      destinationDepartedAt: instant.optional(),
    }).strict(),
  }).strict(),
]);

export type OperatorActionRequest = z.infer<typeof operatorActionRequestSchema>;
export type OperatorActionKind = OperatorActionRequest['action'];

export interface OperatorActionDescriptor {
  readonly action: OperatorActionKind;
  readonly label: string;
  readonly summary: string;
  readonly recommended: boolean;
  readonly alternatives?: readonly {
    actionId: string;
    carrierId: string;
    authorization: 'authorized' | 'refused' | 'undetermined' | 'pending';
  }[];
}

export interface OperatorCockpitSnapshot {
  readonly kind: 'operator_cockpit_snapshot';
  readonly operation: LoadOperationSnapshot;
  readonly communication: CarrierCommunicationSnapshot | null;
  readonly actions: readonly OperatorActionDescriptor[];
}

export type OperatorActionRefusal = {
  readonly kind: 'refusal';
  readonly code: string;
  readonly detail: string;
  readonly remedy: string;
};

export type OperatorActionResult =
  | {
      readonly kind: 'accepted';
      readonly action: OperatorActionKind;
      readonly persistence: 'appended' | 'duplicate';
      readonly operation: LoadOperationSnapshot | null;
      readonly communication: CarrierCommunicationSnapshot | null;
    }
  | OperatorActionRefusal;

type Operations = Pick<LoadOperationsWorkflow,
  'get' | 'registerOpportunity' | 'registerAlternative' | 'authorizeAlternative' |
  'openEpisode' | 'recordAssignment' | 'dispatch' | 'captureOutcome'>;
type Communications = Pick<CarrierCommunicationsWorkflow, 'get' | 'send' | 'recordCarrierEvent'>;

function refusal(code: string, detail: string, remedy: string): OperatorActionRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function isOperationRefusal(value: LoadOperationSnapshot | LoadOperationRefusal): value is LoadOperationRefusal {
  return 'kind' in value && value.kind === 'refusal';
}

function isCommunicationRefusal(
  value: CarrierCommunicationSnapshot | CarrierCommunicationRefusal,
): value is CarrierCommunicationRefusal {
  return 'kind' in value && value.kind === 'refusal';
}

function operationResult(
  action: OperatorActionKind,
  result: LoadOperationCommandResult,
): OperatorActionResult {
  if (result.kind === 'refusal') return result;
  return Object.freeze({
    kind: 'accepted' as const,
    action,
    persistence: result.persistence,
    operation: result.snapshot,
    communication: null,
  });
}

function communicationResult(
  action: OperatorActionKind,
  result: CarrierCommunicationCommandResult,
  operation: LoadOperationSnapshot | null,
): OperatorActionResult {
  if (result.kind === 'refusal') return result;
  if (result.kind === 'delivery_failed') {
    const failure = result.snapshot.attempts.at(-1)?.failure;
    return refusal(
      failure?.code ?? 'CARRIER_TENDER_DELIVERY_FAILED',
      failure?.detail ?? 'The carrier delivery adapter did not confirm delivery.',
      failure?.retryable ? 'Retry the typed send action.' : 'Correct carrier gateway configuration before retrying.',
    );
  }
  return Object.freeze({
    kind: 'accepted' as const,
    action,
    persistence: result.persistence,
    operation,
    communication: result.snapshot,
  });
}

function eventIdentity(request: OperatorActionRequest): string {
  return `cockpit:${request.action}:${hashCommand({ requestId: request.requestId, actorId: request.actorId })}`;
}

function evidenceIdentity(request: OperatorActionRequest, sourceReference?: string): string {
  return `cockpit-evidence:${hashCommand({
    requestId: request.requestId,
    actorId: request.actorId,
    sourceReference: sourceReference ?? request.action,
  })}`;
}

function latestDecision(snapshot: LoadOperationSnapshot): DecisionRecordedEvent | null {
  for (let index = snapshot.decisionEntries.length - 1; index >= 0; index--) {
    const event = snapshot.decisionEntries[index].event;
    if (event.kind === 'decision_recorded') return event;
  }
  return null;
}

function manualProvider(fields: ExtractedFields): ModelProvider {
  return {
    id: 'payload.operator-cockpit.v1',
    vendor: 'Payload',
    extract: () => fields,
  };
}

function absent(evidenceId: string, detail: string, remedy: string) {
  return {
    kind: 'absent' as const,
    absence: { reason: 'not_observed' as const, detail, remedy, evidenceIds: [evidenceId] },
  };
}

function observedMoney(amountMinor: number, currencyCode: string, evidenceId: string, note: string) {
  return {
    kind: 'observed' as const,
    evidence: {
      amountMinor,
      currency: currencyCode,
      attestation: attestationOf('reported', 'medium', 'unknown', note),
      evidenceIds: [evidenceId],
    },
  };
}

function optionalMoney(
  amountMinor: number | undefined,
  currencyCode: string,
  evidenceId: string,
  label: string,
) {
  return amountMinor === undefined
    ? absent(evidenceId, `${label} was not present in this settlement action.`, `Attach the ${label} record and append a corrected settlement outcome.`)
    : observedMoney(amountMinor, currencyCode, evidenceId, `${label} transcribed by the operator cockpit.`);
}

function dwell(
  arrivedAt: string | undefined,
  departedAt: string | undefined,
  evidenceId: string,
  label: string,
) {
  if (!arrivedAt || !departedAt) {
    return absent(evidenceId, `${label} dwell interval was not observed.`, `Attach arrival and departure evidence for ${label}.`);
  }
  const instantEvidence = (value: string) => ({
    instant: value,
    attestation: attestationOf('reported', 'medium', 'unknown', `${label} timestamp transcribed by the operator cockpit.`),
    evidenceIds: [evidenceId],
  });
  return {
    kind: 'observed' as const,
    evidence: { arrivedAt: instantEvidence(arrivedAt), departedAt: instantEvidence(departedAt) },
  };
}

const LABELS: Record<OperatorActionKind, [string, string]> = {
  create_opportunity: ['Create load opportunity', 'Register a sanitized, typed shipper opportunity.'],
  add_carrier_alternative: ['Add carrier alternative', 'Record a carrier, departure window, and evidenced quote.'],
  authorize_carrier: ['Run carrier authorization', 'Bind insurance, authority, BOL, cargo cover, and load identity.'],
  open_decision_episode: ['Freeze decision set', 'Preserve the authorized candidate set before selection.'],
  assign_carrier: ['Assign carrier', 'Record the operator selection against the frozen feasible set.'],
  dispatch_load: ['Record dispatch', 'Start the exact load authorized for the selected carrier.'],
  send_tender: ['Send carrier tender', 'Deliver the immutable dispatch envelope through the configured gateway.'],
  record_carrier_acknowledgement: ['Record carrier response', 'Bind acceptance or rejection to the exact tender and carrier.'],
  record_tracking: ['Record tracking event', 'Capture a physical status with separate occurrence and knowledge time.'],
  capture_settlement: ['Close load outcome', 'Capture transit, invoice, accessorial, damage, rejection, and margin evidence.'],
};

function descriptor(
  action: OperatorActionKind,
  recommended: boolean,
  alternatives?: OperatorActionDescriptor['alternatives'],
): OperatorActionDescriptor {
  return Object.freeze({ action, label: LABELS[action][0], summary: LABELS[action][1], recommended, ...(alternatives ? { alternatives } : {}) });
}

export class OperatorActions {
  constructor(
    private readonly operations: Operations,
    private readonly communications: Communications,
    private readonly clock: () => ISODateTime = () => new Date().toISOString(),
  ) {}

  async inspect(operationId: string): Promise<OperatorCockpitSnapshot | OperatorActionRefusal> {
    const operation = await this.operations.get(operationId);
    if (isOperationRefusal(operation)) return operation;
    let communication: CarrierCommunicationSnapshot | null = null;
    if (operation.phase === 'outcome_pending' || operation.phase === 'outcome_captured') {
      const result = await this.communications.get(operationId);
      if (!isCommunicationRefusal(result)) communication = result;
      else if (result.code !== 'COMMUNICATION_DISPATCH_NOT_READY') return result;
    }
    const alternatives = operation.alternatives.map(item => ({
      actionId: item.alternative.actionId,
      carrierId: item.alternative.carrierId,
      authorization: item.authorization?.decision ?? 'pending' as const,
    }));
    const actions: OperatorActionDescriptor[] = [];
    if (['alternatives_pending', 'authorization_pending', 'episode_opening_pending'].includes(operation.phase)) {
      actions.push(descriptor('add_carrier_alternative', operation.phase === 'alternatives_pending'));
    }
    if (operation.phase === 'authorization_pending') {
      actions.push(descriptor('authorize_carrier', true, alternatives.filter(item => item.authorization === 'pending')));
    }
    if (operation.phase === 'episode_opening_pending') {
      actions.push(descriptor('open_decision_episode', true));
    }
    if (operation.phase === 'assignment_pending') {
      actions.push(descriptor('assign_carrier', true, alternatives.filter(item => item.authorization === 'authorized')));
    }
    if (operation.phase === 'dispatch_pending') actions.push(descriptor('dispatch_load', true));
    if (operation.phase === 'outcome_pending') {
      if (!communication || communication.attempts.length === 0 || communication.deliveryState === 'failed') {
        actions.push(descriptor('send_tender', true));
      }
      if (communication?.deliveryState === 'delivered') {
        actions.push(descriptor('record_carrier_acknowledgement', communication.acknowledgement === 'pending'));
        actions.push(descriptor('record_tracking', communication.acknowledgement === 'accepted'));
        if (communication.latestTrackingStatus === 'delivered') actions.push(descriptor('capture_settlement', true));
      }
    }
    return Object.freeze({
      kind: 'operator_cockpit_snapshot' as const,
      operation,
      communication,
      actions: Object.freeze(actions),
    });
  }

  async execute(input: unknown): Promise<OperatorActionResult> {
    const parsed = operatorActionRequestSchema.safeParse(input);
    if (!parsed.success) {
      return refusal(
        'OPERATOR_ACTION_INVALID',
        parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        'Use the cockpit form for this action; internal journal fields are derived by the server.',
      );
    }
    const request = parsed.data;
    const recordedAt = this.clock();
    if (!Number.isFinite(Date.parse(recordedAt))) {
      return refusal('OPERATOR_CLOCK_INVALID', 'The server clock did not return an ISO instant.', 'Restore the server clock before operating loads.');
    }
    const eventId = eventIdentity(request);
    switch (request.action) {
      case 'create_opportunity': {
        const value = request.payload;
        if (Date.parse(value.pickupStart) > Date.parse(value.pickupEnd) ||
            (!!value.deliveryStart !== !!value.deliveryEnd) ||
            (value.deliveryStart && value.deliveryEnd && Date.parse(value.deliveryStart) > Date.parse(value.deliveryEnd))) {
          return refusal('OPERATOR_ACTION_INVALID', 'A pickup or delivery window is reversed or incomplete.', 'Enter both ends of each window in chronological order.');
        }
        const fields: ExtractedFields = {
          origin: value.origin,
          destination: value.destination,
          equipment: value.equipment,
          pickupWindow: `${value.pickupStart}/${value.pickupEnd}`,
          ...(value.deliveryStart && value.deliveryEnd ? { deliveryWindow: `${value.deliveryStart}/${value.deliveryEnd}` } : {}),
          ...(value.commodity ? { commodity: value.commodity } : {}),
          ...(value.weightLbs !== undefined ? { weightLbs: String(value.weightLbs) } : {}),
          ...(value.targetRate !== undefined ? { targetRate: String(value.targetRate) } : {}),
        };
        const opportunity = intakeEmail({
          messageId: value.sourceReference,
          channel: 'manual_paste',
          receivedAt: recordedAt,
          subject: `Operator intake ${value.operationId}`,
          body: 'Structured load facts entered through the Payload operator cockpit.',
        }, manualProvider(fields), value.operationId);
        return operationResult(request.action, await this.operations.registerOpportunity({
          operationId: value.operationId,
          eventId,
          recordedAt,
          opportunity,
        }));
      }
      case 'add_carrier_alternative': {
        const value = request.payload;
        const evidenceId = evidenceIdentity(request, value.sourceReference);
        const metric: DecisionMetric = {
          name: 'quoted_cost',
          value: value.quotedCostMinor,
          unit: 'money_minor',
          currency: value.currency,
          attestation: attestationOf('reported', 'medium', 'self_reported', 'Carrier quote transcribed by the operator cockpit.'),
          evidenceIds: [evidenceId],
        };
        return operationResult(request.action, await this.operations.registerAlternative({
          operationId: value.operationId,
          eventId,
          recordedAt,
          alternative: {
            actionId: `carrier-action:${hashCommand({ actorId: request.actorId, requestId: request.requestId })}`,
            carrierId: value.carrierId,
            laneId: value.laneId,
            departureWindow: { start: value.departureStart, end: value.departureEnd },
            quotedCost: metric,
            predictedOutcomes: [],
          },
          evidenceIds: [evidenceId],
        }));
      }
      case 'authorize_carrier': {
        const value = request.payload;
        const state = await this.operations.get(value.operationId);
        if (isOperationRefusal(state)) return state;
        const candidate = state.alternatives.find(item => item.alternative.actionId === value.actionId);
        if (!candidate) return refusal('OPERATION_ALTERNATIVE_UNKNOWN', `${value.actionId} is not a carrier alternative on ${value.operationId}.`, 'Select a carrier alternative exposed by the cockpit.');
        const evidenceId = evidenceIdentity(request, value.sourceReference);
        return operationResult(request.action, await this.operations.authorizeAlternative({
          operationId: value.operationId,
          eventId,
          recordedAt,
          actionId: candidate.alternative.actionId,
          request: {
            loadId: value.loadId,
            tenderedCarrierId: candidate.alternative.carrierId,
            bolCarrierId: value.bolCarrierId,
            pickupAt: candidate.alternative.departureWindow.start,
            bookedAt: recordedAt,
            declaredValue: value.declaredValueMinor === undefined ? null : { amount: value.declaredValueMinor, currency: value.currency },
            carrier: {
              carrierId: candidate.alternative.carrierId,
              insuranceExpiresAt: value.insuranceExpiresAt,
              cargoCoverAmount: { amount: value.cargoCoverAmountMinor, currency: value.currency },
              authorityGrantedAt: value.authorityGrantedAt,
              authorityRevokedAt: value.authorityRevokedAt ?? null,
            },
            actingAuthority: { principal: request.actorId, mayBind: true, note: 'Authenticated Payload operations cockpit action.' },
          },
          evidenceIds: [evidenceId],
        }));
      }
      case 'open_decision_episode': {
        const state = await this.operations.get(request.payload.operationId);
        if (isOperationRefusal(state)) return state;
        const evidenceIds = [evidenceIdentity(request)];
        return operationResult(request.action, await this.operations.openEpisode({
          operationId: state.operationId,
          eventId,
          episodeId: `episode:${hashCommand({ operationId: state.operationId, requestId: request.requestId })}`,
          recordedAt,
          knowledgeCutoff: recordedAt,
          stateSnapshotId: `operation-state:${hashCommand(state)}`,
          evidenceIds,
          constraintIds: ['constraint:insurance', 'constraint:operating-authority', 'constraint:cargo-cover', 'constraint:authority-to-bind'],
        }));
      }
      case 'assign_carrier': {
        const state = await this.operations.get(request.payload.operationId);
        if (isOperationRefusal(state)) return state;
        if (!state.episodeId) return refusal('OPERATION_PHASE_INVALID', `${state.operationId} has no open decision episode.`, 'Freeze the authorized decision set before assignment.');
        const candidate = state.alternatives.find(item => item.alternative.actionId === request.payload.actionId);
        if (!candidate || candidate.authorization?.decision !== 'authorized') {
          return refusal('OPERATION_ASSIGNMENT_REFUSED', 'The selected carrier is not an authorized action in the frozen decision set.', 'Select an authorized alternative exposed by the cockpit.');
        }
        const decision: DecisionRecordedEvent = {
          kind: 'decision_recorded',
          eventId,
          episodeId: state.episodeId,
          selectedActionId: candidate.alternative.actionId,
          decidedAt: recordedAt,
          recordedAt,
          selectionBasis: 'operator_judgment',
          policy: null,
          assignmentProbability: null,
          decidedBy: { kind: 'operator', id: request.actorId },
          rationale: request.payload.rationale,
          evidenceIds: [evidenceIdentity(request)],
        };
        return operationResult(request.action, await this.operations.recordAssignment({ operationId: state.operationId, decision }));
      }
      case 'dispatch_load': {
        const state = await this.operations.get(request.payload.operationId);
        if (isOperationRefusal(state)) return state;
        const decision = latestDecision(state);
        const selected = decision && state.alternatives.find(item => item.alternative.actionId === decision.selectedActionId);
        const loadId = selected?.authorization?.loadId;
        if (!loadId) return refusal('OPERATION_DISPATCH_REFUSED', 'The selected action has no bound authorized load identity.', 'Authorize and assign the exact load before dispatch.');
        return operationResult(request.action, await this.operations.dispatch({
          operationId: state.operationId,
          eventId,
          loadId,
          startedAt: recordedAt,
          recordedAt,
          evidenceIds: [evidenceIdentity(request)],
        }));
      }
      case 'send_tender': {
        const operation = await this.operations.get(request.payload.operationId);
        if (isOperationRefusal(operation)) return operation;
        return communicationResult(request.action, await this.communications.send({
          operationId: operation.operationId,
          eventId,
          requestedAt: recordedAt,
        }), operation);
      }
      case 'record_carrier_acknowledgement':
      case 'record_tracking': {
        const value = request.payload;
        if (Date.parse(value.occurredAt) > Date.parse(recordedAt)) {
          return refusal('OPERATOR_ACTION_INVALID', 'The physical carrier event occurs after the server recording time.', 'Enter the actual event time, no later than now.');
        }
        const operation = await this.operations.get(value.operationId);
        if (isOperationRefusal(operation)) return operation;
        const communication = await this.communications.get(value.operationId);
        if (isCommunicationRefusal(communication)) return communication;
        const evidenceId = evidenceIdentity(request, value.sourceReference);
        const result = await this.communications.recordCarrierEvent({
          operationId: operation.operationId,
          messageId: communication.envelope.messageId,
          eventId,
          carrierEventId: `operator-carrier-event:${hashCommand({ actorId: request.actorId, requestId: request.requestId })}`,
          carrierId: communication.envelope.carrierId,
          eventKind: request.action === 'record_carrier_acknowledgement' ? 'acknowledgement' : 'tracking',
          status: value.status,
          occurredAt: value.occurredAt,
          knownAt: recordedAt,
          recordedAt,
          evidenceIds: [evidenceId],
        });
        return communicationResult(request.action, result, operation);
      }
      case 'capture_settlement': {
        const value = request.payload;
        const operation = await this.operations.get(value.operationId);
        if (isOperationRefusal(operation)) return operation;
        const evidenceId = evidenceIdentity(request, value.sourceReference);
        const attestation = attestationOf('reported', 'medium', 'unknown', 'Operational record transcribed by the operator cockpit.');
        const instantEvidence = (valueAt: string) => ({ instant: valueAt, attestation, evidenceIds: [evidenceId] });
        const settlement: OperationalSettlementEvidence = {
          operationId: operation.operationId,
          eventId,
          pickupAt: instantEvidence(value.pickupAt),
          deliveredAt: instantEvidence(value.deliveredAt),
          originDwell: dwell(value.originArrivedAt, value.originDepartedAt, evidenceId, 'origin'),
          destinationDwell: dwell(value.destinationArrivedAt, value.destinationDepartedAt, evidenceId, 'destination'),
          carrierInvoice: optionalMoney(value.carrierInvoiceMinor, value.currency, evidenceId, 'carrier invoice'),
          accessorialCost: optionalMoney(value.accessorialCostMinor, value.currency, evidenceId, 'accessorial cost'),
          shipperRevenue: optionalMoney(value.shipperRevenueMinor, value.currency, evidenceId, 'shipper revenue'),
          damageCost: optionalMoney(value.damageCostMinor, value.currency, evidenceId, 'damage cost'),
          rejected: {
            kind: 'observed',
            evidence: { value: value.rejected ? 1 : 0, attestation, evidenceIds: [evidenceId] },
          },
          knownAt: recordedAt,
          recordedAt,
          evidenceIds: [evidenceId],
        };
        const captured = settlementOutcomeCommand(settlement);
        if (captured.kind === 'refusal') return captured;
        return operationResult(request.action, await this.operations.captureOutcome(captured.command));
      }
    }
  }
}
