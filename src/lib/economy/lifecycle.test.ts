import { describe, it, expect } from 'vitest';
import {
  legalFrom, isLegalTransition, applyTransition, resolveException,
  detectionLatencySeconds, readState, evaluateException, renderLead, downstreamImpact,
} from './lifecycle';
import {
  ALL_LOAD_STATES, OPERATIONAL_STATES, TERMINAL_STATES, TRANSITIONS,
  STATE_CADENCE_SECONDS, ALL_SUPPRESSION_REASONS, IllegalTransition,
  type Transition, type ExceptionCandidate, type ExceptionPolicy,
  type DownstreamLoad, type SuppressionReason,
} from './lifecycle.types';
import { isAdmissible, attestationOf } from './attestation';

const NOW = '2026-08-31T12:00:00.000Z';

/** A carrier reporting on its own load is describing itself. */
const CARRIER_SAYS = attestationOf('reported', 'medium', 'self_reported', 'carrier status update');
/** A shipper stating what a missed appointment costs them is stating a claim basis. */
const SHIPPER_CLAIMS = attestationOf('reported', 'medium', 'negotiating_position', 'shipper-stated appointment cost');
const t = (over: Partial<Transition> = {}): Transition => ({
  loadId: 'L-1', from: 'loaded', to: 'in_transit',
  occurredAt: '2026-08-31T11:00:00.000Z', occurredAtBasis: 'observed',
  firstReportedAt: '2026-08-31T11:05:00.000Z', reportedBy: 'carrier-a', ...over,
});

// ── L1 ───────────────────────────────────────────────────────────────────────
describe('L1 — the transition table is the invariant', () => {
  it('booked → delivered cannot be constructed', () => {
    expect(() => applyTransition('booked', 'delivered')).toThrow(IllegalTransition);
  });

  it('the refusal names what IS legal, and says to change the table not bypass it', () => {
    try {
      applyTransition('booked', 'delivered');
      throw new Error('should have thrown');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).toContain('booked → delivered');
      expect(m).toContain('tendered');            // what is actually legal
      expect(m).toContain('not bypassed');        // asserted against the real string
      expect(m).toContain('changed deliberately');
    }
  });

  it('terminal states accept nothing at all', () => {
    for (const s of TERMINAL_STATES) {
      expect(legalFrom(s), `${s} should be terminal`).toEqual([]);
      for (const to of ALL_LOAD_STATES) {
        expect(isLegalTransition(s, to), `${s} → ${to}`).toBe(false);
      }
    }
  });

  it('every state in the table is a declared state — no orphans either way', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...ALL_LOAD_STATES].sort());
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      for (const to of tos) {
        expect(ALL_LOAD_STATES, `${from} → ${to} targets an undeclared state`).toContain(to);
      }
    }
  });

  it('every non-terminal state can reach a terminal one — no trap states', () => {
    // A state with no path to termination is a load that can never close.
    const reach = (start: string): boolean => {
      const seen = new Set<string>(); const stack = [start];
      while (stack.length) {
        const s = stack.pop()!;
        if (TERMINAL_STATES.has(s as never)) return true;
        if (seen.has(s)) continue;
        seen.add(s);
        stack.push(...TRANSITIONS[s as keyof typeof TRANSITIONS]);
      }
      return false;
    };
    for (const s of ALL_LOAD_STATES) {
      if (TERMINAL_STATES.has(s)) continue;
      expect(reach(s), `${s} cannot reach a terminal state`).toBe(true);
    }
  });
});

// ── L2 ───────────────────────────────────────────────────────────────────────
describe('L2 — exception is a condition, not a position', () => {
  it('is reachable from every operational state', () => {
    for (const s of OPERATIONAL_STATES) {
      expect(isLegalTransition(s, 'exception'), `${s} → exception`).toBe(true);
    }
  });

  it('exits back to the state it interrupted', () => {
    expect(resolveException(t({ to: 'exception', interrupted: 'at_border' }))).toBe('at_border');
  });

  it('refuses to resolve an exception that did not record what it interrupted', () => {
    expect(() => resolveException(t({ to: 'exception' })))
      .toThrow(/did not record which state it interrupted/);
  });

  it('and refuses to resolve a transition that is not an exception', () => {
    expect(() => resolveException(t({ to: 'in_transit' }))).toThrow(/not entering an exception/);
  });

  it('terminal states cannot enter exception — nothing is left to interrupt', () => {
    for (const s of TERMINAL_STATES) expect(isLegalTransition(s, 'exception')).toBe(false);
  });
});

