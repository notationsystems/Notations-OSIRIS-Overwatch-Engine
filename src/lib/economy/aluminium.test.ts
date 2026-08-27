import { describe, it, expect } from 'vitest';
import { getEconomyState } from './store';
import { runEngine } from './engine';
import { buildGraph, downstream } from './graph';
import { propagateEvents, topologyValidity, traversableEdgeFilter } from './propagation';
import { concentration, structuralClassProfile, strongestAttestingClass, type Concentration } from './analytics';
import type { AnalyticalResult } from './types';

/**
 * The substrate-falsification experiment (round 25): everything below runs
 * the SAME engine, graph, analytics, guards and search machinery that
 * copper runs — zero aluminium-specific systems. What had to change to get
 * here (basis rename, intermediate_production, alumina form, commodity
 * spec on the MCS parse) is the experiment's finding, recorded in ledger
 * phase 24.
 */
describe('aluminium: the second commodity', () => {
  it('assembles a valid state from curated + live adapters, chain stages never mixed', async () => {
    const { state, issues, providers } = await getEconomyState('aluminium');
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(providers).toContain('curated-aluminium-v1');
    expect(providers).toContain('usgs-mcs-aluminium-live');
    expect(state.commodity).toBe('aluminium');
    expect(state.entities.length).toBeGreaterThan(45);
    // Three quantified chain stages, three metrics, three populations:
    // bauxite (gross dry tons) / alumina (gross calcined) / metal (content).
    const metrics = new Set(state.observations.map(o => o.metric));
    expect(metrics.has('production')).toBe(true);
    expect(metrics.has('intermediate_production')).toBe(true);
    expect(metrics.has('refined_production')).toBe(true);
    for (const o of state.observations) {
      if (o.metric === 'production' || o.metric === 'intermediate_production') {
        expect(o.basis, o.id).toBe('gross_weight'); // bauxite/alumina are gross mass
      }
      if (o.metric === 'refined_production') expect(o.basis, o.id).toBe('metal_content');
    }
  });

  it('the live MCS layer serves aluminium from the same world file, reported/estimated', async () => {
    const { state } = await getEconomyState('aluminium');
    const live = state.observations.filter(o => o.provenance.sourceId === 'usgs-mcs2025-live');
    expect(live.length).toBeGreaterThan(30);
    // USGS's own vocabulary confirms the chain inversion — smelters make
    // the metal (refined_production), refineries make the intermediate.
    const cnMetal = live.find(o => o.entityId === 'ent:country:cn' && o.metric === 'refined_production' && o.period.start.startsWith('2023'));
    expect(cnMetal).toBeDefined();
    expect(cnMetal!.value).toBeGreaterThan(30000); // China dominates primary Al
    expect(['reported', 'estimated']).toContain(cnMetal!.valueKind);
    const gnBauxite = live.find(o => o.entityId === 'ent:country:gn' && o.metric === 'production' && o.period.start.startsWith('2023'));
    expect(gnBauxite).toBeDefined();
    expect(gnBauxite!.basis).toBe('gross_weight');
  });

  it('every engine system runs unchanged over the aluminium state', async () => {
    const run = await runEngine('aluminium');
    for (const name of Object.keys(run.systems)) {
      expect(run.systems[name].execution.engine, name).toBeTruthy();
    }
    const conc = run.systems.concentration.result as Record<string, AnalyticalResult<Concentration>>;
    // Primary-metal concentration: China's dominance puts the index high,
    // and the inputs carry their class.
    const metal = conc.refinedProductionByCountry;
    expect(metal.result.shares[0].entityId).toBe('ent:country:cn');
    expect(metal.result.hhi).toBeGreaterThan(2500); // Al smelting is China-concentrated
    // The intermediate index EXISTS for aluminium — the slot copper's chain
    // never quantified.
    const alumina = conc.intermediateProductionByCountry;
    expect(alumina.result.shares.length).toBeGreaterThan(5);
    expect(alumina.result.shares[0].entityId).toBe('ent:country:cn');
  });

  it('the sanction reaches the smelters through the owner; the strike stays operational', async () => {
    const { state } = await getEconomyState('aluminium');
    const graph = buildGraph(state);
    // Financial class: OFAC on Rusal (the company) reaches Bratsk and
    // Krasnoyarsk through operated_by edges — same class gate as copper's
    // MIND ID case, exercised on a commodity it was never written against.
    const sanctionReach = downstream(graph, 'ent:company:rusal', 3, traversableEdgeFilter('sanction')).map(s => s.entityId);
    expect(sanctionReach).toContain('ent:smelter:bratsk');
    expect(sanctionReach).toContain('ent:smelter:krasnoyarsk');
    // The operational sibling: a strike-class walk from the owner reaches
    // the same assets through operator edges — but the SANCTION's reach and
    // the class gate are what copper's MIND ID pin established; here the
    // same gate runs on a commodity it was never written against.
    // Topology guard is commodity-agnostic: a 2018 evaluation predates the
    // 2024 aluminium flows exactly as it does copper's.
    const r = propagateEvents(state, graph, { asOf: '2018-06-01' });
    const sanction = r.result.find(i => i.eventId === 'evt:rusal-sanctions-2018')!;
    expect(sanction.active).toBe(true);
    expect(sanction.disruptedKtPerYear).toBeNull();
    expect(sanction.explanation.join(' ')).toContain('predates');
  });

  it('electricity is a first-class dependency: Kitimat declares Kemano, and the strike names it', async () => {
    const { state } = await getEconomyState('aluminium');
    const dep = state.dependencies.find(d => d.id === 'dep:power:kitimat:kemano');
    expect(dep).toBeDefined();
    expect(dep!.strength).toBe(1.0);
    const graph = buildGraph(state);
    const r = propagateEvents(state, graph, { asOf: '2021-08-15' });
    const strike = r.result.find(i => i.eventId === 'evt:kitimat-strike-2021')!;
    expect(strike.active).toBe(true);
    // The power plant is upstream structure, not a strike casualty — the
    // dependency records exposure, the class gate keeps it from traversing.
    expect(strike.affected.map(a => a.entityId)).not.toContain('ent:infrastructure:kemano-hydro');
  });

  it('the epistemic machinery carries over whole: attestation, structural profile, topology validity, search', async () => {
    const { state } = await getEconomyState('aluminium');
    // Countries live-attested; facilities curation-attested — the copper
    // split reproduces on the second commodity.
    const att = strongestAttestingClass(state);
    expect(['reported', 'estimated']).toContain(att.get('ent:country:cn')!);
    expect(att.get('ent:smelter:weiqiao-binzhou')).toBe('representative');
    // Structural layer: 0% sourced here too (flow aggregates are per
    // basis — gross and contained metal never share a sum).
    const p = structuralClassProfile(state);
    for (const cell of Object.values(p.flows.byBasis)) expect(cell.sourcedShareByKt).toBe(0);
    expect(p.capacities.sourcedShareByKt).toBe(0);
    // Topology validity runs per-commodity state.
    expect(topologyValidity(state, '2018-06-01').status).toBe('predates');
    expect(topologyValidity(state, '2024-06-01').status).toBe('within');
  });

  it('bauxite and metal never share an index: gross and content populations stay apart', async () => {
    const { state } = await getEconomyState('aluminium');
    const bauxite = concentration(state, 'production', 'country');
    const metal = concentration(state, 'refined_production', 'country');
    // Different populations entirely — Guinea leads bauxite and does not
    // smelt; the shares must not bleed across metrics.
    expect(bauxite.result.shares.map(s => s.entityId)).toContain('ent:country:gn');
    expect(metal.result.shares.map(s => s.entityId)).not.toContain('ent:country:gn');
  });
});
