import { describe, it, expect } from 'vitest';
import { propagateEvents, topologyValidity } from './propagation';
import { buildGraph } from './graph';
import { searchEvidence } from './evidenceSearch';
import { syntheticState, FIXTURE_PROV } from './fixtures';
import { getEconomyState } from './store';
import { runEngine, listSystems } from './engine';

describe('event propagation (synthetic)', () => {
  it('propagates a port outage downstream with alternatives and dependents', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:gate-outage', entityId: 'ent:port:gate', type: 'outage',
      title: 'Gate Port closed', start: '2024-06-01', end: '2024-09-01', severity: 'high',
      provenance: FIXTURE_PROV,
    });
    const r = propagateEvents(s, buildGraph(s), { asOf: '2024-07-01' });
    expect(r.result).toHaveLength(1);
    const impact = r.result[0];
    expect(impact.active).toBe(true);
    expect(impact.disruptedKtPerYear).toBe(400);
    expect(impact.affected.map(a => a.entityId)).toContain('ent:smelter:omega');
    expect(impact.affected.map(a => a.entityId)).toContain('ent:region:demand');
    // The smelter declared depends_on the port.
    expect(impact.dependents).toEqual([{ entityId: 'ent:smelter:omega', name: 'Omega Smelter', strength: 0.9 }]);
    // No other port exists → no alternatives.
    expect(impact.alternatives).toEqual([]);
    // Evidence identity present.
    expect(impact.flowIds.length).toBeGreaterThan(0);
  });

  it('marks an event outside its window as inactive context', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:gate-outage', entityId: 'ent:port:gate', type: 'outage',
      title: 'Gate Port closed', start: '2024-06-01', end: '2024-09-01', severity: 'high',
      provenance: FIXTURE_PROV,
    });
    const r = propagateEvents(s, buildGraph(s), { asOf: '2025-01-01' });
    expect(r.result[0].active).toBe(false);
  });
});

describe('event propagation (copper)', () => {
  it('propagates the Grasberg disruption to Indonesian smelters', async () => {
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state), { asOf: '2025-10-01' });
    const grasberg = r.result.find(i => i.eventId === 'evt:grasberg-mud-rush-2025');
    expect(grasberg).toBeDefined();
    expect(grasberg!.active).toBe(true);
    expect(grasberg!.disruptedKtPerYear).toBeGreaterThan(500);
    const affectedIds = grasberg!.affected.map(a => a.entityId);
    expect(affectedIds).toContain('ent:port:amamapare');
    expect(affectedIds).toContain('ent:smelter:gresik');
    expect(affectedIds).toContain('ent:smelter:manyar');
    // Gresik + Manyar declared depends_on Grasberg.
    expect(grasberg!.dependents.length).toBeGreaterThanOrEqual(2);
  });

  it('treats the flow-less Cobre Panamá closure as structural, not flow interruption', async () => {
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state), { asOf: '2026-08-26' });
    const panama = r.result.find(i => i.eventId === 'evt:cobre-panama-closure');
    expect(panama).toBeDefined();
    expect(panama!.disruptedKtPerYear).toBe(0);
    expect(panama!.explanation.join(' ')).toContain('structural');
  });
});

