import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { MCP_TOOLS } from './mcpTools';
import { DEFERRED_DECISIONS } from './ledgerGuards';

/**
 * THE SELF-APPLICATION STEP.
 *
 * Three times now, applying a named defect class to the INSTRUMENT'S OWN
 * INSTRUMENTS — its checks, its docs, its deployment script — has found a
 * live instance:
 *
 *   1. The context-severance check failed on `boot.ts` the first time it
 *      ran, because its literal pattern missed a generic call form. A
 *      checker blind to one calling form is the class one level up.
 *   2. A ledger sentence miscounted the guards, and the miscount travelled
 *      into two operator work orders written from the docs rather than the
 *      register.
 *   3. `scripts/smoke.mjs` — the one command run after every deploy —
 *      printed "empty is the healthy state", which is precisely the claim
 *      class 7 exists to reject, asserted at the moment of highest trust.
 *
 * The operator's reading: that has happened often enough that it should be
 * a STEP rather than an insight. This file is the step. It does not replace
 * judgment — most of a class can only be applied by thinking — but the two
 * parts that CAN be mechanised are, and the checklist forces the rest.
 */

const repoFile = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');

/** Documents that describe the instrument AS IT IS. */
const LIVE_DOCS = [
  'docs/RUNBOOK.md', 'docs/OPERATIONS.md', 'docs/OPERATOR_STEPS.md',
  'docs/PHYSICAL_ECONOMY.md', 'docs/DEPLOYMENT.md', 'docs/EXPOSURE_OPTIONS.md',
  'docs/DEFECT_CLASSES.md',
];

/**
 * Documents deliberately NOT scanned, with the argument. The work orders
 * are frozen pre-registration and one of them CONTAINS the guard miscount:
 * correcting it would destroy the evidence of how a literal travelled from
 * a ledger sentence into an instruction. The ledger's phase entries are a
 * narrative of what was true at each phase; "eleven tools" in the phase-36
 * entry is correct about phase 36. A register that rewrites its own history
 * to stay consistent is the failure mode, not the fix.
 */
const NOT_SCANNED_WITH_ARGUMENT: Record<string, string> = {
  'docs/WORK_ORDER_*.md': 'Frozen operator pre-registration. One of them carries the seven-guards miscount verbatim; correcting it would erase the evidence of how the literal travelled into an instruction, which is the instance itself.',
  'docs/ARCHITECTURE_LEDGER.md': 'A phase-by-phase narrative. Each entry is a claim about its own phase and stays true as written; a register that rewrites its history to stay consistent with the present has destroyed the only record of what changed.',
};

/* ── Part A: class 6, mechanised. Counts are derived, never restated. ── */

interface CountedRegister {
  label: string;
  /** The number the TREE knows. */
  actual: () => number;
  /** Matches a doc's claim about it, capturing the number. */
  claim: RegExp;
}

const REGISTERS: CountedRegister[] = [
  { label: 'MCP tools', actual: () => MCP_TOOLS.length, claim: /(\d+)\s+read-only tools|sweep of all (\d+)\s*\n?\s*tools/gi },
  { label: 'validWhile guards', actual: () => DEFERRED_DECISIONS.length, claim: /(\d+)\s+validWhile guards|(\d+)\s+guards run/gi },
  { label: 'named defect classes', actual: () => (repoFile('docs/DEFECT_CLASSES.md').match(/^## \d+\. /gm) ?? []).length, claim: /(\d+)\s+named (?:defect )?classes/gi },
];

describe('the self-application step — class 6: documented counts are derived', () => {
  it('every count a live document states about a register matches the register', () => {
    const checked: string[] = [];
    const wrong: string[] = [];
    for (const doc of LIVE_DOCS) {
      const text = repoFile(doc);
      for (const r of REGISTERS) {
        for (const m of text.matchAll(r.claim)) {
          const stated = Number(m.slice(1).find(g => g !== undefined));
          checked.push(`${doc}: ${r.label} = ${stated}`);
          if (stated !== r.actual()) wrong.push(`${doc} states ${stated} ${r.label}; the register holds ${r.actual()}`);
        }
      }
    }
    expect(wrong, wrong.join('\n')).toEqual([]);
    // VACUITY: the scanner must be matching something, or it is a check
    // that passes because it reads nothing.
    expect(checked.length, 'no documented count was found at all — the patterns have drifted from the prose').toBeGreaterThan(0);
  });

  it('the exclusions are stated with their argument', () => {
    for (const [doc, argument] of Object.entries(NOT_SCANNED_WITH_ARGUMENT)) {
      expect(argument.length, `${doc}: an exclusion without an argument is an omission`).toBeGreaterThan(120);
      expect(LIVE_DOCS).not.toContain(doc);
    }
  });
});

/* ── Part B: class 7, applied to the instrument's own instruments. ── */

/**
 * Assertions a CHECK must never make. Each is a sentence that treats an
 * empty result as a verdict — the thing class 7 names — and the smoke
 * script made exactly this one before it was caught.
 */
const BANNED_IN_CHECKS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /empty is (the )?(healthy|fine|ok|expected)/i, why: 'an empty collection is healthy only if something was examined; this asserts the class the instrument exists to catch' },
  { pattern: /no (signals?|results?|rows?) means? (everything|all) (is )?(ok|fine|healthy)/i, why: 'reads absence as a verdict without stating the population' },
  { pattern: /(zero|0) (signals?|refusals?) (=|means|is) (healthy|clean|good)/i, why: 'same claim in numeric form' },
];

/** The instrument's own instruments: what verifies, deploys and reports. */
function checkingArtifacts(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const p of ['scripts/smoke.mjs', 'scripts/archive-manifest.mjs']) out.push({ path: p, text: repoFile(p) });
  const wfDir = new URL('../../../.github/workflows/', import.meta.url);
  for (const f of readdirSync(wfDir)) out.push({ path: `.github/workflows/${f}`, text: readFileSync(new URL(f, wfDir), 'utf8') });
  return out;
}