// ── L3 ───────────────────────────────────────────────────────────────────────
describe('L3 — latency refuses to measure our inference against itself', () => {
  it('an observed occurrence yields the real gap', () => {
    expect(detectionLatencySeconds(t())).toBe(300);
  });

  it('an INFERRED occurrence yields null, not a flattering number', () => {
    // An occurredAt we derived sits close to the report we derived it from, so
    // the gap would measure the estimator and wear the label of warning time.
    expect(detectionLatencySeconds(t({ occurredAtBasis: 'inferred' }))).toBeNull();
  });

  it('and the inferred case is not merely zero — the two are distinguishable', () => {
    const simultaneous = t({ firstReportedAt: '2026-08-31T11:00:00.000Z' });
    expect(detectionLatencySeconds(simultaneous)).toBe(0);
    expect(detectionLatencySeconds(t({ occurredAtBasis: 'inferred' }))).toBeNull();
    expect(detectionLatencySeconds(simultaneous)).not.toBeNull();
  });
});

// ── L4 ───────────────────────────────────────────────────────────────────────
describe('L4 — silence is not a state', () => {
  it('eleven hours quiet in transit reads UNOBSERVED, not "in transit"', () => {
    const r = readState([t({ occurredAt: '2026-08-31T01:00:00.000Z' })], NOW);
    expect(r.kind).toBe('unobserved');
    if (r.kind === 'unobserved') {
      expect(r.lastKnownState).toBe('in_transit');
      expect(r.staleForSeconds).toBe(11 * 3600);
      expect(r.remedy).toContain('WAS in_transit');
      expect(r.remedy).toContain('Check in with the carrier');
    }
  });

  it('inside the cadence it reads known', () => {
    const r = readState([t({ occurredAt: '2026-08-31T09:00:00.000Z' })], NOW);
    expect(r.kind).toBe('known');
  });

  it('cadence is PER STATE — at_border goes unobserved where in_transit would not', () => {
    const at = '2026-08-31T09:00:00.000Z';   // 3h ago
    expect(readState([t({ to: 'in_transit', occurredAt: at })], NOW).kind).toBe('known');
    expect(readState([t({ from: 'in_transit', to: 'at_border', occurredAt: at })], NOW).kind)
      .toBe('unobserved');
    expect(STATE_CADENCE_SECONDS.at_border).toBeLessThan(STATE_CADENCE_SECONDS.in_transit!);
  });

  it('terminal states never go unobserved — nothing further is expected', () => {
    for (const s of TERMINAL_STATES) {
      const r = readState([t({ to: s, occurredAt: '2020-01-01T00:00:00.000Z' })], NOW);
      expect(r.kind, `${s} after six years`).toBe('known');
    }
  });

  it('NO HISTORY is its own reading — a load with none is not "booked" by default', () => {
    const r = readState([], NOW);
    expect(r.kind).toBe('no_history');
    if (r.kind === 'no_history') expect(r.remedy).toContain('not `booked` by default');
  });

  it('the three readings are mutually exclusive and all reachable', () => {
    const kinds = new Set([
      readState([], NOW).kind,
      readState([t({ occurredAt: '2026-08-31T09:00:00.000Z' })], NOW).kind,
      readState([t({ occurredAt: '2026-08-31T01:00:00.000Z' })], NOW).kind,
    ]);
    expect([...kinds].sort()).toEqual(['known', 'no_history', 'unobserved']);
  });
});

