import { describe, it, expect } from 'vitest';
import { GET as economyGet } from './route';
import { GET as entityGet } from './entity/route';

const req = (url: string) => new Request(`http://localhost${url}`);

describe('GET /api/economy', () => {
  it('serves the map view with entities and coordinate-resolved flows', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=map'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commodity).toBe('copper');
    expect(body.econ_entities.length).toBeGreaterThan(30);
    const escondida = body.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:escondida');
    expect(escondida).toMatchObject({ kind: 'mine', stage: 'production', geoPrecision: 'site' });
    expect(escondida.production).toBeGreaterThan(0);
    for (const f of body.econ_flows) {
      expect(f.fromCoord).toHaveLength(2);
      expect(f.toCoord).toHaveLength(2);
      expect(f.quantity).toBeGreaterThan(0);
    }
    // UI data contract: bottleneck score is present (number|null), never undefined.
    for (const e of body.econ_entities) expect(e.bottleneckScore === null || typeof e.bottleneckScore === 'number').toBe(true);
  });

  it('serves the analytics view with traceable results', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=analytics'));
    const body = await res.json();
    const prod = body.concentration.mineProductionByCountry;
    expect(prod.result.hhi).toBeGreaterThan(1000);
    expect(prod.inputs.observationIds.length).toBeGreaterThan(5);
    expect(body.concentration.smeltingCapacityByCountry.result.shares[0].name).toBe('China');
    expect(body.bottlenecks.result.length).toBeGreaterThan(5);
    expect(body.anomalies.result.length).toBeGreaterThan(0);
    expect(body.sources.length).toBeGreaterThan(2);
  });

  it('serves the full canonical state for research use', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=state'));
    const body = await res.json();
    expect(body.state.observations.every((o: { provenance?: { sourceId?: string } }) => o.provenance?.sourceId)).toBe(true);
  });

  it('serves the second commodity end-to-end: the instrument, not just the engine', async () => {
    const map = await (await economyGet(req('/api/economy?commodity=aluminium&view=map'))).json();
    expect(map.commodity).toBe('aluminium');
    expect(map.econ_entities.length).toBeGreaterThan(25);
    expect(map.econ_flows.length).toBeGreaterThan(10);
    const kitimat = map.econ_entities.find((e: { id: string }) => e.id === 'ent:smelter:kitimat');
    expect(kitimat).toMatchObject({ kind: 'smelter', stage: 'smelting' });
    const analytics = await (await economyGet(req('/api/economy?commodity=aluminium&view=analytics'))).json();
    expect(analytics.concentration.refinedProductionByCountry.result.shares[0].name).toBe('China');
    // The intermediate index exists here and is empty for copper — an
    // absent index is not a claim, and the panel renders nothing for it.
    expect(analytics.concentration.intermediateProductionByCountry.result.shares.length).toBeGreaterThan(5);
    const copperAnalytics = await (await economyGet(req('/api/economy?commodity=copper&view=analytics'))).json();
    expect(copperAnalytics.concentration.intermediateProductionByCountry.result.band).toBe('no-data');
  });

  it('404s unknown commodities and 400s unknown views and malformed asOf', async () => {
    expect((await economyGet(req('/api/economy?commodity=vibranium'))).status).toBe(404);
    expect((await economyGet(req('/api/economy?commodity=copper&view=nope'))).status).toBe(400);
    expect((await economyGet(req('/api/economy?commodity=copper&asOf=last-tuesday'))).status).toBe(400);
  });

  it('evaluates disruption flags at asOf for temporal playback', async () => {
    // During the Grasberg halt (started 2025-09-08): mine + its flows disrupted.
    const during = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2025-10-01'))).json();
    const grasberg = during.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg');
    expect(grasberg.disrupted).toBe(true);
    const grasbergFlow = during.econ_flows.find((f: { id: string }) => f.id === 'flow:grasberg-amamapare');
    expect(grasbergFlow.disrupted).toBe(true);
    expect(during.asOf).toBe('2025-10-01');
    // Before any event window (mid-2023, canal drought already active but
    // Grasberg fine): grasberg not disrupted.
    const before = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2023-01-01'))).json();
    const grasbergBefore = before.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg');
    expect(grasbergBefore.disrupted).toBe(false);
  });

  it('labels topology validity on playback projections — the scrubber must be as honest about arcs as about observations', async () => {
    // Scrubbed to 2017: the country vintage now SERVES it (work order 3.2)
    // — the scrubber draws the 2017 reporter-declared corridors, labeled
    // country-granularity, instead of refusing the date.
    const early = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2017-02-15'))).json();
    expect(early.topology.status).toBe('within');
    expect(early.topology.granularity).toBe('country');
    expect(early.topology.vintageYear).toBe('2017');
    expect(early.topology.note).toContain('COUNTRY-granularity vintage 2017');
    // The arcs are the vintage's corridors, not the 2024 facility flows.
    expect(early.econ_flows.some((f: { id: string }) => f.id.startsWith('flow:vintage:2603:id:'))).toBe(true);
    expect(early.econ_flows.some((f: { id: string }) => f.id === 'flow:grasberg-amamapare')).toBe(false);
    // Before the earliest vintage, 'predates' still refuses honestly.
    const before = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2015-06-01'))).json();
    expect(before.topology.status).toBe('predates');
    expect(before.topology.note).toContain('null (unknown), not zero');
    // Inside the flow period: no caveat to carry.
    const within = await (await economyGet(req('/api/economy?commodity=copper&view=analytics&asOf=2024-06-15'))).json();
    expect(within.topology.status).toBe('within');
    // After it: the snapshot serves as latest-known structure, labeled —
    // and the label carries the first-hand evidence that structure has
    // moved where the register holds it (the projection is where a
    // researcher would otherwise read extrapolation as uncontradicted).
    const later = await (await economyGet(req('/api/economy?commodity=copper&view=analytics&asOf=2026-08-01'))).json();
    expect(later.topology.status).toBe('extrapolated');
    expect(later.topology.note).toContain('latest-known structure');
    expect(later.topology.structuralEvidence.map((e: { id: string }) => e.id)).toContain('evt:grasberg-mud-rush-2025');
  });

  it('serves the timeline view with a playback range and dated events', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=timeline'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range.min <= '2023-06').toBe(true);
    expect(body.range.max >= '2026-08').toBe(true);
    expect(body.events.length).toBeGreaterThan(3);
    const grasberg = body.events.find((e: { id: string }) => e.id === 'evt:grasberg-mud-rush-2025');
    expect(grasberg).toMatchObject({ start: '2025-09-08', disruptive: true, entityName: 'Grasberg' });
    // Sorted by start date.
    const starts = body.events.map((e: { start: string }) => e.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('serves the graph view with no dangling link endpoints', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=graph'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBeGreaterThan(30);
    // Countries and the commodity node are aggregates, not graph structure.
    expect(body.nodes.some((n: { kind: string }) => n.kind === 'country' || n.kind === 'commodity')).toBe(false);
    const ids = new Set(body.nodes.map((n: { id: string }) => n.id));
    for (const l of body.links) {
      expect(ids.has(l.source), `link ${l.id} source`).toBe(true);
      expect(ids.has(l.target), `link ${l.id} target`).toBe(true);
    }
    expect(body.links.some((l: { kind: string }) => l.kind === 'flow')).toBe(true);
    expect(body.links.some((l: { kind: string }) => l.kind === 'dependency')).toBe(true);
    const guixi = body.nodes.find((n: { id: string }) => n.id === 'ent:smelter:guixi');
    expect(guixi.throughputKt).toBeGreaterThan(1000);
  });
});

