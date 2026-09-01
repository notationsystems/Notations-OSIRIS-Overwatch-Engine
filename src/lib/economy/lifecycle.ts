// src/lib/economy/lifecycle.ts
//
// The lifecycle engine. Pure, clockless, and refusing in four distinct places.

import type {
  LoadState, Transition, StateReading, ExceptionCandidate, ExceptionPolicy,
  ExceptionVerdict, DownstreamLoad, DownstreamImpact, LoadImpact, UnassessedReason,
  Materiality, MaterialityFloor,
} from './lifecycle.types';
import {
  TRANSITIONS, TERMINAL_STATES, STATE_CADENCE_SECONDS, IllegalTransition,
  DEFAULT_EXCEPTION_POLICY,
} from './lifecycle.types';
import { combineAttestations, type Attestation } from './attestation';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Transitions
// ─────────────────────────────────────────────────────────────────────────────

export function legalFrom(state: LoadState): readonly LoadState[] {
  return TRANSITIONS[state];
}

export function isLegalTransition(from: LoadState, to: LoadState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Refuse anything the table does not contain.
 *
 * The error names what IS legal from that state, because a refusal that only
 * says "no" makes the table something the caller has to go and read; and it
 * says the table should be CHANGED rather than worked around, because a
 * lifecycle with an escape hatch is a lifecycle that describes nothing.
 */
export function applyTransition(from: LoadState, to: LoadState): LoadState {
  if (!isLegalTransition(from, to)) throw new IllegalTransition(from, to, TRANSITIONS[from]);
  return to;
}

/**
 * Where an exception returns to.
 *
 * An exception interrupts a state; it does not replace the sequence. The state
 * it interrupted is recorded ON the transition, so the exit is a fact rather
 * than a guess about where the load probably was.
 */
export function resolveException(t: Transition): LoadState {
  if (t.to !== 'exception') {
    throw new Error(`resolveException: ${t.loadId} is not entering an exception (to=${t.to})`);
  }
  if (!t.interrupted) {
    throw new Error(
      `resolveException: the exception on ${t.loadId} did not record which state it interrupted, ` +
      'so where it returns to cannot be established. An exception is a condition on a position, ' +
      'and without the position there is nothing to resume.',
    );
  }
  return t.interrupted;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Detection latency — refusing to measure ourselves against ourselves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long between the world moving and us learning.
 *
 * NULL WHEN `occurredAt` IS INFERRED. If we derived the occurrence time
 * ourselves, the gap between it and our report time measures OUR INFERENCE, not
 * our warning time — and it will look flattering, because an inference drawn
 * from the report tends to sit close to it. A latency computed that way is a
 * number about the estimator wearing the label of a number about the world.
 */
export function detectionLatencySeconds(t: Transition): number | null {
  if (t.occurredAtBasis !== 'observed') return null;
  return (Date.parse(t.firstReportedAt) - Date.parse(t.occurredAt)) / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. State reading — three-valued
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What state is this load in, as of `now`?
 *
 * The honest answer is often "it WAS in_transit eleven hours ago". A load that
 * has gone quiet is not in the state it last reported — it is in an unknown
 * state, and the last report is evidence about the past.
 */
export function readState(transitions: readonly Transition[], now: string): StateReading {
  if (transitions.length === 0) {
    return {
      kind: 'no_history',
      remedy:
        'This load has no recorded transitions. That is not `booked` by default — a load nobody ' +
        'has reported anything about has no established state. Record its booking, or establish ' +
        'why it exists with no history.',
    };
  }

  const sorted = [...transitions].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
  const last = sorted[sorted.length - 1];
  const state = last.to;

  // Terminal states never go unobserved: nothing further is expected, so silence
  // is the correct permanent condition rather than a gap in reporting.
  if (TERMINAL_STATES.has(state)) return { kind: 'known', state, asOf: last.occurredAt };

  const cadenceSeconds = STATE_CADENCE_SECONDS[state];
  if (cadenceSeconds === undefined) return { kind: 'known', state, asOf: last.occurredAt };

  const staleForSeconds = (Date.parse(now) - Date.parse(last.occurredAt)) / 1000;
  if (staleForSeconds <= cadenceSeconds) return { kind: 'known', state, asOf: last.occurredAt };

  const hours = (staleForSeconds / 3600).toFixed(1);
  return {
    kind: 'unobserved',
    lastKnownState: state,
    lastSeenAt: last.occurredAt,
    staleForSeconds,
    cadenceSeconds,
    remedy:
      `This load WAS ${state} ${hours}h ago and has not reported since; the cadence for ` +
      `${state} is ${(cadenceSeconds / 3600).toFixed(1)}h. Where it is now is unknown. ` +
      'Check in with the carrier before treating the last report as current position.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The exception gate
// ─────────────────────────────────────────────────────────────────────────────

/** How the lead reads, including when it is negative. */
export function renderLead(leadMinutes: number | null): string {
  // NULL IS NOT ZERO. An unknown lead is not a simultaneous one, and reporting
  // it as "no lead" would claim a measurement nobody took.
  if (leadMinutes === null) return 'lead over other reporting UNKNOWN — not measured';
  if (leadMinutes > 0) return `${leadMinutes} min AHEAD of other reporting`;
  if (leadMinutes === 0) return 'SIMULTANEOUS with other reporting — no lead';
  return `${Math.abs(leadMinutes)} min BEHIND other reporting — the operator likely already knows`;
}

/**
 * Are these two quantities comparable at all?
 *
 * The gate that preceded this compared `materiality.value` against a per-kind
 * threshold WITHOUT reading either side's measure. Demonstrated:
 *
 *   margin_erosion, measure=km,      value=150  FIRES  — 150 km clears a $100 floor
 *   appointment_at_risk, measure=$,  value=25   suppressed — $25 fails a 30-MIN floor
 *
 * Both outcomes are defensible-looking and both are wrong, which is the
 * incommensurability profile exactly: a plausible number ships and gets quoted.
 * The candidate even CARRIED its measure; nothing read it.
 */
function commensurable(m: Materiality, floor: MaterialityFloor): string | null {
  if (m.measure !== floor.measure) {
    return `materiality is in ${m.measure}, the floor for this kind is in ${floor.measure}. ` +
      'These are not the same quantity and comparing them produces a defensible-looking ' +
      'verdict that is false in either direction.';
  }
  if (m.measure === 'money_minor' && m.currency !== floor.currency) {
    return `materiality is ${m.currency}, the floor is ${floor.currency}. Comparing them ` +
      'needs a rate and a date this gate does not have, and converting silently is the ' +
      'commensurability failure with money attached.';
  }
  return null;
}

export function evaluateException(
  c: ExceptionCandidate,
  policy: ExceptionPolicy = DEFAULT_EXCEPTION_POLICY,
  firedTodayForLoad = 0,
): ExceptionVerdict {
  const base = { loadId: c.loadId, kind: c.kind };

  if (c.evidence.length === 0) {
    return {
      ...base, status: 'suppressed', reason: 'no_evidence',
      explanation:
        'This exception cites no records. An exception with no evidence is an assertion, and an ' +
        'operator cannot check it, act on it, or dispute it.',
    };
  }

  if (firedTodayForLoad >= policy.maxPerLoadPerDay) {
    return {
      ...base, status: 'suppressed', reason: 'rate_limited',
      explanation:
        `${firedTodayForLoad} exceptions already fired on this load today, at the cap of ` +
        `${policy.maxPerLoadPerDay}. A load past the cap needs a human looking at it, not more ` +
        'alerts about it.',
    };
  }

  const floor = policy.floors[c.kind];
  if (c.materiality === null) {
    return {
      ...base, status: 'suppressed', reason: 'below_materiality',
      explanation:
        'What is at stake here has not been established, so it cannot clear the materiality ' +
        'floor. Unknown is not above the floor, and it is not below it either — it is not a ' +
        'basis for interrupting an operator.',
    };
  }

  const mismatch = commensurable(c.materiality, floor);
  if (mismatch !== null) {
    return { ...base, status: 'suppressed', reason: 'incommensurable_materiality', explanation: mismatch };
  }

  if (c.materiality.value < floor.value) {
    return {
      ...base, status: 'suppressed', reason: 'below_materiality',
      explanation:
        `${c.materiality.value} ${c.materiality.measure} is below the ${floor.value} ` +
        `${floor.measure} floor for ${c.kind}. Real, and not worth interrupting an operator for.`,
    };
  }

  if (policy.requireAction && c.actions.length === 0) {
    return {
      ...base, status: 'suppressed', reason: 'no_action_available',
      explanation:
        'Nothing an operator could do about this was identified. An exception nobody can act on ' +
        'is a notification, and a queue of notifications is what teaches operators to dismiss ' +
        'the queue.',
    };
  }

  // The records carry their own classes; the gate combines and does not invent.
  // Weakest-input-wins, so one driver text message drags a customs feed down to
  // its level rather than being averaged away.
  const attestation = combineAttestations(c.evidence.map(e => e.attestation));

  return {
    ...base,
    status: 'fired',
    attestation,
    leadMinutes: c.leadMinutes,
    renderedClaim:
      `${c.kind.replace(/_/g, ' ')} on ${c.loadId}: ${c.materiality.value} ` +
      `${c.materiality.measure}${c.materiality.currency ? ` ${c.materiality.currency}` : ''} ` +
      `against a ${floor.value} ${floor.measure} floor, ` +
      `${c.actions.length} action(s) available (proposals only). ` +
      `${renderLead(c.leadMinutes)}. Based on ${c.evidence.length} record(s).`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Downstream impact
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One load slips. Which subsequent loads on that vehicle are affected, by how
 * much, and what is actually at risk in money.
 *
 * THREE REFUSALS TO GUESS, and the total is what they add up to:
 *
 *   an unknown CONTRIBUTION is unassessed, never zero — a zero would be
 *     indistinguishable in the total from a load genuinely at no risk;
 *   an unknown BUFFER does not absorb — stated as `assumed_zero`, the
 *     conservative direction, because assuming absorption is what surprises a
 *     dispatcher at the dock;
 *   a load with NO APPOINTMENT is not assumed on time — `breachesAppointment`
 *     is null, because there is no planned arrival to breach.
 *
 * A fully absorbed delay stops propagating: once the chain reaches zero the
 * loads behind it are genuinely unaffected, and saying so is not a refusal.
 */
export const MIXED_CURRENCY = 'MIXED_CURRENCY';

export function downstreamImpact(
  originDelayMinutes: number,
  loads: readonly DownstreamLoad[],
  currency: string,
): DownstreamImpact {
  // FOUND BY SELF-APPLICATION, immediately after diagnosing the same class in
  // the gate above. `contribution` carried no currency and the aggregate held
  // one, so a CAD figure and a USD figure summed into a single integer that was
  // then stamped with whichever currency the caller passed. The notary refuses
  // a cross-currency COMPARISON; this quietly performed a cross-currency SUM,
  // which is the same failure with an extra step.
  const foreign = loads
    .map(l => l.contribution)
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .filter(m => m.currency !== currency);
  if (foreign.length > 0) {
    throw new Error(
      `${MIXED_CURRENCY}: ${foreign.length} contribution(s) in ` +
      `${[...new Set(foreign.map(f => f.currency))].join(', ')} cannot be summed into a ` +
      `${currency} total. Restate them in ${currency}, or compute a total per currency. ` +
      'A sum across currencies is a number with no unit wearing the label of one.',
    );
  }
  const assessed: LoadImpact[] = [];
  const unassessed: DownstreamImpact['unassessed'] = [];
  const contributions: Attestation[] = [];

  let carried = originDelayMinutes;

  for (const l of loads) {
    if (carried <= 0) break;   // fully absorbed upstream — nothing propagates

    const bufferBasis: LoadImpact['bufferBasis'] = l.bufferMinutes === null ? 'assumed_zero' : 'known';
    const buffer = l.bufferMinutes ?? 0;
    const delayMinutes = Math.max(0, carried - buffer);

    const breachesAppointment = !l.hasAppointment ? null : delayMinutes > 0;

    const impact: LoadImpact = {
      loadId: l.loadId, delayMinutes, bufferBasis, breachesAppointment,
      atRiskMinor: null, attestation: null,
    };

    let reason: UnassessedReason | null = null;
    if (!l.hasAppointment) reason = 'no_appointment';
    else if (l.contribution === null) reason = 'contribution_unknown';

    if (reason !== null) {
      unassessed.push({ loadId: l.loadId, reason, impact });
    } else if (breachesAppointment === true) {
      // The contribution arrives WITH its class. The first version manufactured
      // `negotiating_position` for every one of them, which is a guess about a
      // source the function never sees — right for a shipper's claim basis,
      // wrong for a contractual penalty in a signed rate confirmation.
      impact.atRiskMinor = l.contribution!.minor;
      impact.attestation = l.contribution!.attestation;
      assessed.push(impact);
      contributions.push(l.contribution!.attestation);
    } else {
      // Known appointment, known contribution, and the delay was absorbed.
      impact.atRiskMinor = 0;
      impact.attestation = l.contribution!.attestation;
      assessed.push(impact);
      contributions.push(l.contribution!.attestation);
    }

    carried = delayMinutes;
  }

  const totalAtRiskMinor = assessed.reduce((n, a) => n + (a.atRiskMinor ?? 0), 0);

  // NULL, not a manufactured class. `combineAttestations([])` refuses an empty
  // input because a quantity derived from nothing has no standing to inherit,
  // and the right move here is the same refusal one level up: a zero total over
  // zero assessed loads is not a clean number, it is a vacuous one. Handing it
  // `derived/low` would give it standing by borrowing the weakest label
  // available, which is still a label.
  const attestation = contributions.length > 0 ? combineAttestations(contributions) : null;

  const floorNote = unassessed.length > 0
    ? ` ${unassessed.length} further load(s) affected in TIME whose money risk is not assessed ` +
      `(${unassessed.map(u => `${u.loadId}: ${u.reason}`).join('; ')}), so this total is a FLOOR.`
    : '';

  return {
    originDelayMinutes, currency, assessed, unassessed, totalAtRiskMinor, attestation,
    renderedClaim:
      `A ${originDelayMinutes} min origin delay reaches ${assessed.length + unassessed.length} ` +
      `downstream load(s). ${totalAtRiskMinor} ${currency} minor units at risk across ` +
      `${assessed.length} assessed load(s).${floorNote}`,
  };
}
