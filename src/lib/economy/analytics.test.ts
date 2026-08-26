import { describe, it, expect } from 'vitest';
import {
  concentration, capacityConcentration, concentrationTrajectory, flowCentrality,
  bottleneckCandidates, detectAnomalies, extractSeries, observationsAt,
} from './analytics';
import { buildGraph } from './graph';
import { syntheticState, FIXTURE_PROV } from './fixtures';
import { getEconomyState } from './store';

describe('concentration (synthetic, hand-computable)', () => {
  it('computes HHI = 6800 for an 80/20 split', () => {
    const r = concentration(syntheticState(), 'production', 'country');
    expect(r.result.hhi).toBe(6800);
    expect(r.result.band).toBe('high');
    expect(r.result.shares[0]).toMatchObject({ entityId: 'ent:country:aa', share: 0.8 });
    // Traceability: exactly the two country observations were used.
    expect(r.inputs.observationIds?.sort()).toEqual(['obs:prod:aa', 'obs:prod:bb']);
    expect(r.operation.name).toBe('concentration');
    expect(r.execution.engine).toContain('osiris-economy-analytics');
  });

  it('never mixes entity kinds in one calculation', () => {
    const r = concentration(syntheticState(), 'production', 'mine');
    // No mine-level production observations in the fixture → empty, not
    // silently borrowing the country numbers.
    expect(r.result.shares).toEqual([]);
    expect(r.result.total).toBe(0);
  });

  it('uses only the latest observation per entity when a series exists', () => {
    const s = syntheticState();
    // Add an OLDER year for country aa with a wildly different value: it
    // must not be summed with 2024, and asOf must be able to reach it.
    s.observations.push({
      id: 'obs:prod:aa:2020', entityId: 'ent:country:aa', metric: 'production',
      value: 100, unit: 'kt/y', period: { start: '2020-01-01', end: '2020-12-31' },
      valueKind: 'reported', confidence: 'high', provenance: s.observations[0].provenance,
    });
    const latest = concentration(s, 'production', 'country');
    expect(latest.result.shares.find(x => x.entityId === 'ent:country:aa')?.value).toBe(800);
    expect(latest.result.hhi).toBe(6800);
    const asOf2020 = concentration(s, 'production', 'country', '2020-12-31');
    // At end-2020 only aa has reported → 100% share.
    expect(asOf2020.result.shares).toHaveLength(1);
    expect(asOf2020.result.hhi).toBe(10000);
    expect(observationsAt(s, 'production', 'country', '2021-06-30').map(o => o.id)).toEqual(['obs:prod:aa:2020']);
  });

  it('answers no-data, not a confident zero, when asOf predates all evidence', () => {
    const r = concentration(syntheticState(), 'production', 'country', '2010-12-31');
    expect(r.result.shares).toEqual([]);
    expect(r.result.hhi).toBe(0);
    expect(r.result.band).toBe('no-data');
  });
});

describe('concentration trajectory', () => {
  it('shows falling mine-production concentration as central Africa ramped (copper)', async () => {
    const { state } = await getEconomyState('copper');
    const r = concentrationTrajectory(state, 'production', 'country');
    const byYear = new Map(r.result.map(p => [p.period, p]));
    expect(byYear.has('2015')).toBe(true);
    expect(byYear.has('2023')).toBe(true);
    expect(byYear.get('2015')!.hhi).toBeGreaterThan(byYear.get('2023')!.hhi);
    expect(byYear.get('2015')!.topName).toBe('Chile');
    // Every point is computed from that year's own observations.
    for (const p of r.result) expect(p.participants).toBeGreaterThanOrEqual(5);
    expect(r.inputs.observationIds!.length).toBeGreaterThan(50);
  });

  it('drops years with too few reporters instead of fabricating concentration', () => {
    const s = syntheticState();
    // Only 2 country observations in 2024 → below minParticipants.
    const r = concentrationTrajectory(s, 'production', 'country');
    expect(r.result).toEqual([]);
  });
});

describe('measurement-class invariants', () => {
  it('refuses an HHI over market prices or positioning', () => {
    const s = syntheticState();
    expect(() => concentration(s, 'price', 'country')).toThrow(/physical measurements only/);
    expect(() => concentration(s, 'net_positioning', 'country')).toThrow(/physical measurements only/);
  });

  it('excludes the roll-bearing price series from anomaly detection', () => {
    const s = syntheticState();
    // A price series with a violent "roll" jump that would otherwise flag.
    for (let i = 0; i < 8; i++) {
      s.observations.push({
        id: `obs:price:${i}`, entityId: 'ent:country:aa', metric: 'price',
        value: i === 7 ? 9 : 4, unit: 'USD/lb',
        period: { start: `2024-0${i + 1}-01`, end: `2024-0${i + 1}-28` },
        valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV,
      });
    }
    const r = detectAnomalies(s, { window: 6 });
    expect(r.result.some(a => a.metric === 'price')).toBe(false);
    // Physical signals carry their class tag for the UI to partition on.
    for (const a of r.result) expect(a.measurementClass).toBeDefined();
  });

  it('bilateral (partner-scoped) observations never enter aggregates', () => {
    const s = syntheticState();
    s.observations.push({
      id: 'obs:prod:aa:to-bb', entityId: 'ent:country:aa', partnerEntityId: 'ent:country:bb',
      metric: 'production', value: 99999, unit: 'kt/y',
      period: { start: '2024-01-01', end: '2024-12-31' },
      valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV,
    });
    const r = concentration(s, 'production', 'country');
    expect(r.result.hhi).toBe(6800); // unchanged — the bilateral row is invisible here
    expect(r.inputs.observationIds).not.toContain('obs:prod:aa:to-bb');
    expect(extractSeries(s, 'ent:country:aa', 'production').some(p => p.observationId === 'obs:prod:aa:to-bb')).toBe(false);
  });
});

