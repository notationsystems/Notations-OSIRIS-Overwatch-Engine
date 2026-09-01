/** Replayable constrained project-cargo execution and control logic. */

import { createHash } from 'node:crypto';
import { stableValue } from './loadOperationsStore';
import type {
  CargoTelemetryObservation,
  ConditionBreach,
  CustodyTransfer,
  ExceptionRemedyAuthorization,
  ExceptionRemedyCompletion,
  JourneyLegStatus,
  JourneyLegUpdate,
  JourneyPlan,
  PermitStatusUpdate,
  ProjectCargo,
  ProjectCargoEvent,
  ProjectCargoEventStore,
  ProjectDeliveryVerification,
  ProjectEconomicEntry,
  ProjectEconomicsClosure,
  ProjectEvidence,
  ProjectIntegrationExchange,
  StoredProjectCargoRecord,
  TelemetrySignal,
} from './projectCargoStore';
import { hashCommand } from './projectCargoStore';
import type { Hash, ISODateTime } from './types';

export type ProjectCargoRefusal = {
  readonly kind: 'refusal';
  readonly code:
    | 'PROJECT_CARGO_STORE_UNAVAILABLE'
    | 'PROJECT_CARGO_STORE_CORRUPT'
    | 'PROJECT_CARGO_NOT_FOUND'
    | 'PROJECT_CARGO_DUPLICATE'
    | 'PROJECT_CARGO_COMMAND_INVALID'
    | 'JOURNEY_PLAN_REFUSED'
    | 'PERMIT_UPDATE_REFUSED'
    | 'JOURNEY_LEG_UPDATE_REFUSED'
    | 'CUSTODY_TRANSFER_REFUSED'
    | 'PROJECT_EVIDENCE_REFUSED'
    | 'TELEMETRY_OBSERVATION_REFUSED'
    | 'EXCEPTION_REMEDY_REFUSED'
    | 'PROJECT_ECONOMICS_REFUSED'
    | 'PROJECT_INTEGRATION_REFUSED'
    | 'PROJECT_VERIFICATION_REFUSED';
  readonly detail: string;
  readonly remedy: string;
};

export type ProjectExceptionSnapshot = {
  readonly exceptionId: string;
  readonly observationId: string;
  readonly cargoItemId: string;
  readonly breach: ConditionBreach;
  readonly openedAt: ISODateTime;
  readonly authorization: ExceptionRemedyAuthorization | null;
  readonly completion: ExceptionRemedyCompletion | null;
  readonly status: 'open' | 'authorized' | 'contained' | 'resolved' | 'failed';
};

export type ProjectProfitability =
  | {
      readonly kind: 'complete';
      readonly currency: string;
      readonly revenueMinor: number;
      readonly recoveryMinor: number;
      readonly costMinor: number;
      readonly grossMarginMinor: number;
      readonly entryIds: readonly string[];
      readonly closureId: string;
    }
  | {
      readonly kind: 'incomplete';
      readonly reason: 'economics_open' | 'revenue_missing' | 'currency_mismatch';
      readonly detail: string;
      readonly remedy: string;
      readonly knownEntryIds: readonly string[];
    };

export type ProjectCargoPhase =
  | 'planning'
  | 'permits_pending'
  | 'ready'
  | 'executing'
  | 'exception'
  | 'verification_pending'
  | 'economics_pending'
  | 'complete';

export type ProjectCargoSnapshot = {
  readonly kind: 'project_cargo_snapshot';
  readonly project: ProjectCargo;
  readonly journey: JourneyPlan | null;
  readonly permitStatuses: readonly PermitStatusUpdate[];
  readonly legStatuses: readonly { readonly legId: string; readonly status: JourneyLegStatus; readonly update: JourneyLegUpdate | null }[];
  readonly custody: readonly CustodyTransfer[];
  readonly evidence: readonly ProjectEvidence[];
  readonly observations: readonly CargoTelemetryObservation[];
  readonly exceptions: readonly ProjectExceptionSnapshot[];
  readonly economicEntries: readonly ProjectEconomicEntry[];
  readonly economicsClosure: ProjectEconomicsClosure | null;
  readonly integrations: readonly ProjectIntegrationExchange[];
  readonly verification: ProjectDeliveryVerification | null;
  readonly profitability: ProjectProfitability;
  readonly phase: ProjectCargoPhase;
  readonly recommendedAction: string;
  readonly stateSnapshotId: Hash;
};

export type ProjectCargoPortfolio = {
  readonly kind: 'project_cargo_portfolio';
  readonly durability: ProjectCargoEventStore['durability'];
  readonly projects: readonly ProjectCargoSnapshot[];
  readonly totalProjects: number;
  readonly projectsNeedingAction: number;
  readonly openExceptions: number;
  readonly stateSnapshotId: Hash;
};

export type ProjectCargoCommandResult =
  | { readonly kind: 'accepted'; readonly persistence: 'appended' | 'duplicate'; readonly project: ProjectCargoSnapshot }
  | ProjectCargoRefusal;

