import { NextRequest, NextResponse } from 'next/server';
import { getClientIp, isRateLimited } from '@/lib/ssrf-guard';
import { isGoverned, reserve, release, settle } from '@/lib/economy/spendGovernor';
import { userAgent } from '@/lib/identity';

/**
 * Basemap tile proxy.
 *
 * It exists so a tile key never reaches the client. That makes it the one
 * surface where somebody else's request costs us something, so it carries
 * the two disciplines the rest of the outbound path already has and this
 * route did not: a per-IP throttle, and the credit governor.
 *
 * `GOVERNED_AS` is the provider name to look up. A budget is registered by
 * deployment configuration, not here — the cap belongs to whoever holds the
 * plan. When no budget is registered the route still serves, and says so in
 * its response headers, so *ungoverned by decision* and *ungoverned because
 * nobody looked* are distinguishable from outside.
 */
const GOVERNED_AS = 'carto-basemaps';

/** Requests per IP per minute. Tiles come in bursts; a map pan is ~20. */
const IP_LIMIT = 240;

export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  const ip = getClientIp(request);
  if (isRateLimited(ip, IP_LIMIT, 60_000)) {
    return NextResponse.json(
      { error: 'Rate limited', limit: IP_LIMIT, windowSeconds: 60 },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let targetUrl: URL;
  try {
    // Only allow cartocdn.com domains to prevent open proxy abuse
    targetUrl = new URL(url);
    const host = targetUrl.hostname.toLowerCase();
    if (host !== 'cartocdn.com' && !host.endsWith('.cartocdn.com')) {
      return NextResponse.json({ error: 'Forbidden domain' }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: 'Malformed url parameter' }, { status: 400 });
  }

  // One tile, declared before the request rather than counted after it.
  const governed = isGoverned(GOVERNED_AS);
  const decision = governed ? reserve(GOVERNED_AS, 1, 'tiles', Date.now()) : null;
  if (decision && decision.verdict !== 'permitted') {
    return NextResponse.json(
      { error: 'Tile budget exhausted', reason: decision.reason, remedy: decision.remedy },
      { status: 429, headers: { 'Retry-After': '3600' } },
    );
  }

  const governance = governed ? `budgeted:${GOVERNED_AS}` : 'unbudgeted';

  try {
    const response = await fetch(targetUrl.toString(), { signal: AbortSignal.timeout(15000),
      headers: {
        'Accept': '*/*',
        'User-Agent': userAgent('basemap tile proxy'),
      },
      // Using Next.js fetch cache options to heavily cache tiles locally
      next: {
        revalidate: 31536000, // Cache for 1 year
      }
    });

    if (!response.ok) {
      // Upstream refused: nothing billable happened, so the hold goes back.
      if (decision?.reservationId) release(decision.reservationId, Date.now());
      return NextResponse.json({ error: 'Failed to fetch tile' }, { status: response.status });
    }

    const data = await response.arrayBuffer();
    if (decision?.reservationId) settle(decision.reservationId, 1, Date.now());

    // Forward the content-type from the upstream response
    const contentType = response.headers.get('content-type') || 'application/octet-stream';

    return new NextResponse(data, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Payload-Tile-Governance': governance,
      },
    });

  } catch (error) {
    if (decision?.reservationId) release(decision.reservationId, Date.now());
    console.error('Tile proxy error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
