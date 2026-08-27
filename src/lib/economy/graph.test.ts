import { describe, it, expect } from 'vitest';
import { buildGraph, upstream, downstream, nodeThroughput } from './graph';
import { syntheticState } from './fixtures';
import { getEconomyState } from './store';
import { toKtPerYear } from './types';

describe('economy graph (synthetic)', () => {
  const graph = buildGraph(syntheticState());

  it('keeps flow edges directional', () => {
    const edge = graph.edges.find(e => e.id === 'flow:alpha-gate')!;
    expect(edge.from).toBe('ent:mine:alpha');
    expect(edge.to).toBe('ent:port:gate');
  });

  it('excludes located_in from the traversal graph', () => {
    expect(graph.edges.some(e => e.kind === 'dependency' && e.dependency.type === 'located_in')).toBe(false);
  });

  it('walks downstream from a mine to demand', () => {
    const steps = downstream(graph, 'ent:mine:alpha');
    const ids = steps.map(s => s.entityId);
    expect(ids).toContain('ent:port:gate');
    expect(ids).toContain('ent:smelter:omega');
    expect(ids).toContain('ent:region:demand');
    // Depth ordering: port before smelter before demand.
    const depth = (id: string) => steps.find(s => s.entityId === id)!.depth;
    expect(depth('ent:port:gate')).toBeLessThan(depth('ent:smelter:omega'));
    expect(depth('ent:smelter:omega')).toBeLessThan(depth('ent:region:demand'));
  });

  it('walks upstream from the smelter through flows AND depends_on', () => {
    const steps = upstream(graph, 'ent:smelter:omega');
    const ids = steps.map(s => s.entityId);
    expect(ids).toContain('ent:port:gate');
    expect(ids).toContain('ent:mine:alpha');
    expect(ids).toContain('ent:mine:beta');
    expect(ids).not.toContain('ent:region:demand');
  });

  it('never revisits nodes when flows form a cycle', () => {
    const s = syntheticState();
    s.flows.push({ ...s.flows[0], id: 'flow:back', fromEntityId: 'ent:smelter:omega', toEntityId: 'ent:mine:alpha' });
    const g = buildGraph(s);
    const steps = downstream(g, 'ent:mine:alpha', 20);
    const ids = steps.map(x => x.entityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('basis: a gross-weight flow enters throughput only after face-value refusal — and the refusal is visible', () => {
    const s = syntheticState();
    // Same route, declared gross weight — ~4x fatter than its content basis.
    // At face value it would skew inbound shares toward the fat-basis
    // supplier; as silent zero it would claim the flow carries nothing.
    s.flows.push({
      ...s.flows[0], id: 'flow:alpha-gate-gross', quantity: 1200, basis: 'gross_weight',
    });
    const t = nodeThroughput(buildGraph(s));
    expect(t.get('ent:port:gate')!.inKt).toBe(400); // face value never leaks
    expect(t.get('ent:port:gate')!.flowIds).not.toContain('flow:alpha-gate-gross');
    // With no corridor grade, the tonnage is REFUSED, visibly — on both ends.
    expect(t.get('ent:port:gate')!.unquantifiedFlowIds).toContain('flow:alpha-gate-gross');
    expect(t.get('ent:mine:alpha')!.unquantifiedFlowIds).toContain('flow:alpha-gate-gross');
  });

  it('basis conversion: a gross-only supplier keeps its tonnage via the corridor-implied grade', () => {
    // The case the old firewall silenced: a smelter drawing 100 kt metal_content
    // from A and 400 kt gross from B is DUAL-sourced. Zeroing B made it read
    // single-sourced — supplier count dropped, redundancy inverted, and a
    // disruption at B propagated nothing. Here the mirror pair implies the
    // corridor grade (400 gross vs 100 content → 25%), and B's edge converts.
    const s = syntheticState();
    s.entities.push({ id: 'ent:mine:gamma', kind: 'mine', name: 'Gamma Mine', countryCode: 'BB', lat: 23, lng: 23, geoPrecision: 'site', stage: 'production' });
    s.flows.push({
      ...s.flows[0], id: 'flow:gamma-gate', fromEntityId: 'ent:mine:gamma', quantity: 400, basis: 'gross_weight',
    });
    const prov = s.observations[0].provenance;
    const period = { start: '2024-01-01', end: '2024-12-31' };
    s.observations.push(
      { id: 'obs:mirror:gamma-exp', entityId: 'ent:mine:gamma', partnerEntityId: 'ent:port:gate', metric: 'concentrate_exports', value: 100, unit: 'kt', period, basis: 'metal_content', valueKind: 'reported', confidence: 'medium', provenance: prov },
      { id: 'obs:mirror:gate-imp', entityId: 'ent:port:gate', partnerEntityId: 'ent:mine:gamma', metric: 'concentrate_imports', value: 400, unit: 'kt', period, basis: 'gross_weight', valueKind: 'reported', confidence: 'medium', provenance: prov },
    );
    const g = buildGraph(s);
    const edge = g.edges.find(e => e.id === 'flow:gamma-gate')!;
    expect(edge.kind).toBe('flow');
    if (edge.kind !== 'flow') return;
    expect(edge.ktPerYear).toBeCloseTo(100, 6); // 400 gross × 0.25 implied grade
    expect(edge.basisConversion).toBeDefined();
    expect(edge.basisConversion!.grade).toBeCloseTo(0.25, 6);
    // The uncertainty band travels with the conversion: 20–33% Cu.
    expect(edge.basisConversion!.ktRange[0]).toBeCloseTo(80, 6);
    expect(edge.basisConversion!.ktRange[1]).toBeCloseTo(132, 6);
    expect(edge.basisConversion!.derivedFrom).toEqual(['obs:mirror:gamma-exp', 'obs:mirror:gate-imp']);
    // The port is dual-plus-sourced again: gamma's tonnage is real throughput.
    const t = nodeThroughput(g);
    expect(t.get('ent:port:gate')!.inKt).toBeCloseTo(500, 6); // 300 + 100 + 100
    expect(t.get('ent:port:gate')!.flowIds).toContain('flow:gamma-gate');
    expect(t.get('ent:port:gate')!.unquantifiedFlowIds).toEqual([]);
  });

  it('basis refusal: a gross-only node without a grade stays PRESENT, with shares refused', () => {
    // The worst case: every inbound edge gross-reported, no counterpart.
    // Under the zeroing firewall total_in read 0 and the node (plus its
    // downstream propagation tonnage) went dark. Now it must stay visible
    // with its tonnage explicitly refused.
    const s = syntheticState();
    s.entities.push({ id: 'ent:smelter:dark', kind: 'smelter', name: 'Dark Smelter', countryCode: 'BB', lat: 24, lng: 24, geoPrecision: 'site', stage: 'smelting' });
    s.flows.push({
      ...s.flows[0], id: 'flow:gate-dark', fromEntityId: 'ent:port:gate', toEntityId: 'ent:smelter:dark', quantity: 800, basis: 'gross_weight',
    });
    const g = buildGraph(s);
    const t = nodeThroughput(g);
    // Present, not vanished.
    expect(t.has('ent:smelter:dark')).toBe(true);
    expect(t.get('ent:smelter:dark')!.unquantifiedFlowIds).toEqual(['flow:gate-dark']);
    // Reachability was never in question — the edge traverses.
    expect(downstream(g, 'ent:port:gate').map(x => x.entityId)).toContain('ent:smelter:dark');
  });

  it('sums throughput per node from flow edges', () => {
    const t = nodeThroughput(graph);
    expect(t.get('ent:port:gate')).toMatchObject({ inKt: 400, outKt: 400 });
    expect(t.get('ent:smelter:omega')).toMatchObject({ inKt: 400, outKt: 380 });
  });
});

describe('economy graph (copper)', () => {
  it('traverses Escondida → Antofagasta → Shanghai → Chinese smelters → fabrication', async () => {
    const { state } = await getEconomyState('copper');
    const graph = buildGraph(state);
    const ids = downstream(graph, 'ent:mine:escondida').map(s => s.entityId);
    expect(ids).toContain('ent:port:antofagasta');
    expect(ids).toContain('ent:port:shanghai');
    expect(ids).toContain('ent:smelter:guixi');
    expect(ids).toContain('ent:region:china-fabrication');
  });

  it('finds Grasberg upstream of the Manyar smelter (flow + depends_on agree)', async () => {
    const { state } = await getEconomyState('copper');
    const graph = buildGraph(state);
    const ids = upstream(graph, 'ent:smelter:manyar').map(s => s.entityId);
    expect(ids).toContain('ent:port:amamapare');
    expect(ids).toContain('ent:mine:grasberg');
  });

  it('every flow unit in every state parses — a refusal can never fire on unit while claiming basis', async () => {
    // The wrong-attribution audit's property pin (the 'kt gross/y'
    // finding): an unparseable unit made gross corridors refuse BEFORE the
    // grade lookup ran — right outcome, wrong mechanism, wrong remedy.
    // The property, not the enumeration: every flow unit the assembled
    // states actually carry converts, so the only reachable tonnage
    // refusal mechanisms are the basis firewall's own (no grade, no
    // constant), which carry the right remedies.
    for (const commodity of ['copper', 'aluminium']) {
      const { state } = await getEconomyState(commodity);
      expect(state.flows.length).toBeGreaterThan(0); // vacuity
      for (const f of state.flows) {
        expect(toKtPerYear(f.quantity, f.unit), `${commodity} ${f.id} unit "${f.unit}"`).not.toBeNull();
      }
    }
  });
});
