import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tableRoute from './route';
import { getEconomyState } from '@/lib/economy/store';
import { buildCorpusTable, buildVintageGrid, renderGridMarkdown, renderTableMarkdown, stateFingerprint } from '@/lib/economy/corpusTable';
import { resetSessionTelemetry, sessionDigest } from '@/lib/economy/sessionTelemetry';
import type { EconomyState, Observation } from '@/lib/economy/types';

const { GET } = tableRoute;
const req = (path: string) => new Request(`http://localhost${path}`);

/**
 * Corpus table / export surface — the operator's addition to the shipping
 * order, placed before S-6. The seven criteria below were pre-registered
 * in the order text BEFORE this file was written; each test names the
 * criterion it discharges and plants the failing state where the
 * criterion demands one (an assertion that cannot name the state in
 * which it fails is vacuous — standing doctrine).
 */

function plant(state: EconomyState, obs: Partial<Observation> & { id: string }): EconomyState {
  const clone = structuredClone(state);
  clone.observations.push({
    entityId: 'ent:country:cl',
    metric: 'production',
    value: 999,
    unit: 'kt/y',
    period: { start: '2021-01-01', end: '2021-12-31' },
    valueKind: 'reported',
    confidence: 'medium',
    provenance: { sourceId: 'test-plant', sourceName: 'test plant', retrievedAt: '2026-08-27' },
    ...obs,
  } as Observation);
  return clone;
}

