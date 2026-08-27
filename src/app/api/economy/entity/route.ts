import { NextResponse } from 'next/server';
import { entityDetail, getEconomyState } from '@/lib/economy/store';
import { strongestAttestingClass } from '@/lib/economy/analytics';
import { buildGraph, downstream, upstream } from '@/lib/economy/graph';

/**
 * OSIRIS — Entity inspector endpoint.
 *
 *   GET /api/economy/entity?commodity=copper&id=ent:mine:escondida
 *
 * Returns the entity's canonical state (observations, capacities, flows,
 * events — all with provenance) plus resolved upstream/downstream chains so
 * the UI can render dependency traversal without owning graph logic.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const commodity = url.searchParams.get('commodity') ?? 'copper';
  const id = url.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'missing id' }, { status: 400 });

  let assembled;
  try {
    assembled = await getEconomyState(commodity);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'unknown commodity' }, { status: 404 });
  }
  const { state } = assembled;

  const detail = entityDetail(state, id);
  if (!detail) return NextResponse.json({ error: `unknown entity "${id}"` }, { status: 404 });

  const graph = buildGraph(state);
  const name = (entityId: string) => {
    const e = state.entities.find(x => x.id === entityId);
    return e ? { id: entityId, name: e.name, kind: e.kind, stage: e.stage ?? null, country: e.country ?? null } : { id: entityId, name: entityId, kind: 'unknown', stage: null, country: null };
  };
  const resolveSteps = (steps: ReturnType<typeof upstream>) =>
    steps.map(s => ({ ...name(s.entityId), depth: s.depth, viaEdgeId: s.viaEdgeId, viaKind: s.viaKind }));

  const flowWithNames = (flows: typeof detail.flowsIn) =>
    flows.map(f => ({ ...f, fromName: name(f.fromEntityId).name, toName: name(f.toEntityId).name }));

  return NextResponse.json({
    commodity: state.commodity,
    entity: detail.entity,
    // Identity-level evidence class: what attests this entity's existence.
    // 'representative' or below = the entity exists purely on curation.
    attestation: strongestAttestingClass(state).get(id) ?? null,
    observations: detail.observations,
    capacities: detail.capacities,
    flowsIn: flowWithNames(detail.flowsIn),
    flowsOut: flowWithNames(detail.flowsOut),
    dependencies: detail.dependencies,
    events: detail.events,
    upstream: resolveSteps(upstream(graph, id)),
    downstream: resolveSteps(downstream(graph, id)),
    sources: state.sources,
  });
}
