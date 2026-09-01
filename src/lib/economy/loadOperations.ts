/**
 * Persistent freight operation workflow.
 *
 * Opportunity → alternatives → authorization → episode → assignment →
 * dispatch → outcome. Every accepted command appends one hash-linked journal
 * event. State is always rebuilt by replay, so a process restart changes no
 * answer and a retry cannot perform the physical step twice.
 */

import {
  assertExecutable,
  authorize,
  type Authorization,
  type AuthorizationRequest,
} from './authorization';
import {
  DecisionEpisodeLedger,
  type DecisionAlternative,
  type DecisionLedgerEntry,
  type DecisionMetric,
  type DecisionRecordedEvent,
  type EpisodeOpenedEvent,
  type ExecutionStartedEvent,
  type OutcomeAbsence,
  type OutcomeObservedEvent,
} from './decisionEpisode';
import {
  proposeExplorationAssignment,
  type ExplorationAssignmentPolicy,
} from './explorationAssignment';
import {
  ALL_OPPORTUNITY_FIELDS,
  REQUIRED_TO_QUOTE,
  assertNoContactDetail,
  type Opportunity,
} from './intake';
import {
  hashCommand,
  type AlternativeRegisteredEvent,
  type AuthorizationRecordedEvent,
  type DecisionEventRecorded,
  type LoadOperationEvent,
  type LoadOperationEventStore,
  type OperationalAlternativeDraft,
  type StoredLoadOperationRecord,
} from './loadOperationsStore';
import type { ISODateTime } from './types';

export type LoadOperationPhase =
  | 'alternatives_pending'
  | 'authorization_pending'
  | 'episode_opening_pending'
  | 'assignment_pending'
  | 'dispatch_pending'
  | 'outcome_pending'
  | 'outcome_captured';

export interface OperationalAlternativeState {
  readonly alternative: OperationalAlternativeDraft;
  readonly evidenceIds: readonly string[];
  readonly authorization: Authorization | null;
  readonly authorizationEventId: string | null;
  readonly authorizationEvidenceIds: readonly string[];
}

export interface LoadOperationSnapshot {
  readonly operationId: string;
  readonly opportunity: Opportunity;
  readonly phase: LoadOperationPhase;
  readonly durability: LoadOperationEventStore['durability'];
  readonly alternatives: readonly OperationalAlternativeState[];
  readonly episodeId: string | null;
  readonly decisionEntries: readonly DecisionLedgerEntry[];
}

export type LoadOperationRefusalCode =
  | 'OPERATION_COMMAND_INVALID'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_ALREADY_REGISTERED'
  | 'OPERATION_NOT_QUOTABLE'
  | 'OPERATION_PHASE_INVALID'
  | 'OPERATION_ALTERNATIVE_UNKNOWN'
  | 'OPERATION_ALTERNATIVE_DUPLICATE'
  | 'OPERATION_AUTHORIZATION_INVALID'
  | 'OPERATION_AUTHORIZATION_MISSING'
  | 'OPERATION_NO_FEASIBLE_ACTION'
  | 'OPERATION_ASSIGNMENT_REFUSED'
  | 'OPERATION_DISPATCH_REFUSED'
  | 'OPERATION_OUTCOME_REFUSED'
  | 'OPERATION_EVENT_ID_CONFLICT'
  | 'OPERATION_STORE_CONCURRENT_WRITE'
  | 'OPERATION_STORE_CORRUPT'
  | 'OPERATION_STORE_UNAVAILABLE';

export interface LoadOperationRefusal {
  readonly kind: 'refusal';
  readonly code: LoadOperationRefusalCode;
  readonly detail: string;
  readonly remedy: string;
}

export type LoadOperationCommandResult =
  | {
      readonly kind: 'accepted';
      readonly persistence: 'appended' | 'duplicate';
      readonly snapshot: LoadOperationSnapshot;
    }
  | LoadOperationRefusal;

export interface RegisterOpportunityCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly recordedAt: ISODateTime;
  readonly opportunity: Opportunity;
}

export interface RegisterAlternativeCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly recordedAt: ISODateTime;
  readonly alternative: OperationalAlternativeDraft;
  readonly evidenceIds: readonly string[];
}

export interface AuthorizeAlternativeCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly recordedAt: ISODateTime;
  readonly actionId: string;
  readonly request: AuthorizationRequest;
  readonly evidenceIds: readonly string[];
}

