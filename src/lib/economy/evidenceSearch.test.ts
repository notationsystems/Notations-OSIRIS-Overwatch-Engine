import { describe, it, expect } from 'vitest';
import { parseEvidenceQuery, searchEvidence, searchEvidenceCensus, evidenceNote, EVIDENCE_TYPES, TYPE_CONDITION } from './evidenceSearch';
import { buildGraph } from './graph';
import { syntheticState, FIXTURE_PROV } from './fixtures';
import { getEconomyState } from './store';

describe('evidence query grammar', () => {
  it('recognizes typed evidence kinds and passes filter terms through', () => {
    expect(parseEvidenceQuery('refused:basis chile')).toEqual({ kind: 'refused', type: 'basis', terms: ['chile'] });
    expect(parseEvidenceQuery('stale')).toEqual({ kind: 'stale', type: undefined, terms: [] });
    expect(parseEvidenceQuery('contested:unexplained')).toEqual({ kind: 'contested', type: 'unexplained', terms: [] });
    expect(parseEvidenceQuery('vintages')).toEqual({ kind: 'vintage', type: undefined, terms: [] });
    // Ordinary entity queries are not evidence queries.
    expect(parseEvidenceQuery('escondida')).toBeNull();
    expect(parseEvidenceQuery('refusedish')).toBeNull();
  });
});

describe('typed refusals — each type is one mechanism with one remedy', () => {
  it('refused:scope surfaces the unscoped regulatory event', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:unscoped', entityId: 'ent:port:gate', type: 'policy',
      title: 'Unscoped decree', start: '2024-06-01', severity: 'medium', provenance: FIXTURE_PROV,
    });
    const hits = searchEvidence(s, buildGraph(s), { kind: 'refused', terms: [] }, { asOf: '2024-06-15' });
    const scope = hits.filter(h => h.type === 'scope');
    expect(scope).toHaveLength(1);
    expect(scope[0].title).toContain('Unscoped decree');
    expect(scope[0].remedy).toContain('regulatoryScope');
  });

  it('refused:topology surfaces predating evaluations, typed apart from scope refusals', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:old-outage', entityId: 'ent:port:gate', type: 'outage',
      title: 'Old outage', start: '2017-01-01', end: '2017-03-01', severity: 'high', provenance: FIXTURE_PROV,
    });
    const hits = searchEvidence(s, buildGraph(s), { kind: 'refused', type: 'topology', terms: [] }, { asOf: '2017-02-01' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].remedy).toContain('flow vintages');
    expect(hits.every(h => h.type === 'topology')).toBe(true);
  });

  it('refused:basis surfaces the unconverted gross-weight flow', () => {
    const s = syntheticState();
    s.flows.push({
      id: 'flow:dark', fromEntityId: 'ent:mine:alpha', toEntityId: 'ent:port:gate',
      commodity: 'testium', form: 'concentrate', quantity: 500, unit: 'kt/y',
      basis: 'gross_weight', period: { start: '2024-01-01', end: '2024-12-31' },
      mode: 'rail', valueKind: 'representative', confidence: 'medium', provenance: FIXTURE_PROV,
    });
    const hits = searchEvidence(s, buildGraph(s), { kind: 'refused', type: 'basis', terms: [] }, { asOf: '2024-06-15' });
    expect(hits).toHaveLength(1);
    expect(hits[0].evidenceIds).toContain('flow:dark');
    expect(hits[0].remedy).toContain('corridor grade');
  });

  it('refused:attribution surfaces the null operator index', () => {
    const s = syntheticState(); // fixture has no operated_by edges
    const hits = searchEvidence(s, buildGraph(s), { kind: 'refused', type: 'attribution', terms: [] }, { asOf: '2024-06-15' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].detail).toContain('empty attributed set');
  });
});

describe('typed staleness', () => {
  it('stale:topology surfaces the extrapolation contradiction, and only when evidence exists', () => {
    const s = syntheticState();
    const none = searchEvidence(s, buildGraph(s), { kind: 'stale', type: 'topology', terms: [] }, { asOf: '2026-06-01' });
    expect(none).toEqual([]); // extrapolated but uncontradicted — not stale:topology
    s.events.push({
      id: 'evt:fm', entityId: 'ent:mine:alpha', type: 'disruption',
      title: 'Force majeure (planted)', start: '2025-05-01', severity: 'high', provenance: FIXTURE_PROV,
    });
    const hits = searchEvidence(s, buildGraph(s), { kind: 'stale', type: 'topology', terms: [] }, { asOf: '2026-06-01' });
    expect(hits).toHaveLength(1);
    expect(hits[0].evidenceIds).toContain('evt:fm');
    expect(hits[0].remedy).toContain('flow vintage');
  });
});

