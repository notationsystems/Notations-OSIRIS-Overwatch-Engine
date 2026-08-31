// src/lib/economy/notary.types.ts
//
// PAYLOAD NOTARY — verifiable condition and custody for high-value loads.
//
// The guarantee, stated precisely so it is not overclaimed:
//   "These committed readings, evaluated by this stated predicate, produce this
//    verdict — checkable by a party who holds neither the readings nor trust in us."
//
// It does NOT prove the cargo was fine. A spoofed or unplugged probe produces a
// perfectly provable lie. Device attestation is a separate trust root, carried in a
// SEPARATE field so cryptography can never launder an unattested sensor.
//
// v2 — six corrections folded in:
//   1. Symmetric posting window: a pre-dated commitment must FAIL, not pass.
//   2. Integer millidegrees everywhere: a float boundary is not a circuit boundary.
//   3. Grace window is policy, recorded on the verdict, not a hidden constant.
//   4. Every unproven reason is enumerated so reachability can be asserted.
//   5. requiresNotary is three-valued: unknown value is not "below threshold".
//   6. The omission reason is KEPT in the enum — see UnprovenReason.

import type { ISODateTime, Hash } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 0. Units — integers only, so the reference and the circuit cannot diverge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All condition values are integers in thousandths of the channel's base unit:
 * millidegrees C, milli-percent RH, milli-g.
 *
 * WHY: a predicate boundary at exactly 8.0C is the reading a claims adjuster argues
 * over, and `9.1 > 8` in IEEE-754 is not necessarily what a zk circuit computes over
 * field elements. A verdict that flips between the reference implementation and the
 * proof, on precisely the boundary case that matters, is the worst available failure.
 * Integers remove the class rather than manage it.
 */
export type Milli = number;

export const MILLI = 1000;

/**
 * Convert at INGEST. Refuses a value that is not representable rather than
 * rounding it silently: 21.3504 C is not a reading the circuit can encode, and
 * accepting it produces a root that verifies against nothing.
 */
export function toMilli(v: number): Milli {
  const m = v * MILLI;
  if (!Number.isFinite(m) || Math.abs(m - Math.round(m)) > 1e-9) {
    throw new Error(
      `notary: ${v} is not representable in integer thousandths. The circuit has no floats, ` +
      'so a value it cannot encode is refused here rather than committed to a root that ' +
      'will verify against nothing.',
    );
  }
  return Math.round(m);
}

export const fromMilli = (m: Milli): number => m / MILLI;