export interface OpenOperationEpisodeCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly episodeId: string;
  readonly recordedAt: ISODateTime;
  readonly knowledgeCutoff: ISODateTime;
  readonly stateSnapshotId: string;
  readonly evidenceIds: readonly string[];
  readonly constraintIds: readonly string[];
}

export interface RecordOperationAssignmentCommand {
  readonly operationId: string;
  readonly decision: DecisionRecordedEvent;
}

export interface ExploreOperationAssignmentCommand {
  readonly operationId: string;
  readonly policy: ExplorationAssignmentPolicy;
  readonly randomizationUnitId: string;
  readonly randomizationSalt: string;
  readonly eventId: string;
  readonly decidedAt: ISODateTime;
  readonly recordedAt: ISODateTime;
}

export interface DispatchOperationCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly loadId: string;
  readonly startedAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly evidenceIds: readonly string[];
}

export interface CaptureOperationOutcomeCommand {
  readonly operationId: string;
  readonly eventId: string;
  readonly occurredAt: ISODateTime;
  readonly knownAt: ISODateTime;
  readonly recordedAt: ISODateTime;
  readonly metrics: readonly DecisionMetric[];
  readonly absences: readonly OutcomeAbsence[];
  readonly evidenceIds: readonly string[];
}

interface InternalAlternativeState extends OperationalAlternativeState {
  readonly registeredEventId: string;
}

interface Projection {
  readonly snapshot: LoadOperationSnapshot;
  readonly ledger: DecisionEpisodeLedger;
  readonly alternatives: ReadonlyMap<string, InternalAlternativeState>;
  readonly opened: EpisodeOpenedEvent | null;
  readonly decision: DecisionRecordedEvent | null;
  readonly execution: ExecutionStartedEvent | null;
  readonly outcome: OutcomeObservedEvent | null;
}

class ProjectionDefect extends Error {
  constructor(readonly detail: string) {
    super(detail);
  }
}

function nonEmpty(values: readonly string[]): boolean {
  return values.length > 0 && values.every(value => value.trim().length > 0);
}

function opportunityDefect(opportunity: Opportunity): string | null {
  if (!opportunity || typeof opportunity !== 'object' || !opportunity.sourceMessageId?.trim() ||
      !Number.isFinite(Date.parse(opportunity.receivedAt)) ||
      !opportunity.extractedBy?.id?.trim() || !opportunity.extractedBy?.vendor?.trim() ||
      !opportunity.attestation || opportunity.attestation.inputCount < 1) {
    return 'opportunity identity, receipt time, extractor identity, or attestation is incomplete';
  }
  const missing: string[] = [];
  const unparsed: string[] = [];
  for (const name of ALL_OPPORTUNITY_FIELDS) {
    const field = opportunity.fields?.[name];
    if (!field || !['present', 'missing', 'unparsed'].includes(field.state)) {
      return `opportunity field ${name} has no typed state`;
    }
    if (field.state === 'missing') missing.push(name);
    if (field.state === 'unparsed') unparsed.push(name);
    if (field.state === 'present' || field.state === 'unparsed') {
      try { assertNoContactDetail(name, field.stated); }
      catch (error) { return (error as Error).message; }
    }
  }
  const blocked = REQUIRED_TO_QUOTE.filter(name => opportunity.fields[name].state !== 'present');
  const present = ALL_OPPORTUNITY_FIELDS.length - missing.length - unparsed.length;
  if (JSON.stringify(opportunity.missingFields) !== JSON.stringify(missing) ||
      JSON.stringify(opportunity.unparsedFields) !== JSON.stringify(unparsed) ||
      JSON.stringify(opportunity.blockedOn) !== JSON.stringify(blocked) ||
      opportunity.quotable !== (blocked.length === 0) ||
      opportunity.completeness?.present !== present ||
      opportunity.completeness?.of !== ALL_OPPORTUNITY_FIELDS.length) {
    return 'opportunity summary contradicts its field states';
  }
  return null;
}

function alternativeDefect(alternative: OperationalAlternativeDraft): string | null {
  if (!alternative || typeof alternative !== 'object' || !alternative.actionId?.trim() ||
      !alternative.carrierId?.trim() || !alternative.laneId?.trim()) {
    return 'carrier alternative identity is incomplete';
  }
  const start = Date.parse(alternative.departureWindow?.start);
  const end = Date.parse(alternative.departureWindow?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    return 'carrier alternative departure window is invalid';
  }
  if (!Array.isArray(alternative.predictedOutcomes)) return 'predicted outcomes are not an array';
  return null;
}

