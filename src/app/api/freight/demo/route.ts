import { NextResponse } from 'next/server';
import { runDemo, renderDemo } from '../../../../lib/economy/demoRun';
import { DEMO_NOW } from '../../../../lib/economy/freightFixture';

/**
 * Payload — end-to-end freight run, over the SIMULATED spatial backend.
 *
 * This is the surface that makes the freight layer reachable: until it existed,
 * the notary, the lifecycle engine and the spatial abstraction were imported by
 * nothing outside their own tests. A subsystem nothing calls is a subsystem
 * nobody can be wrong about.
 *
 * `?format=text` returns the rendered report; the default is the structured one.
 *
 * The clock is a QUERY PARAMETER, defaulted to the fixture's own instant, so the
 * response is reproducible and two calls can be diffed. A route that read the
 * wall clock would produce a different report every second and could never be
 * compared against anything.
 *
 * IT DOES NOT CALL `requireRouteEnabled`. The gate's contract, which its own test
 * enforces, is that only RETIRED routes consult it: `isRouteEnabled` is false for
 * anything outside the enabled set, so a live route calling the gate would 503
 * itself invisibly. Classification in `ROUTE_DISPOSITION` is what makes this route
 * accounted for; the gate call is what would retire it.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const now = url.searchParams.get('now') ?? DEMO_NOW;
  if (Number.isNaN(Date.parse(now))) {
    return NextResponse.json(
      { error: 'unparseable `now`', detail: `${now} is not an instant this route can evaluate at.` },
      { status: 400 },
    );
  }

  try {
    const report = await runDemo(now);
    if (url.searchParams.get('format') === 'text') {
      return new Response(renderDemo(report), {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return NextResponse.json(report);
  } catch (e) {
    // The run itself refusing is a RESULT, not a server error — but an
    // unexpected throw is neither, and saying so is better than a 200 with a
    // half-built report.
    return NextResponse.json(
      { error: 'demo run failed', detail: (e as Error).message },
      { status: 500 },
    );
  }
}
