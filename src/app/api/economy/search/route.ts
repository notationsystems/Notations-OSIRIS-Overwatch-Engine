import { NextResponse } from 'next/server';
import { getEconomyState } from '@/lib/economy/store';
import { strongestAttestingClass, knownAtOf, outranksObservation, type AttestationKind } from '@/lib/economy/analytics';
import { matchRegistryGaps, missRecord, type SearchMissRecord } from '@/lib/economy/sourceRegistry';
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
  /** Strongest evidence class attesting the entity's existence — the
   *  identity-level sibling of valueKind. 'representative' or below means
   *  the entity exists, within OSIRIS, purely on curation. */
  attestation?: AttestationKind;
}

const KIND_ZOOM: Record<string, number> = {
  mine: 9, smelter: 9, refinery: 9, port: 9, infrastructure: 8,
  manufacturer: 8, region: 5, country: 4, commodity: 3, company: 3,
};

/** Lower = surfaces first when match scores tie. */
const KIND_RANK: Record<string, number> = {
  country: 0, company: 1, mine: 2, smelter: 3, refinery: 4, port: 5, region: 6, infrastructure: 7, manufacturer: 8, commodity: 9,
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

function headlineFor(state: EconomyState, entityId: string, knowableBy?: string): string | undefined {
  for (const metric of HEADLINE_METRICS) {
    let best: Observation | undefined;
    for (const o of state.observations) {
      if (o.entityId !== entityId || o.metric !== metric || o.partnerEntityId) continue;
      if (knowableBy && knownAtOf(o) > knowableBy) continue; // as_known_then: hindsight never leaks into a headline
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Best-effort miss log. A query the register cannot answer is the instrument
 * ranking its own registry: appended to data-archive/search-misses.jsonl so
 * dormant sources accumulate demand evidence instead of opinions. The record
 * comes from missRecord(), which withholds the query string unless it
 * contains register vocabulary — the person-name policy must hold at the log,
 * not just at the index and the registry. Suppressed under test (synthetic
 * queries are not demand); failure (read-only filesystem) must never break
 * search.
 */
async function archiveSearchMiss(rec: SearchMissRecord & { ts: string }): Promise<void> {
  if (process.env.VITEST) return;
  try {
    const fs = await import('node:fs/promises');
    const dir = `${process.cwd()}/data-archive`;
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(`${dir}/search-misses.jsonl`, JSON.stringify(rec) + '\n');
  } catch { /* best-effort by design */ }
}

/**
 * Under as_known_then, an entity is knowable at asOf iff at least one of its
 * records was: observations by knownAt, events by firstReportedAt. Curated
 * structural records (flows, capacities, dependencies) carry no revision
 * history and are treated as knowable — the same by-construction label the
 * backtest carries. What this excludes is exactly the failure mode: an
 * entity carried only for live sources (e.g. Canada) whose first record
 * postdates the evaluation date.
 */
function knowableEntities(state: EconomyState, asOf: string): Set<string> {
  const out = new Set<string>();
  for (const o of state.observations) {
    if (knownAtOf(o) > asOf) continue;
    out.add(o.entityId);
    if (o.partnerEntityId) out.add(o.partnerEntityId);
  }
  for (const ev of state.events) {
    if (ev.entityId && (ev.firstReportedAt ?? ev.start) <= asOf) out.add(ev.entityId);
  }
  for (const f of state.flows) { out.add(f.fromEntityId); out.add(f.toEntityId); }
  for (const c of state.capacities) out.add(c.entityId);
  for (const d of state.dependencies) { out.add(d.fromEntityId); out.add(d.toEntityId); }
  return out;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const commodity = searchParams.get('commodity') ?? 'copper';
  const q = (searchParams.get('q') ?? '').trim().toLowerCase();
  if (q.length < 2) {
    return NextResponse.json({ error: 'q must be at least 2 characters' }, { status: 400 });
  }
  const asOf = searchParams.get('asOf') ?? undefined;
  if (asOf && !DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  const knowledge = searchParams.get('knowledge') ?? 'best_known';
  if (knowledge !== 'best_known' && knowledge !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }
  // Search must honour the knowledge state like every other surface — a
  // researcher scrubbed to 2019 under AS KNOWN must not be handed an entity
  // that entered the corpus in 2024. Coherence property, not a feature.
  const restrictTo = knowledge === 'as_known_then' && asOf ? asOf : undefined;

  let state: EconomyState;
  try {
    ({ state } = await getEconomyState(commodity));
  } catch {
    return NextResponse.json({ error: `unknown commodity "${commodity}"` }, { status: 404 });
  }
  const knowable = restrictTo ? knowableEntities(state, restrictTo) : null;
  const attestation = strongestAttestingClass(state);

  const hits: Array<SearchHit & { _score: number; _rank: number }> = [];
  let withheld = 0;
  for (const e of state.entities) {
    const score = matchScore(e, q);
    if (score === null) continue;
    if (knowable && !knowable.has(e.id)) { withheld += 1; continue; }
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
      headline: headlineFor(state, e.id, restrictTo),
      attestation: attestation.get(e.id),
      _score: score,
      _rank: KIND_RANK[e.kind] ?? 9,
    });
  }
  hits.sort((a, b) => a._score - b._score || a._rank - b._rank || a.name.localeCompare(b.name));
  const results = hits.slice(0, 8).map((h): SearchHit => ({
    id: h.id, name: h.name, kind: h.kind, stage: h.stage, country: h.country,
    operator: h.operator, lat: h.lat, lng: h.lng, zoom: h.zoom, headline: h.headline,
    attestation: h.attestation,
  }));

  // A TRUE miss — no hits and nothing withheld — is a demand signal against
  // the source registry: name the registered-but-unbuilt sources whose
  // declared coverage could have answered, and log the miss so the registry
  // is ranked by the instrument's own use. A withheld miss is different in
  // kind: the state CAN answer, the knowledge state withholds it — surfacing
  // registry gaps there would misdiagnose coherence as absence.
  let registryGaps: Array<{ sourceId: string; name: string; category: string; cadence: string; accessClass: string; note: string }> | undefined;
  let missNote: string | undefined;
  if (results.length === 0 && withheld === 0) {
    const gaps = matchRegistryGaps(q);
    if (gaps.length > 0) {
      registryGaps = gaps.map(g => ({
        sourceId: g.sourceId, name: g.name, category: g.category,
        cadence: g.cadence, accessClass: g.accessClass, note: g.note,
      }));
      missNote = `No canonical entity answers "${q}". ${gaps.length} registered source${gaps.length === 1 ? '' : 's'} with no adapter declare${gaps.length === 1 ? 's' : ''} coverage that could — a miss is a demand signal, not a dead end.`;
    }
    // State-derived register vocabulary: a miss mentioning any of these is a
    // demand signal; free text mentioning none of them (a person's name, say)
    // is counted but its string is never retained.
    const extraVocabulary = [
      state.commodity, state.commodityName,
      ...state.entities.flatMap(e => [e.name, e.kind, e.stage ?? '', e.country ?? '', e.countryCode ?? '', e.operator ?? '']),
    ];
    await archiveSearchMiss({
      ts: new Date().toISOString(),
      ...missRecord({ q, commodity, asOf: asOf ?? null, knowledge, gapIds: gaps.map(g => g.sourceId), extraVocabulary }),
    });
  }

  return NextResponse.json({
    commodity,
    query: q,
    asOf: asOf ?? null,
    knowledge,
    results,
    withheld,
    ...(withheld > 0 && restrictTo
      ? { withheldNote: `${withheld} further entit${withheld === 1 ? 'y' : 'ies'} match but ${withheld === 1 ? 'was' : 'were'} not knowable on ${restrictTo}.` }
      : {}),
    ...(registryGaps ? { registryGaps, missNote } : {}),
  });
}