describe('corpus table export (shipping-order addition, pre-registered criteria)', () => {
  let state: EconomyState;
  beforeAll(async () => {
    ({ state } = await getEconomyState('copper'));
  });

  // ── Criterion 1: every exported row carries all mandatory columns; a
  //    planted incomplete record exports null AND flagged, never omitted
  //    and never defaulted. ──
  it('a planted basis-less record exports basis=null with a flag naming the gap; refusal rows carry null values and a remedy', () => {
    const planted = plant(state, { id: 'obs:test-plant:incomplete', basis: undefined });
    const table = buildCorpusTable(planted, { metric: 'production', subject: 'ent:country:cl' });
    const row = table.rows.find(r => r.record_id === 'obs:test-plant:incomplete')!;
    expect(row).toBeDefined();
    expect(row.basis).toBeNull(); // null, not a defaulted 'unspecified'
    expect(row.flags.some(f => f.includes('basis'))).toBe(true); // and FLAGGED
    expect(row.claim).toContain('basis UNSTATED'); // the claim sentence carries the gap too

    // Mandatory columns present on EVERY row (null is a value; absence is a defect).
    const mandatory = ['record_id', 'subject_id', 'subject_label', 'metric', 'value', 'unit', 'basis', 'value_kind', 'confidence', 'source_id', 'period_start', 'period_end', 'known_at', 'attestation', 'flags', 'claim'] as const;
    const full = buildCorpusTable(state, {});
    expect(full.rows.length).toBeGreaterThan(0);
    for (const r of full.rows) for (const k of mandatory) expect(k in r, `${r.record_id} lacks ${k}`).toBe(true);

    // Refusal rows: the resolution gate's residue exports as rows, value null, remedy attached.
    const refusals = full.rows.filter(r => r.refusal);
    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) {
      expect(r.value).toBeNull();
      expect(r.refusal!.remedy.length).toBeGreaterThan(0);
      expect(r.claim).toContain('REFUSED');
    }
    // And they are counted in the header's accounting, not just present.
    expect(full.header.filtered.some(f => f.predicate.includes('refusal') && f.count === refusals.length)).toBe(true);
  });

  // ── Criterion 2: markdown and JSON exports of the same query contain
  //    identical values and identical headers — same objects, two renderings. ──
  it('markdown and JSON render the same objects: every JSON value, claim, and header field appears verbatim in the markdown', async () => {
    const json = await (await GET(req('/api/economy/table?commodity=copper&metric=production&format=json'))).json();
    const mdRes = await GET(req('/api/economy/table?commodity=copper&metric=production&format=md'));
    expect(mdRes.headers.get('content-type')).toContain('text/markdown');
    const md = await mdRes.text();
    expect(json.header.row_count).toBeGreaterThan(0);
    expect(md).toContain(json.header.baseline_fingerprint);
    expect(md).toContain(`row_count             ${json.header.row_count}`);
    expect(md).toContain(`withheld              ${json.header.withheld}`);
    for (const r of json.rows) {
      if (r.value !== null) expect(md).toContain(String(r.value));
      expect(md).toContain(r.claim); // the whole sentence, not a paraphrase
    }
    // CSV/XLSX refused with the reason — coercion destroys the axes.
    const csv = await GET(req('/api/economy/table?commodity=copper&format=csv'));
    expect(csv.status).toBe(400);
    expect((await csv.json()).error).toContain('no CSV/XLSX');
  });

  // ── Criterion 3: an as_known_then export contains no row whose known_at
  //    postdates as_of — verified by a planted late-vintage record. ──
  it('a planted late-vintage record is withheld under as_known_then, and the withholding is COUNTED', () => {
    const planted = plant(state, { id: 'obs:test-plant:late-vintage', knownAt: '2026-01-15', basis: 'metal_content' });
    const asOf = '2024-06-30';
    const table = buildCorpusTable(planted, { metric: 'production' }, { asOf, knowledge: 'as_known_then' });
    expect(table.rows.find(r => r.record_id === 'obs:test-plant:late-vintage')).toBeUndefined();
    for (const r of table.rows) {
      if (r.known_at) expect(r.known_at <= asOf, `${r.record_id} known_at ${r.known_at} postdates ${asOf}`).toBe(true);
    }
    // The plant is not silently absent: best-known sees it, and the
    // as-known-then header counts at least one more withheld row.
    const bestKnown = buildCorpusTable(planted, { metric: 'production' });
    expect(bestKnown.rows.find(r => r.record_id === 'obs:test-plant:late-vintage')).toBeDefined();
    const unplanted = buildCorpusTable(state, { metric: 'production' }, { asOf, knowledge: 'as_known_then' });
    expect(table.header.withheld).toBe(unplanted.header.withheld + 1);
  });

  // `renderGridMarkdown` was pinned below and `renderTableMarkdown` was not,
  // though the same `?format=md` switch serves both. The renderer that carries
  // the refusals is the one that most needs the pin: a null that renders as an
  // empty cell reads as a small number, and the whole point of the column is
  // that it is not one.
  it('the markdown export renders a refused value as a refusal, never as a blank or a zero', () => {
    const planted = plant(state, { id: 'obs:test-plant:incomplete', basis: undefined });
    const table = buildCorpusTable(planted, { metric: 'production', subject: 'ent:country:cl' });
    const md = renderTableMarkdown(table);

    // The header block carries the accounting, not just the rows that survived.
    expect(md).toContain(`row_count             ${table.header.row_count}`);
    expect(md).toContain(`withheld              ${table.header.withheld}`);
    expect(md).toContain(table.header.baseline_fingerprint);

    // A basis-less row says so in the cell — 'NULL(flagged)', never '' or '0'.
    expect(md).toContain('| NULL(flagged) |');

    // Per column, not per cell. `flags` renders empty when a row has none,
    // and that IS the honest rendering — an empty flag list means no flags.
    // The columns that must never be blank are the ones where a blank would
    // be read as a quantity or a settled fact.
    const body = md.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| subject |') && !l.startsWith('|---'));
    expect(body.length).toBe(table.rows.length);
    // subject 0 | metric 1 | value 2 | unit 3 | basis 4 | value_kind 5 |
    // source 6 | period 7 | known_at 8 | attestation 9 | flags 10
    const NEVER_BLANK = { value: 2, unit: 3, basis: 4, value_kind: 5, source: 6, period: 7, known_at: 8, attestation: 9 };
    for (const line of body) {
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      for (const [name, idx] of Object.entries(NEVER_BLANK)) {
        expect(cells[idx], `${name} blank in: ${line}`).not.toBe('');
      }
    }

    // Every row's claim ships beneath the table: the sentence is the export,
    // the number alone is not.
    for (const r of table.rows) expect(md).toContain(`- ${r.claim}`);

    // A refused value renders as a refusal, not as an absence.
    const refused = table.rows.filter(r => r.value === null);
    if (refused.length > 0) expect(md).toContain('null (refused)');
  });

  // ── Criterion 4: baseline_fingerprint matches the state that produced the
  //    export, and a mutated state produces a different fingerprint. ──
  it('the fingerprint is reproducible from the producing state and changes when any value changes', () => {
    const table = buildCorpusTable(state, {});
    expect(table.header.baseline_fingerprint).toBe(stateFingerprint(state));
    const mutated = structuredClone(state);
    mutated.observations[0].value += 1;
    expect(stateFingerprint(mutated)).not.toBe(stateFingerprint(state));
    // Deterministic: recomputing on the same state is stable.
    expect(stateFingerprint(state)).toBe(stateFingerprint(state));
  });

  // ── Criterion 5: the two-axis grid renders single-vintage rows and empty
  //    cells distinguishably from zero. ──
  it('a grid cell an edition did not cover is null and renders as a dash — never as 0; a single-vintage row survives', () => {
    // Planted two-edition history: edition A covers 2020+2021, edition B
    // (a revision) covers only 2021 and REVISES it; 2020 is single-vintage.
    const clone = structuredClone(state);
    clone.observations = clone.observations.filter(o => o.entityId !== 'ent:country:cl' || o.metric !== 'production');
    const mk = (id: string, sourceId: string, year: number, value: number, knownAt: string): Observation => ({
      id, entityId: 'ent:country:cl', metric: 'production', value, unit: 'kt/y',
      period: { start: `${year}-01-01`, end: `${year}-12-31` }, knownAt,
      valueKind: 'reported', confidence: 'medium', basis: 'metal_content',
      provenance: { sourceId, sourceName: sourceId, retrievedAt: '2026-08-27' },
    });
    clone.observations.push(
      mk('obs:ed-a:2020', 'edition-a', 2020, 5700, '2021-02-01'),
      mk('obs:ed-a:2021', 'edition-a', 2021, 5600, '2022-02-01'),
      mk('obs:ed-b:2021', 'edition-b', 2021, 5330, '2023-02-01'),
    );
    const grid = buildVintageGrid(clone, 'ent:country:cl', 'production');
    expect(grid.editions).toEqual(['edition-a', 'edition-b']); // column order = knowability order
    const row2020 = grid.rows.find(r => r.period === '2020')!;
    const row2021 = grid.rows.find(r => r.period === '2021')!;
    expect(row2020.cells).toEqual([
      { value: 5700, value_kind: 'reported', known_at: '2021-02-01' },
      null, // NOT COVERED — a typed null, not a zero
    ]);
    expect(row2021.cells.every(c => c !== null)).toBe(true); // the revision history of one fact
    const md = renderGridMarkdown(grid);
    expect(md).toContain('| 2020 | 5700 | — |'); // dash, never 0
    expect(md).not.toContain('| 2020 | 5700 | 0 |');
    expect(md).toContain(grid.legend); // the legend that says a dash is not zero ships with the grid
  });

  // ── Criterion 6: export telemetry writes in the running configuration —
  //    the log record through the real path, the session counter through
  //    the real digest. ──
  it('an export writes the export log through the real path and increments the session digest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sea-dog-export-log-'));
    process.env.SEA_DOG_FORCE_MISS_LOG = '1';
    process.env.SEA_DOG_MISS_LOG_DIR = dir;
    resetSessionTelemetry();
    try {
      const before = sessionDigest().exportsServed;
      expect(before).toBe(0);
      await GET(req('/api/economy/table?commodity=copper&metric=production&subject=ent:country:cl'));
      await GET(req('/api/economy/table?commodity=copper&view=grid&subject=ent:country:cl&metric=production'));
      expect(sessionDigest().exportsServed).toBe(2);

      const logPath = join(dir, 'export-log.jsonl');
      expect(existsSync(logPath)).toBe(true);
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      expect(lines.length).toBe(2);
      for (const rec of lines) {
        expect(rec.fingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(typeof rec.rows).toBe('number');
        // Canonical vocabulary only in the log — every field is either a
        // validated identifier, an enum, a date, or a number.
        if (rec.subject) expect(rec.subject).toMatch(/^ent:[a-z-]+:[a-z0-9-]+$/);
        if (rec.metric) expect(rec.metric).toMatch(/^[a-z_]+$/);
      }
    } finally {
      delete process.env.SEA_DOG_FORCE_MISS_LOG;
      delete process.env.SEA_DOG_MISS_LOG_DIR;
      rmSync(dir, { recursive: true, force: true });
      resetSessionTelemetry();
    }
  });

  // ── Criterion 7: no export path accepts input — verified structurally,
  //    not by trying verbs. ──
  it('the route module exports GET and only GET; free-text subjects are refused at the boundary before any log write', async () => {
    const handlers = Object.keys(tableRoute).filter(k => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k));
    expect(handlers).toEqual(['GET']); // structural: no mutating verb EXISTS to call
    // The boundary regex refuses free text before it can reach the export
    // log — a person-shaped subject never persists anywhere.
    const dir = mkdtempSync(join(tmpdir(), 'sea-dog-export-refuse-'));
    process.env.SEA_DOG_FORCE_MISS_LOG = '1';
    process.env.SEA_DOG_MISS_LOG_DIR = dir;
    try {
      const res = await GET(req(`/api/economy/table?commodity=copper&subject=${encodeURIComponent('jane doe')}`));
      expect(res.status).toBe(400);
      expect(existsSync(join(dir, 'export-log.jsonl'))).toBe(false); // refused BEFORE the log
    } finally {
      delete process.env.SEA_DOG_FORCE_MISS_LOG;
      delete process.env.SEA_DOG_MISS_LOG_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── Header discipline beyond the seven: the withheld count and row
  //    accounting reach the served export (rows path passes the FULL state
  //    so the table's own filter counts what it withholds). ──
  it('the route-served as_known_then export counts withheld rows instead of silently pre-filtering them', async () => {
    const served = await (await GET(req('/api/economy/table?commodity=copper&metric=production&knowledge=as_known_then&asOf=2019-06-30'))).json();
    expect(served.header.knowledge_state).toEqual({ as_of: '2019-06-30', mode: 'as_known_then' });
    expect(served.header.withheld).toBeGreaterThan(0); // later vintages exist and are COUNTED
    for (const r of served.rows) {
      if (r.known_at) expect(r.known_at <= '2019-06-30').toBe(true);
    }
  });
});
