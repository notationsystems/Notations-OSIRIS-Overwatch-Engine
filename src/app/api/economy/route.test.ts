import { describe, it, expect } from 'vitest';
import { GET as economyGet } from './route';
import { GET as entityGet } from './entity/route';

const req = (url: string) => new Request(`http://localhost${url}`);

describe('GET /api/economy', () => {
  it('serves the map view with entities and coordinate-resolved flows', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=map'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.commodity).toBe('copper');
    expect(body.econ_entities.length).toBeGreaterThan(30);
    const escondida = body.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:escondida');
    expect(escondida).toMatchObject({ kind: 'mine', stage: 'production', geoPrecision: 'site' });
    expect(escondida.production).toBeGreaterThan(0);
    for (const f of body.econ_flows) {
      expect(f.fromCoord).toHaveLength(2);
      expect(f.toCoord).toHaveLength(2);
      expect(f.quantity).toBeGreaterThan(0);
    }
    // UI data contract: bottleneck score is present (number|null), never undefined.
    for (const e of body.econ_entities) expect(e.bottleneckScore === null || typeof e.bottleneckScore === 'number').toBe(true);
  });

  it('serves the analytics view with traceable results', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=analytics'));
    const body = await res.json();
    const prod = body.concentration.mineProductionByCountry;
    expect(prod.result.hhi).toBeGreaterThan(1000);
    expect(prod.inputs.observationIds.length).toBeGreaterThan(5);
    expect(body.concentration.smeltingCapacityByCountry.result.shares[0].name).toBe('China');
    expect(body.bottlenecks.result.length).toBeGreaterThan(5);
    expect(body.anomalies.result.length).toBeGreaterThan(0);
    expect(body.sources.length).toBeGreaterThan(2);
  });

  it('serves the full canonical state for research use', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=state'));
    const body = await res.json();
    expect(body.state.observations.every((o: { provenance?: { sourceId?: string } }) => o.provenance?.sourceId)).toBe(true);
  });

  it('404s unknown commodities and 400s unknown views', async () => {
    expect((await economyGet(req('/api/economy?commodity=vibranium'))).status).toBe(404);
    expect((await economyGet(req('/api/economy?commodity=copper&view=nope'))).status).toBe(400);
  });
});

describe('GET /api/economy/entity', () => {
  it('returns detail + upstream/downstream traversal for a smelter', async () => {
    const res = await entityGet(req('/api/economy/entity?commodity=copper&id=ent:smelter:guixi'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entity.name).toBe('Guixi Smelter');
    expect(body.capacities.length).toBeGreaterThan(0);
    const upstreamIds = body.upstream.map((s: { id: string }) => s.id);
    expect(upstreamIds).toContain('ent:port:shanghai');
    expect(upstreamIds).toContain('ent:mine:escondida');
    const downstreamIds = body.downstream.map((s: { id: string }) => s.id);
    expect(downstreamIds).toContain('ent:region:china-fabrication');
    // Every observation shown in the inspector carries provenance.
    for (const o of body.observations) expect(o.provenance.sourceId).toBeTruthy();
  });

  it('400s a missing id and 404s an unknown one', async () => {
    expect((await entityGet(req('/api/economy/entity?commodity=copper'))).status).toBe(400);
    expect((await entityGet(req('/api/economy/entity?commodity=copper&id=ent:mine:nope'))).status).toBe(404);
  });
});
