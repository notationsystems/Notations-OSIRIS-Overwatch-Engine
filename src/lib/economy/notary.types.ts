//
// PAYLOAD NOTARY — verifiable condition and custody for high-value loads.
//
// The guarantee this layer provides, stated precisely so it is not overclaimed:
//
//   "These committed readings, evaluated by this stated predicate, produce this
//    verdict — checkable by a party who holds neither the readings nor trust in us."
//
// It does NOT prove the cargo was fine. A spoofed or unplugged probe produces a
// perfectly provable lie. Device attestation is a separate, harder problem and is
// carried as a SEPARATE field so the two are never conflated. See `DeviceTrust`.
//
// Economics: proving costs orders of magnitude more than computing. This layer is a
// NOTARIZATION layer invoked deliberately at a value threshold — not the substrate.
// Ordinary loads run on plain deterministic provenance; only loads clearing the
// threshold, or loads under dispute, are notarized.

import type { ISODateTime, Hash } from './types';

/**
 * A commitment posted AT THE TIME the fact existed. This is the load-bearing
 * property of the whole layer: a commitment reconstructed at claim time is an
 * expensive way to notarize a story told afterwards.
 */
export interface Commitment {
  commitmentId: string;
  /** Merkle root over the committed readings, in canonical order. */
  root: Hash;
  /** Number of leaves, so a verifier knows the set size without the set. */
  leafCount: number;
  subject: CommitmentSubject;
  coversFrom: ISODateTime;
  coversTo: ISODateTime;
  /** When the commitment itself was published. NOT reconstructible. */
  postedAt: ISODateTime;
  /** Where it was published — an anchor a third party can independently observe. */
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
  | 'temperature_c' | 'humidity_pct' | 'shock_g' | 'tilt_deg'
  | 'door_state' | 'seal_state' | 'position';

/**
 * Where the commitment is anchored so a counterparty can verify it existed at
 * `postedAt` without trusting Payload's own log.
 *
 * `internal` is honest but weak — it means "our own append-only log", which a
 * disputing party has no reason to accept. It is permitted, and it is labelled,
 * so a verdict never implies a stronger anchor than it has.
 */
export type Anchor =
  | { kind: 'internal'; logId: string }
  | { kind: 'counterparty_cosigned'; parties: string[]; signatures: string[] }
  | { kind: 'public_chain'; chain: string; txRef: string; blockTime: ISODateTime }
  | { kind: 'timestamp_authority'; tsaRef: string };

/** Strength ordering. A verdict reports the weakest anchor in its chain. */
export const ANCHOR_STRENGTH: Record<Anchor['kind'], number> = {
  internal: 0,
  counterparty_cosigned: 1,
  timestamp_authority: 2,
  public_chain: 3,
};

/**
 * A condition predicate is a STATED, VERSIONED rule. Changing a threshold changes
 * the predicate id — the model-version discipline applied to the notary.
 */
export interface ConditionPredicate {
  predicateId: string;          // e.g. 'reefer_envelope@1.0.0'
  channel: ConditionChannel;
  statement: string;            // "no reading above 8.0C or below 2.0C"
  bounds: { min?: number; max?: number };
  /** Excursion tolerance: a reading outside bounds for <= this many seconds passes. */
  toleranceSeconds: number;
  /** Max gap between readings before the interval is UNPROVEN rather than passing. */
  maxGapSeconds: number;
}

export interface CustodyPredicate {
  predicateId: string;
  statement: string;
  maxHandoffGapSeconds: number;
  requireBothSignatures: boolean;
}

/**
 * `held` / `breached` / `unproven`.
 *
 * `unproven` is the one that matters and the one a boolean would destroy: a gap in
 * the telemetry, a missing handoff signature, or a commitment posted late means the
 * predicate CANNOT BE EVALUATED — different from the load being fine and different
 * from it being spoiled.
 */
export type NotaryVerdict =
  | {
      status: 'held';
      predicateId: string;
      commitmentId: string;
      proof: ProofRef;
      anchorStrength: Anchor['kind'];
      coverage: IntervalCoverage;
      deviceTrust: DeviceTrust;
      renderedClaim: string;
    }
  | {
      status: 'breached';
      predicateId: string;
      commitmentId: string;
      proof: ProofRef;
      anchorStrength: Anchor['kind'];
      excursions: Array<{ from: ISODateTime; to: ISODateTime; extremum: number }>;
      coverage: IntervalCoverage;
      deviceTrust: DeviceTrust;
      renderedClaim: string;
    }
  | {
      status: 'unproven';
      predicateId: string;
      commitmentId: string | null;
      reason:
        | 'telemetry_gap_exceeds_max'
        | 'commitment_posted_after_the_fact'
        | 'no_commitment_for_interval'
        | 'missing_handoff_signature'
        | 'device_unattested'
        | 'proof_generation_failed'
        /** Added: the readings handed in do not reconstruct the commitment. */
        | 'readings_do_not_match_commitment';
      remedy: string;
      coverage: IntervalCoverage;
      renderedClaim: string;
    };

export interface IntervalCoverage {
  requestedFrom: ISODateTime;
  requestedTo: ISODateTime;
  /** Fraction of the requested interval covered by committed readings. NOT capped
   *  at 1: a value above 1 means readings arrived out of order or outside the
   *  interval, which is a signal about the sensor or the upload path and is
   *  surfaced rather than clamped away. */
  covered: number;
  gaps: Array<{ from: ISODateTime; to: ISODateTime }>;
  /** True when the committed readings were not in non-decreasing time order. */
  outOfOrder?: boolean;
}

/**
 * SEPARATE from the verdict, deliberately. The proof covers the computation over the
 * committed readings. Whether the device producing those readings was truthful is a
 * different question, and merging them would let a cryptographic proof launder an
 * unattested sensor.
 */
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
  /** Cost, recorded so the value threshold can be tuned against reality. */
  provingMs: number;
}