// ── L5 ───────────────────────────────────────────────────────────────────────
describe('L5 — the exception gate returns its suppression', () => {
  const POLICY: ExceptionPolicy = {
    policyId: 'x@1', materialityFloorMinor: 10000, currency: 'CAD', maxPerLoadPerDay: 3,
  };
  const c = (over: Partial<ExceptionCandidate> = {}): ExceptionCandidate => ({
    loadId: 'L-1', kind: 'origin_delay',
    evidence: [{ recordId: 'R-1', note: 'carrier ETA slipped 2h', attestation: CARRIER_SAYS }],
    materialityMinor: 40000, currency: 'CAD',
    actions: ['re-sequence the next pickup'], leadMinutes: 45, detectedAt: NOW, ...over,
  });

  it('all three conditions met → fires', () => {
    const v = evaluateException(c(), POLICY, 0);
    expect(v.status).toBe('fired');
  });

  it('every suppression reason is reachable and distinct', () => {
    const seen = new Map<SuppressionReason, string>();
    const cases: Array<[Partial<ExceptionCandidate>, number]> = [
      [{ evidence: [] }, 0],
      [{ materialityMinor: 500 }, 0],
      [{ actions: [] }, 0],
      [{}, 3],
    ];
    for (const [over, fired] of cases) {
      const v = evaluateException(c(over), POLICY, fired);
      expect(v.status).toBe('suppressed');
      if (v.status === 'suppressed') seen.set(v.reason, v.explanation);
    }
    expect([...seen.keys()].sort()).toEqual([...ALL_SUPPRESSION_REASONS].sort());
    for (const [r, why] of seen) expect(why.length, `${r} has no explanation`).toBeGreaterThan(40);
  });

  it('an UNKNOWN materiality is suppressed as unknown, not treated as above the floor', () => {
    const v = evaluateException(c({ materialityMinor: null }), POLICY, 0);
    expect(v.status).toBe('suppressed');
    if (v.status === 'suppressed') {
      expect(v.reason).toBe('below_materiality');
      expect(v.explanation).toContain('has not been established');
      expect(v.explanation).toContain('not a basis for interrupting');
    }
  });

  it('suppression is a RECORD — a silent return would make the rate invisible', () => {
    // A detector suppressing everything is exactly as informative as one firing
    // constantly, and neither is visible if suppression returns nothing.
    const v = evaluateException(c({ evidence: [] }), POLICY, 0);
    expect(v).toHaveProperty('reason');
    expect(v).toHaveProperty('loadId', 'L-1');
    expect(v).toHaveProperty('kind', 'origin_delay');
  });

  it('the gate COMBINES the evidence classes rather than inventing one', () => {
    // The first version synthesised `reported/self_reported` for every record,
    // which is a hardcoded claim about sources it has never seen. A customs
    // feed and a driver's text message are not the same evidence.
    const CUSTOMS = attestationOf('reported', 'high', 'disinterested', 'border crossing record');
    const DRIVER_GUESS = attestationOf('estimated', 'low', 'self_reported', 'driver text: "maybe 2h"');
    const v = evaluateException(c({
      evidence: [
        { recordId: 'R-1', note: 'customs', attestation: CUSTOMS },
        { recordId: 'R-2', note: 'driver', attestation: DRIVER_GUESS },
      ],
    }), POLICY, 0);
    expect(v.status).toBe('fired');
    if (v.status === 'fired') {
      // WEAKEST WINS. One guess drags the customs record down rather than being
      // averaged away — a combined class that outranked its softest input would
      // be laundering.
      expect(v.attestation.evidenceClass).toBe('estimated');
      expect(v.attestation.confidence).toBe('low');
      expect(v.attestation.inputCount).toBe(2);
    }
  });

  it('a fired exception carries its attestation, and the carrier is self_reported', () => {
    const v = evaluateException(c(), POLICY, 0);
    if (v.status === 'fired') {
      expect(v.attestation.evidenceClass).toBe('reported');
      expect(v.attestation.interest).toBe('self_reported');
      expect(isAdmissible(v.attestation)).toBe(true);
    }
  });
});

// ── L6 ───────────────────────────────────────────────────────────────────────
describe('L6 — the lead is stated plainly, including when it is negative', () => {
  it('a negative lead says BEHIND and says the operator likely knows', () => {
    expect(renderLead(-30)).toBe('30 min BEHIND other reporting — the operator likely already knows');
  });

  it('positive and zero read differently', () => {
    expect(renderLead(45)).toContain('45 min AHEAD');
    expect(renderLead(0)).toContain('no lead');
  });

  it('the negative lead reaches the FIRED claim — it is not hidden on the way out', () => {
    const POLICY: ExceptionPolicy = {
      policyId: 'x@1', materialityFloorMinor: 10000, currency: 'CAD', maxPerLoadPerDay: 3,
    };
    const v = evaluateException({
      loadId: 'L-9', kind: 'origin_delay',
      evidence: [{ recordId: 'R-1', note: 'n', attestation: CARRIER_SAYS }],
      materialityMinor: 40000, currency: 'CAD',
      actions: ['call'], leadMinutes: -30, detectedAt: NOW,
    }, POLICY, 0);
    expect(v.status).toBe('fired');
    if (v.status === 'fired') {
      expect(v.renderedClaim).toContain('BEHIND other reporting');
      expect(v.leadMinutes).toBe(-30);
    }
  });
});