describe('regulatory propagation (territory + scope)', () => {
  it('Peru 2020: the country vintage carries the halt — Peruvian mines and foreign receivers, never Chile, tonnage basis-refused', async () => {
    // Work order 3.2: a 2020 evaluation is served by the 2020 country
    // vintage (Peru's reporter-declared corridors), not refused as
    // predating. The graph is built AT the evaluation date — graph and
    // validity share one frame by construction now (graph.selection).
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state, '2020-04-15'), { asOf: '2020-04-15' });
    const peru = r.result.find(i => i.eventId === 'evt:peru-covid-shutdown-2020')!;
    expect(peru).toBeDefined();
    expect(peru.active).toBe(true);
    const affected = peru.affected.map(a => a.entityId);
    // In-scope: Peruvian production-stage entities…
    expect(affected).toContain('ent:mine:cerro-verde');
    expect(affected).toContain('ent:mine:antamina');
    expect(affected).toContain('ent:mine:las-bambas');
    // …and the halt's material reach is the vintage's corridors: the
    // jurisdiction's country node and the receivers of its concentrate
    // (the staged scope binds country corridors through the FORM —
    // concentrate is production-stage output in every modeled chain).
    expect(affected).toContain('ent:country:pe');
    expect(affected).toContain('ent:country:cn');
    expect(affected).toContain('ent:country:jp');
    // Facility detail is NOT visible at country granularity: no port hop.
    expect(affected).not.toContain('ent:port:callao');
    // Territory means territory: Chilean mines are untouched.
    expect(affected).not.toContain('ent:mine:escondida');
    // Peru declares GROSS weight and no mirror-implied grade exists for its
    // corridors — the tonnage is basis-REFUSED (null, unknown), with the
    // corridor grade named as the remedy. Reach is real; the number is not
    // fabricable from a 4x-wrong basis.
    expect(peru.disruptedKtPerYear).toBeNull();
    expect(peru.explanation.join(' ')).toContain('corridor grade');
    expect(peru.explanation.join(' ')).toContain('COUNTRY-granularity vintage 2020');
    // A facility event under the country vintage refuses with the
    // allocation model named — country granularity cannot attribute one
    // mine's share of its country's trade.
    const strike = r.result.find(i => i.eventId === 'evt:escondida-strike-2017')!;
    expect(strike.disruptedKtPerYear).toBeNull();
    expect(strike.explanation.join(' ')).toContain('ALLOCATION MODEL');
  });

  it('Grasberg 2017: the export halt finds its real crossing corridors in the 2017 vintage — receivers named, tonnage basis-refused', async () => {
    // Round 12 pinned this as an honest 0 (the modeled facility topology is
    // the post-2023 domestic regime); round 13 made it null (predates).
    // Work order 3.2 lands the world that was actually there: Indonesia's
    // reporter-declared 2017 exports — the flows the halt actually stopped.
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state, '2017-02-15'), { asOf: '2017-02-15' });
    const halt = r.result.find(i => i.eventId === 'evt:grasberg-export-halt-2017')!;
    expect(halt).toBeDefined();
    expect(halt.active).toBe(true);
    expect(halt.explanation.join(' ')).toContain('Export halt');
    const affected = halt.affected.map(a => a.entityId);
    // The real 2017 receivers (Comtrade reporter-declared, captured
    // 2026-08-27): Japan, Korea, China, India — the flows that stopped.
    expect(affected).toContain('ent:country:id');
    expect(affected).toContain('ent:country:jp');
    expect(affected).toContain('ent:country:in');
    expect(affected).not.toContain('ent:smelter:gresik'); // domestic — spared
    expect(affected).not.toContain('ent:smelter:manyar');
    // Indonesia declares gross weight; no mirror grade → REFUSED, not zero.
    expect(halt.disruptedKtPerYear).toBeNull();
    expect(halt.explanation.join(' ')).toContain('corridor grade');
    expect(r.operation.params.topologyGranularity).toBe('country');
    expect(r.operation.params.topologyVintage).toBe('2017');
  });

  it('a TRUE predates date (before the earliest vintage) still refuses everything as null', async () => {
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state, '2015-06-01'), { asOf: '2015-06-01' });
    expect(r.operation.params.topologyStatus).toBe('predates');
    for (const i of r.result) expect(i.disruptedKtPerYear, i.eventId).toBeNull();
  });

  it('a graph built for a LATER world refuses a historical evaluation — the graph, not the date, decides the frame', async () => {
    // The incoherence this exists to prevent: hand propagateEvents a
    // facility graph (built without asOf) and evaluate at 2020 — the old
    // wiring re-selected the 2020 vintage for the LABEL while summing
    // FACILITY edges for the number. Now validity classifies against the
    // graph's own selection: this call is honestly 'predates', and the note
    // names the rebuild remedy.
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state), { asOf: '2020-04-15' });
    expect(r.operation.params.topologyStatus).toBe('predates');
    const peru = r.result.find(i => i.eventId === 'evt:peru-covid-shutdown-2020')!;
    expect(peru.disruptedKtPerYear).toBeNull();
    expect(peru.explanation.join(' ')).toContain('predates');
    expect(peru.explanation.join(' ')).toContain('build the graph at the evaluation date');
  });

  it('where the basis resolves, the vintage QUANTIFIES: a scenario-posed Chilean export ban at 2019 states real tonnage', async () => {
    // Chile declares CONTAINED METAL under HS 2603 (the mirror-established
    // deviation) — its vintage corridors are metal_content and quantify
    // directly. The refusals above are basis-honesty, not a blanket rule.
    const run = await runEngine('copper', {
      asOf: '2019-06-01',
      scenario: {
        id: 'cl-export-ban-2019', label: 'Chile concentrate export ban (posed, 2019)',
        events: [{
          entityId: 'ent:country:cl', type: 'policy', title: 'Export ban (posed)', start: '2019-06-01', severity: 'high',
          regulatoryScope: { jurisdictionCountryCode: 'CL', commodity: 'copper', direction: 'export' },
        }],
      },
    });
    const impacts = (run.systems.propagation as { result: Array<{ eventId: string; affected: Array<{ entityId: string }>; disruptedKtPerYear: number | null; explanation: string[] }> }).result;
    const ban = impacts.find(i => i.eventId.startsWith('evt:scenario:cl-export-ban-2019'))!;
    // CL 2019 mapped corridors: CN 1694 + JP 599 + KR 280 + IN 150 = 2723 kt
    // contained metal (reporter-declared, captured 2026-08-27).
    expect(ban.disruptedKtPerYear).toBe(2723);
    const affected = ban.affected.map(a => a.entityId);
    expect(affected).toContain('ent:country:cn');
    expect(affected).toContain('ent:country:jp');
  });

  it('a scenario-posed Chilean export ban halts crossing flows and spares domestic smelting', async () => {
    const run = await runEngine('copper', {
      asOf: '2024-06-15',
      scenario: {
        id: 'cl-export-ban', label: 'Chile concentrate/cathode export ban (hypothetical)',
        events: [{
          entityId: 'ent:country:cl', type: 'policy', title: 'Export ban (posed)', start: '2024-06-01', severity: 'high',
          regulatoryScope: { jurisdictionCountryCode: 'CL', commodity: 'copper', direction: 'export' },
        }],
      },
    });
    const impacts = (run.systems.propagation as { result: Array<{ eventId: string; affected: Array<{ entityId: string }>; disruptedKtPerYear: number }> }).result;
    const ban = impacts.find(i => i.eventId.startsWith('evt:scenario:cl-export-ban'))!;
    const affected = ban.affected.map(a => a.entityId);
    // Crossing flows stop: foreign receivers and their downstream feel it…
    expect(affected).toContain('ent:smelter:saganoseki');
    expect(affected).toContain('ent:port:shanghai');
    expect(affected).toContain('ent:smelter:guixi');
    // …while production and DOMESTIC processing continue.
    expect(affected).not.toContain('ent:smelter:caletones');
    expect(ban.disruptedKtPerYear).toBeGreaterThan(2000);
  });

  it('a predating refusal never carries the basis remedy — attribution, not just outcome', () => {
    // The wrong-attribution species (the 'kt gross/y' finding, audited
    // for): a refusal correct in outcome and wrong in attribution sends
    // work to the wrong place, and is invisible to any test that only
    // asserts a refusal occurred. The discriminating state: a facility
    // graph with an unquantifiable gross crossing corridor, evaluated at
    // a PREDATING date. The pre-fix behavior pushed the corridor-grade
    // remedy (and the evidence search then typed the hit 'basis'); the
    // correct attribution is topology, with the rebuild/serving remedy.
    const s = syntheticState();
    s.flows.push({
      // A CROSSING corridor (AA → BB) — the export branch counts it; the
      // fixture's alpha→gate flows are domestic and would be spared.
      id: 'flow:planted-gross-export', fromEntityId: 'ent:port:gate', toEntityId: 'ent:smelter:omega',
      commodity: 'testium', form: 'concentrate', quantity: 500, unit: 'kt gross/y',
      basis: 'gross_weight', period: { start: '2024-01-01', end: '2024-12-31' },
      mode: 'sea', valueKind: 'representative', confidence: 'medium', provenance: FIXTURE_PROV,
    });
    s.events.push({
      id: 'evt:planted-export-ban', entityId: 'ent:port:gate', type: 'policy',
      title: 'Export ban (planted)', start: '2015-01-01', end: '2015-06-01', severity: 'high',
      regulatoryScope: { jurisdictionCountryCode: 'AA', direction: 'export' },
      provenance: FIXTURE_PROV,
    });
    const graph = buildGraph(s); // facility topology (2024)
    const r = propagateEvents(s, graph, { asOf: '2015-03-01' });
    const ban = r.result.find(i => i.eventId === 'evt:planted-export-ban')!;
    expect(ban.disruptedKtPerYear).toBeNull();
    const text = ban.explanation.join(' ');
    expect(text).toContain('predates');
    // The discriminating assertions — these FAIL under the pre-fix
    // behavior, where the basis notes pushed regardless of predates:
    expect(text).not.toContain('corridor grade');
    expect(text).not.toContain('LOWER BOUND');
    // And the typed-refusal surface attributes it to topology, not basis.
    const hits = searchEvidence(s, graph, { kind: 'refused', type: 'topology', terms: ['planted'] }, { asOf: '2015-03-01' });
    expect(hits.some(h => h.title.includes('Export ban (planted)'))).toBe(true);
    const basisHits = searchEvidence(s, graph, { kind: 'refused', type: 'basis', terms: ['planted'] }, { asOf: '2015-03-01' });
    expect(basisHits.some(h => h.title.includes('Export ban (planted)'))).toBe(false);
  });

  it('a regulatory event without a scope is refused, not guessed', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:unscoped-policy', entityId: 'ent:port:gate', type: 'policy',
      title: 'Unscoped decree', start: '2024-06-01', severity: 'medium', provenance: FIXTURE_PROV,
    });
    const r = propagateEvents(s, buildGraph(s), { asOf: '2024-06-15' });
    const unscoped = r.result.find(i => i.eventId === 'evt:unscoped-policy')!;
    expect(unscoped.affected).toEqual([]);
    // Refused means null: a 0 here would read as "no effect", which is an
    // answer this event was never given.
    expect(unscoped.disruptedKtPerYear).toBeNull();
    expect(unscoped.explanation.join(' ')).toContain('refused rather than guessed');
  });
});