type CommandEnvelope<T> = { readonly eventId: string; readonly recordedAt: ISODateTime; readonly value: T };
type StripEventBase<T> = T extends unknown ? Omit<T, 'eventId' | 'operationId' | 'recordedAt' | 'commandHash'> : never;
type ProjectCargoEventBody = StripEventBase<ProjectCargoEvent>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function refusal(code: ProjectCargoRefusal['code'], detail: string, remedy: string): ProjectCargoRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function validInstant(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function sha(value: unknown): Hash { return createHash('sha256').update(canonical(value)).digest('hex'); }

const SIGNAL_UNITS: Partial<Record<TelemetrySignal, string>> = {
  temperature: 'Cel',
  relative_humidity: '%',
  shock: 'g',
  vibration: 'mm/s',
  tilt: 'deg',
};

export function detectConditionBreaches(
  projectId: string,
  observationId: string,
  cargoItem: ProjectCargo['cargoItems'][number],
  signal: TelemetrySignal,
  numericValue: number | null,
  unit: string,
): readonly ConditionBreach[] {
  if (numericValue === null) return Object.freeze([]);
  const constraints = cargoItem.constraintProfile;
  const candidates: Omit<ConditionBreach, 'exceptionId'>[] = [];
  const add = (code: ConditionBreach['code'], limitValue: number) => candidates.push({ code, signal, observedValue: numericValue, limitValue, unit });
  if (signal === 'temperature' && constraints.temperature) {
    if (numericValue < constraints.temperature.minimum) add('TEMPERATURE_LOW', constraints.temperature.minimum);
    if (numericValue > constraints.temperature.maximum) add('TEMPERATURE_HIGH', constraints.temperature.maximum);
  }
  if (signal === 'relative_humidity' && constraints.relativeHumidity) {
    if (numericValue < constraints.relativeHumidity.minimum) add('HUMIDITY_LOW', constraints.relativeHumidity.minimum);
    if (numericValue > constraints.relativeHumidity.maximum) add('HUMIDITY_HIGH', constraints.relativeHumidity.maximum);
  }
  if (signal === 'shock' && constraints.maximumShockG !== undefined && numericValue > constraints.maximumShockG) add('SHOCK_HIGH', constraints.maximumShockG);
  if (signal === 'vibration' && constraints.maximumVibrationMmS !== undefined && numericValue > constraints.maximumVibrationMmS) add('VIBRATION_HIGH', constraints.maximumVibrationMmS);
  if (signal === 'tilt' && constraints.maximumTiltDegrees !== undefined && numericValue > constraints.maximumTiltDegrees) add('TILT_HIGH', constraints.maximumTiltDegrees);
  return Object.freeze(candidates.map(candidate => freeze({
    ...candidate,
    exceptionId: `project-exception:${sha({ projectId, observationId, code: candidate.code })}`,
  })));
}

function latestBy<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return Object.freeze([...map.values()]);
}

function profitability(entries: readonly ProjectEconomicEntry[], closure: ProjectEconomicsClosure | null): ProjectProfitability {
  const ids = entries.map(entry => entry.entryId);
  if (!closure) return freeze({ kind: 'incomplete' as const, reason: 'economics_open' as const, detail: 'Project economics have not been reconciled and closed.', remedy: 'Import all freight, handling, insurance, claims, revenue, and payment entries; then close economics.', knownEntryIds: ids });
  const revenueEntries = entries.filter(entry => entry.effect === 'revenue');
  if (revenueEntries.length === 0) return freeze({ kind: 'incomplete' as const, reason: 'revenue_missing' as const, detail: 'Closed project economics contain no customer revenue.', remedy: 'Reopen through a corrective economic entry and record evidenced customer revenue before relying on margin.', knownEntryIds: ids });
  const currencies = new Set(entries.map(entry => entry.amount.currency));
  if (currencies.size !== 1) return freeze({ kind: 'incomplete' as const, reason: 'currency_mismatch' as const, detail: 'Project economic entries use more than one currency without evidenced conversion.', remedy: 'Record entries in one settlement currency or append evidenced FX conversion entries.', knownEntryIds: ids });
  const currency = entries[0].amount.currency;
  const sum = (effect: ProjectEconomicEntry['effect']) => entries.filter(entry => entry.effect === effect).reduce((total, entry) => total + entry.amount.amountMinor, 0);
  const revenueMinor = sum('revenue');
  const recoveryMinor = sum('recovery');
  const costMinor = sum('cost');
  return freeze({ kind: 'complete' as const, currency, revenueMinor, recoveryMinor, costMinor, grossMarginMinor: revenueMinor + recoveryMinor - costMinor, entryIds: ids, closureId: closure.closureId });
}

function projectEvents(records: readonly StoredProjectCargoRecord[], projectId: string): readonly ProjectCargoEvent[] {
  return records.map(record => record.event).filter(event => event.operationId === projectId);
}

