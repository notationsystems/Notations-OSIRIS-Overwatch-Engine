import { describe, it, expect } from 'vitest';
import { runEngine } from './engine';
import { getEconomyState } from './store';
import { observationsAt, knownAtOf } from './analytics';

import type { AnalyticalResult } from './types';
import { GET as economyGet } from '@/app/api/economy/route';

const req = (url: string) => new Request(`http://localhost${url}`);

describe('point-in-time correctness (knownAt / as_known_then)', () => {
  it('as-known-then at mid-2024 serves the MCS2024 vintage, not the later revision', async () => {
    const bestKnown = await runEngine('copper', { asOf: '2024-06-30' });
    const asKnownThen = await runEngine('copper', { asOf: '2024-06-30', knowledge: 'as_known_then' });

    // Best-known reconstruction: MCS2025's reported 2023 figure (published
    // Jan 2025) is the hardest evidence for 2023.
    const bkPick = observationsAt(bestKnown.state, 'production', 'country', '2024-06-30')
      .find(o => o.entityId === 'ent:country:cl')!;
    expect(bkPick.id).toBe('obs:usgs-mcs2025:production:cl:2023');

    // As known then: MCS2025 did not exist in June 2024 — the MCS2024
    // vintage estimate is the best that was knowable.
    const aktPick = observationsAt(asKnownThen.state, 'production', 'country', '2024-06-30')
      .find(o => o.entityId === 'ent:country:cl')!;
    expect(aktPick.id).toBe('obs:usgs-mcs2024:production:cl:2023');
    expect(knownAtOf(aktPick) <= '2024-06-30').toBe(true);

    // Nothing in the filtered state was knowable after the evaluation date.
    for (const o of asKnownThen.state.observations) {
      expect(knownAtOf(o) <= '2024-06-30', o.id).toBe(true);
    }
  });

  it('events respect first-report dates: Grasberg is invisible the day before the news broke', async () => {
    // Mud rush occurred 2025-09-08; first public reports 2025-09-10.
    const before = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2025-09-09&knowledge=as_known_then'))).json();
    const grasbergBefore = before.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg');
    expect(grasbergBefore.disrupted).toBe(false);
    // Best-known reconstruction shows the disruption from occurrence.
    const beforeBk = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2025-09-09'))).json();
    expect(beforeBk.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg').disrupted).toBe(true);
    // Once reported, both modes agree.
    const after = await (await economyGet(req('/api/economy?commodity=copper&view=map&asOf=2025-09-15&knowledge=as_known_then'))).json();
    expect(after.econ_entities.find((e: { id: string }) => e.id === 'ent:mine:grasberg').disrupted).toBe(true);
  });

  it('rejects malformed knowledge and reports detection latency on the timeline', async () => {
    expect((await economyGet(req('/api/economy?commodity=copper&knowledge=psychic'))).status).toBe(400);
    const timeline = await (await economyGet(req('/api/economy?commodity=copper&view=timeline'))).json();
    const grasberg = timeline.events.find((e: { id: string }) => e.id === 'evt:grasberg-mud-rush-2025');
    expect(grasberg.firstReportedAt).toBe('2025-09-10');
    expect(grasberg.detectionLatencyDays).toBe(2);
  });

  it('MCS vintages chain through supersedes', async () => {
    const { state } = await getEconomyState('copper');
    const revised = state.observations.find(o => o.id === 'obs:usgs-mcs2025:production:cl:2023')!;
    expect(revised.supersedes).toBe('obs:usgs-mcs2024:production:cl:2023');
    const prior = state.observations.find(o => o.id === revised.supersedes)!;
    expect(prior.valueKind).toBe('estimated');
    expect(knownAtOf(prior) < knownAtOf(revised)).toBe(true);
  });

  it('live adapters stamp knownAt from release schedules, not just retrieval', async () => {
    const { state } = await getEconomyState('copper');
    // CFTC: Tuesday as-of, Friday release (+3 days).
    const cot = state.observations.find(o => o.id === 'obs:cftc-mm-net:2026-08-18')!;
    expect(cot.knownAt).toBe('2026-08-21');
    // Yahoo: a completed month's close is knowable the following day.
    const price = state.observations.find(o => o.id === 'obs:hg-price:2026-07');
    expect(price?.knownAt).toBe('2026-08-01');
  });
});

describe('coverage: the denominator the concentration figures were missing', () => {
  it('reports what fraction of a country the facility model accounts for', async () => {
    const run = await runEngine('copper');
    const coverage = (run.systems.coverage.result as { mineProduction: AnalyticalResult<Array<{ countryId: string; ratio: number; status: string; rolledUp: number; direct: number }>> }).mineProduction;
    const chile = coverage.result.find(r => r.countryId === 'ent:country:cl')!;
    // Four curated Chilean mines (~2,380 kt) vs the country's ~5,300 kt.
    expect(chile.rolledUp).toBeGreaterThan(2000);
    expect(chile.ratio).toBeGreaterThan(0.3);
    expect(chile.ratio).toBeLessThan(0.7);
    expect(chile.status).toBe('partial');
    // Indonesia: Grasberg alone is most of the country — ratio high but ≤ ~1.
    const indonesia = coverage.result.find(r => r.countryId === 'ent:country:id')!;
    expect(indonesia.ratio).toBeGreaterThan(0.6);
    // Panama after the closure: zero facilities against a zero country total
    // is a complete model of nothing, never a contradiction or an Infinity.
    const panama = coverage.result.find(r => r.countryId === 'ent:country:pa')!;
    expect(panama.ratio).toBe(1);
    expect(panama.status).toBe('complete');
  });

  it('granularity pin: facility and country populations never mix in one concentration', async () => {
    const { state } = await getEconomyState('copper');
    const { concentration } = await import('./analytics');
    const byCountry = concentration(state, 'production', 'country');
    const byMine = concentration(state, 'production', 'mine');
    // No facility observation may appear in the country calculation and vice versa.
    for (const id of byCountry.inputs.observationIds!) expect(id).not.toMatch(/ent:mine|:escondida|:grasberg/);
    for (const id of byMine.inputs.observationIds!) {
      const o = state.observations.find(x => x.id === id)!;
      const ent = state.entities.find(e => e.id === o.entityId)!;
      expect(ent.kind).toBe('mine');
    }
    // And the country total is NOT inflated by facility roll-ups: Chile's
    // share value equals its own country observation, not country + mines.
    const chile = byCountry.result.shares.find(s => s.entityId === 'ent:country:cl')!;
    expect(chile.value).toBeLessThan(6000); // 5300-ish, never 5300 + 2380
  });
});
