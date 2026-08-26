import { describe, it, expect } from 'vitest';
import { detectDivergences } from './divergence';
import { syntheticState } from './fixtures';
import { getEconomyState } from './store';

describe('divergence detection (synthetic)', () => {
  it('keeps the residual when resolution discards a claim', () => {
    const s = syntheticState();
    const base = s.observations.find(o => o.id === 'obs:prod:aa')!; // 800, reported
    s.observations.push({
      ...base,
      id: 'obs:prod:aa:curated',
      value: 700,
      valueKind: 'representative',
      provenance: { ...base.provenance, sourceId: 'curated-test' },
    });
    const r = detectDivergences(s);
    const d = r.result.find(x => x.entityId === 'ent:country:aa' && x.kind === 'multi-provider')!;
    expect(d).toBeDefined();
    expect(d.resolvedTo).toBe('obs:prod:aa'); // reported won
    expect(d.spread).toBe(100);
    expect(d.relativeSpread).toBeCloseTo(0.125, 3);
    expect(d.direction).toBe('resolved_higher');
    expect(d.class).toBe('coverage'); // representative vs reported measures curated coverage
    expect(d.claims).toHaveLength(2);
    expect(r.inputs.observationIds).toContain('obs:prod:aa:curated');
  });

  it('classifies same-source-family conflicts as revision lag', () => {
    const s = syntheticState();
    const base = s.observations.find(o => o.id === 'obs:prod:aa')!;
    s.observations.push({
      ...base,
      id: 'obs:prod:aa:v2',
      value: 820,
      supersedes: 'obs:prod:aa',
      knownAt: '2026-01-31',
      provenance: { ...base.provenance, sourceId: base.provenance.sourceId },
    });
    const r = detectDivergences(s);
    const d = r.result.find(x => x.entityId === 'ent:country:aa')!;
    expect(d.class).toBe('revision_lag');
    // The revision (later knownAt at equal rank) is what resolution uses.
    expect(d.resolvedTo).toBe('obs:prod:aa:v2');
  });

  it('ignores sub-noise disagreement', () => {
    const s = syntheticState();
    const base = s.observations.find(o => o.id === 'obs:prod:aa')!;
    s.observations.push({ ...base, id: 'obs:prod:aa:близко', value: 800.5, provenance: { ...base.provenance, sourceId: 'other' } });
    const r = detectDivergences(s);
    expect(r.result.filter(x => x.entityId === 'ent:country:aa')).toHaveLength(0);
  });
});

describe('divergence detection (copper, real captures)', () => {
  it('finds the MCS vintage revisions as revision_lag', async () => {
    const { state } = await getEconomyState('copper');
    const r = detectDivergences(state);
    const revisions = r.result.filter(d => d.kind === 'multi-provider' && d.class === 'revision_lag');
    expect(revisions.length).toBeGreaterThan(0);
    // MCS2025 revised MCS2024's 2023 estimate for at least one country.
    const y2023 = revisions.find(d => d.period.start === '2023-01-01' && d.claims.some(c => c.sourceId === 'usgs-mcs2024-vintage'));
    expect(y2023).toBeDefined();
    expect(y2023!.resolvedTo).toContain('usgs-mcs2025');
  });

  it('surfaces the Comtrade mirror gaps, including the Chilean suppression', async () => {
    const { state } = await getEconomyState('copper');
    const r = detectDivergences(state);
    const mirrors = r.result.filter(d => d.kind === 'mirror');
    expect(mirrors.length).toBeGreaterThanOrEqual(3);

    // Peru → China concentrate: exporter 7,713 kt vs importer 7,248 kt (−6%).
    const peCn = mirrors.find(d => d.entityId === 'ent:country:pe' && d.partnerEntityId === 'ent:country:cn')!;
    expect(peCn.claims.find(c => c.perspective === 'reporter')!.value).toBe(7713);
    expect(peCn.claims.find(c => c.perspective === 'partner')!.value).toBe(7248);
    expect(peCn.class).toBe('coverage'); // ~6% — timing/coverage range
    expect(peCn.resolvedTo).toBe(''); // bilateral evidence feeds no aggregate

    // Chile → China concentrate: importer records 3.97x the exporter's
    // declaration — a ratio that reproduces the industry concentrate grade
    // (implied 25.2% Cu). The basis gate must class this as a candidate
    // basis mismatch (contained metal vs gross weight), NOT suppression:
    // 'unexplained' here would send an analyst after ~6,000 kt of phantom.
    const clCn = mirrors.find(d => d.entityId === 'ent:country:cl' && d.partnerEntityId === 'ent:country:cn')!;
    expect(clCn.claims.find(c => c.perspective === 'reporter')!.value).toBe(2125);
    expect(clCn.claims.find(c => c.perspective === 'partner')!.value).toBe(8433);
    expect(clCn.direction).toBe('partner_higher');
    expect(clCn.class).toBe('definitional');
    expect(clCn.explanation).toContain('3.97');
    expect(clCn.explanation).toContain('25.2% Cu');
    expect(clCn.explanation).toContain('basis mismatch');

    // DRC → China refined: −25% gap. Refined cathode is ~99.99% Cu, so basis
    // cannot be the mechanism — this one legitimately earns 'unexplained'
    // (consistent with Dar/Durban re-attribution).
    const cdCn = mirrors.find(d => d.entityId === 'ent:country:cd' && d.partnerEntityId === 'ent:country:cn')!;
    expect(cdCn.direction).toBe('reporter_higher');
    expect(cdCn.class).toBe('unexplained');

    // Unexplained is the hardest class — and what earns it sorts first,
    // while the basis artifact drops toward the bottom.
    expect(r.result[0].class).toBe('unexplained');
    expect(r.result[0].id).toBe(cdCn.id);
    const clRank = r.result.findIndex(d => d.id === clCn.id);
    const cdRank = r.result.findIndex(d => d.id === cdCn.id);
    expect(clRank).toBeGreaterThan(cdRank);
  });

  it('an anomaly is not a divergence: signal streams stay separate', async () => {
    const { state } = await getEconomyState('copper');
    const r = detectDivergences(state);
    // Divergence records reference only observation evidence — no z-scores,
    // no series periods outside the disputed one.
    for (const d of r.result) {
      expect(d.claims.length).toBeGreaterThanOrEqual(2);
      for (const c of d.claims) expect(c.observationId).toMatch(/^obs:/);
    }
  });
});
