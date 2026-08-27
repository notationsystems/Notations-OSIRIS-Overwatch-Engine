import { NextResponse } from 'next/server';
import { runEngine, listSystems } from '@/lib/economy/engine';
import { getEconomyState } from '@/lib/economy/store';
import { DISRUPTIVE_EVENT_TYPES, isEventActive, topologyValidity } from '@/lib/economy/propagation';
import { selectTopology } from '@/lib/economy/graph';
import type { BottleneckCandidate } from '@/lib/economy/analytics';
import { corpusHealthSignals, corpusHealthAccounting } from '@/lib/economy/horizon';
import { attribution } from '@/lib/economy/attribution';
import type { AnalyticalResult, EconomyState } from '@/lib/economy/types';
import { toKtPerYear } from '@/lib/economy/types';

/**
 * OSIRIS — Physical-economy engine API.
 *
 *   GET /api/economy?commodity=copper&view=map[&asOf=YYYY-MM-DD]
 *       map-ready entities+flows; with asOf, event-disruption flags are
 *       evaluated at that date (temporal playback)
 *   GET /api/economy?commodity=copper&view=analytics[&asOf=…]
 *       system outputs (concentration+trajectory, centrality, bottlenecks,
 *       anomalies, propagation)
 *   GET /api/economy?commodity=copper&view=timeline
 *       playback range + dated events for the time scrubber
 *   GET /api/economy?commodity=copper&view=graph
 *       force-graph projection: nodes + typed links
 *   GET /api/economy?commodity=copper&view=state
 *       full canonical state (research/debug)
 *
 * Routes are projections of an engine run. The canonical state and every
 * derived number live server-side; the UI never computes economics.
 */

export const dynamic = 'force-dynamic';