/** Guard: a non-integer here means a float leaked past ingest. */
export function assertMilli(m: Milli, where: string): void {
  if (!Number.isInteger(m)) {
    throw new Error(
      `notary: non-integer milli value ${m} at ${where} — convert at ingest with toMilli()`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Commitments
// ─────────────────────────────────────────────────────────────────────────────

export interface Commitment {
  commitmentId: string;
  root: Hash;
  leafCount: number;
  subject: CommitmentSubject;
  coversFrom: ISODateTime;
  coversTo: ISODateTime;
  /** When published. Not reconstructible — this is the load-bearing field. */
  postedAt: ISODateTime;
  anchor: Anchor;
  postedBy: string;
  authority: string;
}

export type CommitmentSubject =
  | { kind: 'load_condition'; loadId: string; channel: ConditionChannel }
  | { kind: 'load_custody'; loadId: string }
  | { kind: 'decision_expectation'; decisionId: string }
  | { kind: 'derivation_inputs'; resultId: string };

export type ConditionChannel =
  | 'temperature_c' | 'humidity_pct' | 'shock_g'
  | 'tilt_deg' | 'door_state' | 'seal_state' | 'position';

export type Anchor =
  | { kind: 'internal'; logId: string }
  | { kind: 'counterparty_cosigned'; parties: string[]; signatures: string[] }
  | { kind: 'public_chain'; chain: string; txRef: string; blockTime: ISODateTime }
  | { kind: 'timestamp_authority'; tsaRef: string };

export const ANCHOR_STRENGTH: Record<Anchor['kind'], number> = {
  internal: 0, counterparty_cosigned: 1, timestamp_authority: 2, public_chain: 3,
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. The posting window — symmetric, configurable, recorded
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A commitment must be posted CLOSE TO the interval it covers — on BOTH sides.
 *
 * lateGrace allows clock skew and upload latency after the fact. earlyGrace is the
 * correction that matters: without a lower bound, a commitment claiming to predate its
 * own data passes trivially, and a fabricated pre-commitment yields `held`. The check
 * fails closed in both directions.
 *
 * MEASURED, not supposed. Against the one-sided check this replaces, a commitment
 * posted 2025-08-30 for readings covering 2026-08-30 — a full year before the data
 * existed — returned `postedInTime === true` and `notarizeCondition === 'held'`.
 * A commitment made before the fact existed cannot have been derived from observing
 * it, so it is evidence of fabrication rather than of honesty.
 *
 * Policy, not constants — and the applied window is recorded on the verdict, so a
 * counterparty sees which threshold was used instead of trusting a hidden default.
 */
export interface PostingWindow {
  lateGraceSeconds: number;
  earlyGraceSeconds: number;
}

export const DEFAULT_POSTING_WINDOW: PostingWindow = {
  lateGraceSeconds: 15 * 60,
  earlyGraceSeconds: 5 * 60,
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. Predicates — versioned, integer-bounded, boundary semantics stated
// ─────────────────────────────────────────────────────────────────────────────

export interface ConditionPredicate {
  predicateId: string;
  channel: ConditionChannel;
  statement: string;
  /** INTEGER milli. A float here is a defect. */
  bounds: { minMilli?: Milli; maxMilli?: Milli };
  toleranceSeconds: number;
  maxGapSeconds: number;
  /**
   * A reading exactly ON the bound is the disputed case. Whether it breaches is a
   * CONTRACT TERM, not an implementation detail, so it belongs in the predicate's
   * identity — change it and the predicateId changes.
   */
  boundaryIsBreach: boolean;
}

export interface CustodyPredicate {
  predicateId: string;
  statement: string;
  maxHandoffGapSeconds: number;
  requireBothSignatures: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Verdicts — three-valued, context-carrying
// ─────────────────────────────────────────────────────────────────────────────

/**
 * NOTE ON `readings_do_not_match_commitment`.
 *
 * This member was dropped in the supplied v2 and is RESTORED here, because it is
 * the omission attack and it is the whole reason the root is carried at all.
 *
 * Without it: a caller hands in a CURATED SUBSET of readings together with the
 * commitment built from the FULL set. Coverage, evaluation and proof all run
 * happily over the subset while the root travels along as decoration, the verdict
 * comes back `held`, and the reading that would have breached it was simply not
 * passed in. The circuit spec makes this obligation #2 — "the count of verified
 * leaves equals the committed leafCount, so a prover cannot omit the inconvenient
 * readings" — and the reference implementation IS the spec.
 *
 * A reason removed from this enum is a refusal `notarizeCondition` can no longer
 * express, and `ALL_UNPROVEN_REASONS` below would then certify reachability over a
 * set that is missing the most important member.
 */
export type UnprovenReason =
  | 'telemetry_gap_exceeds_max'
  | 'commitment_posted_after_the_fact'
  | 'commitment_predates_its_interval'
  | 'no_commitment_for_interval'
  | 'readings_do_not_match_commitment'
  | 'missing_handoff_signature'
  | 'device_unattested'
  | 'proof_generation_failed';

/** Reachability is a verdict, not an assumption. The suite asserts each is emitted. */
export const ALL_UNPROVEN_REASONS: readonly UnprovenReason[] = [
  'telemetry_gap_exceeds_max',
  'commitment_posted_after_the_fact',
  'commitment_predates_its_interval',
  'no_commitment_for_interval',
  'readings_do_not_match_commitment',
  'missing_handoff_signature',
  'device_unattested',
  'proof_generation_failed',
] as const;

export interface Excursion {
  from: ISODateTime;
  to: ISODateTime;
  extremumMilli: Milli;
}

export interface IntervalCoverage {
  requestedFrom: ISODateTime;
  requestedTo: ISODateTime;
  /**
   * Fraction of the requested interval covered by committed readings. NOT capped
   * at 1: a value above 1 means readings arrived out of order or outside the
   * interval, which is a signal about the sensor or the upload path and is
   * surfaced rather than clamped away.
   */
  covered: number;
  gaps: Array<{ from: ISODateTime; to: ISODateTime }>;
  /**
   * True when the committed readings were not in non-decreasing time order.
   *
   * Kept (the supplied v2 dropped it): sorting silently would erase the only
   * evidence that a device or upload path is misbehaving, and a device that
   * reorders its own timestamps is a device whose timestamps are worth less.
   */
  outOfOrder?: boolean;
}

export interface VerdictContext {
  postingWindow: PostingWindow;
  /** postedAt − coversTo in seconds. Negative = posted before the interval closed. */
  postingOffsetSeconds: number;
  coverage: IntervalCoverage;
}

export interface DeviceTrust {
  deviceId: string;
  attestation: 'hardware_attested' | 'carrier_asserted' | 'unattested';
  lastCalibratedAt: ISODateTime | null;
  note: string;
}

export interface ProofRef {
  system: 'sp1' | 'none';
  vkey: Hash;
  proofId: string;
  publicInputs: {
    root: Hash;
    predicateId: string;
    coversFrom: ISODateTime;
    coversTo: ISODateTime;
    verdictBit: 'held' | 'breached';
  };
  provedAt: ISODateTime;
  provingMs: number;
}

export type NotaryVerdict =
  | {
      status: 'held';
      predicateId: string; commitmentId: string;
      proof: ProofRef; anchorStrength: Anchor['kind'];
      deviceTrust: DeviceTrust; context: VerdictContext; renderedClaim: string;
    }
  | {
      status: 'breached';
      predicateId: string; commitmentId: string;
      proof: ProofRef; anchorStrength: Anchor['kind'];
      excursions: Excursion[];
      deviceTrust: DeviceTrust; context: VerdictContext; renderedClaim: string;
    }
  | {
      status: 'unproven';
      predicateId: string; commitmentId: string | null;
      reason: UnprovenReason; remedy: string;
      context: VerdictContext; renderedClaim: string;
    };

// ─────────────────────────────────────────────────────────────────────────────
// 5. Policy — three-valued, because unknown is not "below threshold"
// ─────────────────────────────────────────────────────────────────────────────

export interface NotaryPolicy {
  policyId: string;
  valueThreshold: { amount: number; currency: string };
  alwaysNotarize: string[];
  custodyRequired: string[];
  notarizeOnDispute: boolean;
  postingWindow: PostingWindow;
}

/**
 * Three outcomes, not two.
 *
 *   not_required  — CHECKED AND BELOW. A decision.
 *   undetermined  — the input needed to decide is missing. A task, not a decision.
 *
 * Collapsing them into `false` is the class-7 defect this layer names everywhere else:
 * a load of unknown value would silently skip notarization while looking identical to
 * one deliberately excluded.
 */
export type NotaryRequirement =
  | { status: 'required'; because: 'value_threshold' | 'commodity_class' | 'dispute' }
  | { status: 'not_required'; because: 'below_threshold' }
  | { status: 'undetermined'; missing: string[]; remedy: string };

export function requiresNotary(
  policy: NotaryPolicy,
  load: {
    declaredValue?: { amount: number; currency: string };
    commodityClass?: string;
    underDispute?: boolean;
  },
): NotaryRequirement {
  if (load.underDispute && policy.notarizeOnDispute) {
    return { status: 'required', because: 'dispute' };
  }
  if (load.commodityClass && policy.alwaysNotarize.includes(load.commodityClass)) {
    return { status: 'required', because: 'commodity_class' };
  }

  const v = load.declaredValue;
  if (!v) {
    return {
      status: 'undetermined',
      missing: ['declaredValue'],
      remedy: 'No declared cargo value on this load. Obtain it from the shipper before tendering — an unknown value is not a value below the threshold.',
    };
  }
  if (v.currency !== policy.valueThreshold.currency) {
    return {
      status: 'undetermined',
      missing: [`fx:${v.currency}->${policy.valueThreshold.currency}`],
      remedy: `Declared value is ${v.currency}, threshold is ${policy.valueThreshold.currency}. Supply a dated FX basis, or restate the threshold in ${v.currency}. The comparison is refused rather than converted at an unstated rate.`,
    };
  }
  return v.amount >= policy.valueThreshold.amount
    ? { status: 'required', because: 'value_threshold' }
    : { status: 'not_required', because: 'below_threshold' };
}
