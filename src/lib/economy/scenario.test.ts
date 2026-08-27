import { describe, it, expect } from 'vitest';
import { runEngine } from './engine';
import type { EventImpact } from './propagation';
import type { AnalyticalResult } from './types';
import { POST as scenarioPost } from '@/app/api/economy/scenario/route';

const post = (body: unknown) =>
  scenarioPost(new Request('http://localhost/api/economy/scenario', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }));

const impacts = (run: Awaited<ReturnType<typeof runEngine>>) =>
  (run.systems.propagation as AnalyticalResult<EventImpact[]>).result;

describe('scenario: counterfactual injection', () => {
  it('injects a hypothetical, brands it, and never pollutes the reconstruction', async () => {
    const asOf = '2024-06-15';
    const cf = await runEngine('copper', {
      asOf,
      scenario: {
        id: 'test-strike', label: 'Escondida strike',
        events: [{ entityId: 'ent:mine:escondida', type: 'strike', title: 'Hypothetical Escondida strike', start: '2024-06-01', end: '2024-08-31', severity: 'high' }],
      },
    });
    // The frame says what this is — and carries the knowledge mode.
    expect(cf.frame).toMatchObject({ kind: 'counterfactual', asOf, knowledge: 'best_known', scenarioLabel: 'Escondida strike' });
    expect(cf.frame.injectedEventIds).toEqual(['evt:scenario:test-strike:0']);
    // The injected event is branded beyond mistake.
    const injected = cf.state.events.find(e => e.id === 'evt:scenario:test-strike:0')!;
    expect(injected.provenance.sourceId).toBe('osiris-scenario');
    expect(injected.description).toContain('[COUNTERFACTUAL');
    // Propagation evaluates it like any state change.
    const strike = impacts(cf).find(i => i.eventId === 'evt:scenario:test-strike:0')!;
    expect(strike.active).toBe(true);
    expect(strike.disruptedKtPerYear).toBeGreaterThan(500);
    expect(strike.affected.map(a => a.entityId)).toContain('ent:port:antofagasta');
    expect(strike.affected.map(a => a.entityId)).toContain('ent:port:shanghai');
    // A subsequent reconstruction run is untouched: no scenario events leak.
    const base = await runEngine('copper', { asOf });
    expect(base.frame.kind).toBe('reconstruction');
    expect(base.state.events.some(e => e.id.startsWith('evt:scenario:'))).toBe(false);
  });

  it('perturbs a COMPANY and reaches every asset it operates, across borders', async () => {
    // The payoff of operator modeling: a scenario at the company node — a
    // labour dispute, financial distress, sanctions — propagates to all
    // operated facilities simultaneously, in three countries, which the
    // per-site event model could not express.
    const run = await runEngine('copper', {
      asOf: '2024-06-15',
      scenario: {
        id: 'fcx-distress', label: 'Freeport-McMoRan operational distress',
        events: [{ entityId: 'ent:company:freeport', type: 'disruption', title: 'Operator-level distress (hypothetical)', start: '2024-06-01', severity: 'high' }],
      },
    });
    const impact = impacts(run).find(i => i.eventId.startsWith('evt:scenario:fcx-distress'))!;
    expect(impact.active).toBe(true);
    const affected = impact.affected.map(a => a.entityId);
    // Operated assets in Indonesia, Peru and the US — correlated exposure
    // the country lens scores as diversified.
    expect(affected).toContain('ent:mine:grasberg');
    expect(affected).toContain('ent:mine:cerro-verde');
    expect(affected).toContain('ent:mine:morenci');
    // And the reach continues downstream through the material graph.
    expect(affected).toContain('ent:port:amamapare');
  });

  it('rejects scenarios that reference unknown entities', async () => {
    await expect(runEngine('copper', {
      scenario: { id: 'x', label: 'x', events: [{ entityId: 'ent:mine:atlantis', type: 'outage', title: 'x', start: '2024-01-01', severity: 'high' }] },
    })).rejects.toThrow(/unknown entity/);
  });

  it('replays the analytical layer at a past knowledge state (the backtest)', async () => {
    // "Given only what was knowable on 15 September 2025, what would
    //  propagation have concluded about Grasberg's dependent smelters?"
    const then = await runEngine('copper', { asOf: '2025-09-15', knowledge: 'as_known_then' });
    const thenGrasberg = impacts(then).find(i => i.eventId === 'evt:grasberg-mud-rush-2025')!;
    expect(thenGrasberg.active).toBe(true);
    const now = await runEngine('copper', { asOf: '2025-09-15' });
    const nowGrasberg = impacts(now).find(i => i.eventId === 'evt:grasberg-mud-rush-2025')!;
    // The dependent-smelter conclusion was reachable with contemporaneous
    // knowledge — the strongest available evidence the analytics deserve
    // trust: hindsight adds revised figures, not a different structural call.
    const deps = (i: EventImpact) => i.dependents.map(d => d.entityId).sort();
    const affected = (i: EventImpact) => i.affected.map(a => a.entityId).sort();
    expect(deps(thenGrasberg)).toEqual(deps(nowGrasberg));
    expect(affected(thenGrasberg)).toEqual(affected(nowGrasberg));

    // Vacuity guard. "Identical conclusion under both knowledge modes" has
    // two explanations: the analytics are robust to revision, or the two
    // runs read the same records and the test passes regardless of how
    // fragile the analytics are. So assert the inputs actually differed:
    // as_known_then must have withheld observations best_known can see.
    const thenObs = new Set(then.state.observations.map(o => o.id));
    const onlyNow = now.state.observations.filter(o => !thenObs.has(o.id));
    expect(onlyNow.length).toBeGreaterThan(0);
    // And label what is identical BY CONSTRUCTION, so the assertion above
    // never silently overclaims: dependency and flow records are curated
    // with a single vintage and no revision history, so the equality of the
    // structural walk itself is partially guaranteed. What this test
    // genuinely establishes is the event-visibility gate (below) and that
    // the conclusion holds while the observation layer differs — NOT that
    // the analytics survive dependency-graph revisions, which the dataset
    // cannot yet exercise.
    expect(then.state.dependencies.map(d => d.id)).toEqual(now.state.dependencies.map(d => d.id));
    expect(then.state.flows.map(f => f.id)).toEqual(now.state.flows.map(f => f.id));
    // And the frames make the two runs distinguishable — without knowledge in
    // the fingerprint, a disagreeing replay could not tell "baseline moved"
    // from "we know more now".
    expect(then.frame.knowledge).toBe('as_known_then');
    expect(now.frame.knowledge).toBe('best_known');

    // One day before the news broke, the event is invisible — but posing it
    // as a scenario (simulating earlier detection) recovers the same
    // conclusion: what a two-day-earlier detector would have bought.
    const blind = await runEngine('copper', { asOf: '2025-09-09', knowledge: 'as_known_then' });
    expect(impacts(blind).some(i => i.eventId === 'evt:grasberg-mud-rush-2025')).toBe(false);
    const posed = await runEngine('copper', {
      asOf: '2025-09-09', knowledge: 'as_known_then',
      scenario: {
        id: 'early-detect', label: 'Grasberg detected at occurrence',
        events: [{ entityId: 'ent:mine:grasberg', type: 'disruption', title: 'Grasberg halt (posed)', start: '2025-09-08', severity: 'high' }],
      },
    });
    const posedImpact = impacts(posed).find(i => i.eventId.startsWith('evt:scenario:early-detect'))!;
    expect(affected(posedImpact)).toEqual(affected(nowGrasberg));
  });
});

describe('POST /api/economy/scenario', () => {
  it('returns both frames and a structural delta', async () => {
    const res = await post({
      asOf: '2024-06-15',
      label: 'Escondida strike',
      events: [{ entityId: 'ent:mine:escondida', type: 'strike', title: 'Strike', start: '2024-06-01', end: '2024-08-31', severity: 'high' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.baselineFrame.kind).toBe('reconstruction');
    expect(body.counterfactualFrame.kind).toBe('counterfactual');
    expect(body.delta.newlyDisrupted.map((e: { id: string }) => e.id)).toContain('ent:mine:escondida');
    expect(body.delta.disruptedKtPerYear).toBeGreaterThan(500);
    expect(body.delta.newlyAffectedDownstream.length).toBeGreaterThan(0);
    expect(body.scenarioImpacts[0].explanation.length).toBeGreaterThan(0);
  });

  it('validates the request shape', async () => {
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: [{ entityId: 'ent:mine:escondida', type: 'apocalypse', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
    expect((await post({ events: [{ entityId: 'ent:mine:atlantis', type: 'outage', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
    expect((await post({ knowledge: 'psychic', events: [{ entityId: 'ent:mine:escondida', type: 'outage', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
  });
});