/** Entities with a live disruptive event at the evaluation date. */
function disruptedEntities(state: EconomyState, asOf: string): Set<string> {
  const out = new Set<string>();
  for (const ev of state.events) {
    if (ev.entityId && DISRUPTIVE_EVENT_TYPES.includes(ev.type) && isEventActive(ev, asOf)) {
      out.add(ev.entityId);
    }
  }
  return out;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const commodity = url.searchParams.get('commodity') ?? 'copper';
  const view = url.searchParams.get('view') ?? 'map';
  const asOfParam = url.searchParams.get('asOf');
  if (asOfParam && !/^\d{4}-\d{2}-\d{2}$/.test(asOfParam)) {
    return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  }
  const asOf = asOfParam ?? undefined;
  const knowledgeParam = url.searchParams.get('knowledge');
  if (knowledgeParam && knowledgeParam !== 'best_known' && knowledgeParam !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }
  const knowledge = (knowledgeParam ?? 'best_known') as 'best_known' | 'as_known_then';

  let run;
  try {
    run = await runEngine(commodity, { asOf, knowledge });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown commodity' }, { status: 404 });
  }
  const { state, providers, systems } = run;
  const evalDate = asOf ?? new Date().toISOString().slice(0, 10);
  // The scrubber is honest about observations (knownAt) — it must be equally
  // honest about arcs: flow topology is a single-vintage claim about a
  // period, and an evaluation date outside that period says so.
  const topology = topologyValidity(state, evalDate, knowledge);

  // Row accounting from the assembly (memoized — no second fetch): every
  // fetched row accepted, rejected with a reason, or filtered with the
  // predicate named. Filtering is never free.
  const { accounting, issues: assemblyIssues } = await getEconomyState(commodity);

  // D-3: every response is attributable to a build, a state and a
  // knowledge mode — otherwise "this number looks wrong" is an anecdote.
  const attributed = attribution(state, { asOf: run.asOf ?? null, mode: run.knowledge }, { providers, issues: assemblyIssues });

  if (view === 'state') {
    return NextResponse.json({ attribution: attributed, providers, state, accounting });
  }

  if (view === 'analytics') {
    const concentrationSuite = systems.concentration.result as Record<string, unknown>;
    return NextResponse.json({
      attribution: attributed,
      commodity: state.commodity,
      commodityName: state.commodityName,
      providers,
      asOf: run.asOf ?? null,
      knowledge: run.knowledge,
      topology,
      systems: listSystems(),
      concentration: concentrationSuite,
      centrality: systems.centrality,
      bottlenecks: systems.bottlenecks,
      anomalies: systems.anomalies,
      coverage: systems.coverage,
      divergence: systems.divergence,
      propagation: systems.propagation,
      // The system watching its own blindness: fires when a source's lead
      // ceiling degrades or a plausibility gate rejected its live data.
      // Empty on a healthy corpus — the panel renders nothing then.
      corpusHealth: corpusHealthSignals(state, evalDate),
      // "No signals" is the reading that matters most here and the one most
      // easily wrong: a health instrument that cannot distinguish "nothing
      // is wrong" from "nothing was checked" has lost the distinction that
      // IS the product. The population judged travels with the verdict.
      corpusHealthAccounting: corpusHealthAccounting(state, evalDate),
      // Ingest row accounting — filtering is never free (round 26).
      ingestAccounting: accounting,
      events: state.events,
      sources: state.sources,
    });
  }

  if (view === 'timeline') {
    // Playback range: from the earliest dated evidence (events + monthly
    // series) to the present month.
    const months: string[] = [];
    for (const ev of state.events) {
      months.push(ev.start.slice(0, 7));
      if (ev.end) months.push(ev.end.slice(0, 7));
    }
    for (const o of state.observations) {
      // Physical monthly series only (inventory). Annual observations are
      // history, not playback — and the live price/positioning series reach
      // back a decade, which would bury the event horizon in dead months.
      if (o.metric !== 'inventory') continue;
      if (o.period.start.slice(0, 7) !== o.period.end.slice(0, 7)) continue;
      months.push(o.period.start.slice(0, 7));
    }
    months.sort();
    const nowMonth = new Date().toISOString().slice(0, 7);
    const entityName = new Map(state.entities.map(e => [e.id, e.name]));
    return NextResponse.json({
      commodity: state.commodity,
      range: { min: months[0] ?? nowMonth, max: nowMonth },
      events: state.events
        .map(ev => {
          const reported = ev.firstReportedAt ?? ev.start;
          const latencyDays = Math.round((Date.parse(reported) - Date.parse(ev.start)) / 86400000);
          return {
            id: ev.id, title: ev.title, type: ev.type, severity: ev.severity,
            start: ev.start, end: ev.end ?? null,
            firstReportedAt: reported,
            // How much warning a detector could actually have given.
            detectionLatencyDays: latencyDays,
            entityId: ev.entityId ?? null,
            entityName: ev.entityId ? entityName.get(ev.entityId) ?? null : null,
            disruptive: DISRUPTIVE_EVENT_TYPES.includes(ev.type),
          };
        })
        .sort((a, b) => a.start.localeCompare(b.start)),
    });
  }

  if (view === 'graph') {
    const bottlenecks = systems.bottlenecks as AnalyticalResult<BottleneckCandidate[]>;
    const scoreByEntity = new Map(bottlenecks.result.map(b => [b.entityId, b.score]));
    const disrupted = disruptedEntities(state, evalDate);

    // Nodes: everything that participates in material structure (flows or
    // non-geographic dependencies). Countries/commodity stay out — they are
    // aggregates, and located_in is geography, not structure.
    // THE SELECTED TOPOLOGY, exactly as the map uses. This branch read
    // `state.flows` — the whole corpus, every vintage at once, unaffected
    // by asOf — while the map served `selectTopology(state, evalDate)`.
    // Measured: at 1990-01-01 the map served 0 flows and reported
    // topology.status `predates`; the graph served the same 39 links it
    // serves today, with no topology block and an "AS OF 1990-01-01" chip
    // over them. Two projections of one state disagreeing about whether a
    // date can be described at all — and the one asserting the knowledge
    // state in its own header was the one ignoring it. The phase-13
    // topology-validity machinery's APPARENT scope is the instrument's flow
    // topology; its EFFECTIVE scope was the map view. Nothing failed.
    const selected = selectTopology(state, evalDate);
    const linked = new Set<string>();
    for (const f of selected.flows) { linked.add(f.fromEntityId); linked.add(f.toEntityId); }
    for (const d of state.dependencies) {
      if (d.type === 'located_in') continue;
      linked.add(d.fromEntityId); linked.add(d.toEntityId);
    }
    const throughput = new Map<string, number>();
    for (const f of selected.flows) {
      const kt = toKtPerYear(f.quantity, f.unit) ?? 0;
      throughput.set(f.fromEntityId, (throughput.get(f.fromEntityId) ?? 0) + kt);
      throughput.set(f.toEntityId, (throughput.get(f.toEntityId) ?? 0) + kt);
    }
    const nodes = state.entities
      .filter(e => linked.has(e.id) && e.kind !== 'country' && e.kind !== 'commodity')
      .map(e => ({
        id: e.id, name: e.name, kind: e.kind, stage: e.stage ?? null,
        country: e.country ?? null,
        lat: e.lat ?? null, lng: e.lng ?? null,
        throughputKt: Math.round(throughput.get(e.id) ?? 0),
        bottleneckScore: scoreByEntity.get(e.id) ?? null,
        disrupted: disrupted.has(e.id),
      }));
    const nodeIds = new Set(nodes.map(n => n.id));
    const links = [
      ...selected.flows
        .filter(f => nodeIds.has(f.fromEntityId) && nodeIds.has(f.toEntityId))
        .map(f => ({
          id: f.id, source: f.fromEntityId, target: f.toEntityId,
          kind: 'flow' as const, ktPerYear: toKtPerYear(f.quantity, f.unit),
          // The MASS BASIS travels with the magnitude. toKtPerYear
          // normalises the UNIT and not the BASIS, so a gross-weight
          // flow and a contained-metal flow both arrive as "ktPerYear"
          // — ~4x apart for concentrate — under a field name that
          // asserts a commensurability the numbers do not have. The
          // graph view scales link width and particle count on this
          // number, so mixing the bases on one ramp is the same
          // incommensurability F-5 refuses on the map layer. Carried,
          // never silently converted: the corridor-grade machinery is
          // the only thing allowed to convert, and it can refuse.
          basis: f.basis ?? null,
          form: f.form, mode: f.mode, confidence: f.confidence,
          disrupted: disrupted.has(f.fromEntityId) || disrupted.has(f.toEntityId),
        })),
      ...state.dependencies
        .filter(d => d.type === 'depends_on' && nodeIds.has(d.fromEntityId) && nodeIds.has(d.toEntityId))
        .map(d => ({
          id: d.id, source: d.fromEntityId, target: d.toEntityId,
          kind: 'dependency' as const, strength: d.strength ?? null, basis: d.basis ?? null,
        })),
    ];
    // ACCOUNTING FOR THE DROP — the standing rule, applied to a view.
    //
    // Selecting the topology exposed a structural fact the old behaviour was
    // hiding: this view's node set excludes countries as aggregates, and the
    // corpus's historical vintages are country-granularity corridors. So at
    // 2017 the topology is `within` and holds 9 flows, and NONE of them are
    // representable here — every endpoint is a country. Previously the view
    // filled that hole with today's facility network, which is the stronger
    // failure: an empty picture at least does not assert anything.
    //
    // Zero links now comes with the reason, and the three zeroes are
    // distinguished: no topology covers the date (`predates`), the topology
    // is at a granularity this view cannot draw (below), or the network is
    // genuinely empty. The remedy for the middle one is the recorded
    // deferral — the country↔facility allocation model — not a widening of
    // this view.
    const flowLinkCount = links.filter(l => l.kind === 'flow').length;
    const withheldFlows = selected.flows.length - flowLinkCount;
    const representable = {
      flowsInSelectedTopology: selected.flows.length,
      flowLinks: flowLinkCount,
      withheld: withheldFlows,
      reason: withheldFlows > 0
        ? `${withheldFlows} of ${selected.flows.length} flow(s) in the ${selected.granularity}-granularity topology are not representable in this view: it excludes countries and the commodity as AGGREGATES rather than sited structure, and these corridors are stated between them. Resolving them to facilities needs the country↔facility allocation model (deferred — it would have to invent an attribution the corpus does not carry).`
        : null,
    };
    // The topology block travels with the payload, as it does on the map:
    // a view that draws a network at a date must be able to say the date is
    // outside what any vintage can describe. Zero links under `predates` is
    // a refusal; zero links with no block is an empty picture.
    return NextResponse.json({
      commodity: state.commodity, commodityName: state.commodityName,
      asOf: run.asOf ?? null, knowledge: run.knowledge,
      topology, representable, nodes, links,
    });
  }

  if (view === 'map') {
    const bottlenecks = systems.bottlenecks as AnalyticalResult<BottleneckCandidate[]>;
    const scoreByEntity = new Map(bottlenecks.result.map(b => [b.entityId, b.score]));
    const disrupted = disruptedEntities(state, evalDate);
    // Latest production/refined observation per entity at the evaluation date.
    const prodByEntity = new Map<string, { value: number; unit: string; end: string }>();
    for (const o of state.observations) {
      if (o.metric !== 'production' && o.metric !== 'refined_production') continue;
      if (o.period.end > `${evalDate.slice(0, 4)}-12-31`) continue;
      const prev = prodByEntity.get(o.entityId);
      if (!prev || o.period.end > prev.end) prodByEntity.set(o.entityId, { value: o.value, unit: o.unit, end: o.period.end });
    }
    const capByEntity = new Map<string, number>();
    for (const c of state.capacities) capByEntity.set(c.entityId, (capByEntity.get(c.entityId) ?? 0) + c.value);
    const eventsByEntity = new Map<string, number>();
    for (const ev of state.events) if (ev.entityId) eventsByEntity.set(ev.entityId, (eventsByEntity.get(ev.entityId) ?? 0) + 1);

    // F-5: coverage belongs in the cell treatment, not only a caption — each
    // facility dot carries its country's facility-model coverage ratio so the
    // renderer can put it in the ink (opacity). A country not in the coverage
    // result stays null: unknown coverage is not full coverage.
    // COVERAGE OF WHAT. The ratio is per country AND per metric, and this
    // projection applied the MINE-production table to every facility dot —
    // so a Chinese smelter's ink was driven by China's mine coverage, a
    // denominator that has nothing to do with it. Invisible while the mine
    // table dropped its 0% rows (those facilities fell through to `null`,
    // accidentally honest); the moment the zeroes were emitted it would have
    // become nine smelters and refineries wearing a measured number from the
    // wrong table. The table is chosen by the facility's own stage.
    const coverageSuite = systems.coverage.result as {
      mineProduction?: { result?: Array<{ countryId: string; ratio: number }> };
      refinedProduction?: { result?: Array<{ countryId: string; ratio: number }> };
    };
    const ratioTable = (rows: Array<{ countryId: string; ratio: number }> | undefined) => {
      const m = new Map<string, number>();
      for (const r of rows ?? []) {
        const countryName = state.entities.find(e => e.id === r.countryId)?.name;
        if (countryName) m.set(countryName, r.ratio);
      }
      return m;
    };
    const mineRatios = ratioTable(coverageSuite.mineProduction?.result);
    const refinedRatios = ratioTable(coverageSuite.refinedProduction?.result);
    const coverageFor = (e: { kind: string; country?: string }): number | null => {
      if (!e.country) return null;
      // Only the kinds the coverage tables actually measure carry a ratio.
      // A port or a manufacturer has no facility-model coverage figure, and
      // borrowing one from another stage would be a fabricated axis.
      const table = e.kind === 'mine' ? mineRatios
        : e.kind === 'smelter' || e.kind === 'refinery' ? refinedRatios
          : null;
      return table?.get(e.country) ?? null;
    };

    const entities = state.entities
      .filter(e => e.lat !== undefined && e.lng !== undefined && e.kind !== 'country' && e.kind !== 'commodity')
      .map(e => ({
        id: e.id, name: e.name, kind: e.kind, stage: e.stage ?? null,
        lat: e.lat!, lng: e.lng!, geoPrecision: e.geoPrecision ?? 'region',
        country: e.country ?? null, operator: e.operator ?? null,
        production: prodByEntity.get(e.id)?.value ?? null,
        productionUnit: prodByEntity.get(e.id)?.unit ?? null,
        capacity: capByEntity.get(e.id) ?? null,
        bottleneckScore: scoreByEntity.get(e.id) ?? null,
        eventCount: eventsByEntity.get(e.id) ?? 0,
        disrupted: disrupted.has(e.id),
        coverageRatio: coverageFor(e),
      }));

    // Coordinates for ARC endpoints come from the full register (country
    // centroids included) — a country-vintage arc needs country coords even
    // though country dots are not rendered as facilities.
    const coords = new Map(state.entities.filter(e => e.lat !== undefined && e.lng !== undefined).map(e => [e.id, [e.lng!, e.lat!] as [number, number]]));
    // Arcs come from the SELECTED topology — a present-day map must not
    // draw 2017 country vintages beside 2024 facility flows, and a
    // historical scrub draws the vintage serving its date (work order 3.2).
    const flows = selectTopology(state, evalDate).flows
      .filter(f => coords.has(f.fromEntityId) && coords.has(f.toEntityId))
      .map(f => ({
        id: f.id, from: f.fromEntityId, to: f.toEntityId,
        fromCoord: coords.get(f.fromEntityId)!, toCoord: coords.get(f.toEntityId)!,
        form: f.form, quantity: f.quantity, unit: f.unit, mode: f.mode, confidence: f.confidence,
        // The MASS BASIS must survive the projection. It did not, and the
        // consequence was the named class exactly: F-5's "one basis per
        // width-scaled layer" was correct and operating on data whose axis
        // had been stripped upstream, so every flow arrived 'unspecified',
        // all 39 shared one width ramp — gross-weight beside metal-content,
        // the incommensurability F-5 exists to prevent — and the
        // mixed-basis refusal could never fire because the layer never saw
        // two bases. Nothing failed; the unit tests passed because they fed
        // basis to the function directly. Canonical state holds 48
        // metal_content and 14 gross_weight flows.
        basis: f.basis ?? null,
        disrupted: disrupted.has(f.fromEntityId) || disrupted.has(f.toEntityId),
      }));

    return NextResponse.json({
      attribution: attributed,
      commodity: state.commodity,
      commodityName: state.commodityName,
      providers,
      asOf: run.asOf ?? null,
      knowledge: run.knowledge,
      topology,
      econ_entities: entities,
      econ_flows: flows,
      econ_events: state.events,
    });
  }

  return NextResponse.json({ error: `unknown view "${view}"` }, { status: 400 });
}
