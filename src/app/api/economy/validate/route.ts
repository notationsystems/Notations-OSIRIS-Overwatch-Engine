import { NextResponse } from 'next/server';
import { getEconomyState } from '@/lib/economy/store';
import { validateClaim } from '@/lib/economy/validator';

/**
 * Sea Dog Terminal — the validator as a service (final order F-3).
 *
 *   GET /api/economy/validate?claim=...&records=obs:a,obs:b
 *       [&commodity=copper][&asOf=YYYY-MM-DD&knowledge=as_known_then]
 *
 * The claim comes from whatever model the analyst is using; the verdict
 * comes from the substrate — cross-model validation as the arrangement,
 * not a contrivance. GET-only: validation is a computation, never a
 * write, and nothing here persists — the claim text is NOT logged
 * anywhere (free text stays out of the logs by never being written, the
 * same construction as the MCP session log).
 *
 * Under knowledge=as_known_then, a cited record not knowable at asOf
 * cannot support the claim: hindsight evidence does not support an
 * as-known-then assertion.
 */

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RECORD_ID_RE = /^(obs|flow|cap):[a-z0-9:._-]+$/i;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const commodity = searchParams.get('commodity') ?? 'copper';
  const claim = searchParams.get('claim') ?? '';
  if (claim.trim().length < 3) return NextResponse.json({ error: 'claim must be non-empty' }, { status: 400 });
  const recordsParam = searchParams.get('records') ?? '';
  const recordIds = recordsParam.split(',').map(s => s.trim()).filter(Boolean);
  const badId = recordIds.find(id => !RECORD_ID_RE.test(id));
  if (badId) return NextResponse.json({ error: `records must be canonical record ids (obs:/flow:/cap:) — "${badId}" is not one` }, { status: 400 });
  const asOf = searchParams.get('asOf');
  if (asOf && !DATE_RE.test(asOf)) return NextResponse.json({ error: 'asOf must be YYYY-MM-DD' }, { status: 400 });
  const knowledge = searchParams.get('knowledge') ?? 'best_known';
  if (knowledge !== 'best_known' && knowledge !== 'as_known_then') {
    return NextResponse.json({ error: 'knowledge must be best_known or as_known_then' }, { status: 400 });
  }

  let state;
  try {
    ({ state } = await getEconomyState(commodity));
  } catch {
    return NextResponse.json({ error: `unknown commodity "${commodity}"` }, { status: 404 });
  }

  const knowableBy = knowledge === 'as_known_then' && asOf ? asOf : null;
  const validation = validateClaim(state, claim, recordIds, { knowableBy });
  return NextResponse.json({
    commodity,
    asOf: asOf ?? null,
    knowledge,
    ...validation,
    note: 'The validator judges the support relation only: it never recomputes analytics and never supplies evidence the claim did not cite. "supported" means the cited records state these numbers — not that the claim is true.',
  });
}