describe('the self-application step — class 7: the checks do not assert the class', () => {
  it('no checking artifact treats emptiness as a verdict', () => {
    const artifacts = checkingArtifacts();
    // VACUITY first: if the artifact list goes empty (a renamed script, a
    // moved workflow directory), this check would pass by reading nothing.
    expect(artifacts.length, 'no checking artifacts found — the sweep has lost its subjects').toBeGreaterThan(2);
    expect(artifacts.some(a => a.path === 'scripts/smoke.mjs')).toBe(true);

    const violations: string[] = [];
    for (const a of artifacts) {
      for (const b of BANNED_IN_CHECKS) {
        for (const m of a.text.matchAll(new RegExp(b.pattern.source, b.pattern.flags.includes('g') ? b.pattern.flags : b.pattern.flags + 'g'))) {
          // The rule may be QUOTED in a comment explaining why it is banned
          // — that is the record of the fix, not the defect. A line that
          // names the class or quotes the old wording is exempt.
          const line = a.text.slice(0, m.index).split('\n').length;
          const context = a.text.split('\n').slice(Math.max(0, line - 4), line + 1).join(' ');
          if (/class 7|used to read|which is the claim|reject/i.test(context)) continue;
          violations.push(`${a.path}:${line} asserts "${m[0]}" — ${b.why}`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('the deployment check asserts the accounting it needs to read an empty result', () => {
    // The positive form: it is not enough that the bad sentence is gone.
    // The check must actively require the warrant, or the next payload
    // without one passes silently.
    const smoke = repoFile('scripts/smoke.mjs');
    expect(smoke).toMatch(/corpusHealthAccounting/);
    expect(smoke).toMatch(/nothing was checked/i);
  });
});

/* ── Part C: the step itself, forced. ── */

/**
 * What applying each named class to the instrument's own instruments found.
 * A class with nothing to report says so — "checked, nothing found" is a
 * result and an empty entry is not (which is class 7, applied to this
 * table).
 */
const SELF_APPLICATION: Record<number, string> = {
  1: 'Silent filtering, applied to the checks: the archive MANIFEST verifier refuses an unclassified file rather than skipping it, and CI runs the full suite rather than a subset. Applied to the docs: no live document narrows a population without naming the predicate. Checked, nothing found.',
  2: 'Scoped-check blindness, applied to the checks: the guards evaluate over the DERIVED commodity scope, and /api/economy/guards asserts every partition was evaluated (evaluatedCells === scope). Found and closed in phase 26, at the check itself.',
  3: 'Vacuous examples, applied to the checks: every standing sweep in this suite now carries its own vacuity guard — the severance sweep, the runbook extractor, the empty-warrant sweep and both parts of this file. Found repeatedly; it is the reason the guards exist.',
  4: 'Wrong-attribution refusals, applied to the checks: the refusal classifier is coupled to prose, and the `typed-refusal-emission-unbuilt` guard runs a planted instance of every mechanism through the REAL pipeline and fires if any lands in the wrong bucket. Found in phase 33, closed at the check.',
  5: 'Context severance, applied to the checks: contextSeverance.test.ts failed on boot.ts the first time it ran — its literal pattern missed a generic call form, so the checker was blind to a calling form, which is the class one level up. FOUND IN THE CHECK ITSELF.',
  6: 'The literal that agrees with itself, applied to the docs: two instances, the guard miscount (phase 34, into two work orders) and the tool count (phase 44, eleven vs twelve). Mechanised in Part A of this file rather than pinned one number at a time.',
  7: 'The empty collection with no warrant, applied to the deployment check: scripts/smoke.mjs printed "empty is the healthy state" — the class asserted at the moment of highest trust. FOUND IN THE CHECK ITSELF. Mechanised in Part B.',
};

describe('the self-application step is a step, not an insight', () => {
  it('every named class has been applied to the instrument\'s own instruments', () => {
    const classCount = (repoFile('docs/DEFECT_CLASSES.md').match(/^## \d+\. /gm) ?? []).length;
    expect(classCount, 'the class register is unreadable — the heading format changed').toBeGreaterThan(0);
    const applied = Object.keys(SELF_APPLICATION).map(Number).sort((a, b) => a - b);
    expect(applied, `${classCount} classes are named; the self-application table covers ${applied.length}`).toEqual(
      Array.from({ length: classCount }, (_, i) => i + 1),
    );
    for (const [n, finding] of Object.entries(SELF_APPLICATION)) {
      expect(finding.length, `class ${n}: an entry with no finding is the empty collection again`).toBeGreaterThan(80);
    }
    // Three of them found something IN a check. That is the count that made
    // this a step; if it stops being true the sentence above is stale.
    expect(Object.values(SELF_APPLICATION).filter(v => /FOUND IN THE CHECK ITSELF|Found and closed|Found in phase|Found repeatedly/.test(v).valueOf()).length).toBeGreaterThanOrEqual(3);
  });
});
