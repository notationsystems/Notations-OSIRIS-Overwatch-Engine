import { describe, it, expect } from 'vitest';
import { propagateEvents } from './propagation';
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

describe('engine core', () => {
  it('runs all registered systems over the copper state', async () => {
    const run = await runEngine('copper');
    const names = listSystems().map(s => s.name);
    expect(names).toEqual(['concentration', 'centrality', 'bottlenecks', 'anomalies', 'propagation']);
    for (const name of names) {
      expect(run.systems[name], `system ${name}`).toBeDefined();
      expect(run.systems[name].execution.engine).toBeTruthy();
    }
    expect(run.graph.nodes.size).toBeGreaterThan(40);
  });
});
