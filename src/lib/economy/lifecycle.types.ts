// src/lib/economy/lifecycle.types.ts
//
// PAYLOAD LOAD LIFECYCLE — the primitive with no analogue in the commodity tree.
//
// A commodity flow has a PERIOD. A load has a LIFECYCLE, and the transition
// itself is the fact worth recording: when it happened, when we learned of it,
// and whether those are the same kind of knowledge.
//
// Built as a SIDECAR, on the notary precedent: it imports two bare scalar
// aliases from `./types`, touches no `EconomyState` array, registers nothing,
// and holds no module-level mutable state. Nothing in the commodity vertical
// can break because nothing shared is read or written.

import type { ISODateTime } from './types';
import type { Attestation } from './attestation';

// ─────────────────────────────────────────────────────────────────────────────
// 1. States, and the transition table that IS the invariant
// ─────────────────────────────────────────────────────────────────────────────

export type LoadState =
  | 'booked' | 'tendered' | 'accepted' | 'dispatched'
  | 'at_origin' | 'loading' | 'loaded' | 'in_transit'
  | 'at_border' | 'at_destination' | 'unloading' | 'delivered'
  | 'cancelled' | 'refused' | 'exception';

export const ALL_LOAD_STATES: readonly LoadState[] = [
  'booked', 'tendered', 'accepted', 'dispatched',
  'at_origin', 'loading', 'loaded', 'in_transit',
  'at_border', 'at_destination', 'unloading', 'delivered',
  'cancelled', 'refused', 'exception',
];

/** Nothing follows these. A terminal state accepts no transition at all. */
export const TERMINAL_STATES: ReadonlySet<LoadState> =
  new Set<LoadState>(['delivered', 'cancelled', 'refused']);

/**
 * The states a load can be IN while work is outstanding — everything that is
 * neither terminal nor the exception condition itself.
 */
export const OPERATIONAL_STATES: readonly LoadState[] =
  ALL_LOAD_STATES.filter(s => s !== 'exception' && !TERMINAL_STATES.has(s));

/**
 * THE TRANSITION TABLE IS THE INVARIANT.
 *
 * `booked → delivered` cannot be constructed. Not because a guard rejects it
 * downstream, but because it is not in the table, and `applyTransition` refuses
 * anything absent from it.
 *
 * `exception` is reachable from EVERY operational state and exits back to the
 * one it interrupted, because an exception is a CONDITION, not a position in
 * the sequence. A load in exception has not moved backwards; something has
 * happened to it where it stands.
 */
export const TRANSITIONS: Readonly<Record<LoadState, readonly LoadState[]>> = Object.freeze({
  booked: ['tendered', 'cancelled', 'exception'],
  tendered: ['accepted', 'refused', 'cancelled', 'exception'],
  accepted: ['dispatched', 'cancelled', 'exception'],
  dispatched: ['at_origin', 'cancelled', 'exception'],
  at_origin: ['loading', 'cancelled', 'exception'],
  loading: ['loaded', 'exception'],
  loaded: ['in_transit', 'exception'],
  in_transit: ['at_border', 'at_destination', 'exception'],
  at_border: ['in_transit', 'at_destination', 'exception'],
  at_destination: ['unloading', 'exception'],
  unloading: ['delivered', 'exception'],
  // Terminal: nothing follows.
  delivered: [],
  cancelled: [],
  refused: [],
  // Exception exits back to whatever it interrupted; the engine supplies that.
  exception: OPERATIONAL_STATES,
});

export const ILLEGAL_TRANSITION = 'ILLEGAL_TRANSITION';

