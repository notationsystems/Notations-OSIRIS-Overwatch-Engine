import { describe, it, expect } from 'vitest';
import {
  sweepReachability, sweepVacuity, sweepRevertPins, sweepClaimHonesty,
  sweepSelfApplication, runAudit, AUDIT_RAN_NOTHING,
  type SweepResult, type ClaimCase,
} from './protocol';

const AT = '2026-08-31T12:00:00.000Z';
const ok = (over: Partial<SweepResult> = {}): SweepResult => ({
  sweep: 's', status: 'clean', findings: [],
  scope: { examined: 3, description: 'three things' },
  vacuityProof: { planted: 'x', caught: true }, ...over,
});

describe('sweep 1 — reachability', () => {
  it('an unemitted branch with no argument is blocking', () => {
    const r = sweepReachability({
      subject: 'UnprovenReason', declared: ['a', 'b'], observed: new Set(['a']), accountedFor: {},
    });
    expect(r.findings.filter(f => f.severity === 'blocking').map(f => f.subject))
      .toEqual(['UnprovenReason.b']);
  });

  it('an unemitted branch WITH an argument is a note, not a pass and not a block', () => {
    const r = sweepReachability({
      subject: 'X', declared: ['b'], observed: new Set(),
      accountedFor: { b: 'device attestation is carried beside the verdict, not blocking on it' },
    });
    expect(r.findings[0].severity).toBe('note');
    // The note does NOT disturb `clean`: `passed` reads blocking findings, and
    // AuditReport.notes surfaces it regardless. An accounted-for exemption is a
    // record, not a problem.
    expect(r.status).toBe('clean');
  });

  it('every branch emitted is clean', () => {
    expect(sweepReachability({
      subject: 'X', declared: ['a'], observed: new Set(['a']), accountedFor: {},
    }).status).toBe('clean');
  });
});

describe('sweep 2 — vacuity', () => {
  it('a check that survived its plant is blocking', () => {
    const r = sweepVacuity([{ checkName: 'c', plantedDefect: 'removed the guard', caughtIt: false }]);
    expect(r.findings[0].severity).toBe('blocking');
    expect(r.findings[0].detail).toContain('cannot fail');
  });

  it('catching only TOTAL breakage warns — the class arrives partially', () => {
    const r = sweepVacuity([{ checkName: 'c', plantedDefect: 'broke it all', caughtIt: true }]);
    expect(r.findings[0].severity).toBe('warning');
  });

  it('a subtle plant that escapes is blocking, not a warning', () => {
    const r = sweepVacuity([{
      checkName: 'c', plantedDefect: 'broke it all', caughtIt: true,
      subtlePlant: { described: 'retyped one field', caughtIt: false },
    }]);
    expect(r.findings[0].severity).toBe('blocking');
    expect(r.findings[0].detail).toContain('how the defect actually arrives');
  });
});

describe('sweep 3 — revert pins', () => {
  it('an unpinned fix is blocking', () => {
    const r = sweepRevertPins([{ fixName: 'f', reversion: 'put the || back', firingTests: [] }]);
    expect(r.findings[0].severity).toBe('blocking');
  });

  it('a structural-only pin is a NOTE, and says it is structural', () => {
    const r = sweepRevertPins([{
      fixName: 'no clock in the engine', reversion: 'restore new Date()', firingTests: [],
      structuralOnly: {
        reason: 'the stub proof is discarded on the unproven branch, so no behavioural test can observe it',
        sourceCheck: 'notary.test.ts pin 6b',
      },
    }]);
    // A real structural exemption downgrades to a note: there is genuinely
    // nothing behavioural to assert, and blocking it forever would be noise.
    expect(r.findings.map(f => f.severity)).toEqual(['note']);
    expect(r.findings[0].detail).toContain('structural pin only');
  });
});

describe('sweep 3b — a structural exemption must carry an argument', () => {
  it('a hollow exemption does NOT buy the downgrade', () => {
    // Found by writing the test above: `structuralOnly` was accepted on faith,
    // so `{ reason: 'because', sourceCheck: 'x' }` turned blocking into a note.
    // The reachability sweep in the same file already refuses that shape.
    const r = sweepRevertPins([{
      fixName: 'f', reversion: 'undo it', firingTests: [],
      structuralOnly: { reason: 'because', sourceCheck: 'x' },
    }]);
    expect(r.findings.map(f => f.severity)).toEqual(['blocking']);
    expect(r.findings[0].detail).toContain('without an argument');
  });

  it('and a real one still does', () => {
    const r = sweepRevertPins([{
      fixName: 'f', reversion: 'undo it', firingTests: [],
      structuralOnly: {
        reason: 'the stub proof is discarded on the unproven branch, so no behavioural test can observe the clock read',
        sourceCheck: 'notary.test.ts pin 6b',
      },
    }]);
    expect(r.findings.map(f => f.severity)).toEqual(['note']);
  });
});

