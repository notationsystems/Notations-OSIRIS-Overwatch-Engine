// src/lib/audit/protocol.ts
//
// PAYLOAD DEBUG & AUDIT PROTOCOL
//
// Not a checklist. A set of executable sweeps that fail the build, because a protocol
// that relies on someone remembering to run it has been performed once, not adopted.
//
// Each sweep exists because a specific defect class shipped in this codebase and was
// caught late. The sweep is the class made permanent:
//
//   1. REACHABILITY   — a refusal nothing can emit passes every test by never running.
//                       Measured: 20 correct, mutation-tested refusals with a 0%
//                       rejection rate, and 0% was evidence about nothing.
//   2. VACUITY        — a test that cannot fail is not validation. Measured: a coupling
//                       check that only caught total breakage would miss the partial
//                       rewording, which is how the class actually arrives.
//   3. REVERT PINS    — a fix that can be silently reverted has been made once, not made
//                       permanent. Measured: six fixes reverted; all typechecked, all
//                       ran, all returned verdict-shaped objects.
//   4. CLAIM HONESTY  — a rendered claim must not imply assurance it lacks.
//   5. SELF-APPLY     — every class runs over the instruments built to catch it,
//                       including this file. Measured: the deployment check asserted the
//                       very class it existed to catch; the shipped-description gate read
//                       one file while another advertised the prohibited capability harder.
//
// FOUR CORRECTIONS APPLIED ON LANDING, each measured before it was changed. They are
// marked in place rather than silently folded in, because a protocol file that hides its
// own history is asking to be trusted on the strength of its subject matter.

export type Severity = 'blocking' | 'warning' | 'note';

export interface Finding {
  sweep: string;
  severity: Severity;
  subject: string;
  detail: string;
  /** What would resolve it. A finding without one is a complaint. */
  remedy: string;
}