describe('contested and vintage over the real corpus', () => {
  it('contested is typed by divergence class, and the class filter works', async () => {
    const { state } = await getEconomyState('copper');
    const g = buildGraph(state);
    const all = searchEvidence(state, g, { kind: 'contested', terms: [] });
    expect(all.length).toBeGreaterThan(0);
    expect(all.every(h => h.kind === 'contested')).toBe(true);
    const unexplained = searchEvidence(state, g, { kind: 'contested', type: 'unexplained', terms: [] });
    expect(unexplained.length).toBeGreaterThan(0);
    expect(unexplained.every(h => h.type === 'unexplained')).toBe(true);
    expect(unexplained[0].remedy).toContain('Investigate');
  });

  it('vintage lists the source editions actually held, with knowability ranges', async () => {
    const { state } = await getEconomyState('copper');
    const g = buildGraph(state);
    const all = searchEvidence(state, g, { kind: 'vintage', terms: [] });
    expect(all.map(h => h.type)).toContain('usgs-mcs2025-live');
    expect(all.map(h => h.type)).toContain('usgs-mcs2024-vintage');
    for (const h of all) expect(h.detail).toMatch(/knowable \d{4}-\d{2}-\d{2}/);
    // Free terms filter the inventory.
    const usgs = searchEvidence(state, g, { kind: 'vintage', terms: ['usgs'] });
    expect(usgs.length).toBeGreaterThan(0);
    expect(usgs.every(h => `${h.type} ${h.title}`.toLowerCase().includes('usgs'))).toBe(true);
  });
});

/**
 * The wall at the end of the runbook's third move.
 *
 * Found by EXECUTING the runbook against the running instrument rather than
 * reading it: move #3 says "Search `refused:basis`", and today that returns
 * an empty array, the dropdown never opens, and the researcher's first
 * contact with the refusal system is a blank screen indistinguishable from a
 * typo or a dead fetch. The corpus is telling the truth — the gross-weight
 * corridors are country-level, so the type is live at the 2017 vintage and
 * silent under today's facility topology — and the surface was throwing the
 * truth away. Three related drops, all silent, all now accounted for.
 */
