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

  it('404s unknown commodities and 400s unknown views and malformed asOf', async () => {
    expect((await economyGet(req('/api/economy?commodity=vibranium'))).status).toBe(404);
    expect((await economyGet(req('/api/economy?commodity=copper&view=nope'))).status).toBe(400);
    expect((await economyGet(req('/api/economy?commodity=copper&asOf=last-tuesday'))).status).toBe(400);
  });

  it('evaluates disruption flags at asOf for temporal playback', async () => {
    // During the Grasberg halt (started 2025-09-08): mine + its flows disrupted.
    const during = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2025-10-01'))).json();
    const grasberg = during.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg');
    expect(grasberg.disrupted).toBe(true);
    const grasbergFlow = during.econ_flows.find((f: { id: string }) => f.id === 'flow:grasberg-amamapare');
    expect(grasbergFlow.disrupted).toBe(true);
    expect(during.asOf).toBe('2025-10-01');
    // Before any event window (mid-2023, canal drought already active but
    // Grasberg fine): grasberg not disrupted.
    const before = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2023-01-01'))).json();
    const grasbergBefore = before.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg');
    expect(grasbergBefore.disrupted).toBe(false);
  });

  it('serves the timeline view with a playback range and dated events', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=timeline'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range.min <= '2023-06').toBe(true);
    expect(body.range.max >= '2026-08').toBe(true);
    expect(body.events.length).toBeGreaterThan(3);
    const grasberg = body.events.find((e: { id: string }) => e.id === 'evt:grasberg-mud-rush-2025');
    expect(grasberg).toMatchObject({ start: '2025-09-08', disruptive: true, entityName: 'Grasberg' });
    // Sorted by start date.
    const starts = body.events.map((e: { start: string }) => e.start);
    expect([...starts].sort()).toEqual(starts);
  });

  it('serves the graph view with no dangling link endpoints', async () => {
    const res = await economyGet(req('/api/economy?commodity=copper&view=graph'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nodes.length).toBeGreaterThan(30);
    // Countries and the commodity node are aggregates, not graph structure.
    expect(body.nodes.some((n: { kind: string }) => n.kind === 'country' || n.kind === 'commodity')).toBe(false);
    const ids = new Set(body.nodes.map((n: { id: string }) => n.id));
    for (const l of body.links) {
      expect(ids.has(l.source), `link ${l.id} source`).toBe(true);
      expect(ids.has(l.target), `link ${l.id} target`).toBe(true);
    }
    expect(body.links.some((l: { kind: string }) => l.kind === 'flow')).toBe(true);
    expect(body.links.some((l: { kind: string }) => l.kind === 'dependency')).toBe(true);
    const guixi = body.nodes.find((n: { id: string }) => n.id === 'ent:smelter:guixi');
    expect(guixi.throughputKt).toBeGreaterThan(1000);
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