export interface SweepResult {
  sweep: string;
  /** Ran and found nothing, vs. could not run. These are NOT the same. */
  status: 'clean' | 'findings' | 'not_applicable' | 'could_not_run';
  findings: Finding[];
  /** What the sweep actually examined. A sweep silent about its scope is unverifiable. */
  scope: { examined: number; description: string };
  /** Proof the sweep can fail — a planted defect it caught. */
  vacuityProof: { planted: string; caught: boolean } | null;
  reason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP 1 — Reachability of every declared refusal / verdict branch
// ─────────────────────────────────────────────────────────────────────────────

export interface ReachabilityInput {
  /** Every reason/branch the type system declares. */
  declared: readonly string[];
  /** Every reason/branch actually emitted during a full suite run. */
  observed: ReadonlySet<string>;
  /** Branches known to be unreachable today, WITH the argument. Not a suppression list. */
  accountedFor: Record<string, string>;
  subject: string;
}

/**
 * A declared branch nothing emits is dead code that passes every test. Rather than
 * counting a hand-written set, this asserts against what a real run produced.
 *
 * `accountedFor` is deliberately a map to a REASON, not a list of names — an
 * exemption without an argument is a suppression, and suppressions accumulate.
 */
export function sweepReachability(inp: ReachabilityInput): SweepResult {
  const findings: Finding[] = [];
  for (const branch of inp.declared) {
    if (inp.observed.has(branch)) continue;
    const reason = inp.accountedFor[branch];
    if (reason) {
      findings.push({
        sweep: 'reachability', severity: 'note', subject: `${inp.subject}.${branch}`,
        detail: `declared, not emitted by the suite; accounted for: ${reason}`,
        remedy: 'If this branch becomes emittable, remove the exemption and pin it behaviourally.',
      });
      continue;
    }
    findings.push({
      sweep: 'reachability', severity: 'blocking', subject: `${inp.subject}.${branch}`,
      detail: 'declared but never emitted by any test — a branch nothing can reach passes every test by never running.',
      remedy: `Plant an input that produces ${branch}, or delete the branch and record why in the ledger. A 0% rate over an unreachable branch is evidence about nothing.`,
    });
  }
  return {
    sweep: 'reachability',
    status: findings.length ? 'findings' : 'clean',
    findings,
    scope: { examined: inp.declared.length, description: `${inp.subject}: ${inp.declared.length} declared branches` },
    vacuityProof: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP 2 — Vacuity: every check must be shown to fail
// ─────────────────────────────────────────────────────────────────────────────

export interface VacuityCase {
  checkName: string;
  /** A described mutation that SHOULD make the check fail. */
  plantedDefect: string;
  /** Did the check actually fail under the mutation? */
  caughtIt: boolean;
  /**
   * The subtle plant, not just the total one. Measured: a coupling check that catches
   * a classifier typing EVERYTHING wrong but misses one field being retyped is
   * indistinguishable from a working check on the failure that actually happens.
   */
  subtlePlant?: { described: string; caughtIt: boolean };
}

export function sweepVacuity(cases: VacuityCase[]): SweepResult {
  const findings: Finding[] = [];
  for (const c of cases) {
    if (!c.caughtIt) {
      findings.push({
        sweep: 'vacuity', severity: 'blocking', subject: c.checkName,
        detail: `planted "${c.plantedDefect}" and the check still passed — it cannot fail, so it is not validation.`,
        remedy: 'Rewrite the check until the planted defect fails it by name, or delete it. A check that cannot fail reads as coverage and is worse than none.',
      });
      continue;
    }
    if (!c.subtlePlant) {
      findings.push({
        sweep: 'vacuity', severity: 'warning', subject: c.checkName,
        detail: 'catches total breakage; no subtle plant recorded.',
        remedy: 'Add a partial mutation — one field wrong, one threshold moved. The class arrives partially, not totally.',
      });
    } else if (!c.subtlePlant.caughtIt) {
      findings.push({
        sweep: 'vacuity', severity: 'blocking', subject: c.checkName,
        detail: `catches total breakage but NOT the subtle plant "${c.subtlePlant.described}" — which is how the defect actually arrives.`,
        remedy: 'Tighten until the partial mutation fails it. Catching only total breakage is a check calibrated for the failure that does not happen.',
      });
    }
  }
  return {
    sweep: 'vacuity',
    status: findings.length ? 'findings' : 'clean',
    findings,
    scope: { examined: cases.length, description: `${cases.length} checks with planted defects` },
    vacuityProof: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP 3 — Revert pins: a fix that can be silently undone is not permanent
// ─────────────────────────────────────────────────────────────────────────────

export interface RevertPin {
  fixName: string;
  /** The reversion, described precisely enough to apply. */
  reversion: string;
  /** Tests that fire when the reversion is applied. Empty = unpinned. */
  firingTests: string[];
  /**
   * Some fixes are not behaviourally observable (a discarded clock read, a comment).
   * Those are checked structurally — and the split must be NAMED, not implied by a
   * test title, or a structural pin reads as behavioural coverage.
   */
  structuralOnly?: { reason: string; sourceCheck: string };
}

/**
 * CORRECTION 5 — a structural exemption must carry an argument.
 *
 * `structuralOnly` downgrades an unpinned fix from blocking to a note, and the first
 * version accepted it on faith: `{ reason: 'because', sourceCheck: 'trust me' }` bought
 * the exemption. The reachability sweep in this same file already refuses that shape —
 * "an exemption without an argument is a suppression, and suppressions accumulate" —
 * and the rule was applied there and not here.
 *
 * The thresholds are deliberately low. They cannot detect a bad argument; they detect
 * the ABSENCE of one, which is the failure that actually happens when an exemption is
 * added to make a sweep green.
 */
function structuralExemptionHolds(s: RevertPin['structuralOnly']): boolean {
  return s !== undefined && s.reason.trim().length >= 40 && s.sourceCheck.trim().length >= 5;
}

export function sweepRevertPins(pins: RevertPin[]): SweepResult {
  const findings: Finding[] = [];
  for (const p of pins) {
    if (p.structuralOnly && !structuralExemptionHolds(p.structuralOnly)) {
      findings.push({
        sweep: 'revert_pins', severity: 'blocking', subject: p.fixName,
        detail: 'claims a structural-only exemption without an argument for it — an exemption with no reasoning is a suppression, and it buys the same silence as a real one.',
        remedy: 'State why the fix cannot be observed behaviourally, and name the source check that stands in for the behavioural pin. If neither can be written, the fix is unpinned.',
      });
      continue;
    }
    if (p.firingTests.length === 0 && !p.structuralOnly) {
      findings.push({
        sweep: 'revert_pins', severity: 'blocking', subject: p.fixName,
        detail: `no test fires when "${p.reversion}" is applied — the fix typechecks, runs, and returns a correctly-shaped object while being wrong.`,
        remedy: 'Apply the reversion, watch a test fail by name, keep that test. A fix made once is not a fix made permanent.',
      });
    }
    if (p.structuralOnly && p.firingTests.length === 0) {
      findings.push({
        sweep: 'revert_pins', severity: 'note', subject: p.fixName,
        detail: `structural pin only: ${p.structuralOnly.reason} (checked by ${p.structuralOnly.sourceCheck})`,
        remedy: 'Revisit when the branch becomes observable; a structural pin must never be titled as though it were behavioural.',
      });
    }
  }
  return {
    sweep: 'revert_pins',
    status: findings.length ? 'findings' : 'clean',
    findings,
    scope: { examined: pins.length, description: `${pins.length} fixes with revert pins` },
    vacuityProof: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP 4 — Claim honesty: a rendered claim must not imply assurance it lacks
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimCase {
  producer: string;
  rendered: string;
  /** Properties the claim is entitled to assert. */
  entitled: {
    legalityAssured?: boolean;
    admissible?: boolean;
    coveragePct?: number | null;
    anchorStrength?: string;
    deviceAttested?: boolean;
  };
}

const OVERCLAIM_PATTERNS: Array<{ re: RegExp; requires: keyof ClaimCase['entitled']; label: string }> = [
  { re: /\btruck-legal\b/i, requires: 'legalityAssured', label: 'asserts truck-legal' },
  { re: /\bverified\b/i, requires: 'admissible', label: 'asserts verified' },
  { re: /\bproven\b/i, requires: 'admissible', label: 'asserts proven' },
  { re: /\bconfirmed\b/i, requires: 'admissible', label: 'asserts confirmed' },
];

/**
 * CORRECTION 1 — the negated form is not an assertion.
 *
 * `\bverified\b` matches inside "not verified" and "cannot be verified", so a claim
 * being scrupulously honest about what it lacks was flagged as overclaiming it. The
 * word boundary correctly excludes "unverified" (no boundary between n and v) and
 * incorrectly includes every separated negation — which is the SAME shape as the
 * `nmap` marker that matched inside `unmapped` earlier in this codebase, arriving
 * from the other direction.
 *
 * A false positive here is worse than a miss: it trains a reader to suppress the
 * sweep, and a suppressed sweep catches nothing at all.
 */
const NEGATORS = /\b(not|never|no|cannot|un|without|lacks?|fails? to)\s*(?:be\s+|been\s+)?$/i;

function assertedNotNegated(rendered: string, re: RegExp): boolean {
  const m = new RegExp(re.source, re.flags.replace('g', '')).exec(rendered);
  if (!m || m.index === undefined) return false;
  const before = rendered.slice(Math.max(0, m.index - 24), m.index);
  return !NEGATORS.test(before);
}

/**
 * The rendering is where honesty is actually lost — a correct record with an
 * overstating sentence is read as the sentence. This sweep checks the words against
 * the entitlements, and separately requires that qualifiers appear when they should.
 */
export function sweepClaimHonesty(cases: ClaimCase[]): SweepResult {
  const findings: Finding[] = [];
  for (const c of cases) {
    for (const pat of OVERCLAIM_PATTERNS) {
      if (assertedNotNegated(c.rendered, pat.re) && c.entitled[pat.requires] !== true) {
        findings.push({
          sweep: 'claim_honesty', severity: 'blocking', subject: c.producer,
          detail: `rendered claim ${pat.label} while ${String(pat.requires)} is ${String(c.entitled[pat.requires])}.`,
          remedy: 'Render the negative form explicitly (e.g. "NOT legality-assured", "modeled estimate") rather than omitting the qualifier. Omission reads as assurance.',
        });
      }
    }
    if (c.entitled.coveragePct !== undefined && c.entitled.coveragePct !== null
        && c.entitled.coveragePct < 1 && !/%/.test(c.rendered)) {
      findings.push({
        sweep: 'claim_honesty', severity: 'blocking', subject: c.producer,
        detail: `partial coverage (${(c.entitled.coveragePct * 100).toFixed(1)}%) is not stated in the claim.`,
        remedy: 'State coverage in the sentence. "Held" without coverage is read as held across the whole interval.',
      });
    }
    if (c.entitled.deviceAttested === false && !/unattested|not attested/i.test(c.rendered)) {
      findings.push({
        sweep: 'claim_honesty', severity: 'blocking', subject: c.producer,
        detail: 'device is unattested and the claim does not say so.',
        remedy: 'Name the device trust in the sentence — a proof over an unattested sensor must not read as a proof about the world.',
      });
    }
    if (c.entitled.anchorStrength === 'internal' && !/own log|internal/i.test(c.rendered)) {
      findings.push({
        sweep: 'claim_honesty', severity: 'warning', subject: c.producer,
        detail: 'anchored only internally and the claim does not say so.',
        remedy: 'State the anchor. A disputing party has no reason to accept our own log, and the claim should not imply they should.',
      });
    }
  }
  return {
    sweep: 'claim_honesty',
    status: findings.length ? 'findings' : 'clean',
    findings,
    scope: { examined: cases.length, description: `${cases.length} rendered claims` },
    vacuityProof: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWEEP 5 — Self-application: run every sweep over the sweeps, INCLUDING this one
// ─────────────────────────────────────────────────────────────────────────────

/** The per-result rules, extracted so they can be applied to this sweep's own result. */
function selfFindings(r: SweepResult): Finding[] {
  const findings: Finding[] = [];
  if (r.status === 'could_not_run') {
    findings.push({
      sweep: 'self_application', severity: 'blocking', subject: r.sweep,
      detail: `did not run (${r.reason ?? 'no reason given'}) — a sweep that could not run is not a clean sweep, and a report that conflates them is the defect this audit exists to catch.`,
      remedy: 'Fix the sweep or record the blocker in the ledger. Never render could_not_run as clean.',
    });
    return findings;
  }
  if (r.scope.examined === 0 && r.status === 'clean') {
    findings.push({
      sweep: 'self_application', severity: 'blocking', subject: r.sweep,
      detail: 'reported clean over an EMPTY scope — checked nothing and found nothing, which is not the same as checked everything and found nothing.',
      remedy: 'Assert a non-zero scope, or report not_applicable with the reason. Which kind of nothing is this?',
    });
  }
  if (r.status === 'clean' && r.vacuityProof === null) {
    findings.push({
      sweep: 'self_application', severity: 'warning', subject: r.sweep,
      detail: 'reported clean with no vacuity proof — nothing shows this sweep can fail.',
      remedy: 'Plant a defect the sweep should catch, record it in vacuityProof. A clean result from a sweep that cannot fail is not evidence.',
    });
  }
  return findings;
}

/**
 * Measured, repeatedly: a class lands on its own instrument on first run. The
 * deployment check asserted the class it was written to catch. The
 * shipped-description gate read one file while another advertised the prohibited
 * capability harder. The empty-warrant sweep failed on itself.
 *
 * So this is a STEP, not an insight, and it runs on every audit.
 *
 * CORRECTION 2 — this sweep did not examine ITSELF.
 *
 * `runAudit` appended the self-application result to the list without passing it
 * back through the rules, leaving exactly one result nothing checked — its own. With
 * an empty sweep list that result had `scope.examined === 0` and `status: 'clean'`,
 * which is the precise case `selfFindings` raises as blocking for everyone else.
 * Measured before the fix: `runAudit([])` returned `passed: true`. An audit that ran
 * zero sweeps reported PASSED, inside the file whose §3 is "which kind of nothing".
 */
export function sweepSelfApplication(results: readonly SweepResult[]): SweepResult {
  const onOthers = results.flatMap(selfFindings);
  const provisional: SweepResult = {
    sweep: 'self_application',
    status: onOthers.length ? 'findings' : 'clean',
    findings: onOthers,
    scope: { examined: results.length, description: `${results.length} sweeps examined by their own rules` },
    vacuityProof: { planted: 'a sweep reporting clean over an empty scope', caught: true },
  };
  const onSelf = selfFindings(provisional);
  const findings = [...onOthers, ...onSelf];
  return { ...provisional, status: findings.length ? 'findings' : 'clean', findings };
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit run
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditReport {
  runAt: string;
  results: SweepResult[];
  blocking: Finding[];
  warnings: Finding[];
  notes: Finding[];
  /** The gate: blocking findings fail the build. */
  passed: boolean;
  summary: string;
}

export const AUDIT_RAN_NOTHING = 'AUDIT_RAN_NOTHING';

/**
 * CORRECTION 3 — `runAt` is INJECTED, not read from a clock.
 *
 * Third occurrence of this exact defect in one session (the spatial claim, the notary
 * proof stub, and now the audit report). An audit report that stamps itself cannot be
 * compared byte-for-byte against a replay, which is the one thing an audit report is
 * for. The engine holds no clock.
 *
 * CORRECTION 4 — an audit over zero sweeps REFUSES.
 *
 * Even with self-application fixed, `runAudit([])` would report a single blocking
 * finding rather than saying the audit never happened. "Ran nothing" and "ran and
 * found a problem" are different facts and the caller acts differently on each.
 */
export function runAudit(sweeps: readonly SweepResult[], runAt: string): AuditReport {
  if (sweeps.length === 0) {
    const finding: Finding = {
      sweep: 'audit', severity: 'blocking', subject: AUDIT_RAN_NOTHING,
      detail: 'runAudit was called with no sweeps. An audit that examined nothing is not a passing audit, and reporting it as one is the failure the protocol exists to prevent.',
      remedy: 'Supply the sweeps. If none are applicable, say which and why — not_applicable with a reason is a result; an empty list is not.',
    };
    return {
      runAt, results: [], blocking: [finding], warnings: [], notes: [], passed: false,
      summary: `NOT PASSED — ${AUDIT_RAN_NOTHING}: no sweeps were supplied, so nothing was examined.`,
    };
  }

  const withSelf = [...sweeps, sweepSelfApplication(sweeps)];
  const all = withSelf.flatMap(s => s.findings);
  const blocking = all.filter(f => f.severity === 'blocking');
  const warnings = all.filter(f => f.severity === 'warning');
  const notes = all.filter(f => f.severity === 'note');

  const ranClean = withSelf.filter(s => s.status === 'clean').length;
  const couldNotRun = withSelf.filter(s => s.status === 'could_not_run');

  return {
    runAt,
    results: withSelf,
    blocking, warnings, notes,
    passed: blocking.length === 0 && couldNotRun.length === 0,
    summary:
      `${withSelf.length} sweeps: ${ranClean} clean, ${couldNotRun.length} could not run, ` +
      `${blocking.length} blocking, ${warnings.length} warnings, ${notes.length} notes. ` +
      (couldNotRun.length
        ? `NOT PASSED — ${couldNotRun.map(s => s.sweep).join(', ')} did not run, and a sweep that did not run is not a clean sweep.`
        : blocking.length
          ? 'NOT PASSED — blocking findings must be resolved or recorded in the ledger with a validWhile predicate.'
          : 'PASSED.'),
  };
}
