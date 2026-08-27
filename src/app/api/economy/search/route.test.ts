import { describe, it, expect } from 'vitest';
import { GET } from './route';

const get = (qs: string) => GET(new Request(`http://localhost/api/economy/search?${qs}`));

describe('GET /api/economy/search', () => {
  it('finds Escondida by name with coordinates and an evidence headline', async () => {
    const res = await get('q=escondida');
    expect(res.status).toBe(200);
    const body = await res.json();
    const hit = body.results[0];
    expect(hit.id).toBe('ent:mine:escondida');
    expect(hit.kind).toBe('mine');
    expect(hit.operator).toBe('BHP');
    expect(typeof hit.lat).toBe('number');
    expect(typeof hit.lng).toBe('number');
    expect(hit.zoom).toBe(9);
    // The headline is resolved evidence, labeled with its valueKind — the
    // search result never presents a number without its epistemic status.
    expect(hit.headline).toContain('production');
    expect(hit.headline).toMatch(/reported|estimated|representative|derived/);
  });

  it('is case-insensitive and matches by operator and country', async () => {
    const byOperator = await (await get('q=freeport')).json();
    expect(byOperator.results.map((r: { id: string }) => r.id)).toContain('ent:mine:grasberg');
    const byCountry = await (await get('q=CHILE')).json();
    // Direct name match (the country) surfaces first; facilities follow.
    expect(byCountry.results[0].id).toBe('ent:country:cl');
    expect(byCountry.results.length).toBeGreaterThan(1);
  });

  it('rejects 1-char queries and caps results at 8', async () => {
    expect((await get('q=g')).status).toBe(400); // no fuzzy-matching noise
    const port = await (await get('q=port of')).json();
    expect(port.results.length).toBeLessThanOrEqual(8);
    expect(port.results.every((r: { kind: string }) => r.kind === 'port')).toBe(true);
  });

  it('rejects unknown commodities and short queries', async () => {
    expect((await get('q=escondida&commodity=unobtainium')).status).toBe(404);
    expect((await get('q=')).status).toBe(400);
  });
});
