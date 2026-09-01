/**
 * Payload operations control tower.
 *
 * This is a read model over the two durable journals, not a third book of
 * truth. It joins load decisions to carrier delivery/tracking evidence and
 * turns typed absence into a deterministic operator queue. No opaque risk
 * score is emitted: severity, deadline, evidence, and remedy remain visible.
 */

import type {
  CarrierCommunicationRefusal,
  CarrierCommunicationSnapshot,
} from './carrierCommunications';
import type { DecisionLedgerEntry, DecisionMetric } from './decisionEpisode';
import type {
  LoadOperationPhase,
  LoadOperationRefusal,
  LoadOperationSnapshot,
  OperationalAlternativeState,
} from './loadOperations';
import type { OpportunityFieldName } from './intake';
import type { ISODateTime } from './types';

export type ControlTowerSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none';

export type ControlTowerIssueCode =
  | 'intake_blocked'
  | 'carrier_alternatives_missing'
  | 'authorization_incomplete'
  | 'no_authorized_alternative'
  | 'decision_episode_pending'
  | 'carrier_assignment_pending'
  | 'dispatch_record_pending'
  | 'tender_send_pending'
  | 'tender_send_in_progress'
  | 'tender_delivery_failed'
  | 'carrier_ack_pending'
  | 'carrier_rejected'
  | 'pickup_overdue'
  | 'tracking_missing'
  | 'tracking_stale'
  | 'tracking_exception'
  | 'delivery_overdue'
  | 'settlement_pending';

export type ControlTowerIssue = {
  readonly code: ControlTowerIssueCode;
  readonly severity: Exclude<ControlTowerSeverity, 'none'>;
  readonly detail: string;
  readonly remedy: string;
  readonly deadlineAt: ISODateTime | null;
  readonly evidenceIds: readonly string[];
};

export type ControlTowerPolicy = {
  /** How long a delivered tender may remain unacknowledged. */
  readonly acknowledgementGraceMinutes: number;
  /** Maximum age of an in-motion tracking observation. */
  readonly trackingStaleMinutes: number;
  /** How long after delivered tracking before settlement becomes high priority. */
  readonly settlementGraceMinutes: number;
};

export const DEFAULT_CONTROL_TOWER_POLICY: ControlTowerPolicy = Object.freeze({
  acknowledgementGraceMinutes: 30,
  trackingStaleMinutes: 120,
  settlementGraceMinutes: 24 * 60,
});

export type ControlTowerLoad = {
  readonly operationId: string;
  readonly loadId: string | null;
  readonly episodeId: string | null;
  readonly actionId: string | null;
  readonly carrierId: string | null;
  readonly laneId: string | null;
  readonly route: {
    readonly origin: string | null;
    readonly destination: string | null;
    readonly equipment: string | null;
  };
  readonly timing: {
    readonly pickupWindow: { readonly raw: string; readonly start: ISODateTime; readonly end: ISODateTime } | null;
    readonly deliveryWindow: { readonly raw: string; readonly start: ISODateTime; readonly end: ISODateTime } | null;
    readonly dispatchedAt: ISODateTime | null;
    readonly lastTrackingOccurredAt: ISODateTime | null;
    readonly lastTrackingKnownAt: ISODateTime | null;
  };
  readonly state: {
    readonly operationPhase: LoadOperationPhase;
    readonly authorization: 'authorized' | 'refused' | 'undetermined' | 'pending' | 'not_selected';
    readonly tenderDelivery: CarrierCommunicationSnapshot['deliveryState'] | 'not_created';
    readonly acknowledgement: CarrierCommunicationSnapshot['acknowledgement'] | 'not_created';
    readonly tracking: CarrierCommunicationSnapshot['latestTrackingStatus'];
    readonly outcomeCaptured: boolean;
  };
  readonly economics: {
    readonly quotedCost: DecisionMetric | null;
    readonly carrierInvoice: DecisionMetric | null;
    readonly grossMargin: DecisionMetric | null;
  };
  readonly attentionLevel: ControlTowerSeverity;
  readonly nextAction: ControlTowerIssue | null;
  readonly issues: readonly ControlTowerIssue[];
};