/**
 * Proving is expensive. The threshold policy decides which loads get it, and it is
 * explicit config rather than a judgement call at dispatch time.
 */
export interface NotaryPolicy {
  policyId: string;
  valueThreshold: { amount: number; currency: string };
  alwaysNotarize: string[];
  custodyRequired: string[];
  notarizeOnDispute: boolean;
}

/**
 * THREE STATES, BECAUSE THE BOOLEAN WAS THE BUG.
 *
 * Two reviews disagreed about `requiresNotary` returning false on a
 * cross-currency value, and both were right about their half:
 *
 *   - Returning FALSE silently leaves a possibly high-value load
 *     unnotarized, and the cost of that surfaces as a claim.
 *   - Returning TRUE asserts the threshold was cleared when nothing
 *     compared it, which is a silent conversion at an unstated rate.
 *
 * The disagreement was not about which answer is right. It was that a
 * boolean has no room for the true one: 80,000 USD against a 50,000 CAD
 * threshold is UNDETERMINED — comparing them needs a rate and a date this
 * function does not have. That is the same collapse `NotaryVerdict` refuses
 * with held/breached/unproven, appearing one layer down in the policy that
 * decides whether to evaluate at all.
 *
 * So the caller decides, with the reason in hand, and neither failure is
 * silent.
 */
export type NotaryRequirement =
  | { required: true; reason: string }
  | { required: false; reason: string }
  | { required: 'undetermined'; reason: string; remedy: string };

export function notaryRequirement(
  policy: NotaryPolicy,
  load: { declaredValue?: { amount: number; currency: string }; commodityClass?: string },
): NotaryRequirement {
  if (load.commodityClass && policy.alwaysNotarize.includes(load.commodityClass)) {
    return { required: true, reason: `commodity class ${load.commodityClass} is always notarized` };
  }
  const v = load.declaredValue;
  if (!v) {
    return {
      required: 'undetermined',
      reason: 'no declared value. An unknown value is not a value below the threshold.',
      remedy: 'obtain the declared value, or notarize by default if the lane warrants it.',
    };
  }
  if (v.currency !== policy.valueThreshold.currency) {
    return {
      required: 'undetermined',
      reason:
        `${v.amount} ${v.currency} cannot be compared with a threshold in ` +
        `${policy.valueThreshold.currency} without a rate and a date.`,
      remedy:
        `restate the declared value in ${policy.valueThreshold.currency}, or convert at a ` +
        'stated rate and date and record both. Converting silently is a commensurability ' +
        'failure with money attached.',
    };
  }
  return v.amount >= policy.valueThreshold.amount
    ? { required: true, reason: `${v.amount} ${v.currency} is at or above the threshold` }
    : { required: false, reason: `${v.amount} ${v.currency} is below the threshold` };
}

/**
 * Boolean convenience for the comparable case ONLY.
 *
 * THROWS on undetermined rather than picking a side. A caller that wants a
 * boolean must have established the basis first; one that has not gets an
 * error naming what is missing, not a default that hides it.
 */
export function requiresNotary(
  policy: NotaryPolicy,
  load: { declaredValue?: { amount: number; currency: string }; commodityClass?: string },
): boolean {
  const r = notaryRequirement(policy, load);
  if (r.required === 'undetermined') {
    throw new Error(`notary policy undetermined: ${r.reason} ${r.remedy}`);
  }
  return r.required;
}
