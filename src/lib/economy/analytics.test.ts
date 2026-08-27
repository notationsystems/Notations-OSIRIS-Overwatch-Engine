import { describe, it, expect } from 'vitest';
import {
  concentration, capacityConcentration, concentrationTrajectory, flowCentrality,
  bottleneckCandidates, detectAnomalies, extractSeries, observationsAt, operatorConcentration,
} from './analytics';
import { buildGraph, upstream, downstream } from './graph';
import { traversableEdgeFilter } from './propagation';
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

describe('operator concentration', () => {
  it('sees operational concentration that geographic grouping scores as diversified', () => {
    // THE demonstration: two mines in two countries, one operator. By
    // country the production is a 50/50 split (HHI 5000); by operator it is
    // a monopoly (HHI 10000). A commodity can be geographically diversified
    // and operationally concentrated at the same time — a single operator's
    // labour dispute or financial distress hits both assets simultaneously,
    // correlated risk the country lens cannot represent.
    const s = syntheticState();
    s.entities.push(
      { id: 'ent:mine:gamma', kind: 'mine', name: 'Gamma Mine', countryCode: 'BB', lat: 23, lng: 23, geoPrecision: 'site', stage: 'production' },
      { id: 'ent:company:omega-corp', kind: 'company', name: 'Omega Corp' },
    );
    const period = { start: '2024-01-01', end: '2024-12-31' };
    s.observations.push(
      { id: 'obs:mp:alpha', entityId: 'ent:mine:alpha', metric: 'production', value: 500, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'obs:mp:gamma', entityId: 'ent:mine:gamma', metric: 'production', value: 500, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    );
    s.dependencies.push(
      { id: 'dep:op:alpha', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:omega-corp', strength: 1, role: 'operator', provenance: FIXTURE_PROV },
      { id: 'dep:op:gamma', fromEntityId: 'ent:mine:gamma', type: 'operated_by', toEntityId: 'ent:company:omega-corp', strength: 1, role: 'operator', provenance: FIXTURE_PROV },
    );
    const r = operatorConcentration(s, 'production', ['mine'], 'control');
    expect(r.result.hhi).toBe(10000);
    expect(r.result.band).toBe('high');
    expect(r.result.attributionBasis).toBe('control');
    expect(r.result.shares[0]).toMatchObject({ entityId: 'ent:company:omega-corp', share: 1 });
    expect(r.result.attributionCoverage).toBe(1);
    // The comparability fields travel with the number: one group, one
    // effective group, floor 10000 — this index is only comparable within
    // its own partition.
    expect(r.result.groupCount).toBe(1);
    expect(r.result.effectiveGroups).toBe(1);
    expect(r.result.partitionFloor).toBe(10000);
  });

  it('states the basis on the number, and the two bases answer different questions', () => {
    // One mine: operator holds 48.8%, a state shareholder holds 51% — the
    // Grasberg shape. Control says the operator can stop 100% of it;
    // economic says the state owns most of the loss. Never pool the two.
    const s = syntheticState();
    s.entities.push(
      { id: 'ent:company:op-co', kind: 'company', name: 'Operator Co' },
      { id: 'ent:company:state-co', kind: 'company', name: 'State Holding' },
    );
    const period = { start: '2024-01-01', end: '2024-12-31' };
    s.observations.push(
      { id: 'obs:mp:alpha', entityId: 'ent:mine:alpha', metric: 'production', value: 800, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    );
    s.dependencies.push(
      { id: 'dep:op:alpha:op', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:op-co', strength: 0.488, role: 'operator', provenance: FIXTURE_PROV },
      { id: 'dep:op:alpha:state', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:state-co', strength: 0.51, role: 'shareholder', provenance: FIXTURE_PROV },
    );
    const control = operatorConcentration(s, 'production', ['mine'], 'control');
    expect(control.result.shares[0]).toMatchObject({ entityId: 'ent:company:op-co', value: 800 });
    expect(control.result.attributionCoverage).toBe(1);
    const economic = operatorConcentration(s, 'production', ['mine'], 'economic_interest');
    expect(economic.result.shares[0].entityId).toBe('ent:company:state-co'); // 51% > 48.8%
    expect(economic.result.attributionCoverage).toBeCloseTo(0.998, 3);
    expect(control.result.note).toContain('who can stop it');
    expect(economic.result.note).toContain('who owns the loss');
  });

  it('control basis never force-assigns a JV-operated asset to a shareholder', () => {
    const s = syntheticState();
    s.entities.push({ id: 'ent:company:holder', kind: 'company', name: 'Holder' });
    const period = { start: '2024-01-01', end: '2024-12-31' };
    s.observations.push(
      { id: 'obs:mp:alpha', entityId: 'ent:mine:alpha', metric: 'production', value: 400, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    );
    // Only shareholder edges (the Antamina/Collahuasi shape: the operator of
    // record is an unmodeled JV vehicle).
    s.dependencies.push(
      { id: 'dep:op:alpha:h', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:holder', strength: 0.44, role: 'shareholder', provenance: FIXTURE_PROV },
    );
    const control = operatorConcentration(s, 'production', ['mine'], 'control');
    expect(control.result.attributionCoverage).toBe(0);
    expect(control.result.unattributedKt).toBe(400);
    // The renormalized hhi has nothing to say here (no attributed shares) —
    // but the COMPARABLE figure does: one unattributed facility is the
    // whole universe, a monopoly of the unmodeled. Excluding-and-
    // renormalizing would have hidden exactly this.
    expect(control.result.hhi).toBe(0);
    expect(control.result.hhiWithRemainder).toBe(10000);
    expect(control.result.remainderTreatment).toBe('enumerated');
    const economic = operatorConcentration(s, 'production', ['mine'], 'economic_interest');
    expect(economic.result.attributionCoverage).toBeCloseTo(0.44, 3);
    // Renormalized: one holder of everything attributed → 10000. With the
    // remainder restored, the same data reads far less concentrated —
    // the 1/completeness² inflation made visible.
    expect(economic.result.hhi).toBe(10000);
    expect(economic.result.hhiWithRemainder).toBeCloseTo(5072, 0); // 44%² + 56%² of the full universe
  });

  it('reports partial attribution the way geographic coverage is reported — never hidden', () => {
    const s = syntheticState();
    s.entities.push({ id: 'ent:company:omega-corp', kind: 'company', name: 'Omega Corp' });
    const period = { start: '2024-01-01', end: '2024-12-31' };
    s.observations.push(
      { id: 'obs:mp:alpha', entityId: 'ent:mine:alpha', metric: 'production', value: 300, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'obs:mp:beta', entityId: 'ent:mine:beta', metric: 'production', value: 100, unit: 'kt/y', period, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    );
    // JV attribution: 60% of alpha attributed, beta not attributed at all.
    s.dependencies.push(
      { id: 'dep:op:alpha', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:omega-corp', strength: 0.6, role: 'shareholder', provenance: FIXTURE_PROV },
    );
    const r = operatorConcentration(s, 'production', ['mine'], 'economic_interest');
    expect(r.result.totalKt).toBe(400);
    expect(r.result.total).toBeCloseTo(180, 1); // 300 × 0.6 allocated
    expect(r.result.attributionCoverage).toBeCloseTo(0.45, 3);
    expect(r.result.unattributedKt).toBeCloseTo(220, 1);
    expect(r.result.note).toContain('hhiWithRemainder');
  });

  it('copper: the pair is only quotable with basis, universe and partition labeled', async () => {
    // Round 9 compared country-HHI 1339 against operator-HHI 959 raw. That
    // comparison was triply incommensurable: different partitions (HHI
    // floors 10000/n), different attribution bases (economic shares vs
    // control), and different universes (reported country totals vs the
    // modeled facility subset). This test pins the corrected, fully
    // labeled measurement.
    const { state } = await getEconomyState('copper');
    const control = operatorConcentration(state, 'production', ['mine'], 'control').result;
    const economic = operatorConcentration(state, 'production', ['mine'], 'economic_interest').result;
    // Like-for-like geographic figure: the SAME facility universe grouped
    // by country — same total, same floor as the control index.
    const facObs = observationsAt(state, 'production', 'mine');
    const byCountry = new Map<string, number>();
    let total = 0;
    for (const o of facObs) {
      const ent = state.entities.find(e => e.id === o.entityId)!;
      byCountry.set(ent.countryCode ?? '?', (byCountry.get(ent.countryCode ?? '?') ?? 0) + o.value);
      total += o.value;
    }
    const geoHhi = Math.round([...byCountry.values()].reduce((s, v) => s + ((v / total) * 100) ** 2, 0));

    // Control above economic: 100%-to-operator concentrates what JV
    // share-splitting dilutes (Grasberg alone: 800 kt to Freeport under
    // control vs 390 under economic interest). The margin NARROWED when the
    // JV operating vehicles were curated — raising control completeness to
    // ~100% removed the 1/completeness² inflation, which is the round-11
    // correction working as intended.
    expect(control.attributionCoverage).toBeGreaterThan(0.99); // JV vehicles curated: unmodeled was never unknown
    expect(control.hhi).toBeGreaterThan(economic.hhi);
    // Freeport's control position is the index-free finding: largest
    // operator, roughly a quarter of modeled mine output, three countries.
    expect(control.shares[0].entityId).toBe('ent:company:freeport');
    expect(control.shares[0].share).toBeGreaterThan(0.2);
    // Same universe, same partition — and with control completeness ~1,
    // hhi and hhiWithRemainder coincide, so the comparison against the
    // full-universe geographic figure is finally clean: the modeled
    // facility set is substantially more concentrated by geography than by
    // control (Chile-heavy facility coverage — the coverage bias annotation
    // explains why). The world-reported country figure (different universe)
    // is labeled, never compared raw.
    expect(control.hhiWithRemainder).toBe(control.hhi);
    expect(geoHhi).toBeGreaterThan(control.hhiWithRemainder);
    // Economic completeness stays partial (minority residues) — its
    // comparable figure deflates accordingly and says so.
    expect(economic.attributionCoverage).toBeLessThan(1);
    expect(economic.hhiWithRemainder).toBeLessThan(economic.hhi);
    // Every index carries its partition context, so no consumer has to
    // reconstruct comparability from the outside.
    for (const r of [control, economic]) {
      expect(r.groupCount).toBeGreaterThan(0);
      expect(r.effectiveGroups).toBeCloseTo(10000 / r.hhi, 0);
      expect(r.partitionFloor).toBe(Math.round(10000 / r.groupCount));
    }
  });

  it('refuses market metrics like every other concentration', () => {
    expect(() => operatorConcentration(syntheticState(), 'price', ['mine'], 'control')).toThrow(/physical measurements only/);
  });

  it('only CONTROL traverses: the operator appears upstream, a shareholder never does', () => {
    const s = syntheticState();
    s.entities.push(
      { id: 'ent:company:omega-corp', kind: 'company', name: 'Omega Corp' },
      { id: 'ent:company:holder', kind: 'company', name: 'Holder' },
    );
    s.dependencies.push(
      { id: 'dep:op:alpha', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:omega-corp', strength: 1, role: 'operator', provenance: FIXTURE_PROV },
      { id: 'dep:op:alpha:h', fromEntityId: 'ent:mine:alpha', type: 'operated_by', toEntityId: 'ent:company:holder', strength: 0.3, role: 'shareholder', provenance: FIXTURE_PROV },
    );
    const g = buildGraph(s);
    const up = upstream(g, 'ent:mine:alpha').map(x => x.entityId);
    expect(up).toContain('ent:company:omega-corp');
    // Operationally, a shareholding is a claim on output, not a lever —
    // strikes and outages must not propagate through it in either direction.
    expect(up).not.toContain('ent:company:holder');
    expect(downstream(g, 'ent:company:holder')).toEqual([]);
    // The operator's reach covers the asset and everything downstream of it.
    const reach = downstream(g, 'ent:company:omega-corp').map(x => x.entityId);
    expect(reach).toContain('ent:mine:alpha');
    expect(reach).toContain('ent:port:gate');
    // The sibling rule: FINANCIAL/LEGAL events attach to owners, not
    // managers — a sanctions-class event DOES reach the asset through the
    // 30%, because the edge that carries it is exactly the one operational
    // events must not use.
    const sanctionReach = downstream(g, 'ent:company:holder', 6, traversableEdgeFilter('sanction')).map(x => x.entityId);
    expect(sanctionReach).toContain('ent:mine:alpha');
    expect(sanctionReach).toContain('ent:port:gate');
    // Regulatory events attach to territory: neither attribution role
    // carries them.
    expect(downstream(g, 'ent:company:holder', 6, traversableEdgeFilter('policy'))).toEqual([]);
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
    const a = bottleneckCandidates(s, buildGraph(s)).result.map(b => `${b.entityId}:${b.score!.toFixed(6)}`);
    const b = bottleneckCandidates(s, buildGraph(s)).result.map(x => `${x.entityId}:${x.score!.toFixed(6)}`);
    expect(a).toEqual(b);
  });

  it('refuses to score a node touched by unquantifiable basis — and sorts the refusal first', () => {
    const s = syntheticState();
    // Gross-weight inbound with no corridor grade: shares and redundancy at
    // the smelter would be computed against a total known to be wrong. A
    // zero would report a fragility that doesn't exist (single-sourced,
    // irredundant); a refusal reports exactly what is missing.
    s.flows.push({
      ...s.flows[0], id: 'flow:gate-omega-gross', fromEntityId: 'ent:port:gate', toEntityId: 'ent:smelter:omega', quantity: 1600, basis: 'gross_weight',
    });
    const g = buildGraph(s);
    const r = bottleneckCandidates(s, g);
    const omega = r.result.find(b => b.entityId === 'ent:smelter:omega')!;
    expect(omega.score).toBeNull();
    expect(omega.explanation[0]).toContain('SCORE REFUSED');
    expect(omega.explanation[0]).toContain('flow:gate-omega-gross');
    // Refusals sort first (the gross edge touches both its endpoints).
    expect(r.result[0].score).toBeNull();
    expect(r.result.filter(b => b.score === null).map(b => b.entityId).sort())
      .toEqual(['ent:port:gate', 'ent:smelter:omega']);
    expect(omega.flowIds).toContain('flow:gate-omega-gross'); // evidence keeps the refused flow
    // Centrality refuses the share for the same node, keeps the lower bound.
    const c = flowCentrality(s, g);
    const omegaRow = c.result.find(x => x.entityId === 'ent:smelter:omega')!;
    expect(omegaRow.share).toBeNull();
    expect(omegaRow.inKt).toBe(400); // quantified lower bound, not zero
    expect(omegaRow.unquantifiedFlowIds).toEqual(['flow:gate-omega-gross']);
    // Untouched nodes still get shares.
    expect(c.result.find(x => x.entityId === 'ent:mine:alpha')!.share).not.toBeNull();
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
