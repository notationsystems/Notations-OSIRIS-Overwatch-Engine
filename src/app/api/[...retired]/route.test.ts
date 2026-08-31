import { describe, it, expect } from 'vitest';
import { GET, POST } from './route';
import {
  DELETED_ROUTES, ROUTE_RETIRED_STATUS, requireRouteEnabled, routeRetiredPayload,
} from '@/lib/routeGate';

const call = (segments: string[], fn = GET) =>
  fn(new Request(`http://localhost/api/${segments.join('/')}`),
     { params: Promise.resolve({ retired: segments }) });

describe('deleting 31 handlers did not change a single answer', () => {
  it('every deleted route still gets the exact payload its own handler produced', async () => {
    // THE CLAIM THE DELETION RESTS ON. 8,835 lines were removed on the
    // grounds that a caller cannot tell. This asserts it over every name,
    // against the same function the deleted handlers called, rather than
    // against a copy of what it used to return.
    for (const route of DELETED_ROUTES) {
      const res = await call(route.split('/'));
      expect(res.status, route).toBe(ROUTE_RETIRED_STATUS);
      expect(await res.json(), route).toEqual(routeRetiredPayload(route));
    }
  });

  it('the refusal carries the remedy, on the deep paths too', async () => {
    // `cctv/stream-status` is two segments; a catch-all that joined them
    // wrongly would refuse under a name no operator could act on.
    const res = await call(['cctv', 'stream-status']);
    const body = await res.json();
    expect(body.route).toBe('cctv/stream-status');
    expect(body.remedy).toContain('PAYLOAD_ROUTES_ENABLED');
    expect(body.remedy).toContain('cctv/stream-status');
  });

  it('answers the same way whatever the method — a retired POST is not a 405', async () => {
    const g = await call(['flights']);
    const p = await call(['flights'], POST);
    expect(p.status).toBe(g.status);
    expect(await p.json()).toEqual(await g.json());
  });

  it('agrees with requireRouteEnabled, which is what live routes call', async () => {
    // Two paths to one refusal. If they ever disagree, a caller's experience
    // depends on which door it came through.
    const route = [...DELETED_ROUTES][0];
    const viaGate = requireRouteEnabled(route)!;
    const viaCatchAll = await call(route.split('/'));
    expect(viaCatchAll.status).toBe(viaGate.status);
    expect(await viaCatchAll.json()).toEqual(await viaGate.json());
  });
});

describe('which kind of nothing', () => {
  it('a path that never existed is 404, not a fabricated retirement', async () => {
    const res = await call(['no-such-thing']);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('no_such_route');
    // Saying "retired" here would invent a history for a typo.
    expect(JSON.stringify(body)).not.toContain('route_retired');
    expect(body.remedy).toContain('/api/health');
  });

  it('a deep unknown path is 404 too, and echoes what was asked for', async () => {
    const res = await call(['a', 'b', 'c']);
    expect(res.status).toBe(404);
    expect((await res.json()).route).toBe('a/b/c');
  });

  it('an empty path does not read as a retired route', async () => {
    const res = await call([]);
    expect(res.status).toBe(404);
  });

  it('a classified route with no handler reports a defect, not a policy refusal', async () => {
    // 'economy' is freight and live, so it never reaches the catch-all in a
    // working build. Reaching it here means the handler went missing without
    // anyone deciding it should — a 500, because calling it a retirement
    // would hide a broken build behind a policy message.
    const res = await call(['economy']);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('route_handler_missing');
  });
});