describe('sweep 4 — claim honesty', () => {
  const c = (rendered: string, entitled: ClaimCase['entitled']): ClaimCase =>
    ({ producer: 'p', rendered, entitled });

  it('asserting truck-legal without assurance is blocking', () => {
    const r = sweepClaimHonesty([c('545 km, truck-legal for height', { legalityAssured: false })]);
    expect(r.findings[0].severity).toBe('blocking');
  });

  it('THE NEGATED FORM IS NOT AN ASSERTION — the correction applied on landing', () => {
    // `\bverified\b` matches inside "not verified", so a claim being scrupulously
    // honest was flagged as overclaiming. Same shape as `nmap` matching inside
    // `unmapped`, arriving from the other direction. A false positive here trains
    // a reader to suppress the sweep, and a suppressed sweep catches nothing.
    for (const s of ['not verified', 'cannot be verified', 'never confirmed', 'not proven']) {
      const r = sweepClaimHonesty([c(`the restriction was ${s}`, { admissible: false })]);
      expect(r.findings, `"${s}" should not be flagged`).toEqual([]);
    }
  });

  it('and the un- prefix is still excluded, as it always was', () => {
    expect(sweepClaimHonesty([c('device unverified', { admissible: false })]).findings).toEqual([]);
  });

  it('the POSITIVE assertion is still caught — the fix did not blunt the sweep', () => {
    const r = sweepClaimHonesty([c('the restriction was verified', { admissible: false })]);
    expect(r.findings[0].severity).toBe('blocking');
  });

  it('partial coverage must be stated', () => {
    expect(sweepClaimHonesty([c('held', { coveragePct: 0.62 })]).findings[0].detail)
      .toContain('62.0%');
    expect(sweepClaimHonesty([c('held across 62.0%', { coveragePct: 0.62 })]).findings).toEqual([]);
  });

  it('an unattested device must be named', () => {
    expect(sweepClaimHonesty([c('held', { deviceAttested: false })]).findings[0].severity)
      .toBe('blocking');
    expect(sweepClaimHonesty([c('held; device unattested', { deviceAttested: false })]).findings)
      .toEqual([]);
  });

  it('an internal anchor warns rather than blocks — honest but weak', () => {
    expect(sweepClaimHonesty([c('held', { anchorStrength: 'internal' })]).findings[0].severity)
      .toBe('warning');
  });
});

describe('sweep 5 — self-application, including on itself', () => {
  it('a sweep that could not run is blocking, never clean', () => {
    const r = sweepSelfApplication([ok({ status: 'could_not_run', reason: 'no fixture' })]);
    expect(r.findings[0].severity).toBe('blocking');
    expect(r.findings[0].detail).toContain('not a clean sweep');
  });

  it('clean over an EMPTY scope is blocking', () => {
    const r = sweepSelfApplication([ok({ scope: { examined: 0, description: '' } })]);
    expect(r.findings.some(f => f.detail.includes('EMPTY scope'))).toBe(true);
  });

  it('clean with no vacuity proof warns', () => {
    const r = sweepSelfApplication([ok({ vacuityProof: null })]);
    expect(r.findings[0].severity).toBe('warning');
  });

  it('THE CORRECTION: it examines its own result, which nothing else does', () => {
    // Over an empty list the self result had scope.examined === 0 and status
    // 'clean' — the exact case it raises as blocking for every other sweep, in
    // the one result nothing passed back through the rules.
    const r = sweepSelfApplication([]);
    expect(r.scope.examined).toBe(0);
    expect(r.status).toBe('findings');
    expect(r.findings.some(f => f.subject === 'self_application')).toBe(true);
    expect(r.findings.some(f => f.detail.includes('EMPTY scope'))).toBe(true);
  });
});

