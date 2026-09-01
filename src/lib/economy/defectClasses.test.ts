import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE INSTANCE COUNT WAS ITSELF AN INSTANCE.
 *
 * `DEFECT_CLASSES.md` called the phase-40 graph view the "ninth instance" while
 * `ARCHITECTURE_LEDGER.md` titled phase 48 "ninth instance". Two documents, two
 * different ninths, and the ledger's chain (38→7th, 46→8th, 48→9th, 50→10th)
 * skipped phase 40 entirely.
 *
 * That is class 6 — the literal that agrees with itself and not with the world —
 * arriving in the registry that catalogues it, by the mechanism the ledger names
 * at phase 44: "a hand-maintained number describing something". Neither document
 * was checkable against the other, so both stayed internally consistent and the
 * pair diverged.
 *
 * The roster table in DEFECT_CLASSES.md is now the single place instances are
 * counted, the ordinal is its ROW POSITION rather than a written word, and these
 * checks make a future divergence fail instead of accumulate.
 */
const CLASSES = readFileSync(join(process.cwd(), 'docs/DEFECT_CLASSES.md'), 'utf8');
const LEDGER = readFileSync(join(process.cwd(), 'docs/ARCHITECTURE_LEDGER.md'), 'utf8');

interface Row { ordinal: number; phase: number; text: string }

function roster(): Row[] {
  const out: Row[] = [];
  // | 8 | 40 | ... |
  for (const m of CLASSES.matchAll(/^\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|$/gm)) {
    out.push({ ordinal: Number(m[1]), phase: Number(m[2]), text: m[3] });
  }
  return out;
}

const ledgerPhases = (): Set<number> =>
  new Set([...LEDGER.matchAll(/^## Phase (\d+)\b/gm)].map(m => Number(m[1])));

describe('the class-5 instance roster is derived, not remembered', () => {
  it('the roster exists and is not empty — the test is not vacuous', () => {
    const r = roster();
    expect(r.length).toBeGreaterThan(10);
    expect(r[0].phase).toBe(37);
  });

  it('ordinals are contiguous from 1, with no duplicates', () => {
    const r = roster();
    const ordinals = r.map(x => x.ordinal);
    expect(ordinals).toEqual(ordinals.map((_, i) => i + 1));
  });

  it('phases are non-decreasing — the ordinal IS the phase order', () => {
    // The whole point of deriving it. A row inserted out of order would make
    // the ordinal mean something other than "when this was found".
    const phases = roster().map(x => x.phase);
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i], `row ${i + 1} goes backwards in phase`).toBeGreaterThanOrEqual(phases[i - 1]);
    }
  });

  it('every rostered phase exists in the ledger', () => {
    const have = ledgerPhases();
    const missing = roster().filter(r => !have.has(r.phase)).map(r => `#${r.ordinal} → phase ${r.phase}`);
    expect(missing, 'a roster row names a phase the ledger does not contain').toEqual([]);
  });

  it('every row says what the mechanism was, not just that there was one', () => {
    for (const r of roster()) {
      expect(r.text.length, `row ${r.ordinal} has no description`).toBeGreaterThan(30);
    }
  });

  it('THE DRIFT CATCHER: no ledger heading claims an ordinal the roster contradicts', () => {
    // `## Phase 48 — instance 10: …` must agree with the roster's row for 48.
    const byPhase = new Map(roster().map(r => [r.phase, r.ordinal]));
    const conflicts: string[] = [];
    for (const m of LEDGER.matchAll(/^## Phase (\d+) — instance (\d+)\b/gm)) {
      const phase = Number(m[1]), claimed = Number(m[2]);
      const rostered = byPhase.get(phase);
      if (rostered === undefined) conflicts.push(`phase ${phase} claims instance ${claimed} but is not rostered`);
      else if (rostered !== claimed) conflicts.push(`phase ${phase} claims instance ${claimed}, roster says ${rostered}`);
    }
    expect(conflicts, 'the ledger and the roster disagree about an ordinal').toEqual([]);
  });

  it('no ORDINAL WORD survives as a class-5 instance count in either document', () => {
    // "ninth instance" written as a word is the exact shape that drifted: it
    // reads as authoritative, cannot be checked against anything, and each
    // document keeps its own. Numbers in the roster, positions in the table.
    //
    // Class 6's own instances are counted in words elsewhere and are not in
    // scope here; this checks the two headings that carried the collision.
    const WORDS = /\b(seventh|eighth|ninth|tenth|eleventh|twelfth)[- ]instance\b/gi;
    const offenders: string[] = [];
    for (const [name, src] of [['DEFECT_CLASSES.md', CLASSES], ['ARCHITECTURE_LEDGER.md', LEDGER]] as const) {
      for (const m of src.matchAll(WORDS)) {
        // The roster's own explanation quotes the old wording to explain it.
        const around = src.slice(Math.max(0, m.index! - 200), m.index! + 120);
        if (/drift|roster|two different ninths|called the/i.test(around)) continue;
        offenders.push(`${name}: "${m[0]}"`);
      }
    }
    expect(offenders, 'an instance is counted in words again — put it in the roster').toEqual([]);
  });
});