describe('topology validity (what WAS vs what was KNOWN)', () => {
  it('classifies the evaluation date against the union of flow periods', () => {
    const s = syntheticState(); // all flows 2024-01-01..2024-12-31
    expect(topologyValidity(s, '2024-07-01').status).toBe('within');
    // With vintages in the model, 'predates' means "before the earliest
    // topology material of ANY granularity" and selects nothing: the period
    // is null (nothing serves), and the note names where material begins.
    expect(topologyValidity(s, '2017-02-15')).toMatchObject({
      status: 'predates',
      topologyPeriod: null,
    });
    expect(topologyValidity(s, '2017-02-15').note).toContain('earliest material');
    expect(topologyValidity(s, '2017-02-15').note).toContain('null (unknown), not zero');
    // Forward is the standard latest-claim-at-asOf convention: the snapshot
    // serves as latest-known structure, labeled — never silently.
    const ahead = topologyValidity(s, '2026-08-27');
    expect(ahead.status).toBe('extrapolated');
    expect(ahead.note).toContain('latest-known structure');
    // Extrapolation is QUANTIFIED, not just flagged: against a fixed
    // snapshot the status is permanently 'extrapolated' for live
    // evaluations, so the distance is the number that actually moves.
    expect(ahead.extrapolationDays).toBe(604);
    expect(ahead.note).toContain('604 days past the period');
  });

  it('the evidence trigger fires on the real register: Grasberg force majeure contradicts extrapolation today', async () => {
    // Elapsed time is a proxy for "something probably changed"; the event
    // register holds the thing itself. The open-ended Sep-2025 mud rush
    // postdates the 2024 snapshot — first-hand evidence the Indonesian
    // concentrate topology moved, months ahead of the clock ceiling.
    const { state } = await getEconomyState('copper');
    const now = topologyValidity(state, '2026-08-27');
    expect(now.status).toBe('extrapolated');
    expect(now.structuralEvidence!.map(e => e.id)).toContain('evt:grasberg-mud-rush-2025');
    expect(now.note).toContain('STRUCTURE HAS MOVED');
    // Transience is not movement: Kakula's disruption has a curated end —
    // the structure came back, so it never appears as evidence.
    expect(now.structuralEvidence!.map(e => e.id)).not.toContain('evt:kakula-seismic-2025');
    // No future leak: scrubbed to mid-2025, the mud rush has not happened
    // yet — extrapolation is uncontradicted at that date.
    const before = topologyValidity(state, '2025-08-01');
    expect(before.status).toBe('extrapolated');
    expect(before.structuralEvidence).toBeUndefined();
    expect(before.note).not.toContain('STRUCTURE HAS MOVED');
  });

  it('the evidence trigger honours the knowledge state: occurrence under best_known, first report under as_known_then', async () => {
    const { state } = await getEconomyState('copper');
    const ev = state.events.find(e => e.id === 'evt:grasberg-mud-rush-2025')!;
    // Vacuity: this pin proves something only while the two dates differ —
    // the mud rush occurred 09-08 and entered the evidence base 09-10.
    expect(ev.firstReportedAt! > ev.start).toBe(true);
    // In the occurrence→report window, the contradiction EXISTS (the world
    // moved) but is not yet KNOWABLE: best_known fires, as_known_then must
    // not — firing there would be hindsight leakage in the mode built to
    // exclude it.
    const best = topologyValidity(state, '2025-09-09');
    expect(best.structuralEvidence!.map(e => e.id)).toContain('evt:grasberg-mud-rush-2025');
    const known = topologyValidity(state, '2025-09-09', 'as_known_then');
    expect((known.structuralEvidence ?? []).map(e => e.id)).not.toContain('evt:grasberg-mud-rush-2025');
    // From the report date the two modes agree again.
    const knownAfter = topologyValidity(state, '2025-09-10', 'as_known_then');
    expect(knownAfter.structuralEvidence!.map(e => e.id)).toContain('evt:grasberg-mud-rush-2025');
  });

  it('an extrapolated evaluation keeps its figures and carries the label', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:gate-outage', entityId: 'ent:port:gate', type: 'outage',
      title: 'Gate Port closed', start: '2026-06-01', severity: 'high',
      provenance: FIXTURE_PROV,
    });
    const r = propagateEvents(s, buildGraph(s), { asOf: '2026-07-01' });
    const impact = r.result[0];
    expect(impact.disruptedKtPerYear).toBe(400); // latest-known structure serves
    expect(impact.explanation.join(' ')).toContain('latest-known structure');
    expect(r.operation.params.topologyStatus).toBe('extrapolated');
  });
});

describe('engine core', () => {
  it('runs all registered systems over the copper state', async () => {
    const run = await runEngine('copper');
    const names = listSystems().map(s => s.name);
    expect(names).toEqual(['concentration', 'centrality', 'bottlenecks', 'anomalies', 'coverage', 'divergence', 'propagation']);
    for (const name of names) {
      expect(run.systems[name], `system ${name}`).toBeDefined();
      expect(run.systems[name].execution.engine).toBeTruthy();
    }
    expect(run.graph.nodes.size).toBeGreaterThan(40);
  });
});