describe('the audit gate', () => {
  it('THE MEASURED DEFECT: an audit over zero sweeps must not pass', () => {
    // Before the correction this returned passed:true — an audit that examined
    // nothing reporting success, inside the file whose §3 is "which kind of
    // nothing is this".
    const rep = runAudit([], AT);
    expect(rep.passed).toBe(false);
    expect(rep.blocking[0].subject).toBe(AUDIT_RAN_NOTHING);
    expect(rep.summary).toContain('nothing was examined');
  });

  it('"ran nothing" is distinguishable from "ran and found a problem"', () => {
    const ranNothing = runAudit([], AT);
    const foundProblem = runAudit([ok({ status: 'findings', findings: [{
      sweep: 's', severity: 'blocking', subject: 'x', detail: 'd', remedy: 'r',
    }] })], AT);
    expect(ranNothing.passed).toBe(false);
    expect(foundProblem.passed).toBe(false);
    expect(ranNothing.blocking[0].subject).not.toBe(foundProblem.blocking[0].subject);
    expect(ranNothing.results).toHaveLength(0);
    expect(foundProblem.results.length).toBeGreaterThan(0);
  });

  it('could_not_run fails the gate even with zero blocking findings', () => {
    const rep = runAudit([ok({ status: 'could_not_run', reason: 'fixture missing', findings: [] })], AT);
    expect(rep.passed).toBe(false);
    expect(rep.summary).toContain('did not run');
  });

  it('a real clean run passes', () => {
    expect(runAudit([ok()], AT).passed).toBe(true);
  });

  it('the report holds no clock — two runs are byte-identical', () => {
    // Third occurrence of this defect in one session. An audit report that
    // stamps itself cannot be compared against a replay, which is the one thing
    // an audit report is for.
    expect(JSON.stringify(runAudit([ok()], AT))).toBe(JSON.stringify(runAudit([ok()], AT)));
    expect(runAudit([ok()], AT).runAt).toBe(AT);
  });
});


/**
 * THE NEGATIVE CASES.
 *
 * Every sweep above is planted with the defect it exists to catch. These assert
 * the other half: an honest input must NOT be flagged. A sweep that flags
 * everything is exactly as useless as one that flags nothing, and it fails in
 * the more expensive direction — it gets suppressed, and then it catches
 * nothing either.
 */
describe('the sweeps do not flag honest inputs', () => {
  it('reachability: a fully-reached set is clean with no findings', () => {
    const declared = ['a', 'b', 'c', 'd'];
    const r = sweepReachability({
      subject: 'Reason', declared, observed: new Set(declared), accountedFor: {},
    });
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(0);
  });

  it('vacuity: both plants caught is clean', () => {
    const r = sweepVacuity([{
      checkName: 'c', plantedDefect: 'total', caughtIt: true,
      subtlePlant: { described: 'partial', caughtIt: true },
    }]);
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(0);
  });

  it('revert pins: a pinned fix is clean', () => {
    expect(sweepRevertPins([{ fixName: 'f', reversion: 'x', firingTests: ['t1', 't2'] }]).status)
      .toBe('clean');
  });

  it('claim honesty: a claim that states its own limits is clean', () => {
    // Every qualifier present: the negative legality form, the modelled class,
    // and no positive assertion anywhere in it.
    const r = sweepClaimHonesty([{
      producer: 'good',
      rendered: '546.0 km, 5h30 — NOT legality-assured (requested height, honoured none); '
        + 'computed by the configured backend. Modeled estimate, not an observation.',
      entitled: { legalityAssured: false },
    }]);
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(0);
  });

  it('self-application: a well-formed sweep is clean', () => {
    const r = sweepSelfApplication([{
      sweep: 's', status: 'clean', findings: [],
      scope: { examined: 10, description: 'ten' },
      vacuityProof: { planted: 'p', caught: true },
    }]);
    expect(r.status).toBe('clean');
    expect(r.findings).toHaveLength(0);
  });
});

describe('the audit report is actionable', () => {
  it('every finding carries a remedy — a finding without one is a complaint', () => {
    const rep = runAudit([{
      sweep: 'b', status: 'findings',
      findings: [{ sweep: 'b', severity: 'blocking', subject: 's', detail: 'd', remedy: 'do x' }],
      scope: { examined: 1, description: '' }, vacuityProof: null,
    }], AT);
    const all = [...rep.blocking, ...rep.warnings, ...rep.notes];
    expect(all.length).toBeGreaterThan(0);
    for (const f of all) expect(f.remedy.length, `${f.subject} has no remedy`).toBeGreaterThan(0);
  });

  it('self-application is always appended — a step, not an option', () => {
    expect(runAudit([ok()], AT).results.map(r => r.sweep)).toContain('self_application');
  });
});