function buildSnapshot(records: readonly StoredProjectCargoRecord[], projectId: string): ProjectCargoSnapshot | null {
  const events = projectEvents(records, projectId);
  const registration = events.find((event): event is Extract<ProjectCargoEvent, { kind: 'project_registered' }> => event.kind === 'project_registered');
  if (!registration) return null;
  const plans = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'journey_planned' }> => event.kind === 'journey_planned').map(event => event.plan);
  const journey = plans.sort((left, right) => left.version - right.version).at(-1) ?? null;
  const permitStatuses = journey ? latestBy(events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'permit_status_updated' }> => event.kind === 'permit_status_updated' && event.update.journeyId === journey.journeyId).map(event => event.update), update => update.permitId) : [];
  const updates = journey ? latestBy(events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'journey_leg_updated' }> => event.kind === 'journey_leg_updated' && event.update.journeyId === journey.journeyId).map(event => event.update), update => update.legId) : [];
  const legStatuses = journey?.legs.map(leg => ({ legId: leg.legId, status: updates.find(update => update.legId === leg.legId)?.status ?? 'planned' as const, update: updates.find(update => update.legId === leg.legId) ?? null })) ?? [];
  const custody = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'custody_transferred' }> => event.kind === 'custody_transferred').map(event => event.transfer);
  const evidence = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_evidence_attached' }> => event.kind === 'project_evidence_attached').map(event => event.evidence);
  const observations = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'cargo_condition_observed' }> => event.kind === 'cargo_condition_observed').map(event => event.observation);
  const authorizations = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'exception_remedy_authorized' }> => event.kind === 'exception_remedy_authorized').map(event => event.authorization);
  const completions = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'exception_remedy_completed' }> => event.kind === 'exception_remedy_completed').map(event => event.completion);
  const exceptions = observations.flatMap(observation => observation.breaches.map(breach => {
    const authorization = authorizations.filter(item => item.exceptionId === breach.exceptionId).at(-1) ?? null;
    const completion = completions.filter(item => item.exceptionId === breach.exceptionId).at(-1) ?? null;
    const status: ProjectExceptionSnapshot['status'] = completion?.outcome === 'resolved' ? 'resolved' : completion?.outcome === 'contained' ? 'contained' : completion?.outcome === 'failed' ? 'failed' : authorization ? 'authorized' : 'open';
    return freeze({ exceptionId: breach.exceptionId, observationId: observation.observationId, cargoItemId: observation.cargoItemId, breach, openedAt: observation.observedTimestamp, authorization, completion, status });
  }));
  const economicEntries = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_economic_entry_recorded' }> => event.kind === 'project_economic_entry_recorded').map(event => event.entry);
  const economicsClosure = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_economics_closed' }> => event.kind === 'project_economics_closed').map(event => event.closure).at(-1) ?? null;
  const integrations = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_integration_recorded' }> => event.kind === 'project_integration_recorded').map(event => event.exchange);
  const verification = events.filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_delivery_verified' }> => event.kind === 'project_delivery_verified').map(event => event.verification).at(-1) ?? null;
  const openExceptions = exceptions.filter(item => item.status === 'open' || item.status === 'authorized' || item.status === 'failed');
  const permitsComplete = !!journey && journey.permits.every(permit => permitStatuses.find(update => update.permitId === permit.permitId)?.status === 'approved');
  const anyLegStarted = legStatuses.some(item => item.status !== 'planned' && item.status !== 'ready');
  const legsComplete = !!journey && journey.legs.length > 0 && legStatuses.every(item => item.status === 'completed');
  const profit = profitability(economicEntries, economicsClosure);
  let phase: ProjectCargoPhase;
  let recommendedAction: string;
  if (!journey) { phase = 'planning'; recommendedAction = 'Plan the multimodal journey.'; }
  else if (openExceptions.length > 0) { phase = 'exception'; recommendedAction = openExceptions.some(item => item.status === 'open') ? 'Authorize a typed remedy for the open exception.' : 'Complete or replace the authorized exception remedy.'; }
  else if (!permitsComplete) { phase = 'permits_pending'; recommendedAction = 'Resolve every required permit before movement.'; }
  else if (legsComplete && !verification) { phase = 'verification_pending'; recommendedAction = 'Verify delivery after required custody, telemetry, and evidence checks pass.'; }
  else if (verification && profit.kind === 'incomplete') { phase = 'economics_pending'; recommendedAction = 'Reconcile and close project economics.'; }
  else if (verification && profit.kind === 'complete') { phase = 'complete'; recommendedAction = 'Project execution and economics are complete.'; }
  else if (anyLegStarted) { phase = 'executing'; recommendedAction = 'Advance the next eligible journey leg and monitor condition.'; }
  else { phase = 'ready'; recommendedAction = 'Begin the first eligible journey leg.'; }
  return freeze({
    kind: 'project_cargo_snapshot' as const,
    project: registration.project,
    journey,
    permitStatuses,
    legStatuses,
    custody,
    evidence,
    observations,
    exceptions,
    economicEntries,
    economicsClosure,
    integrations,
    verification,
    profitability: profit,
    phase,
    recommendedAction,
    stateSnapshotId: sha(events),
  });
}

