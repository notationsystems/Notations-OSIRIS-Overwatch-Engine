import { NextResponse } from 'next/server';
import { runEngine, listSystems } from '@/lib/economy/engine';
import type { BottleneckCandidate } from '@/lib/economy/analytics';
import type { AnalyticalResult } from '@/lib/economy/types';

/**
 * OSIRIS — Physical-economy engine API.
 *
 *   GET /api/economy?commodity=copper&view=map        map-ready entities+flows
 *   GET /api/economy?commodity=copper&view=analytics  system outputs (concentration,
 *                                                     centrality, bottlenecks, anomalies, propagation)
 *   GET /api/economy?commodity=copper&view=state      full canonical state (research/debug)
 *
 * Routes are projections of an engine run. The canonical state and every
 * derived number live server-side; the UI never computes economics.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const commodity = url.searchParams.get('commodity') ?? 'copper';
  const view = url.searchParams.get('view') ?? 'map';

  let run;
  try {
    run = await runEngine(commodity);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown commodity' }, { status: 404 });
  }
  const { state, providers, systems } = run;

  if (view === 'state') {
    return NextResponse.json({ providers, state });
  }

  if (view === 'analytics') {
    const concentrationSuite = systems.concentration.result as Record<string, unknown>;
    return NextResponse.json({
      commodity: state.commodity,
      commodityName: state.commodityName,
      providers,
      systems: listSystems(),
      concentration: concentrationSuite,
      centrality: systems.centrality,
      bottlenecks: systems.bottlenecks,
      anomalies: systems.anomalies,
      propagation: systems.propagation,
      events: state.events,
      sources: state.sources,
    });
  }

  if (view === 'map') {
    const bottlenecks = systems.bottlenecks as AnalyticalResult<BottleneckCandidate[]>;
    const scoreByEntity = new Map(bottlenecks.result.map(b => [b.entityId, b.score]));
    const prodByEntity = new Map(
      state.observations.filter(o => o.metric === 'production' || o.metric === 'refined_production')
        .map(o => [o.entityId, o] as const),
    );
    const capByEntity = new Map<string, number>();
    for (const c of state.capacities) capByEntity.set(c.entityId, (capByEntity.get(c.entityId) ?? 0) + c.value);
    const eventsByEntity = new Map<string, number>();
    for (const ev of state.events) if (ev.entityId) eventsByEntity.set(ev.entityId, (eventsByEntity.get(ev.entityId) ?? 0) + 1);

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
      }));

    const coords = new Map(entities.map(e => [e.id, [e.lng, e.lat] as [number, number]]));
    const flows = state.flows
      .filter(f => coords.has(f.fromEntityId) && coords.has(f.toEntityId))
      .map(f => ({
        id: f.id, from: f.fromEntityId, to: f.toEntityId,
        fromCoord: coords.get(f.fromEntityId)!, toCoord: coords.get(f.toEntityId)!,
        form: f.form, quantity: f.quantity, unit: f.unit, mode: f.mode, confidence: f.confidence,
      }));

    return NextResponse.json({
      commodity: state.commodity,
      commodityName: state.commodityName,
      providers,
      econ_entities: entities,
      econ_flows: flows,
      econ_events: state.events,
    });
  }

  return NextResponse.json({ error: `unknown view "${view}"` }, { status: 400 });
}