function refusal(
  code: LoadOperationRefusalCode,
  detail: string,
  remedy: string,
): LoadOperationRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function latest<T extends DecisionLedgerEntry['event']['kind']>(
  entries: readonly DecisionLedgerEntry[],
  kind: T,
): Extract<DecisionLedgerEntry['event'], { kind: T }> | null {
  for (let index = entries.length - 1; index >= 0; index--) {
    const event = entries[index].event;
    if (event.kind === kind) return event as Extract<DecisionLedgerEntry['event'], { kind: T }>;
  }
  return null;
}

function snapshotPhase(
  alternatives: ReadonlyMap<string, InternalAlternativeState>,
  opened: EpisodeOpenedEvent | null,
  decision: DecisionRecordedEvent | null,
  execution: ExecutionStartedEvent | null,
  outcome: OutcomeObservedEvent | null,
): LoadOperationPhase {
  if (alternatives.size === 0) return 'alternatives_pending';
  if ([...alternatives.values()].some(value => value.authorization === null)) return 'authorization_pending';
  if (!opened) return 'episode_opening_pending';
  if (!decision) return 'assignment_pending';
  if (!execution) return 'dispatch_pending';
  if (!outcome) return 'outcome_pending';
  return 'outcome_captured';
}

function project(
  records: readonly StoredLoadOperationRecord[],
  operationId: string,
  durability: LoadOperationEventStore['durability'],
): Projection | null {
  const events = records.map(record => record.event).filter(event => event.operationId === operationId);
  if (events.length === 0) return null;
  if (events[0].kind !== 'opportunity_registered') {
    throw new ProjectionDefect(`${operationId} does not begin with opportunity registration`);
  }
  const opportunityEvents = events.filter(event => event.kind === 'opportunity_registered');
  if (opportunityEvents.length !== 1) {
    throw new ProjectionDefect(`${operationId} has ${opportunityEvents.length} opportunity registrations`);
  }
  const opportunity = opportunityEvents[0].opportunity;
  const alternatives = new Map<string, InternalAlternativeState>();
  const ledger = new DecisionEpisodeLedger();
  let priorRecordedAt: number | null = null;
  let decisionStarted = false;
  for (const event of events) {
    const recordedAt = Date.parse(event.recordedAt);
    if (priorRecordedAt !== null && recordedAt < priorRecordedAt) {
      throw new ProjectionDefect(`${operationId} event ${event.eventId} is recorded before its journal predecessor`);
    }
    priorRecordedAt = recordedAt;
    if (event.kind === 'alternative_registered') {
      if (decisionStarted) throw new ProjectionDefect(`${operationId} registers an alternative after episode opening`);
      if (alternatives.has(event.alternative.actionId)) {
        throw new ProjectionDefect(`${operationId} registers action ${event.alternative.actionId} more than once`);
      }
      alternatives.set(event.alternative.actionId, {
        alternative: event.alternative,
        evidenceIds: event.evidenceIds,
        authorization: null,
        authorizationEventId: null,
        authorizationEvidenceIds: [],
        registeredEventId: event.eventId,
      });
    } else if (event.kind === 'authorization_recorded') {
      if (decisionStarted) throw new ProjectionDefect(`${operationId} records authorization after episode opening`);
      const prior = alternatives.get(event.actionId);
      if (!prior) throw new ProjectionDefect(`${operationId} authorizes unknown action ${event.actionId}`);
      alternatives.set(event.actionId, {
        ...prior,
        authorization: event.authorization,
        authorizationEventId: event.eventId,
        authorizationEvidenceIds: event.evidenceIds,
      });
    } else if (event.kind === 'decision_event_recorded') {
      if (event.eventId !== event.decisionEvent.eventId) {
        throw new ProjectionDefect(`${event.eventId} wrapper identity differs from its decision event`);
      }
      if (event.recordedAt !== event.decisionEvent.recordedAt) {
        throw new ProjectionDefect(`${event.eventId} wrapper and decision event recordedAt differ`);
      }
      if (event.decisionEvent.kind === 'episode_opened') {
        decisionStarted = true;
        if (event.decisionEvent.context.opportunityId !== operationId) {
          throw new ProjectionDefect(`${event.eventId} opens an episode for another opportunity`);
        }
        const openedById = new Map(event.decisionEvent.alternatives.map(action => [action.actionId, action]));
        if (openedById.size !== alternatives.size) {
          throw new ProjectionDefect(`${event.eventId} feasible-set population differs from registered alternatives`);
        }
        for (const [actionId, candidate] of alternatives) {
          const openedAction = openedById.get(actionId);
          if (!openedAction || !candidate.authorization) {
            throw new ProjectionDefect(`${event.eventId} opens before ${actionId} has an authorization decision`);
          }
          const expected = candidate.authorization.decision === 'authorized'
            ? 'feasible' : candidate.authorization.decision;
          if (openedAction.feasibility.status !== expected) {
            throw new ProjectionDefect(`${event.eventId} feasibility for ${actionId} contradicts authorization`);
          }
        }
      }
      const appended = ledger.append(event.decisionEvent);
      if (appended.kind === 'refusal') {
        throw new ProjectionDefect(`${event.eventId} does not replay: ${appended.code} ${appended.detail}`);
      }
    }
  }
  const episodeIds = ledger.episodeIds();
  if (episodeIds.length > 1) throw new ProjectionDefect(`${operationId} contains more than one decision episode`);
  const episodeId = episodeIds[0] ?? null;
  const decisionEntries = episodeId ? ledger.entries(episodeId) : [];
  const opened = latest(decisionEntries, 'episode_opened');
  const decision = latest(decisionEntries, 'decision_recorded');
  const execution = latest(decisionEntries, 'execution_started');
  const outcome = latest(decisionEntries, 'outcome_observed');
  const snapshot: LoadOperationSnapshot = Object.freeze({
    operationId,
    opportunity,
    phase: snapshotPhase(alternatives, opened, decision, execution, outcome),
    durability,
    alternatives: Object.freeze([...alternatives.values()].map(value => Object.freeze({
      alternative: value.alternative,
      evidenceIds: value.evidenceIds,
      authorization: value.authorization,
      authorizationEventId: value.authorizationEventId,
      authorizationEvidenceIds: value.authorizationEvidenceIds,
    }))),
    episodeId,
    decisionEntries,
  });
  return { snapshot, ledger, alternatives, opened, decision, execution, outcome };
}

