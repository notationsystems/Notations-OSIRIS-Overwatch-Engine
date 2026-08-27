import { describe, it, expect } from 'vitest';
import { formConversionFor } from './stageConversion';
import { buildGraph, type FlowEdge } from './graph';
import { getEconomyState } from './store';
import type { EconomyState, Flow } from './types';

// Facility-shaped endpoints: a country→country plant would land in the
// vintage partition and be excluded by the facility selection (3.2's
// granularity firewall doing its job).
const GROSS_FLOW = (over: Partial<Flow>): Flow => ({
  id: 'flow:planted', fromEntityId: 'ent:mine:planted-bauxite', toEntityId: 'ent:port:planted',
  commodity: 'aluminium', form: 'ore', quantity: 1000, unit: 'kt gross/y',
  basis: 'gross_weight', period: { start: '2024-01-01', end: '2024-12-31' },
  mode: 'sea', valueKind: 'representative', confidence: 'medium',
  provenance: { sourceId: 'test', sourceName: 'test', retrievedAt: '2026-08-27T00:00:00Z' },
  ...over,
});

describe('form-level stage conversion (work order 3.5)', () => {
  it('a gross bauxite flow converts with a stated factor, source, and uncertainty band', async () => {
    const { state } = await getEconomyState('aluminium');
    const s: EconomyState = { ...state, flows: [...state.flows, GROSS_FLOW({ id: 'flow:planted-bauxite' })] };
    const edge = buildGraph(s).edges.find(e => e.id === 'flow:planted-bauxite') as FlowEdge;
    expect(edge.basisUnresolved).toBeUndefined();
    // 1000 kt gross bauxite × 0.222 = 222 kt contained Al, band [200, 250].
    expect(edge.ktPerYear).toBeCloseTo(222, 6);
    expect(edge.basisConversion!.grade).toBe(0.222);
    expect(edge.basisConversion!.ktRange).toEqual([200, 250]);
    expect(edge.basisConversion!.source).toContain('bauxite');
    expect(edge.basisConversion!.derivedFrom).toBeUndefined(); // constant, not a mirror grade
  });

  it('a gross alumina flow converts under the stoichiometric ceiling', async () => {
    const { state } = await getEconomyState('aluminium');
    const s: EconomyState = { ...state, flows: [...state.flows, GROSS_FLOW({ id: 'flow:planted-alumina', form: 'alumina', quantity: 100 })] };
    const edge = buildGraph(s).edges.find(e => e.id === 'flow:planted-alumina') as FlowEdge;
    expect(edge.ktPerYear).toBeCloseTo(52, 6);
    expect(edge.basisConversion!.ktRange[1]).toBeLessThanOrEqual(52.9 + 1e-9); // Al share of Al2O3 caps at 0.529
    expect(edge.basisConversion!.source).toContain('Stoichiometric');
  });

  it('NEVER uses a copper constant: a planted cross-commodity lookup fails, and the flow refuses through refused:basis', async () => {
    // The lookup consults exactly one commodity's sub-table. Copper has no
    // form-level constants AT ALL (its concentrate converts per-corridor
    // via mirror grades — a form-level fallback would erase the corridor
    // variance the mirror system measures), so every cross-commodity
    // pairing misses:
    expect(formConversionFor('copper', 'ore')).toBeUndefined();
    expect(formConversionFor('copper', 'alumina')).toBeUndefined();
    expect(formConversionFor('copper', 'concentrate')).toBeUndefined();
    expect(formConversionFor('aluminium', 'concentrate')).toBeUndefined(); // no concentrate in this chain
    // And the graph shows the refusal, not a borrowed number: a planted
    // gross COPPER flow in bauxite's form gets no aluminium constant.
    const { state } = await getEconomyState('copper');
    const s: EconomyState = {
      ...state,
      flows: [...state.flows, GROSS_FLOW({ id: 'flow:planted-cross', commodity: 'copper' })],
    };
    const edge = buildGraph(s).edges.find(e => e.id === 'flow:planted-cross') as FlowEdge;
    expect(edge.ktPerYear).toBeNull();
    expect(edge.basisUnresolved).toBe(true);
  });

  it('aluminium flows curated in contained metal are untouched', async () => {
    const { state } = await getEconomyState('aluminium');
    const graph = buildGraph(state);
    const metalEdges = graph.edges.filter((e): e is FlowEdge => e.kind === 'flow' && e.flow.basis === 'metal_content');
    expect(metalEdges.length).toBeGreaterThan(0); // vacuity: the curated chain is present
    for (const e of metalEdges) {
      expect(e.basisConversion, e.id).toBeUndefined();
      expect(e.ktPerYear, e.id).not.toBeNull();
    }
  });
});
