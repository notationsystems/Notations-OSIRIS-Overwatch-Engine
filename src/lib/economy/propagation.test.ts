import { describe, it, expect } from 'vitest';
import { propagateEvents, topologyValidity } from './propagation';
import { buildGraph } from './graph';
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
  it('Peru 2020: a jurisdiction-wide mining halt reaches Peruvian mines and their downstream, never Chile', async () => {
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state), { asOf: '2020-04-15' });
    const peru = r.result.find(i => i.eventId === 'evt:peru-covid-shutdown-2020')!;
    expect(peru).toBeDefined();
    expect(peru.active).toBe(true);
    const affected = peru.affected.map(a => a.entityId);
    // In-scope: Peruvian production-stage entities…
    expect(affected).toContain('ent:mine:cerro-verde');
    expect(affected).toContain('ent:mine:antamina');
    expect(affected).toContain('ent:mine:las-bambas');
    // …and the material consequences propagate downstream through the ports.
    expect(affected).toContain('ent:port:callao');
    expect(affected).toContain('ent:smelter:onsan');
    // Territory means territory: Chilean mines are untouched.
    expect(affected).not.toContain('ent:mine:escondida');
    // A 2020 evaluation PREDATES the 2024 flow topology: the reach above is
    // structural, but the tonnage cannot be stated — null, never a number
    // computed from a world that did not yet exist.
    expect(peru.disruptedKtPerYear).toBeNull();
    expect(peru.explanation.join(' ')).toContain('predates');
    // The guard is general, not regulatory-only: every flow-derived figure
    // at a predating date is null — the 2017 Escondida strike included.
    const strike = r.result.find(i => i.eventId === 'evt:escondida-strike-2017')!;
    expect(strike.disruptedKtPerYear).toBeNull();
  });

  it('Grasberg 2017: an export halt spares domestic receivers — and a predating evaluation refuses the tonnage as null', async () => {
    // Round 12 pinned this as an honest 0 with the flow-vintage limitation
    // in prose (the modeled Indonesian topology is the post-2023 domestic-
    // processing regime, so a 2017 halt finds no crossing flows). Round 13
    // converts the documented special case into the enforced invariant:
    // "topology out of period" and "no entity in scope" must never render
    // alike, so a 2017 evaluation against 2024 flows returns null, not 0.
    const { state } = await getEconomyState('copper');
    const r = propagateEvents(state, buildGraph(state), { asOf: '2017-02-15' });
    const halt = r.result.find(i => i.eventId === 'evt:grasberg-export-halt-2017')!;
    expect(halt).toBeDefined();
    expect(halt.active).toBe(true);
    expect(halt.explanation.join(' ')).toContain('Export halt');
    const affected = halt.affected.map(a => a.entityId);
    expect(affected).not.toContain('ent:smelter:gresik'); // domestic — spared
    expect(affected).not.toContain('ent:smelter:manyar');
    expect(halt.disruptedKtPerYear).toBeNull(); // 2017 predates the 2024 topology — refused, not zero
    expect(halt.explanation.join(' ')).toContain('predates');
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
    expect(topologyValidity(s, '2017-02-15')).toMatchObject({
      status: 'predates',
      topologyPeriod: { start: '2024-01-01', end: '2024-12-31' },
    });
    expect(topologyValidity(s, '2017-02-15').note).toContain('null (unknown), not zero');
    // Forward is the standard latest-claim-at-asOf convention: the snapshot
    // serves as latest-known structure, labeled — never silently.
    const ahead = topologyValidity(s, '2026-08-27');
    expect(ahead.status).toBe('extrapolated');
    expect(ahead.note).toContain('latest-known structure');
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