describe('capacity concentration', () => {
  it('groups smelting capacity by country', () => {
    const r = capacityConcentration(syntheticState(), 'smelting');
    expect(r.result.shares).toHaveLength(1);
    expect(r.result.shares[0].name).toBe('Borland');
    expect(r.result.hhi).toBe(10000);
    expect(r.inputs.capacityIds).toEqual(['cap:omega']);
  });
});

describe('flow centrality', () => {
  it('ranks the port as the most central node in the synthetic chain', () => {
    const s = syntheticState();
    const r = flowCentrality(s, buildGraph(s));
    expect(r.result[0].entityId).toBe('ent:port:gate');
    expect(r.result[0].throughputKt).toBe(800);
    expect(r.inputs.flowIds?.length).toBe(4);
  });
});

describe('bottleneck candidates', () => {
  it('scores the constrained port/smelter highest and explains itself', () => {
    const s = syntheticState();
    const r = bottleneckCandidates(s, buildGraph(s));
    // Countries and demand regions must never appear as bottleneck candidates.
    expect(r.result.some(b => b.kind === 'country' || b.kind === 'region')).toBe(false);
    const port = r.result.find(b => b.entityId === 'ent:port:gate')!;
    const omega = r.result.find(b => b.entityId === 'ent:smelter:omega')!;
    expect(port.score).toBeGreaterThan(0.5);
    expect(omega.components.utilization).toBeCloseTo(400 / 420, 2);
    expect(port.explanation.length).toBeGreaterThan(0);
    expect(omega.capacityIds).toEqual(['cap:omega']);
  });

  it('is deterministic across runs', () => {
    const s = syntheticState();
    const a = bottleneckCandidates(s, buildGraph(s)).result.map(b => `${b.entityId}:${b.score.toFixed(6)}`);
    const b = bottleneckCandidates(s, buildGraph(s)).result.map(x => `${x.entityId}:${x.score.toFixed(6)}`);
    expect(a).toEqual(b);
  });
});

describe('anomaly detection', () => {
  it('never treats same-period multi-provider observations as time steps', () => {
    const s = syntheticState();
    // A second provider disagrees slightly on the SAME periods with softer
    // evidence — this must not read as period-over-period change, collapse
    // the rolling σ, or appear in any signal at all.
    const inv = s.observations.filter(o => o.metric === 'inventory');
    for (const o of inv) {
      s.observations.push({
        ...o,
        id: o.id + ':secondary',
        value: o.value * 0.94, // 6% provider disagreement
        valueKind: 'estimated',
        provenance: { ...o.provenance, sourceId: 'secondary-test' },
      });
    }
    const r = detectAnomalies(s, { window: 6 });
    // Exactly the same signals as the single-provider baseline — the harder
    // (reported) series wins each period and no duplicate-period signals appear.
    const baseline = detectAnomalies(syntheticState(), { window: 6 });
    expect(r.result.map(a => `${a.kind}:${a.period}:${a.value}`).sort())
      .toEqual(baseline.result.map(a => `${a.kind}:${a.period}:${a.value}`).sort());
    for (const a of r.result) {
      for (const id of a.observationIds) expect(id).not.toMatch(/:secondary$/);
    }
  });

  it('resolves duplicate periods inside extractSeries by evidence rank', () => {
    const s = syntheticState();
    const first = s.observations.find(o => o.metric === 'inventory')!;
    s.observations.push({ ...first, id: first.id + ':dup', value: 999, valueKind: 'estimated' });
    const series = extractSeries(s, first.entityId, 'inventory');
    // 8 periods stay 8 points; the reported 100 beats the estimated 999.
    expect(series).toHaveLength(8);
    expect(series[0].value).toBe(100);
    expect(series[0].observationId).toBe(first.id);
  });

  it('flags the structural break in the synthetic inventory series', () => {
    const r = detectAnomalies(syntheticState(), { window: 6 });
    const hit = r.result.find(a => a.entityId === 'ent:port:gate' && a.kind === 'rolling-deviation');
    expect(hit).toBeDefined();
    expect(hit!.period).toBe('2024-08');
    expect(hit!.magnitude).toBeLessThan(-2);
    // Evidence trail: the observations behind the signal are named.
    expect(hit!.observationIds.length).toBeGreaterThanOrEqual(7);
  });

  it('flags the copper exchange-stock drawdown via rate-of-change', async () => {
    const { state } = await getEconomyState('copper');
    const r = detectAnomalies(state);
    const roc = r.result.filter(a => a.entityId === 'ent:infrastructure:lme-warehouses' && a.kind === 'rate-of-change');
    expect(roc.length).toBeGreaterThan(0);
    expect(roc.some(a => a.period === '2026-06')).toBe(true);
  });

  it('extractSeries orders points chronologically', () => {
    const series = extractSeries(syntheticState(), 'ent:port:gate', 'inventory');
    expect(series.map(p => p.period)).toEqual(['2024-01', '2024-02', '2024-03', '2024-04', '2024-05', '2024-06', '2024-07', '2024-08']);
  });
});
