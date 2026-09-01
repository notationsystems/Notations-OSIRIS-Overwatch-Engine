import { DELETED_ROUTES, ROUTE_DISPOSITION, routeRetiredPayload, ROUTE_RETIRED_STATUS } from '@/lib/routeGate';

/**
 * The retired surface, as one handler.
 *
 * A-1 retired 31 general-purpose routes behind a 503 and kept their code so a
 * commodity vertical could flip one back on. Phase 70 deleted that code —
 * 8,835 lines no request could reach — and this file is what keeps the
 * deletion invisible from outside: the same `route_retired` payload, the same
 * 503, for the same names.
 *
 * WHY A CATCH-ALL IS SAFE HERE. Next matches a static segment before a
 * dynamic one, so every live route is served by its own handler and never
 * reaches this file. It sees only paths with no handler of their own, which
 * is exactly the set this is for.
 *
 * WHICH KIND OF NOTHING. Two cases arrive here and they are not the same
 * thing, so they do not get the same answer:
 *
 *   a retired route   → 503 `route_retired`, with the remedy that names how
 *                       to turn it back on. It existed, it was withdrawn.
 *   anything else     → 404 `no_such_route`. It never existed, and saying
 *                       "retired" would invent a history for a typo.
 *
 * A classified-but-not-deleted name reaching here would mean a handler went
 * missing without anybody deciding it should, so it is reported as its own
 * third case rather than folded into either.
 */

export const dynamic = 'force-dynamic';

function answer(segments: string[]): Response {
  const route = segments.join('/');

  if (DELETED_ROUTES.has(route)) {
    return new Response(JSON.stringify(routeRetiredPayload(route)), {
      status: ROUTE_RETIRED_STATUS,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (route in ROUTE_DISPOSITION) {
    // Classified, not deleted, and yet nothing served it. That is a missing
    // handler, not a retirement, and calling it a retirement would hide it.
    return new Response(JSON.stringify({
      error: 'route_handler_missing',
      route,
      detail: `'${route}' is classified '${ROUTE_DISPOSITION[route]}' and was not deleted, but no handler answered it.`,
      remedy: 'This is a build or routing defect, not a policy refusal. Check that the route file exists and exports a method handler.',
    }), { status: 500, headers: { 'content-type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    error: 'no_such_route',
    route,
    detail: `No route '${route}' exists on this surface.`,
    remedy: 'Check the path. GET /api/health lists the endpoints this deployment serves.',
  }), { status: 404, headers: { 'content-type': 'application/json' } });
}

type Ctx = { params: Promise<{ retired: string[] }> };

const handler = async (_request: Request, ctx: Ctx): Promise<Response> =>
  answer((await ctx.params).retired ?? []);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