describe('GET /api/economy/entity', () => {
  it('returns detail + upstream/downstream traversal for a smelter', async () => {
    const res = await entityGet(req('/api/economy/entity?commodity=copper&id=ent:smelter:guixi'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entity.name).toBe('Guixi Smelter');
    expect(body.capacities.length).toBeGreaterThan(0);
    const upstreamIds = body.upstream.map((s: { id: string }) => s.id);
    expect(upstreamIds).toContain('ent:port:shanghai');
    expect(upstreamIds).toContain('ent:mine:escondida');
    const downstreamIds = body.downstream.map((s: { id: string }) => s.id);
    expect(downstreamIds).toContain('ent:region:china-fabrication');
    // Every observation shown in the inspector carries provenance.
    for (const o of body.observations) expect(o.provenance.sourceId).toBeTruthy();
  });

  it('400s a missing id and 404s an unknown one', async () => {
    expect((await entityGet(req('/api/economy/entity?commodity=copper'))).status).toBe(400);
    expect((await entityGet(req('/api/economy/entity?commodity=copper&id=ent:mine:nope'))).status).toBe(404);
  });
});

/**
 * The ninth instance of context severance, at the graph projection.
 *
 * `topologyValidity` / `selectTopology` — the phase-13 machinery whose whole
 * purpose is that a date outside any flow vintage produces null rather than
 * today's structure wearing a historical label — had the map view as its
 * EFFECTIVE scope and the instrument as its APPARENT one. The graph branch
 * read `state.flows`: every vintage at once, identical at every date.
 *
 * MEASURED before it was believed: at 1990-01-01 the map served 0 flows with
 * topology.status `predates`; the graph served the same 39 flow links it
 * serves today. And the graph view is the surface that displays an
 * "AS OF 1990-01-01" chip over what it draws — the projection asserting the
 * knowledge state was the one ignoring it. Nothing failed.
 */
describe('the graph view answers at the date it is asked about', () => {
  const graph = async (q = '') => {
    const res = await economyGet(req(`/api/economy?commodity=copper&view=graph${q}`));
    return await res.json() as {
      links: Array<{ kind: string }>;
      nodes: Array<{ id: string; throughputKt: number }>;
      topology?: { status: string; granularity?: string };
      representable?: { flowsInSelectedTopology: number; flowLinks: number; withheld: number; reason: string | null };
    };
  };
  const flowLinks = (b: { links: Array<{ kind: string }> }) => b.links.filter(l => l.kind === 'flow').length;

  it('a date no vintage covers refuses the network instead of serving today\'s', async () => {
    const past = await graph('&asOf=1990-01-01');
    expect(past.topology?.status, 'the graph must carry the topology block the map has').toBe('predates');
    expect(flowLinks(past), 'a network drawn at 1990 is today\'s structure wearing a historical date').toBe(0);
    // Throughput is a flow-derived magnitude: it must go with the flows.
    expect(past.nodes.every(n => n.throughputKt === 0)).toBe(true);
  });

  it('DISCRIMINATING: the selected topology actually changes with the date', async () => {
    // Without this the assertion above would pass on a graph that is empty
    // everywhere. Three dates, three different selections.
    const [today, v2017, past] = await Promise.all([graph(), graph('&asOf=2017-06-30'), graph('&asOf=1990-01-01')]);
    expect(flowLinks(today)).toBeGreaterThan(0);
    expect(today.topology?.granularity).toBe('facility');
    expect(v2017.topology?.granularity).toBe('country');
    expect(v2017.representable!.flowsInSelectedTopology).toBeGreaterThan(0);
    expect(past.representable!.flowsInSelectedTopology).toBe(0);
  });

  it('THE THIRD ZERO: a country-granularity topology is not representable here, and says so', async () => {
    // Corrected against the measurement rather than the other way round.
    // Selecting the topology exposed a structural fact the old behaviour was
    // hiding: this view excludes countries as AGGREGATES, and the corpus's
    // historical vintages are country↔country corridors — so at 2017 the
    // topology is `within`, holds flows, and none of them can be drawn here.
    // The previous behaviour filled that hole with today's facility network,
    // which is the stronger failure: an empty picture asserts nothing.
    const v2017 = await graph('&asOf=2017-06-30');
    expect(v2017.topology?.status).toBe('within');
    expect(flowLinks(v2017)).toBe(0);
    const r = v2017.representable!;
    expect(r.flowsInSelectedTopology).toBeGreaterThan(0);
    expect(r.withheld).toBe(r.flowsInSelectedTopology);   // every drop counted
    expect(r.reason).toMatch(/not representable in this view/);
    expect(r.reason).toMatch(/allocation model/);          // the recorded deferral, named
    // And today's facility topology withholds NOTHING — otherwise the
    // accounting above would be a constant rather than a measurement.
    const today = await graph();
    expect(today.representable!.withheld).toBe(0);
    expect(today.representable!.reason).toBeNull();
    expect(today.representable!.flowLinks).toBe(today.representable!.flowsInSelectedTopology);
  });

  it('the graph and the map agree about what the date can carry', async () => {
    // Two projections of one state. Disagreeing about whether a date is
    // describable is the defect; agreeing is the property.
    for (const q of ['', '&asOf=2017-06-30', '&asOf=2022-06-30', '&asOf=1990-01-01']) {
      const g = await graph(q);
      const m = await (await economyGet(req(`/api/economy?commodity=copper&view=map${q}`))).json() as {
        econ_flows: unknown[]; topology: { status: string; granularity?: string };
      };
      expect(g.topology?.status, `status disagrees at ${q || 'today'}`).toBe(m.topology.status);
      expect(g.topology?.granularity, `granularity disagrees at ${q || 'today'}`).toBe(m.topology.granularity);
      // The two views must agree on WHICH TOPOLOGY serves the date. They may
      // draw different amounts of it — the map sites country corridors on
      // coordinates, this view cannot — but that difference is accounted
      // for, never silent.
      expect(g.representable!.flowsInSelectedTopology, `selected flow count disagrees at ${q || 'today'}`).toBe(m.econ_flows.length);
      expect(g.representable!.flowLinks + g.representable!.withheld).toBe(g.representable!.flowsInSelectedTopology);
      if (g.representable!.withheld > 0) expect(g.representable!.reason).toBeTruthy();
    }
  });
});

/**
 * COVERAGE OF WHAT — the ink on the map carries a ratio, and a ratio is
 * per country AND per metric.
 *
 * The map applied the MINE-production coverage table to every facility dot,
 * so a Chinese smelter's opacity was driven by China's mine coverage. It was
 * invisible while the coverage table dropped its 0% rows — those facilities
 * fell through to `null`, accidentally honest — and would have become nine
 * smelters and refineries wearing a measured number from the wrong table the
 * moment the zeroes were emitted. Two defects hiding each other.
 */
describe('the map\'s coverage ink comes from the matching table', () => {
  it('mines read mine coverage, smelters and refineries read refined coverage', async () => {
    const body = await (await economyGet(req('/api/economy?commodity=copper&view=map'))).json() as {
      econ_entities: Array<{ id: string; name: string; kind: string; country: string | null; coverageRatio: number | null }>;
    };
    const analytics = await (await economyGet(req('/api/economy?commodity=copper&view=analytics'))).json() as {
      coverage: { result: { mineProduction: { result: Array<{ countryName: string; ratio: number }> }; refinedProduction: { result: Array<{ countryName: string; ratio: number }> } } };
    };
    const mineBy = new Map(analytics.coverage.result.mineProduction.result.map(r => [r.countryName, r.ratio]));
    const refBy = new Map(analytics.coverage.result.refinedProduction.result.map(r => [r.countryName, r.ratio]));

    let checkedMine = 0, checkedRef = 0, checkedOther = 0;
    for (const e of body.econ_entities) {
      if (e.kind === 'mine') {
        expect(e.coverageRatio, `${e.name}`).toBe(e.country ? mineBy.get(e.country) ?? null : null);
        if (e.coverageRatio !== null) checkedMine++;
      } else if (e.kind === 'smelter' || e.kind === 'refinery') {
        expect(e.coverageRatio, `${e.name}`).toBe(e.country ? refBy.get(e.country) ?? null : null);
        if (e.coverageRatio !== null) checkedRef++;
      } else {
        // A port or a manufacturer has no facility-model coverage figure;
        // borrowing one from another stage would be a fabricated axis.
        expect(e.coverageRatio, `${e.name} (${e.kind}) must not borrow a coverage ratio`).toBeNull();
        checkedOther++;
      }
    }
    // Not vacuous in any of the three branches.
    expect(checkedMine).toBeGreaterThan(0);
    expect(checkedRef).toBeGreaterThan(0);
    expect(checkedOther).toBeGreaterThan(0);
  });

  it('DISCRIMINATING: the two tables actually disagree, so the choice matters', async () => {
    const analytics = await (await economyGet(req('/api/economy?commodity=copper&view=analytics'))).json() as {
      coverage: { result: { mineProduction: { result: Array<{ countryName: string; ratio: number }> }; refinedProduction: { result: Array<{ countryName: string; ratio: number }> } } };
    };
    const mine = analytics.coverage.result.mineProduction.result;
    const ref = analytics.coverage.result.refinedProduction.result;
    const disagree = mine.filter(m => {
      const r = ref.find(x => x.countryName === m.countryName);
      return r && r.ratio !== m.ratio;
    });
    expect(disagree.length, 'if the tables agreed everywhere this pin would be vacuous').toBeGreaterThan(0);
  });
});