export class IllegalTransition extends Error {
  readonly code = ILLEGAL_TRANSITION;
  constructor(readonly from: LoadState, readonly to: LoadState, readonly legal: readonly LoadState[]) {
    super(
      `${ILLEGAL_TRANSITION}: ${from} → ${to} is not a transition this lifecycle has. ` +
      `Legal from ${from}: ${legal.length ? legal.join(', ') : '(none — terminal state)'}. ` +
      'If the world really did this, the table is wrong and should be changed deliberately — ' +
      'not bypassed.',
    );
    this.name = 'IllegalTransition';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Dual dating — when it happened, and when we learned
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How we came to have `occurredAt`.
 *
 * `observed` — a party reported the event with its own time.
 * `inferred` — WE derived it (a geofence crossing, a status backfill, a guess
 *              from the next event). Our own reconstruction.
 */
export type OccurredAtBasis = 'observed' | 'inferred';

export interface Transition {
  loadId: string;
  from: LoadState | null;      // null for the first transition into `booked`
  to: LoadState;
  /** When the world moved. */
  occurredAt: ISODateTime;
  /** Whether that instant was observed or reconstructed by us. */
  occurredAtBasis: OccurredAtBasis;
  /** When WE first learned. Never reconstructible after the fact. */
  firstReportedAt: ISODateTime;
  reportedBy: string;
  /** The state an exception interrupted, so it knows where to return. */
  interrupted?: LoadState;
  note?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. State reading — three-valued, because silence is not a state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a load may sit in a state before silence stops being informative.
 *
 * PER STATE, because the states are not alike: a truck in transit that has not
 * pinged in four hours is a different fact from one at a border for two. A
 * single global cadence would make one of those noise and the other invisible.
 *
 * Terminal states are absent deliberately — nothing further is expected, so
 * silence there is the correct and permanent condition, not staleness.
 */
export const STATE_CADENCE_SECONDS: Readonly<Partial<Record<LoadState, number>>> = Object.freeze({
  booked: 24 * 3600,
  tendered: 4 * 3600,
  accepted: 12 * 3600,
  dispatched: 6 * 3600,
  at_origin: 3 * 3600,
  loading: 2 * 3600,
  loaded: 2 * 3600,
  in_transit: 4 * 3600,
  at_border: 2 * 3600,
  at_destination: 3 * 3600,
  unloading: 2 * 3600,
  exception: 1 * 3600,
});

export type StateReading =
  | { kind: 'known'; state: LoadState; asOf: ISODateTime }
  | {
      kind: 'unobserved';
      /** What it WAS. Not what it is. */
      lastKnownState: LoadState;
      lastSeenAt: ISODateTime;
      staleForSeconds: number;
      cadenceSeconds: number;
      remedy: string;
    }
  | { kind: 'no_history'; remedy: string };

// ─────────────────────────────────────────────────────────────────────────────
// 4. The exception gate — evidence AND materiality AND actionability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SUPPRESSION IS RETURNED, NOT PERFORMED IN SILENCE.
 *
 * The commodity programme measured an alert detector into a `not ready`
 * verdict, and the finding was that statistical unusualness alone teaches
 * operators to dismiss the queue. So an exception fires only with all three
 * conditions — and a suppressed one is a RECORD, because a detector suppressing
 * everything is exactly as informative as one firing constantly and neither is
 * visible if suppression is a silent `return`.
 */
export type SuppressionReason =
  | 'no_evidence'
  | 'below_materiality'
  | 'no_action_available'
  | 'rate_limited';

export const ALL_SUPPRESSION_REASONS: readonly SuppressionReason[] = [
  'no_evidence', 'below_materiality', 'no_action_available', 'rate_limited',
];

export interface ExceptionCandidate {
  loadId: string;
  kind: string;
  /**
   * Records supporting it. An exception citing none is an assertion.
   *
   * Each record CARRIES ITS OWN attestation rather than the gate assuming one.
   * The first version of this synthesised `reported/self_reported` for every
   * record, which is a hardcoded claim about sources it has never seen: a
   * customs feed and a driver's text message are not the same evidence, and a
   * gate that flattens them decides materiality on a class it invented.
   */
  evidence: readonly { recordId: string; note: string; attestation: Attestation }[];
  /** What is at stake, in integer MINOR units (cents). Null = not established. */
  materialityMinor: number | null;
  currency: string;
  /** What an operator could actually do. Empty means this is a notification. */
  actions: readonly string[];
  /**
   * Minutes ahead of other reporting. NEGATIVE means behind, and that is stated
   * rather than hidden — it is the number that decides whether a copilot is
   * worth building.
   */
  leadMinutes: number;
  detectedAt: ISODateTime;
}

export interface ExceptionPolicy {
  policyId: string;
  materialityFloorMinor: number;
  currency: string;
  /** Per-load daily cap. Past it the load needs a human, not more alerts. */
  maxPerLoadPerDay: number;
}

export type ExceptionVerdict =
  | {
      status: 'fired';
      loadId: string;
      kind: string;
      attestation: Attestation;
      leadMinutes: number;
      renderedClaim: string;
    }
  | {
      status: 'suppressed';
      loadId: string;
      kind: string;
      reason: SuppressionReason;
      explanation: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// 5. Downstream impact — the computation the dispatcher has not done
// ─────────────────────────────────────────────────────────────────────────────

export interface DownstreamLoad {
  loadId: string;
  /** Slack before this load's plan is threatened. Null = NOT KNOWN. */
  bufferMinutes: number | null;
  /** Is there a planned arrival to breach at all? */
  hasAppointment: boolean;
  /**
   * Cost if the appointment is missed, in integer MINOR units, INSEPARABLE from
   * its evidence class. Null = unknown, which is the only way to express an
   * unknown cost — there is no way to supply a number without saying where it
   * came from.
   */
  contribution: { minor: number; attestation: Attestation } | null;
}

/** Why a load's dollar risk could not be assessed. Never silently zero. */
export type UnassessedReason =
  | 'contribution_unknown'
  | 'no_appointment';

export interface LoadImpact {
  loadId: string;
  /** Delay reaching this load after the upstream buffer chain. */
  delayMinutes: number;
  /**
   * How `bufferMinutes` was obtained. `assumed_zero` is a STATED CONSERVATIVE
   * ASSUMPTION, not a measurement: an unknown buffer is treated as absorbing
   * nothing, because assuming it absorbs is the direction that surprises a
   * dispatcher at the dock.
   */
  bufferBasis: 'known' | 'assumed_zero';
  /**
   * THREE-VALUED. `null` means there is no appointment to breach — which is not
   * the same as an appointment that is met.
   */
  breachesAppointment: boolean | null;
  /** Dollars at risk, or null with the reason recorded in `unassessed`. */
  atRiskMinor: number | null;
  /** The class of the figure above. Null when there is no figure. */
  attestation: Attestation | null;
}

export interface DownstreamImpact {
  originDelayMinutes: number;
  currency: string;
  assessed: LoadImpact[];
  /** Every load whose risk is NOT in the total, with why. */
  unassessed: Array<{ loadId: string; reason: UnassessedReason; impact: LoadImpact }>;
  /**
   * The sum over `assessed` ONLY. An unknown contribution is not zero, so it is
   * not added; it is carried in `unassessed` where a dispatcher can see the
   * total is a floor rather than a figure.
   */
  totalAtRiskMinor: number;
  /**
   * NULL when no load was assessed — a zero total over zero assessed loads is
   * vacuous, not clean, and `combineAttestations([])` refuses for the same
   * reason one level down.
   */
  attestation: Attestation | null;
  renderedClaim: string;
}