describe('the evidence layer accounts for every drop', () => {
  const q = (s: string) => parseEvidenceQuery(s)!;

  it('`refused:` — the token the docs themselves print — is the untyped queue, not an entity miss', () => {
    // docs/RUNBOOK.md: "`refused:` is a work queue, not an error." A reader
    // copies what they read. The old pattern required at least one type
    // character, so the trailing colon fell out of the evidence layer
    // entirely, hit the ENTITY register, matched nothing, and answered with
    // a source-registry gap note about copper.
    expect(q('refused:')).toEqual({ kind: 'refused', type: undefined, terms: [] });
    expect(q('stale:')).toEqual({ kind: 'stale', type: undefined, terms: [] });
    expect(parseEvidenceQuery('refused: chile')).toEqual({ kind: 'refused', type: undefined, terms: ['chile'] });
    // Still not an evidence query when the kind is wrong.
    expect(parseEvidenceQuery('escondida:')).toBeNull();
  });

  it('an UNDECLARED type is refused and names the taxonomy; a declared-but-empty type is not', async () => {
    const { state } = await getEconomyState('copper');
    const g = buildGraph(state);
    // These two states produced the SAME empty array before, and they are
    // not the same fact: one is a typo, the other is a statement about the
    // corpus. Refuse-don't-default, at the query parser.
    const typo = searchEvidenceCensus(state, g, q('refused:bassis'));
    expect(typo.unknownType?.type).toBe('bassis');
    expect(typo.unknownType?.declared).toContain('basis');
    expect(evidenceNote(q('refused:bassis'), typo)).toMatch(/not a declared refused type/);

    const real = searchEvidenceCensus(state, g, q('refused:basis'));
    expect(real.unknownType).toBeUndefined();
    const note = evidenceNote(q('refused:basis'), real)!;
    expect(note).toMatch(/statement about the corpus, not a failure/);
    // And it says WHERE the type lives, which is the half that makes an
    // empty screen usable.
    expect(note).toMatch(/2017-06-30/);
  });

  it('MEASURED: refused:basis is empty under today\'s topology and NON-empty at the 2017 vintage', async () => {
    // The discriminating pair. If this ever inverts, the note above is
    // pointing a researcher at the wrong date and the runbook is stale.
    const { state } = await getEconomyState('copper');
    const today = searchEvidenceCensus(state, buildGraph(state), q('refused:basis'));
    expect(today.total, 'facility topology is single-basis: no gross-weight corridor to refuse').toBe(0);
    const v2017 = searchEvidenceCensus(state, buildGraph(state, '2017-06-30'), q('refused:basis'), { asOf: '2017-06-30' });
    expect(v2017.total, 'the country vintage carries gross-weight corridors — the type must fire there').toBeGreaterThan(0);
    expect(v2017.hits.every(h => h.type === 'basis')).toBe(true);
    expect(v2017.hits[0].remedy).toMatch(/corridor grade/);
  });

  it('the cap is REPORTED, and no type can hide behind it', async () => {
    // The standing queue held 30 records; the route served 20 and the search
    // bar rendered 6, and none of the three said so. Worse than the count:
    // the slice runs over a list built type-by-type, so a type pushed after
    // a fuller one disappears entirely — the researcher reads "these are the
    // refusals" and a whole mechanism is absent.
    const { state } = await getEconomyState('copper');
    const g = buildGraph(state);
    const capped = searchEvidenceCensus(state, g, q('refused'), { limit: 3 });
    expect(capped.shown).toBe(3);
    expect(capped.total).toBeGreaterThan(3);
    expect(capped.truncated).toBe(true);
    expect(evidenceNote(q('refused'), capped)).toMatch(/Showing 3 of \d+/);
    // byType is censused over the WHOLE kind, before the cut.
    const full = searchEvidenceCensus(state, g, q('refused'), { limit: Infinity });
    expect(capped.byType).toEqual(full.byType);
    expect(capped.byType.reduce((s, t) => s + t.count, 0)).toBe(full.total);
    // The uncapped page is not flagged as truncated, and needs no gloss —
    // a note on a complete single-type answer would be noise, and noise is
    // how a real note gets ignored.
    expect(full.truncated).toBe(false);
    expect(evidenceNote(q('refused'), full)).toBeNull();
    // A planted second type survives the cap in the census even when the
    // page cannot show it — the vacuity guard on the assertion above, since
    // today's queue happens to be a single type.
    const planted = { ...full, byType: [...full.byType, { type: 'scope', count: 1 }] };
    expect(evidenceNote(q('refused'), planted)).toMatch(/refused:scope \(1\)/);
  });

  it('TRIPWIRE: every type the mechanisms actually emit is declared in the taxonomy', async () => {
    // A hand-written list of what the code can produce is the literal that
    // agrees with itself and not with the world (defect class 6). It is not
    // trusted: the mechanisms are RUN, across kinds and vintages, and every
    // type they emit must be declared — otherwise a real refusal would be
    // refused as a typo, which is the worse failure of the two.
    const { state } = await getEconomyState('copper');
    const seen = new Map<keyof typeof EVIDENCE_TYPES, Set<string>>();
    for (const asOf of [undefined, '2017-06-30', '2019-06-30', '2022-06-30', '2026-06-30']) {
      const g = buildGraph(state, asOf);
      for (const kind of ['refused', 'stale', 'contested', 'vintage'] as const) {
        const c = searchEvidenceCensus(state, g, { kind, terms: [] }, { asOf, limit: Infinity });
        const set = seen.get(kind) ?? new Set<string>();
        for (const t of c.byType) set.add(t.type);
        seen.set(kind, set);
      }
    }
    for (const [kind, types] of seen) {
      const declared = EVIDENCE_TYPES[kind];
      if (declared === null) continue; // vintage: sourceIds are corpus state
      for (const t of types) {
        expect(declared, `${kind}:${t} is emitted by a mechanism but not declared in EVIDENCE_TYPES`).toContain(t);
        expect(TYPE_CONDITION[`${kind}:${t}`], `${kind}:${t} has no condition line — an empty result for it would say nothing`).toBeTruthy();
      }
    }
    // Not vacuous: the sweep must actually have produced types.
    expect([...seen.values()].reduce((n, s) => n + s.size, 0)).toBeGreaterThan(3);
    // And every DECLARED type carries a condition line, including the ones
    // the corpus is not currently producing.
    for (const [kind, declared] of Object.entries(EVIDENCE_TYPES) as Array<[keyof typeof EVIDENCE_TYPES, readonly string[] | null]>) {
      for (const t of declared ?? []) expect(TYPE_CONDITION[`${kind}:${t}`], `${kind}:${t} declared without a condition line`).toBeTruthy();
    }
  });
});
