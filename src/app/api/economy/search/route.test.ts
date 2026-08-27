import { describe, it, expect } from 'vitest';
import { GET } from './route';
import { getEconomyState } from '@/lib/economy/store';

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

  it('rejects unknown commodities, short queries, and malformed dates', async () => {
    expect((await get('q=escondida&commodity=unobtainium')).status).toBe(404);
    expect((await get('q=')).status).toBe(400);
    expect((await get('q=escondida&asOf=not-a-date')).status).toBe(400);
    expect((await get('q=escondida&asOf=2019-06-01&knowledge=psychic')).status).toBe(400);
  });

  it('honours the knowledge state: entities not knowable at asOf are withheld and counted', async () => {
    // Canada exists in the register only for live observations whose knownAt
    // is 2025+. Under AS KNOWN at 2019 it must be withheld — search must not
    // be the way around the badge.
    const then = await (await get('q=canada&asOf=2019-06-01&knowledge=as_known_then')).json();
    expect(then.results).toEqual([]);
    expect(then.withheld).toBeGreaterThanOrEqual(1);
    expect(then.withheldNote).toContain('not knowable on 2019-06-01');
    const now = await (await get('q=canada')).json();
    expect(now.results.map((r: { id: string }) => r.id)).toContain('ent:country:ca');
  });

  it('headlines never leak hindsight under as_known_then', async () => {
    // Escondida is knowable in 2019 via curated structure, but its
    // observation evidence carries knownAt 2025 — the headline must not
    // surface a 2024 figure under a 2019 AS KNOWN state.
    const then = await (await get('q=escondida&asOf=2019-06-01&knowledge=as_known_then')).json();
    const hit = then.results[0];
    expect(hit.id).toBe('ent:mine:escondida');
    expect(hit.headline ?? '').not.toContain('2024');
  });
});

describe('search miss → registry gap', () => {
  it('a true miss names the registered-but-unbuilt sources that could answer it', async () => {
    const body = await (await get('q=vessel shipping movements')).json();
    expect(body.results).toEqual([]);
    const ids = body.registryGaps.map((g: { sourceId: string }) => g.sourceId);
    expect(ids).toContain('maritime-ais');
    // Built sources are never gaps.
    expect(ids).not.toContain('westmetall-lme');
    expect(body.missNote).toContain('demand signal');
  });

  it('an ownership miss surfaces the parent-chain register', async () => {
    const body = await (await get('q=beneficial ownership parent')).json();
    expect(body.results).toEqual([]);
    const ids = body.registryGaps.map((g: { sourceId: string }) => g.sourceId);
    expect(ids).toContain('openownership');
  });

  it('a hit carries no gaps; a withheld miss is a knowledge state, not a registry gap', async () => {
    const hit = await (await get('q=escondida')).json();
    expect(hit.registryGaps).toBeUndefined();
    // Canada at 2019 AS KNOWN: the state CAN answer — the knowledge state
    // withholds it. Offering registry gaps here would misdiagnose coherence
    // as absence.
    const withheldMiss = await (await get('q=canada&asOf=2019-06-01&knowledge=as_known_then')).json();
    expect(withheldMiss.results).toEqual([]);
    expect(withheldMiss.withheld).toBeGreaterThanOrEqual(1);
    expect(withheldMiss.registryGaps).toBeUndefined();
  });
});

describe('search policy: no natural persons', () => {
  it('SearchHit projects register fields only — no person-shaped keys can leak', async () => {
    const REGISTER_FIELDS = ['id', 'name', 'kind', 'stage', 'country', 'operator', 'lat', 'lng', 'zoom', 'headline'];
    const body = await (await get('q=freeport')).json();
    expect(body.results.length).toBeGreaterThan(0);
    for (const hit of body.results) {
      for (const key of Object.keys(hit)) expect(REGISTER_FIELDS).toContain(key);
    }
  });

  it('the entity register holds no person-shaped kinds', async () => {
    const { state } = await getEconomyState('copper');
    const PERSON_SHAPED = ['person', 'individual', 'officer', 'director', 'beneficial_owner'];
    for (const e of state.entities) {
      expect(PERSON_SHAPED, `entity ${e.id}`).not.toContain(e.kind);
    }
  });
});