function publicExplorationCommand(command: ExploreOperationAssignmentCommand): unknown {
  return {
    ...command,
    randomizationSalt: undefined,
    randomizationSaltCommitment: command.policy.randomizationSaltCommitment,
  };
}

export class LoadOperationsWorkflow {
  constructor(private readonly store: LoadOperationEventStore) {}

  async get(operationId: string): Promise<LoadOperationSnapshot | LoadOperationRefusal> {
    try {
      const records = await this.store.readAll();
      const state = project(records, operationId, this.store.durability);
      return state?.snapshot ?? refusal(
        'OPERATION_NOT_FOUND', `${operationId} is not in the operation journal.`,
        'Register the sanitized opportunity before adding carrier alternatives.',
      );
    } catch (error) {
      return this.storeFailure(error);
    }
  }

  async list(): Promise<readonly LoadOperationSnapshot[] | LoadOperationRefusal> {
    try {
      const records = await this.store.readAll();
      const ids = [...new Set(records.map(record => record.event.operationId))].sort();
      return Object.freeze(ids.map(id => project(records, id, this.store.durability)!.snapshot));
    } catch (error) {
      return this.storeFailure(error);
    }
  }

  async registerOpportunity(command: RegisterOpportunityCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    const opportunityProblem = opportunityDefect(command.opportunity);
    if (opportunityProblem) {
      return refusal(
        'OPERATION_COMMAND_INVALID', `Opportunity refused: ${opportunityProblem}.`,
        'Create the opportunity through intakeEmail and preserve its typed fields and sanitized load-only subject.',
      );
    }
    if (command.opportunity.opportunityId !== command.operationId) {
      return refusal(
        'OPERATION_COMMAND_INVALID',
        `Operation ${command.operationId} cannot register opportunity ${command.opportunity.opportunityId}.`,
        'Use the opportunity id as the stable operation id so every downstream record joins without inference.',
      );
    }
    const commandHash = hashCommand(command);
    const event: LoadOperationEvent = {
      kind: 'opportunity_registered', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash, opportunity: command.opportunity,
    };
    const prepared = await this.prepare(event);
    if (prepared.kind !== 'ready') return prepared.result;
    if (prepared.state) {
      return refusal(
        'OPERATION_ALREADY_REGISTERED', `${command.operationId} already has an opportunity.`,
        'Continue the existing operation or use a different opportunity id.',
      );
    }
    return this.persist(event);
  }

