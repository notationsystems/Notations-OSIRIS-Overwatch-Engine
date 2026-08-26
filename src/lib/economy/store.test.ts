import { describe, it, expect } from 'vitest';
import { getEconomyState, entityDetail } from './store';

describe('economy store (curated copper assembly)', () => {
  it('assembles a valid copper state from the curated adapter', async () => {
    const { state, issues, providers } = await getEconomyState('copper');
    expect(providers).toContain('curated-copper-v1');
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(state.entities.length).toBeGreaterThan(40);
    expect(state.flows.length).toBeGreaterThan(20);
    expect(state.observations.length).toBeGreaterThan(40);
  });

  it('rejects a commodity with no adapter', async () => {
    await expect(getEconomyState('unobtainium')).rejects.toThrow(/No adapter/);
  });

  it('preserves provenance on every observation, flow, capacity and event', async () => {
    const { state } = await getEconomyState('copper');
    const all = [...state.observations, ...state.flows, ...state.capacities, ...state.dependencies, ...state.events];
    for (const rec of all) {
      expect(rec.provenance.sourceId, `record ${rec.id}`).toBeTruthy();
      expect(rec.provenance.retrievedAt, `record ${rec.id}`).toBeTruthy();
    }
  });

  it('marks every curated quantitative record as representative — never reported', async () => {
    const { state } = await getEconomyState('copper');
    for (const rec of [...state.observations, ...state.flows, ...state.capacities]) {
      expect(rec.valueKind, `record ${rec.id}`).toBe('representative');
    }
  });

  it('derives located_in dependencies from countryCode', async () => {
    const { state } = await getEconomyState('copper');
    const locs = state.dependencies.filter(d => d.type === 'located_in');
    expect(locs.length).toBeGreaterThan(20);
    const escondida = locs.find(d => d.fromEntityId === 'ent:mine:escondida');
    expect(escondida?.toEntityId).toBe('ent:country:cl');
    // Derived records must say they are derived, not sourced.
    expect(escondida?.provenance.sourceId).toBe('osiris-derived');
  });

  it('entityDetail returns observations, flows and events for a mine', async () => {
    const { state } = await getEconomyState('copper');
    const detail = entityDetail(state, 'ent:mine:grasberg');
    expect(detail).not.toBeNull();
    expect(detail!.observations.some(o => o.metric === 'production')).toBe(true);
    expect(detail!.flowsOut.length).toBeGreaterThan(0);
    expect(detail!.events.some(e => e.id === 'evt:grasberg-mud-rush-2025')).toBe(true);
    expect(entityDetail(state, 'ent:mine:nope')).toBeNull();
  });
});