export type ControlTowerPortfolio = {
  readonly totalLoads: number;
  readonly activeLoads: number;
  readonly completedLoads: number;
  readonly needingAttention: number;
  readonly critical: number;
  readonly high: number;
  readonly inMotion: number;
  readonly awaitingSettlement: number;
};

export type ControlTowerSnapshot = {
  readonly kind: 'control_tower_snapshot';
  readonly asOf: ISODateTime;
  readonly policy: ControlTowerPolicy;
  readonly portfolio: ControlTowerPortfolio;
  readonly loads: readonly ControlTowerLoad[];
};

export type ControlTowerRefusal = {
  readonly kind: 'refusal';
  readonly code: 'CONTROL_TOWER_REQUEST_INVALID' | 'CONTROL_TOWER_OPERATIONS_UNAVAILABLE' | 'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE';
  readonly detail: string;
  readonly remedy: string;
};

export type ControlTowerResult = ControlTowerSnapshot | ControlTowerRefusal;

type OperationsReader = {
  list(): Promise<readonly LoadOperationSnapshot[] | LoadOperationRefusal>;
};

type CommunicationsReader = {
  list(): Promise<readonly CarrierCommunicationSnapshot[] | CarrierCommunicationRefusal>;
};

function isLoadOperationRefusal(
  result: readonly LoadOperationSnapshot[] | LoadOperationRefusal,
): result is LoadOperationRefusal {
  return 'kind' in result && result.kind === 'refusal';
}

function isCarrierCommunicationRefusal(
  result: readonly CarrierCommunicationSnapshot[] | CarrierCommunicationRefusal,
): result is CarrierCommunicationRefusal {
  return 'kind' in result && result.kind === 'refusal';
}

const SEVERITY_RANK: Record<ControlTowerSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

