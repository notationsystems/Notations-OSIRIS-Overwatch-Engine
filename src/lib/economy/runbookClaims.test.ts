import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseEvidenceQuery, searchEvidenceCensus, evidenceNote } from './evidenceSearch';
import { buildGraph } from './graph';
import { getEconomyState } from './store';

/**
 * The runbook is the only document in front of the researcher, and it is a
 * LITERAL: prose asserting things about a system that keeps moving. That is
 * the sixth defect class by construction — a document agreeing with itself
 * and not with the world — and the afternoon is the one session where the
 * cost is unrecoverable, because a move that dead-ends measures the runbook
 * instead of the instrument and the S-7 window starts from that session.
 *
 * Found by EXECUTING the runbook rather than reading it: move #3 sent a
 * first-time reader to `refused:basis`, which has no instances under today's
 * facility topology (the gross-weight corridors are country-level), and the
 * bar rendered a blank — indistinguishable from a typo or a dead fetch. The
 * prose was corrected; this is the part that keeps it corrected.
 *
 * Every evidence query the runbook PRINTS is extracted from the document
 * itself and run. Each must either return records or come back with a note
 * that explains the emptiness. A silent empty result is the failure.
 */

const RUNBOOK = readFileSync(new URL('../../../docs/RUNBOOK.md', import.meta.url), 'utf8');

/** Backticked tokens in the runbook that the evidence grammar accepts. */
function instructedQueries(md: string): string[] {
  const out = new Set<string>();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim().toLowerCase();
    if (parseEvidenceQuery(token)) out.add(token);
  }
  return [...out].sort();
}

describe('the runbook cannot send a researcher into a blank screen', () => {
  it('extracts the queries the document actually prints', () => {
    const qs = instructedQueries(RUNBOOK);
    // Vacuity guard: if the extraction silently stops matching, this whole
    // file goes quiet while claiming to check the runbook.
    expect(qs.length, 'no evidence queries extracted — the check has gone vacuous').toBeGreaterThan(4);
    expect(qs).toContain('refused:');
    expect(qs).toContain('refused:basis');
    // And the grammar accepts the document's own vocabulary, colon and all.
    for (const q of qs) expect(parseEvidenceQuery(q), `runbook prints \`${q}\` but the parser rejects it`).not.toBeNull();
  });

  it('every printed query answers or explains, at today AND at the date the runbook names', async () => {
    const { state } = await getEconomyState('copper');
    // The runbook tells the reader to set 2017-06-30 for the basis refusals;
    // both states must be legible, since the reader will be in one of them.
    const dates: Array<string | undefined> = [undefined, '2017-06-30'];
    expect(RUNBOOK, 'the runbook names a date for the basis refusals').toContain('2017-06-30');

    for (const q of instructedQueries(RUNBOOK)) {
      const parsed = parseEvidenceQuery(q)!;
      for (const asOf of dates) {
        const census = searchEvidenceCensus(state, buildGraph(state, asOf), parsed, { asOf });
        const note = evidenceNote(parsed, census, asOf);
        const where = `\`${q}\` at ${asOf ?? 'today'}`;
        // The claim: never a bare empty. Records, or a sentence saying why
        // there are none — and an undeclared type is refused by name.
        expect(census.total > 0 || note !== null, `${where} returns nothing and says nothing`).toBe(true);
        if (census.total === 0) {
          expect(note, `${where} is empty without naming its kind`).toContain(parsed.kind);
          // The runbook deliberately prints ONE invalid token — the typo
          // example, `refused:bassis` — to show what a mistyped type does.
          // That is a claim about the instrument too, and it holds only if
          // the token is refused BY NAME against the declared taxonomy. The
          // check caught this on its first run, which is the extractor
          // working: a doc example is as much an assertion as an
          // instruction, and both are now measured against the running code.
          if (census.unknownType) {
            expect(note, `${where}: an undeclared type must be refused by name`).toMatch(/not a declared/);
            expect(census.unknownType.declared.length, `${where}: refusal names no alternatives`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it('the runbook\'s worked example is live at the date it names', async () => {
    // The specific instruction — "set the date to 2017-06-30 and search it
    // again" — is a factual claim about the corpus. If a future vintage
    // changes which dates carry gross-weight corridors, this fails here
    // rather than in front of the researcher.
    const { state } = await getEconomyState('copper');
    const q = parseEvidenceQuery('refused:basis')!;
    const at2017 = searchEvidenceCensus(state, buildGraph(state, '2017-06-30'), q, { asOf: '2017-06-30' });
    expect(at2017.total, 'the runbook sends the reader to 2017-06-30 for basis refusals').toBeGreaterThan(0);
    // And the claim that TODAY is the empty one, which is what makes the
    // instruction worth printing at all.
    const today = searchEvidenceCensus(state, buildGraph(state), q);
    expect(today.total).toBe(0);
  });
});
