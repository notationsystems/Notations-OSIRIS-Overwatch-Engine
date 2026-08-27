import { NextResponse } from 'next/server';
import { getEconomyState } from '@/lib/economy/store';
import { outranksObservation } from '@/lib/economy/analytics';
import type { EconomyState, Entity, Observation } from '@/lib/economy/types';

/**
 * OSIRIS — Entity search: find "Escondida" from the search bar.
 *
 *   GET /api/economy/search?q=escondida[&commodity=copper]
 *
 * Searches the canonical entity register (name, operator, country, kind) and
 * returns map-ready hits with a one-line evidence headline (latest resolved
 * production/capacity), so a researcher can jump from a name to the entity's
 * position on the map and its state in the research panel. This is a
 * projection of canonical state — the search index IS the entity register,
 * never a parallel list that could drift from it.
 */

export const dynamic = 'force-dynamic';

interface SearchHit {
  id: string;
  name: string;
  kind: string;
  stage?: string;
  country?: string;
  operator?: string;
  lat?: number;
  lng?: number;
  /** Suggested map zoom for the entity's geoPrecision. */
  zoom: number;
  /** One-line evidence summary (latest resolved observation or capacity). */
  headline?: string;
}

const KIND_ZOOM: Record<string, number> = {
  mine: 9, smelter: 9, refinery: 9, port: 9, infrastructure: 8,
  manufacturer: 8, region: 5, country: 4, commodity: 3,
};

/** Lower = surfaces first when match scores tie. */
const KIND_RANK: Record<string, number> = {
  country: 0, mine: 1, smelter: 2, refinery: 3, port: 4, region: 5, infrastructure: 6, manufacturer: 7, commodity: 8,
};

function matchScore(e: Entity, q: string): number | null {
  const name = e.name.toLowerCase();
  if (name.startsWith(q)) return 0;
  if (name.includes(q)) return 1;
  if ((e.operator ?? '').toLowerCase().includes(q)) return 2;
  if ((e.country ?? '').toLowerCase().includes(q) || (e.countryCode ?? '').toLowerCase() === q) return 3;
  if (e.kind.toLowerCase() === q || (e.stage ?? '').toLowerCase() === q) return 4;
  return null;
}

const HEADLINE_METRICS = ['production', 'refined_production', 'smelter_production', 'throughput', 'inventory'] as const;

function headlineFor(state: EconomyState, entityId: string): string | undefined {
  for (const metric of HEADLINE_METRICS) {
    let best: Observation | undefined;
    for (const o of state.observations) {
      if (o.entityId !== entityId || o.metric !== metric || o.partnerEntityId) continue;
      if (!best
        || o.period.end > best.period.end
        || (o.period.end === best.period.end && outranksObservation(o, best))) best = o;
    }
    if (best) {
      return `${best.value.toLocaleString()} ${best.unit} ${metric.replace(/_/g, ' ')} (${best.period.start.slice(0, 4)}, ${best.valueKind})`;
    }
  }
  const capKt = state.capacities.filter(c => c.entityId === entityId).reduce((s, c) => s + c.value, 0);
  if (capKt > 0) return `${capKt.toLocaleString()} kt/y stated capacity`;
  return undefined;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const commodity = searchParams.get('commodity') ?? 'copper';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 2) {
    return NextResponse.json({ error: 'q must be at least 2 characters' }, { status: 400 });
  }

  let state: EconomyState;
  try {
    ({ state } = await getEconomyState(commodity));
  } catch {
    return NextResponse.json({ error: `unknown commodity "${commodity}"` }, { status: 404 });
  }

  const hits: Array<SearchHit & { _score: number; _rank: number }> = [];
  for (const e of state.entities) {
    const score = matchScore(e, q);
    if (score === null) continue;
    hits.push({
      id: e.id,
      name: e.name,
      kind: e.kind,
      stage: e.stage,
      country: e.country ?? e.countryCode,
      operator: e.operator,
      lat: e.lat,
      lng: e.lng,
      zoom: KIND_ZOOM[e.kind] ?? 6,
      headline: headlineFor(state, e.id),
      _score: score,
      _rank: KIND_RANK[e.kind] ?? 9,
    });
  }
  hits.sort((a, b) => a._score - b._score || a._rank - b._rank || a.name.localeCompare(b.name));

  return NextResponse.json({
    commodity,
    query: q,
    results: hits.slice(0, 8).map((h): SearchHit => ({
      id: h.id, name: h.name, kind: h.kind, stage: h.stage, country: h.country,
      operator: h.operator, lat: h.lat, lng: h.lng, zoom: h.zoom, headline: h.headline,
    })),
  });
}