function refusal(
  code: ControlTowerRefusal['code'],
  detail: string,
  remedy: string,
): ControlTowerRefusal {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function validPolicy(policy: ControlTowerPolicy): boolean {
  return [
    policy.acknowledgementGraceMinutes,
    policy.trackingStaleMinutes,
    policy.settlementGraceMinutes,
  ].every(value => Number.isFinite(value) && value >= 0 && value <= 60 * 24 * 30);
}

function fieldText(snapshot: LoadOperationSnapshot, name: OpportunityFieldName): string | null {
  const field = snapshot.opportunity.fields[name];
  if (field.state !== 'present') return null;
  if (typeof field.value !== 'string' && typeof field.value !== 'number') return null;
  const text = String(field.value).trim();
  return text || null;
}

function parseWindow(raw: string | null): ControlTowerLoad['timing']['pickupWindow'] {
  if (!raw) return null;
  const parts = raw.split('/');
  if (parts.length !== 2) return null;
  const start = Date.parse(parts[0]);
  const end = Date.parse(parts[1]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  return Object.freeze({
    raw,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  });
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

function selectedAlternative(snapshot: LoadOperationSnapshot): OperationalAlternativeState | null {
  const decision = latest(snapshot.decisionEntries, 'decision_recorded');
  if (!decision) return null;
  return snapshot.alternatives.find(item => item.alternative.actionId === decision.selectedActionId) ?? null;
}

function metric(entries: readonly DecisionLedgerEntry[], name: DecisionMetric['name']): DecisionMetric | null {
  const outcome = latest(entries, 'outcome_observed');
  return outcome?.metrics.find(item => item.name === name) ?? null;
}

function addMinutes(instant: string, minutes: number): ISODateTime {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

function after(left: string, right: string): boolean {
  return Date.parse(left) > Date.parse(right);
}

function issue(
  code: ControlTowerIssueCode,
  severity: Exclude<ControlTowerSeverity, 'none'>,
  detail: string,
  remedy: string,
  deadlineAt: ISODateTime | null = null,
  evidenceIds: readonly string[] = [],
): ControlTowerIssue {
  return Object.freeze({ code, severity, detail, remedy, deadlineAt, evidenceIds: Object.freeze([...evidenceIds]) });
}

function sortIssues(issues: readonly ControlTowerIssue[]): readonly ControlTowerIssue[] {
  return Object.freeze([...issues].sort((left, right) => {
    const severity = SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    if (severity) return severity;
    const leftDeadline = left.deadlineAt ? Date.parse(left.deadlineAt) : Number.POSITIVE_INFINITY;
    const rightDeadline = right.deadlineAt ? Date.parse(right.deadlineAt) : Number.POSITIVE_INFINITY;
    return leftDeadline - rightDeadline || left.code.localeCompare(right.code);
  }));
}

function phaseIssues(snapshot: LoadOperationSnapshot): ControlTowerIssue[] {
  const issues: ControlTowerIssue[] = [];
  if (!snapshot.opportunity.quotable) {
    issues.push(issue(
      'intake_blocked', 'high',
      `${snapshot.operationId} is blocked on ${snapshot.opportunity.blockedOn.join(', ')}.`,
      'Resolve the named shipper fields before sourcing capacity.',
    ));
  }
  if (snapshot.phase === 'alternatives_pending') {
    issues.push(issue(
      'carrier_alternatives_missing', 'high',
      `${snapshot.operationId} has no carrier alternatives.`,
      'Source evidenced carrier capacity and rate alternatives for this lane and departure window.',
    ));
  } else if (snapshot.phase === 'authorization_pending') {
    const pending = snapshot.alternatives.filter(item => item.authorization === null);
    issues.push(issue(
      'authorization_incomplete', 'high',
      `${pending.length} carrier alternative${pending.length === 1 ? '' : 's'} lack an authorization decision.`,
      'Pull authority and insurance evidence, then run the deterministic gate for every candidate.',
      null,
      pending.flatMap(item => item.evidenceIds),
    ));
  } else if (snapshot.phase === 'episode_opening_pending') {
    const authorized = snapshot.alternatives.filter(item => item.authorization?.decision === 'authorized');
    if (authorized.length === 0) {
      issues.push(issue(
        'no_authorized_alternative', 'critical',
        `${snapshot.operationId} has no authorized carrier action.`,
        'Resolve an undetermined compliance record or source another carrier; do not assign across a refusal.',
        null,
        snapshot.alternatives.flatMap(item => item.authorizationEvidenceIds),
      ));
    } else {
      issues.push(issue(
        'decision_episode_pending', 'medium',
        `${snapshot.operationId} has an authorized feasible set but no frozen decision episode.`,
        'Freeze the knowledge cutoff and feasible set before assigning the carrier.',
        null,
        authorized.flatMap(item => item.authorizationEvidenceIds),
      ));
    }
  } else if (snapshot.phase === 'assignment_pending') {
    issues.push(issue(
      'carrier_assignment_pending', 'high',
      `${snapshot.operationId} has an open feasible set but no selected action.`,
      'Select deterministically or run the registered exploration policy, preserving the selection basis.',
    ));
  } else if (snapshot.phase === 'dispatch_pending') {
    issues.push(issue(
      'dispatch_record_pending', 'high',
      `${snapshot.operationId} has an assigned carrier but no immutable dispatch record.`,
      'Bind the exact authorized load and carrier in the dispatch journal before sending the tender.',
    ));
  }
  return issues;
}

function communicationIssues(
  operation: LoadOperationSnapshot,
  communication: CarrierCommunicationSnapshot | null,
  asOf: ISODateTime,
  policy: ControlTowerPolicy,
  pickup: ControlTowerLoad['timing']['pickupWindow'],
  delivery: ControlTowerLoad['timing']['deliveryWindow'],
): ControlTowerIssue[] {
  const execution = latest(operation.decisionEntries, 'execution_started');
  if (!execution || operation.phase === 'outcome_captured') return [];
  const issues: ControlTowerIssue[] = [];
  if (!communication || communication.deliveryState === 'pending') {
    issues.push(issue(
      'tender_send_pending', 'high',
      `${execution.loadId} is dispatched internally but has no carrier delivery receipt.`,
      'Send the immutable tender through the configured carrier gateway.',
      pickup?.start ?? null,
      execution.evidenceIds,
    ));
  } else if (communication.deliveryState === 'sending') {
    issues.push(issue(
      'tender_send_in_progress', 'low',
      `${communication.envelope.messageId} has an open delivery attempt.`,
      'Wait for the bounded provider call; investigate if the attempt remains open after its timeout.',
      pickup?.start ?? null,
      communication.envelope.sourceEvidenceIds,
    ));
  } else if (communication.deliveryState === 'failed') {
    const failure = communication.attempts.at(-1)?.failure;
    issues.push(issue(
      'tender_delivery_failed', failure?.retryable ? 'high' : 'critical',
      `${communication.envelope.messageId} delivery failed${failure ? `: ${failure.detail}` : '.'}`,
      failure?.retryable
        ? 'Retry with the same stable attempt identity after the provider recovers.'
        : 'Escalate to an operator and repair provider configuration before creating another tender.',
      pickup?.start ?? null,
      communication.envelope.sourceEvidenceIds,
    ));
  }

  if (communication?.deliveryState === 'delivered') {
    const deliveredAt = [...communication.attempts].reverse()
      .find(attempt => attempt.state === 'delivered')?.completedAt;
    if (communication.acknowledgement === 'rejected') {
      const acknowledgement = [...communication.carrierEvents].reverse()
        .find(event => event.eventKind === 'acknowledgement');
      issues.push(issue(
        'carrier_rejected', 'critical',
        `${communication.envelope.carrierId} rejected ${communication.envelope.loadId}.`,
        'Re-cover the load through a new authorized decision episode; do not mutate the rejected assignment.',
        pickup?.start ?? null,
        acknowledgement?.evidenceIds ?? [],
      ));
    } else if (communication.acknowledgement === 'pending' && deliveredAt) {
      const due = addMinutes(deliveredAt, policy.acknowledgementGraceMinutes);
      issues.push(issue(
        'carrier_ack_pending', after(asOf, due) ? 'high' : 'low',
        `${communication.envelope.carrierId} has not acknowledged the delivered tender.`,
        'Obtain an acceptance or rejection tied to the immutable dispatch message.',
        due,
        communication.envelope.sourceEvidenceIds,
      ));
    }
  }

  const trackingEvent = communication ? [...communication.carrierEvents].reverse()
    .find(event => event.eventKind === 'tracking') : undefined;
  const tracking = communication?.latestTrackingStatus ?? null;
  const progressed = new Set(['picked_up', 'in_transit', 'arrived', 'delivered']);
  if (pickup && after(asOf, pickup.end) && !progressed.has(tracking ?? '')) {
    issues.push(issue(
      'pickup_overdue', 'high',
      `${execution.loadId} has passed its pickup window without picked-up evidence.`,
      'Contact the assigned carrier and shipper; record the actual pickup or an explicit exception.',
      pickup.end,
      trackingEvent?.evidenceIds ?? execution.evidenceIds,
    ));
  }
  if (delivery && after(asOf, delivery.end) && tracking !== 'delivered') {
    issues.push(issue(
      'delivery_overdue', 'critical',
      `${execution.loadId} has passed its delivery window without delivered evidence.`,
      'Escalate the load exception, obtain current position/ETA, and preserve detention or service-failure evidence.',
      delivery.end,
      trackingEvent?.evidenceIds ?? execution.evidenceIds,
    ));
  }
  if (tracking === 'exception') {
    issues.push(issue(
      'tracking_exception', 'critical',
      `${execution.loadId} carries an unresolved carrier exception.`,
      'Classify the exception, assign an owner, and capture its operational and financial consequence.',
      delivery?.end ?? null,
      trackingEvent?.evidenceIds ?? [],
    ));
  } else if (!tracking && pickup && !after(pickup.start, asOf)) {
    issues.push(issue(
      'tracking_missing', 'high',
      `${execution.loadId} reached its pickup window without a tracking observation.`,
      'Pull telematics or obtain a carrier status event; absence is not on-time evidence.',
      pickup.start,
      communication?.envelope.sourceEvidenceIds ?? execution.evidenceIds,
    ));
  } else if (trackingEvent && tracking !== 'delivered') {
    const staleAt = addMinutes(trackingEvent.knownAt, policy.trackingStaleMinutes);
    if (after(asOf, staleAt)) {
      issues.push(issue(
        'tracking_stale', 'high',
        `${execution.loadId} tracking has not been updated since ${trackingEvent.knownAt}.`,
        'Refresh the carrier/telematics observation and preserve the provider event identity.',
        staleAt,
        trackingEvent.evidenceIds,
      ));
    }
  }

  if (tracking === 'delivered' && operation.phase === 'outcome_pending' && trackingEvent) {
    const settlementDue = addMinutes(trackingEvent.occurredAt, policy.settlementGraceMinutes);
    issues.push(issue(
      'settlement_pending', after(asOf, settlementDue) ? 'high' : 'medium',
      `${execution.loadId} is delivered but operational and financial outcomes are not captured.`,
      'Capture POD, transit/dwell, carrier invoice, accessorials, rejection/damage, and gross margin.',
      settlementDue,
      trackingEvent.evidenceIds,
    ));
  }
  return issues;
}

function projectLoad(
  operation: LoadOperationSnapshot,
  communication: CarrierCommunicationSnapshot | null,
  asOf: ISODateTime,
  policy: ControlTowerPolicy,
): ControlTowerLoad {
  const decision = latest(operation.decisionEntries, 'decision_recorded');
  const execution = latest(operation.decisionEntries, 'execution_started');
  const selected = selectedAlternative(operation);
  const pickup = parseWindow(fieldText(operation, 'pickupWindow'));
  const delivery = parseWindow(fieldText(operation, 'deliveryWindow'));
  const trackingEvent = communication ? [...communication.carrierEvents].reverse()
    .find(event => event.eventKind === 'tracking') : undefined;
  const issues = sortIssues([
    ...phaseIssues(operation),
    ...communicationIssues(operation, communication, asOf, policy, pickup, delivery),
  ]);
  const nextAction = issues[0] ?? null;
  return Object.freeze({
    operationId: operation.operationId,
    loadId: execution?.loadId ?? null,
    episodeId: operation.episodeId,
    actionId: decision?.selectedActionId ?? null,
    carrierId: selected?.alternative.carrierId ?? communication?.envelope.carrierId ?? null,
    laneId: selected?.alternative.laneId ?? communication?.envelope.laneId ?? null,
    route: Object.freeze({
      origin: fieldText(operation, 'origin'),
      destination: fieldText(operation, 'destination'),
      equipment: fieldText(operation, 'equipment'),
    }),
    timing: Object.freeze({
      pickupWindow: pickup,
      deliveryWindow: delivery,
      dispatchedAt: execution?.startedAt ?? null,
      lastTrackingOccurredAt: trackingEvent?.occurredAt ?? null,
      lastTrackingKnownAt: trackingEvent?.knownAt ?? null,
    }),
    state: Object.freeze({
      operationPhase: operation.phase,
      authorization: selected?.authorization?.decision ?? (decision ? 'pending' : 'not_selected'),
      tenderDelivery: communication?.deliveryState ?? 'not_created',
      acknowledgement: communication?.acknowledgement ?? 'not_created',
      tracking: communication?.latestTrackingStatus ?? null,
      outcomeCaptured: operation.phase === 'outcome_captured',
    }),
    economics: Object.freeze({
      quotedCost: selected?.alternative.quotedCost ?? null,
      carrierInvoice: metric(operation.decisionEntries, 'carrier_invoice'),
      grossMargin: metric(operation.decisionEntries, 'gross_margin'),
    }),
    attentionLevel: nextAction?.severity ?? 'none',
    nextAction,
    issues,
  });
}

function loadDeadline(load: ControlTowerLoad): number {
  return load.nextAction?.deadlineAt
    ? Date.parse(load.nextAction.deadlineAt)
    : load.timing.pickupWindow
      ? Date.parse(load.timing.pickupWindow.start)
      : Number.POSITIVE_INFINITY;
}

function portfolio(loads: readonly ControlTowerLoad[]): ControlTowerPortfolio {
  return Object.freeze({
    totalLoads: loads.length,
    activeLoads: loads.filter(load => !load.state.outcomeCaptured).length,
    completedLoads: loads.filter(load => load.state.outcomeCaptured).length,
    needingAttention: loads.filter(load => load.nextAction !== null).length,
    critical: loads.filter(load => load.attentionLevel === 'critical').length,
    high: loads.filter(load => load.attentionLevel === 'high').length,
    inMotion: loads.filter(load => ['picked_up', 'in_transit', 'arrived'].includes(load.state.tracking ?? '')).length,
    awaitingSettlement: loads.filter(load => load.issues.some(item => item.code === 'settlement_pending')).length,
  });
}

export function buildControlTowerSnapshot(
  operations: readonly LoadOperationSnapshot[],
  communications: readonly CarrierCommunicationSnapshot[],
  asOf: ISODateTime,
  policy: ControlTowerPolicy = DEFAULT_CONTROL_TOWER_POLICY,
): ControlTowerResult {
  if (!Number.isFinite(Date.parse(asOf)) || !validPolicy(policy)) {
    return refusal(
      'CONTROL_TOWER_REQUEST_INVALID',
      'Control-tower clock or policy is invalid.',
      'Supply an ISO asOf time and non-negative bounded operational grace periods.',
    );
  }
  const operationById = new Map(operations.map(operation => [operation.operationId, operation]));
  const byOperation = new Map<string, CarrierCommunicationSnapshot>();
  for (const communication of communications) {
    const operation = operationById.get(communication.envelope.operationId);
    if (!operation) {
      return refusal(
        'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
        `Communication ${communication.envelope.messageId} names an unknown operation.`,
        'Restore matching journal generations; do not operate from an orphan carrier record.',
      );
    }
    const execution = latest(operation.decisionEntries, 'execution_started');
    const selected = selectedAlternative(operation);
    if (!execution || !selected ||
        execution.loadId !== communication.envelope.loadId ||
        execution.actionId !== communication.envelope.actionId ||
        selected.alternative.carrierId !== communication.envelope.carrierId ||
        selected.alternative.laneId !== communication.envelope.laneId) {
      return refusal(
        'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
        `Communication ${communication.envelope.messageId} does not match the immutable dispatch binding.`,
        'Quarantine the projection and restore matching operation and communication journals before dispatching.',
      );
    }
    if (byOperation.has(communication.envelope.operationId)) {
      return refusal(
        'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE',
        `More than one communication projection names ${communication.envelope.operationId}.`,
        'Repair the communication projection; one immutable dispatch may have one joined snapshot.',
      );
    }
    byOperation.set(communication.envelope.operationId, communication);
  }
  const projected = operations.map(operation =>
    projectLoad(operation, byOperation.get(operation.operationId) ?? null, asOf, policy));
  const loads = Object.freeze(projected.sort((left, right) =>
    SEVERITY_RANK[right.attentionLevel] - SEVERITY_RANK[left.attentionLevel] ||
    loadDeadline(left) - loadDeadline(right) ||
    left.operationId.localeCompare(right.operationId)));
  return Object.freeze({
    kind: 'control_tower_snapshot' as const,
    asOf,
    policy: Object.freeze({ ...policy }),
    portfolio: portfolio(loads),
    loads,
  });
}

export class FreightControlTower {
  constructor(
    private readonly operations: OperationsReader,
    private readonly communications: CommunicationsReader,
  ) {}

  async read(
    asOf: ISODateTime,
    policy: ControlTowerPolicy = DEFAULT_CONTROL_TOWER_POLICY,
  ): Promise<ControlTowerResult> {
    const [operations, communications] = await Promise.all([
      this.operations.list(),
      this.communications.list(),
    ]);
    if (isLoadOperationRefusal(operations)) {
      return refusal(
        'CONTROL_TOWER_OPERATIONS_UNAVAILABLE', operations.detail,
        `Restore/read the operations journal before opening the tower. ${operations.remedy}`,
      );
    }
    if (isCarrierCommunicationRefusal(communications)) {
      return refusal(
        'CONTROL_TOWER_COMMUNICATIONS_UNAVAILABLE', communications.detail,
        `Restore/read the communication journal before opening the tower. ${communications.remedy}`,
      );
    }
    return buildControlTowerSnapshot(operations, communications, asOf, policy);
  }
}