function registrationDefect(project: ProjectCargo): string | null {
  if (!project.projectId.trim() || !project.projectReference.trim() || !project.customerId.trim()) return 'Project identity, reference, and customer are required.';
  if (!validInstant(project.openedAt) || project.cargoItems.length === 0) return 'Project opening time and at least one cargo item are required.';
  if (!unique(project.cargoItems.map(item => item.cargoItemId)) || !unique(project.cargoItems.map(item => item.assetId))) return 'Cargo item and asset identities must be unique inside the project.';
  for (const item of project.cargoItems) {
    if (!item.cargoItemId.trim() || !item.assetId.trim() || !item.description.trim() || item.quantity.amount <= 0) return `Cargo item ${item.cargoItemId || '(missing)'} has invalid identity, description, or quantity.`;
    if (item.geometry && Object.values(item.geometry).some(value => !Number.isFinite(value) || value <= 0)) return `Cargo item ${item.cargoItemId} geometry must be positive and finite.`;
    const profile = item.constraintProfile;
    if (profile.temperature && profile.temperature.minimum > profile.temperature.maximum) return `Cargo item ${item.cargoItemId} temperature range is inverted.`;
    if (profile.relativeHumidity && (profile.relativeHumidity.minimum < 0 || profile.relativeHumidity.maximum > 100 || profile.relativeHumidity.minimum > profile.relativeHumidity.maximum)) return `Cargo item ${item.cargoItemId} humidity range is invalid.`;
    if (!unique(item.serialOrLotIds) || !unique(profile.requiredDocumentTypes) || !unique(profile.requiredTelemetrySignals)) return `Cargo item ${item.cargoItemId} contains duplicate serial, document, or telemetry requirements.`;
  }
  return null;
}

function journeyDefect(project: ProjectCargo, plan: JourneyPlan): string | null {
  if (plan.projectId !== project.projectId || !validInstant(plan.plannedAt) || plan.version < 1 || !Number.isSafeInteger(plan.version)) return 'Journey identity, version, or plan time is invalid.';
  if (plan.facilities.length < 2 || plan.legs.length < 1 || !unique(plan.facilities.map(item => item.facilityId)) || !unique(plan.legs.map(item => item.legId)) || !unique(plan.permits.map(item => item.permitId))) return 'Journey needs unique facilities, permits, and at least one unique leg.';
  const facilities = new Map(plan.facilities.map(item => [item.facilityId, item]));
  const legs = [...plan.legs].sort((left, right) => left.sequence - right.sequence);
  if (legs.some((leg, index) => leg.sequence !== index + 1)) return 'Journey leg sequence must be contiguous from one.';
  if (facilities.get(legs[0].fromFacilityId)?.locationId !== project.originLocationId || facilities.get(legs.at(-1)!.toFacilityId)?.locationId !== project.destinationLocationId) return 'Journey endpoints must match the project origin and destination.';
  const permitIds = new Set(plan.permits.map(item => item.permitId));
  const legIds = new Set(legs.map(item => item.legId));
  for (const [index, leg] of legs.entries()) {
    if (!facilities.has(leg.fromFacilityId) || !facilities.has(leg.toFacilityId) || !validInstant(leg.plannedStart) || !validInstant(leg.plannedEnd) || Date.parse(leg.plannedStart) >= Date.parse(leg.plannedEnd)) return `Journey leg ${leg.legId} has invalid facilities or time window.`;
    if (index > 0 && legs[index - 1].toFacilityId !== leg.fromFacilityId) return `Journey leg ${leg.legId} does not continue from the preceding facility.`;
    if (leg.dependsOnLegIds.some(id => !legIds.has(id) || legs.find(candidate => candidate.legId === id)!.sequence >= leg.sequence)) return `Journey leg ${leg.legId} has a missing or forward dependency.`;
    if (leg.requiredPermitIds.some(id => !permitIds.has(id))) return `Journey leg ${leg.legId} references an unknown permit.`;
  }
  for (const permit of plan.permits) if (permit.requiredForLegIds.some(id => !legIds.has(id))) return `Permit ${permit.permitId} references an unknown leg.`;
  return null;
}

