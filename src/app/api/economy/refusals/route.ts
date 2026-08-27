import { NextResponse } from 'next/server';
import { getEconomyState } from '@/lib/economy/store';
import { buildGraph } from '@/lib/economy/graph';
import { searchEvidence, type EvidenceHit } from '@/lib/economy/evidenceSearch';
import { asKnownThen } from '@/lib/economy/engine';
import { recordRefusalDigest, sessionDigest } from '@/lib/economy/sessionTelemetry';
import type { EconomyState } from '@/lib/economy/types';

/**
 * Sea Dog Terminal — the refused:* queue as an exportable digest
 * (work order 3.7).
 *
 *   GET /api/economy/refusals?commodity=copper[&asOf=YYYY-MM-DD][&knowledge=...]
 *   GET /api/economy/refusals?view=session   → the session telemetry digest
 *
 * Everything the system declined to answer, grouped by refusal type with
 * the type's shared remedy — a WORK QUEUE, and the most useful artifact a
 * researcher session can produce: each group is one mechanism with one
 * fix, ranked by how often it blocked an answer.
 */

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  if (searchParams.get('view') === 'session') {
    return NextResponse.json({ session: sessionDigest() });
  }
  const commodity = searchParams.get('commodity') ?? 'copper';
  const asOf = searchParams.get('asOf') ?? undefined;
  if (asOf && !DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  const knowledge = (searchParams.get('knowledge') ?? 'best_known') as 'best_known' | 'as_known_then';
  if (knowledge !== 'best_known' && knowledge !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }

  let state: EconomyState;
  try {
    ({ state } = await getEconomyState(commodity));
  } catch {
    return NextResponse.json({ error: `unknown commodity "${commodity}"` }, { status: 404 });
  }
  const evidenceState = knowledge === 'as_known_then' && asOf ? asKnownThen(state, asOf) : state;
  // Graph built AT the evaluation date — refusals reflect the topology
  // that actually serves it, same rule as the evidence search route.
  const hits = searchEvidence(evidenceState, buildGraph(evidenceState, asOf), { kind: 'refused', terms: [] }, { asOf, knowledge, limit: Infinity });

  const byType = new Map<string, { type: string; count: number; remedy: string; items: Array<{ title: string; entityId?: string; entityName?: string; evidenceIds: string[] }> }>();
  for (const h of hits as EvidenceHit[]) {
    const g = byType.get(h.type) ?? { type: h.type, count: 0, remedy: h.remedy, items: [] };
    g.count += 1;
    g.items.push({ title: h.title, entityId: h.entityId, entityName: h.entityName, evidenceIds: h.evidenceIds });
    byType.set(h.type, g);
  }
  recordRefusalDigest();

  return NextResponse.json({
    commodity,
    asOf: asOf ?? null,
    knowledge,
    generatedAt: new Date().toISOString(),
    totalRefusals: hits.length,
    // Most-blocking mechanism first: the work queue's ordering.
    byType: [...byType.values()].sort((a, b) => b.count - a.count),
    note: 'Each group is one refusal mechanism with one shared remedy. This is a work queue: what the instrument declined to answer, and what would make it answer.',
  });
}
