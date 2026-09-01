// src/lib/economy/carrierTrust.ts
//
// CARRIER TRUST — a profile, deliberately NOT a score.
//
// Fraud, double-brokering and cargo theft are the industry's largest operational
// loss vector, so the instinct to compute "carrier trust: 82" is strong. It is
// also the composite-index failure this codebase has caught repeatedly: one
// number collapses
//
//     regulator-verified fact   (authoritative)
//     our own observation       (n-dependent)
//     absence of data           (not a low value — NO value)
//
// into a figure implying precision it does not have. An 82 from four verified
// components and an 82 from one verified plus three defaults are the same number
// and different facts.
//
// So: named components each carrying its own attestation class; a three-valued
// verdict; and a composite that REFUSES rather than defaults.
//
// One line held deliberately: a trust profile must not be the SOLE basis for
// exclusion. It gates a tender; a human decides a relationship.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS MODULE HOLDS NO CLOCK
// ─────────────────────────────────────────────────────────────────────────────
//
// The supplied design injected `atPickup` — correctly, because insurance valid
// today is not insurance valid at pickup — and then read `Date.now()` for the
// new-authority window and `new Date()` for `detectedAt`. Two verdicts computed
// from the same profile minutes apart could differ, and neither would be
// reproducible in a dispute, which is the one situation this module exists for.
//
// Every freight sidecar in this tree (lifecycle, notary, authorization,
// freightWorld, simulatedProver) is clock-free by construction; this would have
// been the first regression against that property. `assessedAt` on the profile
// is now the reference instant for every time comparison.

import type { ISODateTime } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Components — each with its own warrant
// ─────────────────────────────────────────────────────────────────────────────

export type AttestationClass =
  | 'regulator_reported'    // FMCSA / provincial registry — authoritative
  | 'insurer_confirmed'     // confirmed WITH the insurer, not the carrier
  | 'self_reported'         // the carrier's own claim — a claim, not a fact
  | 'our_observation'       // our commitment/outcome record
  | 'computed'
  | 'absent';               // no data. NOT a low value.

export type ComponentValue<T> =
  | { status: 'present'; value: T; attestation: AttestationClass; asOf: ISODateTime; source: string }
  | { status: 'absent'; reason: string; remedy: string };

export type SafetyRating = 'satisfactory' | 'conditional' | 'unsatisfactory' | 'unrated';

export interface CarrierTrustProfile {
  carrierId: string;
  /** THE REFERENCE INSTANT. Every time comparison in this module is against it. */
  assessedAt: ISODateTime;

  authorityActive: ComponentValue<boolean>;
  authorityGrantedAt: ComponentValue<string>;
  insuranceValidUntil: ComponentValue<string>;
  insuranceCoverageAmount: ComponentValue<number>;
  safetyRating: ComponentValue<SafetyRating>;
  outOfServiceOpen: ComponentValue<boolean>;

  loadsRun: number;
  onTimePickupRate: ComponentValue<number>;
  onTimeDeliveryRate: ComponentValue<number>;
  rateVariancePct: ComponentValue<number>;
  claimsFiled: ComponentValue<number>;

  fraudSignals: FraudSignal[];
}