  async registerAlternative(command: RegisterAlternativeCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    const alternativeProblem = alternativeDefect(command.alternative);
    if (!nonEmpty(command.evidenceIds) || alternativeProblem) {
      return refusal(
        'OPERATION_COMMAND_INVALID',
        `Carrier alternative refused: ${alternativeProblem ?? 'evidence is incomplete'}.`,
        'Name the action, carrier, lane, and records from which the alternative was constructed.',
      );
    }
    const event: AlternativeRegisteredEvent = {
      kind: 'alternative_registered', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash: hashCommand(command),
      alternative: command.alternative, evidenceIds: command.evidenceIds,
    };
    const prepared = await this.prepare(event);
    if (prepared.kind !== 'ready') return prepared.result;
    const state = prepared.state;
    if (!state) return this.notFound(command.operationId);
    if (!state.snapshot.opportunity.quotable) {
      return refusal(
        'OPERATION_NOT_QUOTABLE',
        `${command.operationId} is blocked on ${state.snapshot.opportunity.blockedOn.join(', ')}.`,
        'Resolve the named intake fields before soliciting or constructing carrier alternatives.',
      );
    }
    if (state.opened) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'register alternatives');
    if (state.alternatives.has(command.alternative.actionId)) {
      return refusal(
        'OPERATION_ALTERNATIVE_DUPLICATE',
        `${command.alternative.actionId} is already registered in ${command.operationId}.`,
        'Revise the candidate set in a new operation episode; action identities are immutable.',
      );
    }
    return this.persist(event);
  }

  async authorizeAlternative(command: AuthorizeAlternativeCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    if (!nonEmpty(command.evidenceIds)) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Authorization cites no evidence.',
        'Attach the insurance, authority, value, BOL, and principal records used by the gate.',
      );
    }
    if (!command.request?.carrier || !command.request.tenderedCarrierId?.trim() ||
        !command.request.loadId?.trim()) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Authorization request identity or carrier record is incomplete.',
        'Submit the exact load, tendered carrier, and carrier compliance record to the authorization gate.',
      );
    }
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    const retry = this.retry(records, command.operationId, command.eventId, hashCommand(command));
    if (retry) return retry;
    let state: Projection | null;
    try { state = project(records, command.operationId, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    if (!state) return this.notFound(command.operationId);
    if (state.opened) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'authorize alternatives');
    const candidate = state.alternatives.get(command.actionId);
    if (!candidate) return this.unknownAlternative(command.operationId, command.actionId);
    if (command.request.tenderedCarrierId !== candidate.alternative.carrierId ||
        command.request.carrier.carrierId !== candidate.alternative.carrierId) {
      return refusal(
        'OPERATION_AUTHORIZATION_INVALID',
        `Authorization carrier identity does not match ${candidate.alternative.carrierId} on ${command.actionId}.`,
        'Authorize the exact carrier named by the candidate; a clearance is not transferable.',
      );
    }
    const pickup = Date.parse(command.request.pickupAt);
    const start = Date.parse(candidate.alternative.departureWindow.start);
    const end = Date.parse(candidate.alternative.departureWindow.end);
    if (![pickup, start, end].every(Number.isFinite) || pickup < start || pickup > end) {
      return refusal(
        'OPERATION_AUTHORIZATION_INVALID',
        `Authorization pickup ${command.request.pickupAt} is outside ${command.actionId}'s departure window.`,
        'Authorize the candidate at the pickup time it actually proposes.',
      );
    }
    const authorization = authorize(command.request, command.recordedAt);
    const event: AuthorizationRecordedEvent = {
      kind: 'authorization_recorded', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash: hashCommand(command), actionId: command.actionId,
      authorization, evidenceIds: command.evidenceIds,
    };
    return this.persist(event);
  }

  async openEpisode(command: OpenOperationEpisodeCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    if (!command.episodeId.trim() || !command.stateSnapshotId.trim() || !nonEmpty(command.evidenceIds)) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Episode identity, state snapshot, or evidence is incomplete.',
        'Name the decision episode and preserve the opportunity/state evidence available before selection.',
      );
    }
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(command);
    const retry = this.retry(records, command.operationId, command.eventId, commandHash);
    if (retry) return retry;
    let state: Projection | null;
    try { state = project(records, command.operationId, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    if (!state) return this.notFound(command.operationId);
    if (state.opened) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'open another episode');
    if (state.alternatives.size === 0) {
      return refusal(
        'OPERATION_PHASE_INVALID', `${command.operationId} has no carrier alternatives.`,
        'Register candidate actions before opening the decision episode.',
      );
    }
    const missing = [...state.alternatives.values()].filter(value => value.authorization === null);
    if (missing.length) {
      return refusal(
        'OPERATION_AUTHORIZATION_MISSING',
        `Actions lack authorization decisions: ${missing.map(value => value.alternative.actionId).join(', ')}.`,
        'Run the authorization gate for every candidate so refusal and uncertainty remain in the feasible-set record.',
      );
    }
    const alternatives = [...state.alternatives.values()].map(value =>
      this.decisionAlternative(value));
    if (!alternatives.some(alternative => alternative.feasibility.status === 'feasible')) {
      return refusal(
        'OPERATION_NO_FEASIBLE_ACTION', `${command.operationId} has no authorized action.`,
        'Resolve an undetermined check or register a new carrier alternative; do not assign across refusals.',
      );
    }
    const opened: EpisodeOpenedEvent = {
      kind: 'episode_opened', eventId: command.eventId, episodeId: command.episodeId,
      recordedAt: command.recordedAt,
      context: {
        opportunityId: command.operationId,
        stateSnapshotId: command.stateSnapshotId,
        knowledgeCutoff: command.knowledgeCutoff,
        evidenceIds: command.evidenceIds,
        constraintIds: command.constraintIds,
      },
      alternatives,
    };
    const trial = new DecisionEpisodeLedger();
    const result = trial.append(opened);
    if (result.kind === 'refusal') {
      return refusal('OPERATION_ASSIGNMENT_REFUSED', result.detail, result.remedy);
    }
    const event: DecisionEventRecorded = {
      kind: 'decision_event_recorded', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash, decisionEvent: opened,
    };
    return this.persist(event);
  }

  async recordAssignment(command: RecordOperationAssignmentCommand): Promise<LoadOperationCommandResult> {
    return this.appendDecision(
      command.operationId,
      command.decision,
      hashCommand(command),
    );
  }

  async exploreAssignment(command: ExploreOperationAssignmentCommand): Promise<LoadOperationCommandResult> {
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(publicExplorationCommand(command));
    const retry = this.retry(records, command.operationId, command.eventId, commandHash);
    if (retry) return retry;
    let state: Projection | null;
    try { state = project(records, command.operationId, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    if (!state) return this.notFound(command.operationId);
    if (!state.opened) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'assign exploration');
    const proposed = proposeExplorationAssignment({
      opened: state.opened,
      policy: command.policy,
      randomizationUnitId: command.randomizationUnitId,
      randomizationSalt: command.randomizationSalt,
      eventId: command.eventId,
      decidedAt: command.decidedAt,
      recordedAt: command.recordedAt,
    });
    if (proposed.kind === 'refusal') {
      return refusal('OPERATION_ASSIGNMENT_REFUSED', proposed.detail, proposed.remedy);
    }
    return this.appendDecision(command.operationId, proposed.decision, commandHash, records, state);
  }

  async dispatch(command: DispatchOperationCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    if (!command.loadId.trim() || !nonEmpty(command.evidenceIds)) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Dispatch lacks load identity or evidence.',
        'Attach the tender, acceptance, or dispatch record for the exact selected load.',
      );
    }
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(command);
    const retry = this.retry(records, command.operationId, command.eventId, commandHash);
    if (retry) return retry;
    let state: Projection | null;
    try { state = project(records, command.operationId, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    if (!state) return this.notFound(command.operationId);
    if (!state.decision) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'dispatch');
    const selected = state.alternatives.get(state.decision.selectedActionId);
    if (!selected?.authorization || selected.authorization.decision !== 'authorized') {
      return refusal(
        'OPERATION_DISPATCH_REFUSED',
        `Selected action ${state.decision.selectedActionId} has no binding authorization.`,
        'Re-open the decision against the current authorized feasible set; selection is not clearance.',
      );
    }
    try { assertExecutable(selected.authorization, command.loadId); }
    catch (error) {
      return refusal(
        'OPERATION_DISPATCH_REFUSED', (error as Error).message,
        'Dispatch only the load named by the selected action authorization.',
      );
    }
    const execution: ExecutionStartedEvent = {
      kind: 'execution_started', eventId: command.eventId, episodeId: state.opened!.episodeId,
      actionId: state.decision.selectedActionId, loadId: command.loadId,
      startedAt: command.startedAt, recordedAt: command.recordedAt,
      evidenceIds: command.evidenceIds,
    };
    const result = state.ledger.append(execution);
    if (result.kind === 'refusal') {
      return refusal('OPERATION_DISPATCH_REFUSED', result.detail, result.remedy);
    }
    const event: DecisionEventRecorded = {
      kind: 'decision_event_recorded', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash, decisionEvent: execution,
    };
    return this.persist(event);
  }

  async captureOutcome(command: CaptureOperationOutcomeCommand): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(command.operationId, command.eventId, command.recordedAt);
    if (invalid) return invalid;
    if (!nonEmpty(command.evidenceIds)) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Outcome capture cites no evidence.',
        'Attach telematics, POD, invoice, claim, or exception records to the captured outcome.',
      );
    }
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    const commandHash = hashCommand(command);
    const retry = this.retry(records, command.operationId, command.eventId, commandHash);
    if (retry) return retry;
    let state: Projection | null;
    try { state = project(records, command.operationId, this.store.durability); }
    catch (error) { return this.projectionFailure(error); }
    if (!state) return this.notFound(command.operationId);
    if (!state.execution) return this.phaseRefusal(command.operationId, state.snapshot.phase, 'capture an outcome');
    const outcome: OutcomeObservedEvent = {
      kind: 'outcome_observed', eventId: command.eventId, episodeId: state.opened!.episodeId,
      actionId: state.execution.actionId, loadId: state.execution.loadId,
      occurredAt: command.occurredAt, knownAt: command.knownAt, recordedAt: command.recordedAt,
      metrics: command.metrics, absences: command.absences, evidenceIds: command.evidenceIds,
      ...(state.outcome ? { supersedesEventId: state.outcome.eventId } : {}),
    };
    const result = state.ledger.append(outcome);
    if (result.kind === 'refusal') {
      return refusal('OPERATION_OUTCOME_REFUSED', result.detail, result.remedy);
    }
    const event: DecisionEventRecorded = {
      kind: 'decision_event_recorded', eventId: command.eventId, operationId: command.operationId,
      recordedAt: command.recordedAt, commandHash, decisionEvent: outcome,
    };
    return this.persist(event);
  }

  private async appendDecision(
    operationId: string,
    decision: DecisionRecordedEvent,
    commandHash: string,
    suppliedRecords?: readonly StoredLoadOperationRecord[],
    suppliedState?: Projection,
  ): Promise<LoadOperationCommandResult> {
    const invalid = this.baseDefect(operationId, decision.eventId, decision.recordedAt);
    if (invalid) return invalid;
    let records = suppliedRecords;
    if (!records) {
      try { records = await this.store.readAll(); } catch (error) { return this.storeFailure(error); }
    }
    const retry = this.retry(records, operationId, decision.eventId, commandHash);
    if (retry) return retry;
    let state = suppliedState;
    if (!state) {
      try { state = project(records, operationId, this.store.durability) ?? undefined; }
      catch (error) { return this.projectionFailure(error); }
    }
    if (!state) return this.notFound(operationId);
    if (!state.opened || decision.episodeId !== state.opened.episodeId) {
      return refusal(
        'OPERATION_ASSIGNMENT_REFUSED',
        `Decision ${decision.eventId} does not belong to ${operationId}'s open episode.`,
        'Open the decision episode first and record selection against that exact feasible set.',
      );
    }
    const result = state.ledger.append(decision);
    if (result.kind === 'refusal') {
      return refusal('OPERATION_ASSIGNMENT_REFUSED', result.detail, result.remedy);
    }
    const event: DecisionEventRecorded = {
      kind: 'decision_event_recorded', eventId: decision.eventId, operationId,
      recordedAt: decision.recordedAt, commandHash, decisionEvent: decision,
    };
    return this.persist(event);
  }

  private decisionAlternative(state: InternalAlternativeState): DecisionAlternative {
    const auth = state.authorization!;
    const evidenceIds = Object.freeze([
      ...state.authorizationEvidenceIds,
      state.authorizationEventId!,
    ]);
    const feasibility: DecisionAlternative['feasibility'] = auth.decision === 'authorized'
      ? { status: 'feasible', evidenceIds }
      : auth.decision === 'undetermined'
        ? {
            status: 'undetermined', reason: auth.statement,
            remedy: auth.blockedBy.map(check => check.remedy ?? check.detail).join('; '),
            evidenceIds,
          }
        : {
            status: 'refused',
            code: `AUTH_${auth.blockedBy.map(check => check.check).join('_') || 'REFUSED'}`,
            reason: auth.statement,
            remedy: 'Resolve the failed authorization check or register a different carrier action.',
            evidenceIds,
          };
    return {
      ...state.alternative,
      feasibility,
    };
  }

  private baseDefect(operationId: string, eventId: string, recordedAt: string): LoadOperationRefusal | null {
    if (!operationId.trim() || !eventId.trim() || !Number.isFinite(Date.parse(recordedAt))) {
      return refusal(
        'OPERATION_COMMAND_INVALID', 'Operation id, event id, or recordedAt is invalid.',
        'Supply stable identities and an explicit ISO timestamp; the workflow owns no clock.',
      );
    }
    return null;
  }

  private async prepare(event: LoadOperationEvent): Promise<
    | { kind: 'ready'; state: Projection | null }
    | { kind: 'done'; result: LoadOperationCommandResult }
  > {
    let records: readonly StoredLoadOperationRecord[];
    try { records = await this.store.readAll(); }
    catch (error) { return { kind: 'done', result: this.storeFailure(error) }; }
    const retry = this.retry(records, event.operationId, event.eventId, event.commandHash);
    if (retry) return { kind: 'done', result: retry };
    try {
      return { kind: 'ready', state: project(records, event.operationId, this.store.durability) };
    } catch (error) {
      return { kind: 'done', result: this.projectionFailure(error) };
    }
  }

  private retry(
    records: readonly StoredLoadOperationRecord[],
    operationId: string,
    eventId: string,
    commandHash: string,
  ): LoadOperationCommandResult | null {
    const existing = records.find(record => record.event.eventId === eventId);
    if (!existing) return null;
    if (existing.event.operationId !== operationId || existing.event.commandHash !== commandHash) {
      return refusal(
        'OPERATION_EVENT_ID_CONFLICT',
        `Event id ${eventId} already belongs to a different workflow command.`,
        'Retry the original command or allocate a new event id; do not reuse event identity.',
      );
    }
    try {
      const state = project(records, operationId, this.store.durability);
      if (!state) return this.notFound(operationId);
      return { kind: 'accepted', persistence: 'duplicate', snapshot: state.snapshot };
    } catch (error) {
      return this.projectionFailure(error);
    }
  }

  private async persist(event: LoadOperationEvent): Promise<LoadOperationCommandResult> {
    try {
      const before = await this.store.readAll();
      const retry = this.retry(before, event.operationId, event.eventId, event.commandHash);
      if (retry) return retry;
      const previousHash = before.length ? before[before.length - 1].recordHash : null;
      // Semantic preflight before durability: a rejected event must never poison
      // the journal and make every later restart refuse recovery.
      project([
        ...before,
        { event, previousHash, recordHash: '' },
      ], event.operationId, this.store.durability);
      const stored = await this.store.append(event, previousHash);
      if (stored.kind === 'refusal') {
        return refusal(stored.code, stored.detail, stored.remedy);
      }
      const records = await this.store.readAll();
      const state = project(records, event.operationId, this.store.durability);
      if (!state) return this.notFound(event.operationId);
      return {
        kind: 'accepted',
        persistence: stored.kind === 'duplicate' ? 'duplicate' : 'appended',
        snapshot: state.snapshot,
      };
    } catch (error) {
      return this.storeFailure(error);
    }
  }

  private notFound(operationId: string): LoadOperationRefusal {
    return refusal(
      'OPERATION_NOT_FOUND', `${operationId} is not in the operation journal.`,
      'Register the sanitized opportunity before continuing the workflow.',
    );
  }

  private unknownAlternative(operationId: string, actionId: string): LoadOperationRefusal {
    return refusal(
      'OPERATION_ALTERNATIVE_UNKNOWN', `${operationId} has no action ${actionId}.`,
      'Authorize an action registered before the episode opened.',
    );
  }

  private phaseRefusal(operationId: string, phase: LoadOperationPhase, action: string): LoadOperationRefusal {
    return refusal(
      'OPERATION_PHASE_INVALID', `${operationId} is ${phase}; cannot ${action}.`,
      'Continue from the current snapshot phase; completed facts append and are never rewritten.',
    );
  }

  private projectionFailure(error: unknown): LoadOperationRefusal {
    return refusal(
      'OPERATION_STORE_CORRUPT', (error as Error).message,
      'Stop workflow execution and restore the append-only journal from a verified copy.',
    );
  }

  private storeFailure(error: unknown): LoadOperationRefusal {
    const message = (error as Error).message;
    return refusal(
      error instanceof ProjectionDefect || message.includes('OPERATION_STORE_CORRUPT')
        ? 'OPERATION_STORE_CORRUPT'
        : 'OPERATION_STORE_UNAVAILABLE',
      message,
      'Do not execute from an unavailable or unverifiable journal; restore persistence and retry the same event id.',
    );
  }
}
