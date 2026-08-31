// src/lib/economy/worldRun.test.ts
//
// The end-to-end run, the authorization gate, and the simulated prover.
// Several pins here exist because THIS FILE's first run produced the defect.

import { describe, it, expect } from 'vitest';
import {
  runWorld, runDefaultWorld, renderWorldRun, analyseSeasonality,
  assessDetector, discriminationCeiling, mean, median, rateAbove,
} from './worldRun';
import { makeFreightWorld } from './freightWorld';
import {
  authorize, assertExecutable, notarizationRequired, NotAuthorized, NOT_AUTHORIZED,
  type AuthorizationRequest,
} from './authorization';
import {
  simulatedProver, isSimulatedProof, ProverDisagrees, PROVER_DISAGREES,
  SIMULATED_VKEY, simulatedProvingMs,
} from './simulatedProver';
import { toMilli } from './notary.types';
import type { ConditionPredicate } from './notary.types';
import type { Reading } from './notary';

const NOW = '2026-09-05T00:00:00.000Z';
const world = makeFreightWorld({ generatedAt: NOW });
const report = runWorld(world, NOW);

// ─────────────────────────────────────────────────────────────────────────────
describe('assessDetector - containment is not detection', () => {
  it('recovers when the named set is small and contains the plant', () => {
    expect(assessDetector(['L-7'], ['L-7'], 500, 'n').status).toBe('recovered');
  });

  it('MISSES when the detector names the whole population', () => {
    // THE DEFECT THIS FILE PRODUCED ON ITS FIRST RUN. With no prover wired, all
    // 243 notarizable loads were `unproven`, and two plants whose detector was
    // "appears in the unproven set" both reported RECOVERED.
    const everything = Array.from({ length: 243 }, (_, i) => `L-${i}`);
    const r = assessDetector(['L-7'], everything, 500, 'found it');
    expect(r.status).toBe('missed');
    expect(r.note).toContain('Containing the planted entity is not finding it');
  });

  it('misses when the plant is absent, however small the set', () => {
    expect(assessDetector(['L-7'], ['L-8'], 500, 'n').status).toBe('missed');
    expect(assessDetector(['L-7'], [], 500, 'n').status).toBe('missed');
  });

  it('floors the ceiling at 5 so a tiny population does not flatter a detector', () => {
    expect(discriminationCeiling(10)).toBe(5);
    expect(discriminationCeiling(500)).toBe(25);
    expect(assessDetector(['a'], ['a', 'b', 'c', 'd', 'e'], 4, 'n').status).toBe('recovered');
    expect(assessDetector(['a'], ['a', 'b', 'c', 'd', 'e', 'f'], 4, 'n').status).toBe('missed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('worldRun - the lifecycle goes through the real table', () => {
  it('walks every transition with zero refusals, over a population worth walking', () => {
    expect(report.lifecycle.transitions).toBeGreaterThan(5000);
    expect(report.lifecycle.illegal).toBe(0);
  });

  it('computes latency only over observed instants, and says how many it dropped', () => {
    expect(report.lifecycle.latencyInferredExcluded).toBeGreaterThan(1000);
    expect(report.lifecycle.latencyObserved + report.lifecycle.latencyInferredExcluded)
      .toBe(report.lifecycle.transitions);
    expect(report.lifecycle.latencyP50Min).not.toBeNull();
  });
});

describe('worldRun - authorization reaches all three states on real checks', () => {
  it('splits the population across authorized, refused and undetermined', () => {
    const a = report.authorization;
    expect(a.authorized + a.refused + a.undetermined).toBe(report.lifecycle.loads);
    expect(a.authorized).toBeGreaterThan(0);
    expect(a.refused).toBeGreaterThan(0);
    expect(a.undetermined).toBeGreaterThan(0);
  });

  it('exercises the cover check in all three directions, not just one', () => {
    // MEASURED ON THE FIRST RUN: cargo cover was null for every carrier, so
    // `value_within_cargo_cover` returned `undetermined` 437 times and never
    // once cleared or refused. A check whose effective range is a single value
    // is a check that has not been tested by the fixture it runs on.
    expect(report.authorization.refusalsByCheck.value_within_cargo_cover).toBeGreaterThan(0);
    expect(report.authorization.undeterminedByCheck.value_within_cargo_cover).toBeGreaterThan(0);
  });
});

describe('worldRun - the notary reaches all three verdicts', () => {
  it('holds, breaches and refuses, each at least once', () => {
    expect(report.notary.held).toBeGreaterThan(0);
    expect(report.notary.breached).toBe(1);
    expect(report.notary.unproven).toBe(2);
    expect(Object.keys(report.notary.unprovenReasons).sort())
      .toEqual(['commitment_posted_after_the_fact', 'telemetry_gap_exceeds_max']);
  });

  it('says how many verdicts are a rehearsal', () => {
    expect(report.notary.restingOnSimulatedProof).toBeGreaterThan(0);
    expect(report.notary.restingOnSimulatedProof).toBe(report.notary.held + report.notary.breached);
  });

  it('quantifies what keeping the prover off the critical path is worth', () => {
    // The architecture argument stops being an assertion once this is a number.
    expect(report.notary.provingMsMean).toBeGreaterThan(500);
    expect(report.notary.provingMsTotal).toBeGreaterThan(60_000);
  });
});

describe('worldRun - all nine plants are recovered, each by a discriminating detector', () => {
  it('recovers every plant', () => {
    const missed = report.plants.filter(p => p.status !== 'recovered');
    expect(missed.map(p => `${p.plant}: ${p.note}`)).toEqual([]);
    expect(report.plants).toHaveLength(9);
  });

  it('gives PLANT-7 and PLANT-9 DIFFERENT detectors', () => {
    // Both land in the unproven set. A detector that asks only "is it unproven"
    // credits either plant for the other's evidence.
    const p7 = report.plants.find(p => p.plant === 'PLANT-7')!;
    const p9 = report.plants.find(p => p.plant === 'PLANT-9')!;
    expect(p7.detected).not.toEqual(p9.detected);
    expect(p7.detected.some(d => p9.detected.includes(d))).toBe(false);
  });

  it('detects the insurance lapse as a CARRIER fact, not a load fact', () => {
    // Every load that carrier moved after expiry refuses, so the load-level set
    // is as large as its book (31 of 520) and reads as non-discriminating. The
    // finding is about the carrier, and denominated that way it is one row.
    const p4 = report.plants.find(p => p.plant === 'PLANT-4')!;
    expect(p4.detected.every(d => /^CX-/.test(d))).toBe(true);
    expect(p4.detected.length).toBeLessThanOrEqual(discriminationCeiling(report.lifecycle.loads));
  });
});

describe('worldRun - the seasonality finding', () => {
  const s = report.seasonality;

  it('IS in the data and the naive query does not see it', () => {
    // THE POINT OF THE WHOLE FIXTURE. A first version put the plant on a clean
    // lane and BOTH queries recovered it, which cannot separate a sound
    // estimator from an unsound one.
    expect(s.onPlantBasis.recovers).toBe(true);
    expect(s.naive.recovers).toBe(false);
    expect(s.verdict).toBe('recovered');
    expect(s.explanation).toContain('fix the statistic, not');
  });

  it('separates in-season from out-of-season on median and on rate, not only mean', () => {
    const { inSeason, outSeason } = s.onPlantBasis;
    expect(inSeason.median!).toBeGreaterThan(outSeason.median!);
    expect(inSeason.rateAbove120!).toBeGreaterThan(outSeason.rateAbove120!);
    expect(inSeason.n).toBeGreaterThan(3);
    expect(outSeason.n).toBeGreaterThan(3);
  });

  it('reports the naive cells so the failure is visible, not just asserted', () => {
    expect(s.naive.cells).toHaveLength(4);
    expect(s.naive.cells.every(c => c.n > 0)).toBe(true);
  });

  it('would report not_recovered if the effect really were absent', () => {
    // VACUITY PIN: strip the seasonal signal and the finding must flip, so a
    // `recovered` verdict is a measurement rather than a constant.
    const flat = world.loads.map(l => ({ ...l, detentionMinutes: 0 }));
    expect(analyseSeasonality(flat).verdict).toBe('not_recovered');
  });
});

describe('worldRun - estimators are named, and behave', () => {
  it('mean, median and rateAbove refuse an empty population rather than returning 0', () => {
    expect(mean([])).toBeNull();
    expect(median([])).toBeNull();
    expect(rateAbove([], 1)).toBeNull();
  });

  it('median survives the outlier that moves the mean', () => {
    const bimodal = [0, 0, 0, 0, 0, 0, 0, 0, 0, 900];
    expect(mean(bimodal)).toBe(90);
    expect(median(bimodal)).toBe(0);
  });
});

describe('worldRun - the report is honest about itself', () => {
  it('never claims admissibility', () => {
    expect(report.admissible).toBe(false);
    const text = renderWorldRun(report);
    expect(text).toContain('isAdmissible() === false');
    expect(text).toContain('not claims about the');
  });

  it('runs from the convenience entry point with an injected clock', () => {
    const a = runDefaultWorld(NOW);
    const b = runDefaultWorld(NOW);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.now).toBe(NOW);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const baseReq: AuthorizationRequest = {
  loadId: 'L-1', tenderedCarrierId: 'CX-1', bolCarrierId: 'CX-1',
  pickupAt: '2026-03-01T00:00:00.000Z', bookedAt: '2026-02-01T00:00:00.000Z',
  declaredValue: { amount: 10_000, currency: 'CAD' },
  carrier: {
    carrierId: 'CX-1',
    insuranceExpiresAt: '2027-01-01T00:00:00.000Z',
    cargoCoverAmount: { amount: 100_000, currency: 'CAD' },
    authorityGrantedAt: '2020-01-01T00:00:00.000Z',
    authorityRevokedAt: null,
  },
  actingAuthority: { principal: 'ops', mayBind: true },
};

describe('authorization - deterministic, blocking, and three-valued', () => {
  it('authorizes a clean proposal', () => {
    const a = authorize(baseReq, NOW);
    expect(a.decision).toBe('authorized');
    expect(a.blockedBy).toEqual([]);
  });

  it('treats a missing record as undetermined, never as clearance', () => {
    const a = authorize({ ...baseReq, carrier: { ...baseReq.carrier, insuranceExpiresAt: null } }, NOW);
    expect(a.decision).toBe('undetermined');
    expect(a.statement).toContain('absence of a record is not evidence of compliance');
    expect(a.blockedBy[0].remedy).toBeTruthy();
  });

  it('checks insurance AT PICKUP, not at decision time', () => {
    // A policy expiring between booking and pickup covers the booking, not the load.
    const a = authorize({
      ...baseReq,
      carrier: { ...baseReq.carrier, insuranceExpiresAt: '2026-02-15T00:00:00.000Z' },
    }, NOW);
    expect(a.decision).toBe('refused');
    expect(a.blockedBy[0].check).toBe('insurance_valid_at_pickup');
  });

  it('refuses a BOL naming a carrier we did not tender to', () => {
    const a = authorize({ ...baseReq, bolCarrierId: 'CX-9' }, NOW);
    expect(a.decision).toBe('refused');
    expect(a.statement).toContain('BOL names CX-9');
  });

  it('refuses to compare across currencies rather than converting silently', () => {
    const a = authorize({
      ...baseReq, declaredValue: { amount: 10_000, currency: 'USD' },
    }, NOW);
    expect(a.decision).toBe('undetermined');
    expect(a.blockedBy[0].remedy).toContain('a number with no unit wearing the label of one');
  });

  it('lets a refusal dominate an undetermined beside it', () => {
    const a = authorize({
      ...baseReq, bolCarrierId: 'CX-9',
      carrier: { ...baseReq.carrier, cargoCoverAmount: null },
    }, NOW);
    expect(a.decision).toBe('refused');
    expect(a.blockedBy.every(b => b.outcome === 'refused')).toBe(true);
  });

  it('REFUSES when the acting principal cannot bind, however clean the rest', () => {
    // Recommendation != Authorization != Execution.
    const a = authorize({
      ...baseReq, actingAuthority: { principal: 'agent:planner', mayBind: false, note: 'advisory scope' },
    }, NOW);
    expect(a.decision).toBe('refused');
    expect(a.statement).toContain('recommendation, not an authorization');
    expect(a.checks.filter(c => c.outcome === 'authorized').length).toBe(4);
  });

  it('holds no clock - decidedAt is echoed, not read', () => {
    expect(authorize(baseReq, '1999-01-01T00:00:00.000Z').decidedAt).toBe('1999-01-01T00:00:00.000Z');
  });
});

describe('authorization - the execution boundary', () => {
  it('lets an authorized proposal through', () => {
    expect(() => assertExecutable(authorize(baseReq, NOW), 'L-1')).not.toThrow();
  });

  it('throws on a refusal', () => {
    const a = authorize({ ...baseReq, bolCarrierId: 'CX-9' }, NOW);
    expect(() => assertExecutable(a, 'L-1')).toThrow(NotAuthorized);
  });

  it('throws when a clearance for one load is used to execute another', () => {
    // A bypass with a receipt: the gate was called and its answer was for
    // something else.
    const a = authorize(baseReq, NOW);
    expect(() => assertExecutable(a, 'L-2')).toThrow(NOT_AUTHORIZED);
    try { assertExecutable(a, 'L-2'); } catch (e) {
      expect((e as Error).message).toContain('reusing it across loads');
    }
  });
});

describe('authorization - notarization is threshold-gated and off the path', () => {
  it('always notarizes a reefer, because the condition IS the term', () => {
    expect(notarizationRequired(null, 'reefer_53', 50_000, 'CAD').required).toBe(true);
  });

  it('does not notarize below the threshold', () => {
    expect(notarizationRequired({ amount: 10, currency: 'CAD' }, 'van_53', 50_000, 'CAD').required).toBe(false);
  });

  it('fires rather than silently passing when the currencies differ', () => {
    const t = notarizationRequired({ amount: 10, currency: 'USD' }, 'van_53', 50_000, 'CAD');
    expect(t.required).toBe(true);
    expect(t.reason).toContain('Over-notarizing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const PRED: ConditionPredicate = {
  predicateId: 'p.v1', channel: 'temperature_c',
  statement: 'at or below 8.0 C', bounds: { maxMilli: toMilli(8) },
  toleranceSeconds: 0, maxGapSeconds: 3600, boundaryIsBreach: false,
};
const clean: Reading[] = [
  { at: '2026-03-01T00:00:00.000Z', channel: 'temperature_c', valueMilli: 4000, deviceId: 'D' },
  { at: '2026-03-01T01:00:00.000Z', channel: 'temperature_c', valueMilli: 4200, deviceId: 'D' },
];

describe('simulatedProver - a prover, not an echo', () => {
  const args = {
    root: 'r', predicateId: 'p.v1',
    from: '2026-03-01T00:00:00.000Z', to: '2026-03-01T01:00:00.000Z',
  };

  it('attests the verdict it independently derives', () => {
    const p = simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, verdictBit: 'held' });
    expect(p.system).toBe('sp1');
    expect(p.publicInputs.verdictBit).toBe('held');
  });

  it('REFUSES a verdict it does not derive', () => {
    // The only thing a prover is actually for.
    expect(() =>
      simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, verdictBit: 'breached' }),
    ).toThrow(ProverDisagrees);
    try {
      simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, verdictBit: 'breached' });
    } catch (e) {
      expect((e as Error).message).toContain(PROVER_DISAGREES);
      expect((e as Error).message).toContain('indistinguishable from a working prover');
    }
  });

  it('refuses a predicate it was not given', () => {
    expect(() =>
      simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, predicateId: 'other', verdictBit: 'held' }),
    ).toThrow(ProverDisagrees);
  });

  it('is identifiable as a rehearsal from the proof alone', () => {
    const p = simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, verdictBit: 'held' });
    expect(isSimulatedProof(p)).toBe(true);
    expect(p.vkey).toBe(SIMULATED_VKEY);
    expect(p.proofId.startsWith('SIMULATED-')).toBe(true);
    // `system: 'sp1'` alone cannot carry the distinction, which is why it does not.
    expect(isSimulatedProof({ ...p, vkey: 'deadbeef', proofId: 'real-1' })).toBe(false);
    expect(isSimulatedProof(null)).toBe(false);
  });

  it('is deterministic in its proof id and rises with leaf count', () => {
    const mk = () => simulatedProver({ readings: clean, predicate: PRED, now: NOW })({ ...args, verdictBit: 'held' });
    expect(mk().proofId).toBe(mk().proofId);
    expect(simulatedProvingMs(1000)).toBeGreaterThan(simulatedProvingMs(10));
  });
});