export interface FraudSignal {
  signal:
    | 'new_authority'
    | 'shared_contact_across_dots'
    | 'bol_carrier_mismatch'
    | 'certificate_insurer_divergence'
    | 'equipment_count_jump'
    | 'contact_details_changed_recently';
  severity: 'high' | 'medium' | 'low';
  /** What was actually OBSERVED. Never the inference — the observable. */
  observed: string;
  evidenceIds: string[];
  detectedAt: ISODateTime;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The verdict — three-valued, per-component, never a number
// ─────────────────────────────────────────────────────────────────────────────

export type TrustVerdict =
  | {
      status: 'cleared';
      basis: Array<{ component: string; attestation: AttestationClass }>;
      /** The weakest class in the basis. It travels with the verdict. */
      weakestAttestation: AttestationClass;
      observationCount: number;
      /** Whether behavioural components were used, and if not, why not. */
      behaviourUsed: boolean;
      validUntil: ISODateTime;
      notes: string[];
      renderedClaim: string;
    }
  | {
      status: 'blocked';
      blockedBy: string;
      observed: string;
      evidenceIds: string[];
      renderedClaim: string;
    }
  | {
      status: 'undetermined';
      missing: string[];
      remedy: string;
      renderedClaim: string;
    };

/**
 * THE OBSERVATION FLOOR, DEFINED ONCE.
 *
 * The supplied design carried two: `minObservationsForBehaviour: 8` in the trust
 * policy, and `floor = 10` as a default parameter in the response assessor. Both
 * answer the same question — how many observations before a rate about a carrier
 * is a fact rather than noise — and its own report quoted both, saying "below the
 * 8 floor" in the prose and "floor 10" in the run output.
 *
 * A carrier with 9 loads then sits on both sides at once: behavioural components
 * enter the trust basis, and the response profile is withheld. Two lists of one
 * fact drift, and they drift silently because each reads as internally
 * consistent. One constant, imported by both.
 */
export const MIN_OBSERVATIONS = 10;

export interface TrustPolicy {
  minInsuranceCoverage: number;
  minInsuranceCurrency: string;
  /** Authority younger than this is a reincarnation RISK, not a disqualification. */
  newAuthorityDays: number;
  minObservationsForBehaviour: number;
  blockingSignals: FraudSignal['signal'][];
  verdictValidSeconds: number;
}

export const DEFAULT_TRUST_POLICY: TrustPolicy = {
  minInsuranceCoverage: 100_000,
  minInsuranceCurrency: 'CAD',
  newAuthorityDays: 180,
  minObservationsForBehaviour: MIN_OBSERVATIONS,
  blockingSignals: ['bol_carrier_mismatch', 'certificate_insurer_divergence'],
  verdictValidSeconds: 24 * 3600,
};

const REQUIRED = [
  'authorityActive', 'insuranceValidUntil', 'insuranceCoverageAmount',
  'safetyRating', 'outOfServiceOpen',
] as const;

const CLASS_ORDER: AttestationClass[] = [
  'absent', 'self_reported', 'computed', 'our_observation', 'insurer_confirmed', 'regulator_reported',
];

export function weakestClass(cs: readonly AttestationClass[]): AttestationClass {
  if (!cs.length) {
    throw new Error(
      'carrierTrust: weakestClass over an empty basis. A verdict resting on nothing is not a ' +
      'strong verdict, and returning the strongest class for it would say the opposite.',
    );
  }
  return cs.reduce((w, c) => (CLASS_ORDER.indexOf(c) < CLASS_ORDER.indexOf(w) ? c : w), 'regulator_reported');
}

export function assessTrust(
  p: CarrierTrustProfile,
  atPickup: ISODateTime,
  policy: TrustPolicy = DEFAULT_TRUST_POLICY,
): TrustVerdict {
  // 1. Blocking fraud signals first — these are facts, not weights.
  for (const s of p.fraudSignals) {
    if (policy.blockingSignals.includes(s.signal)) {
      return {
        status: 'blocked', blockedBy: s.signal, observed: s.observed, evidenceIds: s.evidenceIds,
        renderedClaim:
          `BLOCKED — ${s.signal.replace(/_/g, ' ')}: ${s.observed}. An observation from ` +
          `${s.evidenceIds.length} record(s), not a score.`,
      };
    }
  }

  // 2. Missing required components → undetermined. Absence is a TASK.
  const missing = REQUIRED.filter(k => {
    const c = p[k] as ComponentValue<unknown> | undefined;
    return !c || c.status === 'absent';
  });
  if (missing.length) {
    return {
      status: 'undetermined', missing: [...missing],
      remedy:
        `Cannot assess ${p.carrierId}: ${missing.join(', ')} absent. Obtain before tendering. ` +
        'An absent component is NOT a low value — it is an unanswered question.',
      renderedClaim: `UNDETERMINED — ${missing.length} required component(s) absent: ${missing.join(', ')}.`,
    };
  }

  const present = <T,>(k: typeof REQUIRED[number]) =>
    p[k] as Extract<ComponentValue<T>, { status: 'present' }>;

  // 3. Hard disqualifiers, each naming what was observed.
  const auth = present<boolean>('authorityActive');
  if (auth.value !== true) {
    return { status: 'blocked', blockedBy: 'authorityActive',
      observed: `authority not active per ${auth.source} as of ${auth.asOf}`, evidenceIds: [auth.source],
      renderedClaim: `BLOCKED — operating authority not active (${auth.source}, ${auth.asOf}).` };
  }
  const oos = present<boolean>('outOfServiceOpen');
  if (oos.value === true) {
    return { status: 'blocked', blockedBy: 'outOfServiceOpen',
      observed: `open out-of-service order per ${oos.source}`, evidenceIds: [oos.source],
      renderedClaim: `BLOCKED — open out-of-service order (${oos.source}).` };
  }
  const rating = present<SafetyRating>('safetyRating');
  if (rating.value === 'unsatisfactory') {
    return { status: 'blocked', blockedBy: 'safetyRating',
      observed: `unsatisfactory rating per ${rating.source}`, evidenceIds: [rating.source],
      renderedClaim: `BLOCKED — unsatisfactory safety rating (${rating.source}).` };
  }

  // 4. Insurance valid AT PICKUP, not merely today. The knownAt distinction where
  //    getting it wrong is a liability rather than a reporting error.
  const ins = present<string>('insuranceValidUntil');
  if (Date.parse(ins.value) <= Date.parse(atPickup)) {
    return {
      status: 'blocked', blockedBy: 'insuranceValidUntil',
      observed: `coverage expires ${ins.value}, pickup is ${atPickup} — valid today, NOT valid at pickup`,
      evidenceIds: [ins.source],
      renderedClaim:
        `BLOCKED — insurance expires ${ins.value}, before the ${atPickup} pickup. ` +
        'Valid now is not valid then.',
    };
  }
  const cov = present<number>('insuranceCoverageAmount');
  if (cov.value < policy.minInsuranceCoverage) {
    return { status: 'blocked', blockedBy: 'insuranceCoverageAmount',
      observed: `coverage ${cov.value} ${policy.minInsuranceCurrency} below required ${policy.minInsuranceCoverage}`,
      evidenceIds: [cov.source],
      renderedClaim:
        `BLOCKED — cargo coverage ${cov.value} below the ${policy.minInsuranceCoverage} ` +
        `${policy.minInsuranceCurrency} minimum.` };
  }

  // 5. Cleared — and the basis travels, including the weakest class in it.
  const basis: Array<{ component: string; attestation: AttestationClass }> = REQUIRED.map(k => ({
    component: k,
    attestation: (p[k] as Extract<ComponentValue<unknown>, { status: 'present' }>).attestation,
  }));

  const behaviourUsed = p.loadsRun >= policy.minObservationsForBehaviour;
  if (behaviourUsed && p.onTimeDeliveryRate.status === 'present') {
    basis.push({ component: 'onTimeDeliveryRate', attestation: p.onTimeDeliveryRate.attestation });
  }

  // NO CLOCK. `assessedAt` is the reference instant.
  const newAuth = p.authorityGrantedAt.status === 'present'
    && (Date.parse(p.assessedAt) - Date.parse(p.authorityGrantedAt.value)) / 86_400_000
       < policy.newAuthorityDays;

  const notes: string[] = [];
  if (!behaviourUsed) {
    notes.push(
      `behavioural components withheld — ${p.loadsRun} loads is below the ` +
      `${policy.minObservationsForBehaviour} floor, so on-time rates are noise`);
  }
  if (newAuth) {
    notes.push(
      `authority granted within ${policy.newAuthorityDays} days of assessment — ` +
      'reincarnation risk, not a disqualification');
  }
  for (const s of p.fraudSignals.filter(x => !policy.blockingSignals.includes(x.signal))) {
    notes.push(`${s.signal.replace(/_/g, ' ')} (${s.severity}): ${s.observed}`);
  }

  const w = weakestClass(basis.map(b => b.attestation));
  return {
    status: 'cleared',
    basis, weakestAttestation: w, observationCount: p.loadsRun, behaviourUsed,
    validUntil: new Date(Date.parse(p.assessedAt) + policy.verdictValidSeconds * 1000).toISOString(),
    notes,
    renderedClaim:
      `CLEARED on ${basis.length} components, weakest attestation ${w}` +
      (notes.length ? ` — ${notes.join('; ')}` : '') +
      `. Verdict valid ${policy.verdictValidSeconds / 3600}h from ${p.assessedAt}; re-assess before pickup.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The strongest fraud signal you own
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BOL carrier vs tendered carrier. No vendor sells this, because it is a
 * divergence between two records only you hold: who you tendered to, and who
 * actually signed. It is the double-brokering signature.
 */
export function detectBolMismatch(
  loads: readonly { loadId: string; carrierId: string; bolCarrierId: string }[],
  detectedAt: ISODateTime,
): FraudSignal[] {
  const byCarrier = new Map<string, string[]>();
  for (const l of loads) {
    if (l.bolCarrierId && l.bolCarrierId !== l.carrierId) {
      byCarrier.set(l.carrierId, [...(byCarrier.get(l.carrierId) ?? []), l.loadId]);
    }
  }
  return [...byCarrier.entries()].map(([carrierId, loadIds]) => ({
    signal: 'bol_carrier_mismatch' as const,
    severity: 'high' as const,
    observed:
      `tendered to ${carrierId}; bill of lading names a different carrier on ` +
      `${loadIds.length} load(s): ${loadIds.slice(0, 5).join(', ')}`,
    evidenceIds: [...loadIds],
    detectedAt,
  }));
}
