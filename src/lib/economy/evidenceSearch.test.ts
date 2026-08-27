import { describe, it, expect } from 'vitest';
import { parseEvidenceQuery, searchEvidence } from './evidenceSearch';
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
