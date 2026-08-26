import { describe, it, expect } from 'vitest';
import { buildGraph, upstream, downstream, nodeThroughput } from './graph';
import { syntheticState } from './fixtures';
import { getEconomyState } from './store';

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
});
