import { NextResponse } from 'next/server';
import { runDefaultWorld, renderWorldRun } from '../../../../lib/economy/worldRun';

/**
 * Payload — the end-to-end run over the SIMULATED FREIGHT WORLD.
 *
 * `/api/freight/demo` runs nine hand-built loads and pins every refusal. This
 * runs a generated population of ~520 with signals planted in it, and reports
 * whether each detector found the entity the world's own manifest says it
 * planted. The two are complements: one proves the refusals fire, the other
 * proves the detectors discriminate.
 *
 * Query parameters:
 *   ?now=<ISO>     the instant to evaluate at. REQUIRED semantics, defaulted for
 *                  convenience — the engines hold no clock, so the report is
 *                  reproducible and two responses can be diffed.
 *   ?seed=<int>    which world. Same seed, byte-identical world.
 *   ?format=text   the rendered report instead of the structured one.
 *
 * Nothing here is admissible. Every figure derives from records stamped
 * `representative`, and the report says so in its own body rather than relying
 * on a reader knowing which route they called.
 *
 * IT DOES NOT CALL `requireRouteEnabled` — the gate's contract is that only
 * RETIRED routes consult it, so a live route calling it would 503 itself
 * invisibly. `ROUTE_DISPOSITION` is what makes this route accounted for.
 */
export const DEFAULT_WORLD_NOW = '2026-09-05T00:00:00.000Z';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const now = url.searchParams.get('now') ?? DEFAULT_WORLD_NOW;
  if (Number.isNaN(Date.parse(now))) {
    return NextResponse.json(
      { error: 'unparseable `now`', detail: `${now} is not an instant this route can evaluate at.` },
      { status: 400 },
    );
  }
  const seedRaw = url.searchParams.get('seed');
  const seed = seedRaw === null ? undefined : Number(seedRaw);
  if (seed !== undefined && !Number.isSafeInteger(seed)) {
    return NextResponse.json(
      { error: 'unusable `seed`', detail: `${seedRaw} is not an integer seed; the world would not be reproducible.` },
      { status: 400 },
    );
  }

  try {
    const report = runDefaultWorld(now, seed);
    if (url.searchParams.get('format') === 'text') {
      return new Response(renderWorldRun(report), {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return NextResponse.json(report);
  } catch (e) {
    // A plant that cannot bind, or a prover that disagrees, is the generator
    // REFUSING — a result worth reading, not a silent half-built report.
    return NextResponse.json(
      { error: 'world run refused', detail: (e as Error).message },
      { status: 500 },
    );
  }
}
