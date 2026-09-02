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
    expect(injected.provenance.sourceId).toBe('payload-scenario');
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

  it('sanctions attach to owners: a MIND ID sanction reaches Grasberg through the 51% a strike cannot use', async () => {
    // Grasberg is the sharp case: Freeport operates it, MIND ID holds 51%.
    // An OPERATIONAL event at the state holding reaches nothing — a
    // shareholding is not a lever over operations…
    const strike = await runEngine('copper', {
      asOf: '2024-06-15',
      scenario: {
        id: 'mind-op', label: 'MIND ID operational event',
        events: [{ entityId: 'ent:company:mind-id', type: 'disruption', title: 'Operational event (hypothetical)', start: '2024-06-01', severity: 'high' }],
      },
    });
    const strikeImpact = impacts(strike).find(i => i.eventId.startsWith('evt:scenario:mind-op'))!;
    expect(strikeImpact.affected.map(a => a.entityId)).not.toContain('ent:mine:grasberg');
    // …but a FINANCIAL/LEGAL event attaches to owners, and traverses the
    // shareholder edge that operational events must not use.
    const sanction = await runEngine('copper', {
      asOf: '2024-06-15',
      scenario: {
        id: 'mind-sanction', label: 'Sanctions touching MIND ID',
        events: [{ entityId: 'ent:company:mind-id', type: 'sanction', title: 'Sanctions (hypothetical)', start: '2024-06-01', severity: 'high' }],
      },
    });
    const sancImpact = impacts(sanction).find(i => i.eventId.startsWith('evt:scenario:mind-sanction'))!;
    const affected = sancImpact.affected.map(a => a.entityId);
    expect(affected).toContain('ent:mine:grasberg');
    expect(affected).toContain('ent:smelter:manyar');
    expect(affected).toContain('ent:port:amamapare'); // and onward through the material graph
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
    // never silently overclaims: dependency records and CURATED flows are
    // single-vintage with no revision history, so the equality of the
    // structural walk itself is partially guaranteed. SOURCED flows stopped
    // being by-construction when work order 3.2 landed the country flow
    // vintages: captured 2026-08-27, so as_known_then at 2025 must withhold
    // them — the capture is the only publication bound the corpus can
    // honestly claim (Comtrade revises in place), and the earlier date is
    // refused rather than defaulted. What this test genuinely establishes
    // is the event-visibility gate (below) and that the conclusion holds
    // while the observation layer differs — NOT that the analytics survive
    // dependency-graph revisions, which the dataset cannot yet exercise.
    expect(then.state.dependencies.map(d => d.id)).toEqual(now.state.dependencies.map(d => d.id));
    const curatedFlowIds = (flows: typeof now.state.flows) => flows.filter(f => f.valueKind === 'representative').map(f => f.id);
    expect(curatedFlowIds(then.state.flows)).toEqual(curatedFlowIds(now.state.flows));
    const thenFlowIds = new Set(then.state.flows.map(f => f.id));
    const withheldVintages = now.state.flows.filter(f => f.valueKind !== 'representative' && !thenFlowIds.has(f.id));
    expect(withheldVintages.length).toBeGreaterThan(0); // vacuity: the knowledge gate actually withheld flow records here
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
    expect(body.unobservedStates).toEqual([]);
  });

  it('keeps unobserved impact state separate from the numeric delta', async () => {
    const res = await post({
      asOf: '2020-04-15',
      label: 'Escondida interruption against country topology',
      events: [{ entityId: 'ent:mine:escondida', type: 'outage', title: 'Facility interruption', start: '2020-04-01', severity: 'high' }],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delta.disruptedKtPerYear).toBeNull();
    expect(body.unobservedStates).toHaveLength(1);
    expect(body.unobservedStates[0]).toMatchObject({
      kind: 'unobserved_state',
      scope: { entityId: 'ent:mine:escondida' },
      metric: { name: 'disruptedKtPerYear', unit: 'kt/y', value: null },
      observability: {
        status: 'unobserved',
        reasonCode: 'facility_allocation_unobserved',
        missingFields: ['countryFacilityAllocation'],
      },
      acquisition: { status: 'evidence_required' },
      presentation: {
        component: 'ScenarioUnobservedStateCard',
        accent: 'violet',
        label: 'UNOBSERVED',
        valueText: 'Not observed',
      },
    });
    expect(body.unobservedStates[0]).not.toHaveProperty('baselineValue');
    expect(body.unobservedStates[0].acquisition.remedy).toContain('country-to-facility allocation model');
  });

  it('validates the request shape', async () => {
    expect((await post({ events: [] })).status).toBe(400);
    expect((await post({ events: [{ entityId: 'ent:mine:escondida', type: 'apocalypse', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
    expect((await post({ events: [{ entityId: 'ent:mine:atlantis', type: 'outage', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
    expect((await post({ knowledge: 'psychic', events: [{ entityId: 'ent:mine:escondida', type: 'outage', title: 'x', start: '2024-01-01', severity: 'high' }] })).status).toBe(400);
  });
});