const TRANSITIONS: Readonly<Record<JourneyLegStatus, readonly JourneyLegStatus[]>> = {
  planned: ['ready', 'blocked', 'cancelled'],
  ready: ['in_transit', 'blocked', 'cancelled'],
  in_transit: ['arrived', 'blocked'],
  arrived: ['completed', 'blocked'],
  blocked: ['ready', 'in_transit', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class ProjectCargoWorkflow {
  constructor(private readonly store: ProjectCargoEventStore) {}

  async list(): Promise<ProjectCargoPortfolio | ProjectCargoRefusal> {
    const records = await this.records();
    if ('kind' in records) return records;
    const ids = records.map(record => record.event).filter((event): event is Extract<ProjectCargoEvent, { kind: 'project_registered' }> => event.kind === 'project_registered').map(event => event.project.projectId);
    const projects = ids.map(id => buildSnapshot(records, id)!).filter(Boolean);
    return freeze({ kind: 'project_cargo_portfolio' as const, durability: this.store.durability, projects, totalProjects: projects.length, projectsNeedingAction: projects.filter(project => project.phase !== 'complete').length, openExceptions: projects.reduce((sum, project) => sum + project.exceptions.filter(item => item.status === 'open' || item.status === 'authorized' || item.status === 'failed').length, 0), stateSnapshotId: sha(records.map(record => record.recordHash)) });
  }

  async get(projectId: string): Promise<ProjectCargoSnapshot | ProjectCargoRefusal> {
    const records = await this.records();
    if ('kind' in records) return records;
    return buildSnapshot(records, projectId) ?? refusal('PROJECT_CARGO_NOT_FOUND', `Project ${projectId} is not registered.`, 'Register the canonical cargo project first.');
  }

  async register(command: CommandEnvelope<ProjectCargo>): Promise<ProjectCargoCommandResult> {
    const records = await this.records(); if ('kind' in records) return records;
    const defect = registrationDefect(command.value); if (defect) return refusal('PROJECT_CARGO_COMMAND_INVALID', defect, 'Correct the canonical cargo specification and constraints before registration.');
    if (buildSnapshot(records, command.value.projectId)) return refusal('PROJECT_CARGO_DUPLICATE', `Project ${command.value.projectId} already exists.`, 'Operate the existing project or allocate a new stable project identity.');
    if (records.some(record => record.event.kind === 'project_registered' && record.event.project.projectReference === command.value.projectReference)) return refusal('PROJECT_CARGO_DUPLICATE', `Project reference ${command.value.projectReference} already identifies another project.`, 'Use the existing project bound to that customer reference.');
    return this.append(command, command.value.projectId, { kind: 'project_registered', project: command.value }, records);
  }

  async planJourney(command: CommandEnvelope<JourneyPlan>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const defect = journeyDefect(state.snapshot.project, command.value); if (defect) return refusal('JOURNEY_PLAN_REFUSED', defect, 'Correct facilities, leg order, dependencies, permits, and time windows.');
    if (state.snapshot.verification) return refusal('JOURNEY_PLAN_REFUSED', 'A verified delivery cannot receive a new journey plan.', 'Create a new project for a subsequent movement.');
    if (state.snapshot.legStatuses.some(item => item.status !== 'planned')) return refusal('JOURNEY_PLAN_REFUSED', 'Journey execution has started; replacing the plan would rewrite the meaning of recorded leg events.', 'Complete the active plan or create an explicitly linked recovery project.');
    const expectedVersion = (state.snapshot.journey?.version ?? 0) + 1;
    if (command.value.version !== expectedVersion) return refusal('JOURNEY_PLAN_REFUSED', `Expected journey version ${expectedVersion}, received ${command.value.version}.`, 'Reload the project and submit the next append-only plan version.');
    return this.append(command, command.value.projectId, { kind: 'journey_planned', plan: command.value }, state.records);
  }

  async updatePermit(command: CommandEnvelope<PermitStatusUpdate>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const plan = state.snapshot.journey;
    if (!plan || plan.journeyId !== command.value.journeyId || !plan.permits.some(permit => permit.permitId === command.value.permitId)) return refusal('PERMIT_UPDATE_REFUSED', 'Permit is not part of the active journey.', 'Select a required permit from the active journey plan.');
    if (!validInstant(command.value.updatedAt) || (command.value.validFrom && !validInstant(command.value.validFrom)) || (command.value.validThrough && !validInstant(command.value.validThrough)) || (command.value.validFrom && command.value.validThrough && Date.parse(command.value.validFrom) >= Date.parse(command.value.validThrough))) return refusal('PERMIT_UPDATE_REFUSED', 'Permit dates are invalid.', 'Supply valid issue and expiry instants from the authority record.');
    return this.append(command, command.value.projectId, { kind: 'permit_status_updated', update: command.value }, state.records);
  }

  async updateLeg(command: CommandEnvelope<JourneyLegUpdate>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const plan = state.snapshot.journey;
    const leg = plan?.legs.find(item => item.legId === command.value.legId);
    if (!plan || plan.journeyId !== command.value.journeyId || !leg) return refusal('JOURNEY_LEG_UPDATE_REFUSED', 'Leg is not part of the active journey.', 'Select a leg from the active journey plan.');
    if (!validInstant(command.value.occurredAt) || state.snapshot.verification) return refusal('JOURNEY_LEG_UPDATE_REFUSED', 'Leg time is invalid or delivery is already verified.', 'Use a valid occurrence time on an open project.');
    const current = state.snapshot.legStatuses.find(item => item.legId === leg.legId)?.status ?? 'planned';
    if (!TRANSITIONS[current].includes(command.value.status)) return refusal('JOURNEY_LEG_UPDATE_REFUSED', `Leg ${leg.legId} cannot move from ${current} to ${command.value.status}.`, 'Use the next physical state transition; history cannot move backward.');
    if (command.value.status === 'ready' || command.value.status === 'in_transit') {
      const missingDependency = leg.dependsOnLegIds.find(id => state.snapshot.legStatuses.find(item => item.legId === id)?.status !== 'completed');
      if (missingDependency) return refusal('JOURNEY_LEG_UPDATE_REFUSED', `Dependency ${missingDependency} is not complete.`, 'Complete the prerequisite leg before releasing this leg.');
      const missingPermit = leg.requiredPermitIds.find(id => {
        const update = state.snapshot.permitStatuses.find(item => item.permitId === id);
        return update?.status !== 'approved' || (update.validFrom && Date.parse(command.value.occurredAt) < Date.parse(update.validFrom)) || (update.validThrough && Date.parse(command.value.occurredAt) > Date.parse(update.validThrough));
      });
      if (missingPermit) return refusal('JOURNEY_LEG_UPDATE_REFUSED', `Required permit ${missingPermit} is not approved and valid at movement time.`, 'Approve or renew the permit before releasing the leg.');
    }
    const facility = plan.facilities.find(item => item.facilityId === (command.value.status === 'completed' || command.value.status === 'arrived' ? leg.toFacilityId : leg.fromFacilityId));
    if ((command.value.status === 'completed' || command.value.status === 'arrived' || command.value.status === 'ready') && facility?.locationId !== command.value.locationId) return refusal('JOURNEY_LEG_UPDATE_REFUSED', `Leg ${command.value.status} location does not match the planned facility.`, 'Use the planned facility location or append a new plan before execution starts.');
    return this.append(command, command.value.projectId, { kind: 'journey_leg_updated', update: command.value }, state.records);
  }

  async transferCustody(command: CommandEnvelope<CustodyTransfer>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    if (!validInstant(command.value.transferredAt) || command.value.cargoItemIds.length === 0 || !unique(command.value.cargoItemIds) || command.value.cargoItemIds.some(id => !state.snapshot.project.cargoItems.some(item => item.cargoItemId === id))) return refusal('CUSTODY_TRANSFER_REFUSED', 'Custody transfer has invalid time or cargo identity.', 'Select one or more exact cargo items from the project.');
    for (const cargoItemId of command.value.cargoItemIds) {
      const latest = state.snapshot.custody.filter(transfer => transfer.cargoItemIds.includes(cargoItemId)).at(-1);
      if ((latest?.toCustodianId ?? null) !== command.value.fromCustodianId) return refusal('CUSTODY_TRANSFER_REFUSED', `Cargo ${cargoItemId} is currently held by ${latest?.toCustodianId ?? 'no recorded custodian'}, not ${command.value.fromCustodianId ?? 'no custodian'}.`, 'Reload custody and transfer from the exact current custodian.');
    }
    return this.append(command, command.value.projectId, { kind: 'custody_transferred', transfer: command.value }, state.records);
  }

  async attachEvidence(command: CommandEnvelope<ProjectEvidence>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    if (!/^[a-f0-9]{64}$/.test(command.value.sha256) || !validInstant(command.value.capturedAt) || (command.value.cargoItemId && !state.snapshot.project.cargoItems.some(item => item.cargoItemId === command.value.cargoItemId))) return refusal('PROJECT_EVIDENCE_REFUSED', 'Evidence digest, time, or cargo identity is invalid.', 'Hash the immutable artifact and bind it to the exact project cargo item.');
    if (state.snapshot.evidence.some(item => item.evidenceId === command.value.evidenceId)) return refusal('PROJECT_EVIDENCE_REFUSED', `Evidence ${command.value.evidenceId} already exists.`, 'Use the existing evidence identity or hash a genuinely new artifact.');
    return this.append(command, command.value.projectId, { kind: 'project_evidence_attached', evidence: command.value }, state.records);
  }

  async observeCondition(command: CommandEnvelope<CargoTelemetryObservation>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const observation = command.value;
    const item = state.snapshot.project.cargoItems.find(candidate => candidate.cargoItemId === observation.cargoItemId);
    if (!item || !validInstant(observation.timestamp) || !validInstant(observation.observedTimestamp) || Date.parse(observation.timestamp) > Date.parse(observation.observedTimestamp) + 300_000) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Telemetry cargo identity or timestamps are invalid.', 'Bind the sensor to a project cargo item and retain both source and observed time.');
    const expectedUnit = SIGNAL_UNITS[observation.signal];
    if (expectedUnit && (observation.numericValue === null || observation.unit !== expectedUnit)) return refusal('TELEMETRY_OBSERVATION_REFUSED', `${observation.signal} requires a numeric value in ${expectedUnit}.`, 'Normalize the source unit in the telemetry processor before ingestion.');
    if ((!expectedUnit && observation.numericValue === null && observation.textValue === null) || observation.eventName !== 'payload.cargo.condition.observed') return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Telemetry value or event name is invalid.', 'Emit the canonical Payload cargo condition event.');
    if (observation.traceId && !/^[a-f0-9]{32}$/.test(observation.traceId)) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Trace ID must be 16-byte lowercase hexadecimal.', 'Preserve a valid W3C trace identity or omit it.');
    if (observation.spanId && (!observation.traceId || !/^[a-f0-9]{16}$/.test(observation.spanId))) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Span ID requires a valid trace ID and 8-byte lowercase hexadecimal.', 'Preserve valid trace context or omit both fields.');
    const requiredResources: Record<string, string> = { 'payload.project.id': observation.projectId, 'payload.cargo.item.id': observation.cargoItemId, 'device.id': observation.sensorId };
    if (Object.entries(requiredResources).some(([key, value]) => observation.resource.attributes[key] !== value)) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'OTel resource identity does not match project, cargo, and sensor fields.', 'Set immutable entity identity as resource attributes before export.');
    const breaches = detectConditionBreaches(observation.projectId, observation.observationId, item, observation.signal, observation.numericValue, observation.unit);
    if (canonical(breaches) !== canonical(observation.breaches)) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Supplied breach claims do not match server-derived constraints.', 'Send the raw observation; use the server-derived exception set.');
    const severity = breaches.length ? { number: 13, text: 'WARN' } : { number: 9, text: 'INFO' };
    if (observation.severityNumber !== severity.number || observation.severityText !== severity.text) return refusal('TELEMETRY_OBSERVATION_REFUSED', 'Telemetry severity does not match the derived condition state.', 'Use INFO for in-range data and WARN for a derived breach.');
    return this.append(command, command.value.projectId, { kind: 'cargo_condition_observed', observation }, state.records);
  }

  async authorizeRemedy(command: CommandEnvelope<ExceptionRemedyAuthorization>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const exception = state.snapshot.exceptions.find(item => item.exceptionId === command.value.exceptionId);
    if (!exception || exception.status === 'resolved' || exception.status === 'contained') return refusal('EXCEPTION_REMEDY_REFUSED', 'Exception is missing or already closed.', 'Select an open or failed condition exception.');
    if (!validInstant(command.value.authorizedAt) || !command.value.instruction.trim()) return refusal('EXCEPTION_REMEDY_REFUSED', 'Remedy authorization time or instruction is invalid.', 'Describe a concrete typed intervention and authorization time.');
    return this.append(command, command.value.projectId, { kind: 'exception_remedy_authorized', authorization: command.value }, state.records);
  }

  async completeRemedy(command: CommandEnvelope<ExceptionRemedyCompletion>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const exception = state.snapshot.exceptions.find(item => item.exceptionId === command.value.exceptionId);
    if (!exception?.authorization || exception.status === 'resolved' || exception.status === 'contained') return refusal('EXCEPTION_REMEDY_REFUSED', 'Exception has no active authorization or is already closed.', 'Authorize the remedy first, then record its evidenced outcome.');
    if (!validInstant(command.value.completedAt) || Date.parse(command.value.completedAt) < Date.parse(exception.authorization.authorizedAt)) return refusal('EXCEPTION_REMEDY_REFUSED', 'Remedy completion predates authorization.', 'Use the actual completion time after operator authorization.');
    return this.append(command, command.value.projectId, { kind: 'exception_remedy_completed', completion: command.value }, state.records);
  }

  async recordEconomicEntry(command: CommandEnvelope<ProjectEconomicEntry>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    if (state.snapshot.economicsClosure) return refusal('PROJECT_ECONOMICS_REFUSED', 'Project economics are already closed.', 'Do not mutate a closed ledger; create an explicit adjustment workflow in a subsequent project revision.');
    if (!validInstant(command.value.incurredAt) || command.value.amount.amountMinor < 0 || !/^[A-Z]{3}$/.test(command.value.amount.currency) || state.snapshot.economicEntries.some(entry => entry.entryId === command.value.entryId)) return refusal('PROJECT_ECONOMICS_REFUSED', 'Economic entry identity, amount, currency, or time is invalid.', 'Import a unique evidenced non-negative entry in ISO currency minor units.');
    const expectedEffect: Partial<Record<ProjectEconomicEntry['category'], ProjectEconomicEntry['effect']>> = { customer_revenue: 'revenue', claim_recovery: 'recovery', freight: 'cost', handling: 'cost', insurance: 'cost', customs: 'cost', storage: 'cost', permit: 'cost', claim_loss: 'cost' };
    if (expectedEffect[command.value.category] && expectedEffect[command.value.category] !== command.value.effect) return refusal('PROJECT_ECONOMICS_REFUSED', `${command.value.category} must be recorded as ${expectedEffect[command.value.category]}.`, 'Correct the economic direction; do not net costs and recoveries into one entry.');
    return this.append(command, command.value.projectId, { kind: 'project_economic_entry_recorded', entry: command.value }, state.records);
  }

  async closeEconomics(command: CommandEnvelope<ProjectEconomicsClosure>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    if (!state.snapshot.verification || state.snapshot.economicsClosure || !validInstant(command.value.closedAt)) return refusal('PROJECT_ECONOMICS_REFUSED', 'Economics can close once, after physical delivery verification.', 'Verify physical delivery, import all entries, then reconcile economics once.');
    if (!state.snapshot.economicEntries.some(entry => entry.effect === 'revenue')) return refusal('PROJECT_ECONOMICS_REFUSED', 'No customer revenue entry exists.', 'Import evidenced commercial or payment revenue before closing economics.');
    if (new Set(state.snapshot.economicEntries.map(entry => entry.amount.currency)).size !== 1) return refusal('PROJECT_ECONOMICS_REFUSED', 'Economic entries are not in one reconciled currency.', 'Append evidenced conversion entries before closure.');
    if (command.value.sourceSystemsReconciled.length === 0 || !unique(command.value.sourceSystemsReconciled)) return refusal('PROJECT_ECONOMICS_REFUSED', 'No source systems were reconciled.', 'Name each commercial, accounting, payment, or claims source checked at closure.');
    return this.append(command, command.value.projectId, { kind: 'project_economics_closed', closure: command.value }, state.records);
  }

  async recordIntegration(command: CommandEnvelope<ProjectIntegrationExchange>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    if (!validInstant(command.value.occurredAt) || !command.value.externalReference.trim() || state.snapshot.integrations.some(exchange => exchange.exchangeId === command.value.exchangeId)) return refusal('PROJECT_INTEGRATION_REFUSED', 'Integration exchange identity, external reference, or time is invalid.', 'Use the provider delivery identity so retries deduplicate deterministically.');
    return this.append(command, command.value.projectId, { kind: 'project_integration_recorded', exchange: command.value }, state.records);
  }

  async verifyDelivery(command: CommandEnvelope<ProjectDeliveryVerification>): Promise<ProjectCargoCommandResult> {
    const state = await this.state(command.value.projectId); if ('kind' in state) return state;
    const snapshot = state.snapshot;
    if (snapshot.verification || !snapshot.journey || snapshot.legStatuses.some(item => item.status !== 'completed')) return refusal('PROJECT_VERIFICATION_REFUSED', 'Every active journey leg must be completed exactly once before delivery verification.', 'Complete the journey execution timeline first.');
    if (snapshot.exceptions.some(item => item.status === 'open' || item.status === 'authorized' || item.status === 'failed')) return refusal('PROJECT_VERIFICATION_REFUSED', 'One or more condition exceptions remain unresolved.', 'Complete an effective remedy or quarantine/reject the cargo through an evidenced outcome.');
    if (command.value.disposition === 'accepted' && snapshot.exceptions.some(item => item.status === 'contained')) return refusal('PROJECT_VERIFICATION_REFUSED', 'Contained cargo cannot be accepted as an exception-free delivery.', 'Use the quarantined or rejected disposition, or record a resolved remedy supported by condition evidence.');
    for (const item of snapshot.project.cargoItems) {
      if (item.constraintProfile.continuousCustodyRequired) {
        const custody = snapshot.custody.filter(transfer => transfer.cargoItemIds.includes(item.cargoItemId)).at(-1);
        if (!custody || custody.locationId !== snapshot.project.destinationLocationId) return refusal('PROJECT_VERIFICATION_REFUSED', `Cargo ${item.cargoItemId} lacks destination custody evidence.`, 'Record the final custody transfer at the project destination.');
      }
      const missingSignal = item.constraintProfile.requiredTelemetrySignals.find(signal => !snapshot.observations.some(observation => observation.cargoItemId === item.cargoItemId && observation.signal === signal));
      if (missingSignal) return refusal('PROJECT_VERIFICATION_REFUSED', `Cargo ${item.cargoItemId} lacks required ${missingSignal} telemetry.`, 'Ingest at least one valid observation for every required signal.');
      const missingDocument = item.constraintProfile.requiredDocumentTypes.find(documentType => !snapshot.evidence.some(evidence => (evidence.cargoItemId === null || evidence.cargoItemId === item.cargoItemId) && evidence.documentType === documentType));
      if (missingDocument) return refusal('PROJECT_VERIFICATION_REFUSED', `Cargo ${item.cargoItemId} lacks required document ${missingDocument}.`, 'Attach the immutable document hash before verification.');
    }
    if (command.value.locationId !== snapshot.project.destinationLocationId || !validInstant(command.value.verifiedAt) || command.value.evidenceIds.length === 0) return refusal('PROJECT_VERIFICATION_REFUSED', 'Verification location, time, or evidence is invalid.', 'Verify at the canonical destination with signed delivery evidence.');
    return this.append(command, command.value.projectId, { kind: 'project_delivery_verified', verification: command.value }, state.records);
  }

  private async records(): Promise<readonly StoredProjectCargoRecord[] | ProjectCargoRefusal> {
    try { return await this.store.readAll(); }
    catch (error) {
      const corrupt = (error as Error).message.includes('CORRUPT');
      return refusal(corrupt ? 'PROJECT_CARGO_STORE_CORRUPT' : 'PROJECT_CARGO_STORE_UNAVAILABLE', (error as Error).message, corrupt ? 'Restore the project journal from a verified replica; never skip a damaged record.' : 'Restore persistent project storage before operating cargo.');
    }
  }

  private async state(projectId: string): Promise<{ readonly records: readonly StoredProjectCargoRecord[]; readonly snapshot: ProjectCargoSnapshot } | ProjectCargoRefusal> {
    const records = await this.records(); if ('kind' in records) return records;
    const snapshot = buildSnapshot(records, projectId);
    return snapshot ? { records, snapshot } : refusal('PROJECT_CARGO_NOT_FOUND', `Project ${projectId} is not registered.`, 'Register the canonical cargo project first.');
  }

  private async append<T>(command: CommandEnvelope<T>, projectId: string, body: ProjectCargoEventBody, records: readonly StoredProjectCargoRecord[]): Promise<ProjectCargoCommandResult> {
    if (!command.eventId.trim() || !validInstant(command.recordedAt)) return refusal('PROJECT_CARGO_COMMAND_INVALID', 'Event identity or recorded time is invalid.', 'Use the authenticated action adapter so server identities and time are derived.');
    const event = freeze({ ...body, eventId: command.eventId, operationId: projectId, recordedAt: command.recordedAt, commandHash: hashCommand({ projectId, body }) } as ProjectCargoEvent);
    const result = await this.store.append(event, records.at(-1)?.recordHash ?? null);
    if (result.kind === 'refusal') return refusal(result.code === 'PROJECT_CARGO_STORE_CORRUPT' ? 'PROJECT_CARGO_STORE_CORRUPT' : 'PROJECT_CARGO_STORE_UNAVAILABLE', result.detail, result.remedy);
    const nextRecords = result.kind === 'appended' ? [...records, result.record] : records;
    const snapshot = buildSnapshot(nextRecords, projectId);
    if (!snapshot) return refusal('PROJECT_CARGO_STORE_CORRUPT', 'Accepted event did not replay to a project.', 'Stop writes and inspect the project journal.');
    return freeze({ kind: 'accepted' as const, persistence: result.kind, project: snapshot });
  }
}