// ── L7 ───────────────────────────────────────────────────────────────────────
describe('L7 — downstream impact, and three refusals to guess', () => {
  const LOADS: DownstreamLoad[] = [
    { loadId: 'L-2', bufferMinutes: 30, hasAppointment: true, contribution: { minor: 40000, attestation: SHIPPER_CLAIMS } },
    { loadId: 'L-3', bufferMinutes: 0, hasAppointment: true, contribution: null },
    { loadId: 'L-4', bufferMinutes: 0, hasAppointment: false, contribution: { minor: 30000, attestation: SHIPPER_CLAIMS } },
  ];
  const r = () => downstreamImpact(120, LOADS, 'CAD');

  it('L-2 absorbs 30 of 120 and breaches at 90', () => {
    const l2 = r().assessed.find(a => a.loadId === 'L-2')!;
    expect(l2.delayMinutes).toBe(90);
    expect(l2.breachesAppointment).toBe(true);
    expect(l2.atRiskMinor).toBe(40000);
  });

  it('L-3 breaches in TIME but its money risk is UNASSESSED, not zero', () => {
    const u = r().unassessed.find(x => x.loadId === 'L-3')!;
    expect(u.reason).toBe('contribution_unknown');
    expect(u.impact.delayMinutes).toBe(90);
    expect(u.impact.breachesAppointment).toBe(true);   // known in time
    expect(u.impact.atRiskMinor).toBeNull();            // unknown in dollars
  });

  it('L-4 breachesAppointment is NULL, not false', () => {
    const u = r().unassessed.find(x => x.loadId === 'L-4')!;
    expect(u.reason).toBe('no_appointment');
    expect(u.impact.breachesAppointment).toBeNull();
    expect(u.impact.breachesAppointment).not.toBe(false);
  });

  it('the total is 400, not 700 and not 400 plus a zero', () => {
    const out = r();
    expect(out.totalAtRiskMinor).toBe(40000);
    expect(out.totalAtRiskMinor).not.toBe(70000);
    expect(out.assessed).toHaveLength(1);
    expect(out.unassessed).toHaveLength(2);
  });

  it('CONSERVATION: every input load is assessed or unassessed, never dropped', () => {
    const out = r();
    const covered = [...out.assessed.map(a => a.loadId), ...out.unassessed.map(u => u.loadId)];
    expect(covered.sort()).toEqual(LOADS.map(l => l.loadId).sort());
  });

  it('the claim says the total is a FLOOR when anything is unassessed', () => {
    expect(r().renderedClaim).toContain('FLOOR');
    expect(r().renderedClaim).toContain('L-3: contribution_unknown');
  });

  it('an unknown buffer does not absorb, and says it assumed so', () => {
    const out = downstreamImpact(120, [
      { loadId: 'L-5', bufferMinutes: null, hasAppointment: true, contribution: { minor: 10000, attestation: SHIPPER_CLAIMS } },
    ], 'CAD');
    const l5 = out.assessed[0];
    expect(l5.delayMinutes).toBe(120);            // absorbed nothing
    expect(l5.bufferBasis).toBe('assumed_zero');  // and says that is an assumption
  });

  it('a fully absorbed delay stops propagating', () => {
    const out = downstreamImpact(60, [
      { loadId: 'A', bufferMinutes: 90, hasAppointment: true, contribution: { minor: 10000, attestation: SHIPPER_CLAIMS } },
      { loadId: 'B', bufferMinutes: 0, hasAppointment: true, contribution: { minor: 99999, attestation: SHIPPER_CLAIMS } },
    ], 'CAD');
    expect(out.assessed.find(a => a.loadId === 'A')!.delayMinutes).toBe(0);
    expect(out.assessed.find(a => a.loadId === 'A')!.breachesAppointment).toBe(false);
    // B is never reached, so it is neither assessed nor unassessed — it is not
    // affected, which is a different fact from being affected by zero.
    expect([...out.assessed, ...out.unassessed].some(x => x.loadId === 'B')).toBe(false);
    expect(out.totalAtRiskMinor).toBe(0);
  });

  it('a total resting on no assessed load has a NULL attestation, not a weak one', () => {
    const out = downstreamImpact(120, [
      { loadId: 'X', bufferMinutes: 0, hasAppointment: false, contribution: null },
    ], 'CAD');
    expect(out.totalAtRiskMinor).toBe(0);
    expect(out.attestation).toBeNull();
  });

  it('a real total carries the weakest class of its inputs, and the interest is stated', () => {
    const a = r().attestation!;
    expect(a).not.toBeNull();
    // A shipper stating what a missed appointment costs them is stating the
    // basis of a claim. Calling that disinterested would launder it.
    expect(a.interest).toBe('negotiating_position');
  });
});
