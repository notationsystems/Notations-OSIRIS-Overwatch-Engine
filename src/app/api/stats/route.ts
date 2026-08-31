import { NextResponse } from 'next/server';

export const maxDuration = 60;

/**
 * Payload Terminal — aggregate counters.
 *
 * Serves ~100 bytes instead of megabytes of GeoJSON when many clients boot at
 * once; the underlying routes keep their own cache TTLs, so the upstreams are
 * hit once per interval however many callers ask.
 *
 * WHAT PHASE 70 CHANGED, and why it is not a smaller version of the same
 * thing. This counted six feeds. Four of them — flights, satellites, cameras,
 * GDELT incidents — were deleted with the general-purpose surface, and the
 * `Promise.allSettled` around them meant the route would have kept answering
 * with `flights: 0`. A zero here reads as *nothing is flying*. The truth is
 * *this deployment does not collect that*, and those are different enough
 * that a reader acting on the first would be acting on a fabrication.
 *
 * So a counter that has no source is absent from `stats` and named in
 * `not_collected` instead. A caller sees which of the two it is getting
 * without having to know what was retired.
 */

/** Feeds retired with the general-purpose surface. Named, not zeroed. */
const NOT_COLLECTED = ['flights', 'sats', 'cctv', 'incidents'] as const;

export async function GET(req: Request) {
  try {
    const origin = new URL(req.url).origin;

    const [weatherRes, infraRes] = await Promise.allSettled([
      fetch(`${origin}/api/weather`, { signal: AbortSignal.timeout(20000), next: { revalidate: 300 } }),
      fetch(`${origin}/api/infrastructure`, { signal: AbortSignal.timeout(20000), next: { revalidate: 86400 } }),
    ]);

    /**
     * `null` where the feed exists but did not answer, a number where it did.
     * Collapsing an upstream failure to 0 would be the same lie one layer
     * down: a live feed that timed out is not a live feed reporting nothing.
     */
    const countOf = async (
      settled: PromiseSettledResult<Response>,
      key: string,
    ): Promise<number | null> => {
      if (settled.status !== 'fulfilled' || !settled.value.ok) return null;
      try {
        const data = await settled.value.json();
        return Array.isArray(data?.[key]) ? data[key].length : null;
      } catch {
        return null;
      }
    };

    const weather = await countOf(weatherRes, 'events');
    const nuclear = await countOf(infraRes, 'infrastructure');

    return NextResponse.json({
      stats: { weather, nuclear },
      not_collected: NOT_COLLECTED,
      detail: 'A counter in not_collected has no source in this deployment; it is absent rather than zero. A null in stats means the feed exists and did not answer.',
      timestamp: new Date().toISOString(),
    }, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60' },
    });

  } catch (error) {
    console.error('Stats aggregation failed:', error);
    return NextResponse.json({ error: 'Failed to compute stats' }, { status: 500 });
  }
}
