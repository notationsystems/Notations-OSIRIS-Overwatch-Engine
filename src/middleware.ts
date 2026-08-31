import { NextResponse } from 'next/server';
import type { NextRequest, NextFetchEvent } from 'next/server';
import { buildTelemetryPosts } from '@/lib/telemetryPayload';

/**
 * Payload — page telemetry.
 *
 * This file previously sent Umami a second event named `"Network Log"`
 * carrying `data: { IP: ip }`. Umami stores custom event properties verbatim,
 * so that accumulated a retained visitor-address log on every page view. The
 * payload construction now lives in `@/lib/telemetryPayload`, where a test can
 * assert of the OUTPUT that the address never reaches a body — see its header
 * for why the address in a HEADER is a different act from the address in a
 * body, and why a check that merely looks for the word cannot tell them apart.
 *
 * Telemetry is silent unless both `UMAMI_WEBSITE_ID` and `UMAMI_ENDPOINT` are
 * set. The previous hard-coded site-id fallback meant any fork posted its
 * traffic into one specific analytics account.
 */
export function middleware(request: NextRequest, event: NextFetchEvent) {
  const posts = buildTelemetryPosts({
    url: request.nextUrl.pathname,
    hostname: request.nextUrl.hostname,
    referrer: request.headers.get('referer') || '',
    userAgent: request.headers.get('user-agent') || 'Unknown Payload Terminal Client',
    clientIp:
      request.headers.get('cf-connecting-ip') ||
      request.headers.get('x-forwarded-for') ||
      '127.0.0.1',
    websiteId: process.env.UMAMI_WEBSITE_ID,
    endpoint: process.env.UMAMI_ENDPOINT,
  });

  if (posts.length) {
    event.waitUntil(
      Promise.all(
        posts.map((post) =>
          fetch(post.endpoint, {
            method: 'POST',
            headers: post.headers,
            body: post.body,
          }).catch(() => {}),
        ),
      ),
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
