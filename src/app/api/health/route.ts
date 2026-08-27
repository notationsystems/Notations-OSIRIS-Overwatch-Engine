import { NextResponse } from 'next/server';
import { evaluateAllDeferredDecisions, guardEvaluationScope } from '@/lib/economy/ledgerGuards';
import { isStateWarm } from '@/lib/economy/store';
import { buildVersion } from '@/lib/economy/attribution';
import { bootReport } from '@/lib/economy/boot';
import { processReport } from '@/lib/economy/observability';
import { rateStats } from '@/lib/economy/outboundRate';

/**
 * Health surface. The substrate's own liveness block is unchanged; the
 * `seaDogTerminal` block is the physical-economy instrument's health
 * (deployment order D-1, D-2).
 *
 * The guard summary here is the RUNTIME verdict against the state this
 * instance is serving — never CI's verdict about the repository, which
 * is a separate fact this process cannot observe. Full detail, with the
 * per-commodity scope and each lapsed condition, is at
 * /api/economy/guards.
 */

export const dynamic = 'force-dynamic';

export async function GET() {
  const now = new Date().toISOString().slice(0, 10);
  let guards: Record<string, unknown>;

  // A health check must NEVER block on state assembly. Measured in the
  // running configuration: a cold /api/health took 14.8s because guard
  // evaluation triggered the assembly it needed — a health endpoint that
  // hangs for the one reason it exists to survive, and long enough to
  // fail an orchestrator's liveness probe and get the instance killed
  // mid-warm. So while state is still warming, the guard verdict is
  // reported as UNAVAILABLE-YET rather than waited for.
  const scope = guardEvaluationScope();
  const warm = scope.every(isStateWarm);
  if (!warm) {
    return NextResponse.json({
      status: 'operational',
      platform: 'OSIRIS',
      version: '1.0.0',
      uptime: process.uptime ? Math.round(process.uptime()) : 0,
      timestamp: new Date().toISOString(),
      seaDogTerminal: {
        build: buildVersion(),
        boot: bootReport(),
        guards: {
          verdict_of: 'runtime',
          status: 'warming',
          scope,
          detail: '/api/economy/guards',
          note: 'State is still assembling; the runtime guard verdict is not available YET and is not guessed. /api/economy/guards will WAIT for the assembly and answer — this endpoint deliberately does not, so a liveness probe never hangs on a cold instance.',
        },
        process: processReport(),
        outbound: rateStats(),
      },
    });
  }

  try {
    const evaluation = await evaluateAllDeferredDecisions(now);
    guards = {
      verdict_of: 'runtime',
      status: evaluation.failures.length === 0 ? 'all_holding' : 'condition_lapsed',
      scope: evaluation.scope,
      failing: evaluation.failures.map(f => ({ id: f.id, commodity: f.commodity })),
      detail: '/api/economy/guards',
      note: 'Runtime verdict against served state. CI\'s verdict is about the repository at a commit and is NOT reported here — two greens about two artifacts is the hazard this exists to close.',
    };
  } catch (e) {
    // A guard evaluation that cannot run is itself a condition — reported,
    // never swallowed into a healthy-looking response.
    guards = {
      verdict_of: 'runtime',
      status: 'evaluation_failed',
      error: e instanceof Error ? e.message : 'guard evaluation failed',
      detail: '/api/economy/guards',
    };
  }

  return NextResponse.json({
    status: 'operational',
    platform: 'OSIRIS',
    version: '1.0.0',
    uptime: process.uptime ? Math.round(process.uptime()) : 0,
    timestamp: new Date().toISOString(),
    seaDogTerminal: {
      build: buildVersion(),
      boot: bootReport(),
      guards,
      // D-7: process health, distinct from corpus health (data staleness).
      process: processReport(),
      // D-10: what the outbound limiter actually did, per host.
      outbound: rateStats(),
    },
    endpoints: [
      '/api/flights',
      '/api/satellites',
      '/api/earthquakes',
      '/api/news',
      '/api/gdelt',
      '/api/markets',
      '/api/frontlines',
      '/api/region-dossier',
      '/api/economy',
      '/api/economy/guards',
    ],
  });
}
