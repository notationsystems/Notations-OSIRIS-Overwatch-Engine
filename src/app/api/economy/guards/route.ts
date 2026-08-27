import { NextResponse } from 'next/server';
import { evaluateAllDeferredDecisions, DEFERRED_DECISIONS } from '@/lib/economy/ledgerGuards';
import { getEconomyState } from '@/lib/economy/store';
import { attribution, buildVersion } from '@/lib/economy/attribution';

/**
 * Sea Dog Terminal — RUNTIME guard evaluation (deployment order D-1).
 *
 *   GET /api/economy/guards[?now=YYYY-MM-DD]
 *
 * The seven `validWhile` guards run in CI against the REPOSITORY's state.
 * The deployed instance's state is not that state: different vintages
 * fetched, different ladder rungs served, a different topology age, a
 * source possibly degraded to snapshot. A guard that passes in CI and
 * would fire in production is the split-commit hazard one layer over —
 * two greens about two different artifacts, which this project already
 * carries as a standing rule (ledger phase 35: CI's verdict on the
 * pushed commit is the only one that counts; here, the RUNTIME verdict
 * on the served state is the only one that describes what a researcher
 * is looking at).
 *
 * So this endpoint reports the runtime verdict AND says explicitly what
 * it is not: it does not know whether CI is green, and it never claims
 * to. The two verdicts are separate facts about separate artifacts and
 * are returned as such — `runtime` here, `ci` never inferred.
 *
 * A firing guard on a running instance is a FIRST-CLASS CONDITION, not a
 * test failure: the endpoint still returns 200 (the instrument is
 * working — it is telling you a deferral no longer holds), with the
 * failure typed, scoped to its commodity, and carrying the ledger
 * reference and the condition that lapsed.
 */

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const now = searchParams.get('now') ?? new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(now)) return NextResponse.json({ error: 'now must be YYYY-MM-DD' }, { status: 400 });

  const evaluatedAt = new Date().toISOString();
  const evaluation = await evaluateAllDeferredDecisions(now);

  // Attribution of the state the guards were evaluated AGAINST, per
  // commodity in scope — the whole point of the item is that this is the
  // deployed state, not the repository's.
  const states = await Promise.all(
    evaluation.scope.map(async commodity => {
      const { state } = await getEconomyState(commodity);
      return attribution(state, { asOf: now }).state; // carries commodity
    }),
  );

  return NextResponse.json({
    verdict_of: 'runtime',
    note: 'RUNTIME verdict, computed at request time against the state this instance is actually serving. This is a separate fact from the CI verdict, which is about the repository\'s state at a commit; a green CI run does not imply a green runtime and this endpoint never infers one. A firing guard here is a live condition to act on, not a failed test.',
    evaluatedAt,
    now,
    version: buildVersion(),
    scope: evaluation.scope,
    evaluatedCells: evaluation.evaluatedCells,
    guardCount: DEFERRED_DECISIONS.length,
    states,
    status: evaluation.failures.length === 0 ? 'all_holding' : 'condition_lapsed',
    failures: evaluation.failures,
  });
}
