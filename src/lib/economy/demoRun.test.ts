import { describe, it, expect } from 'vitest';
import { runDemo, renderDemo } from './demoRun';
import { DEMO_NOW, LOADS, reeferReadings, reeferReadingsClean } from './freightFixture';

/**
 * THE PLANTS MUST STAY REACHABLE.
 *
 * A fixture too clean to fail its own guards proves the guards run and nothing
 * else. These assert that every planted defect still produces the outcome it was
 * planted for — so a fixture edit that quietly makes one unreachable fails here
 * rather than making the demo look better.
 */
describe('the end-to-end run reaches every planted defect', () => {
  it('runs at all, and says SIMULATED before anything else', async () => {
    const r = await runDemo();
    expect(r.backend).toBe('simulated');
    expect(r.banner.startsWith('SIMULATED RUN')).toBe(true);
    expect(renderDemo(r)).toContain('SIMULATED');
  });

  it('PLANT 8 — the clearance binds: the tall unit is slower on the same lane', async () => {
    const r = await runDemo();
    expect(r.spatial.routeStrict.status).toBe('ok');
    expect(r.spatial.routeControl.status).toBe('ok');
    const hrs = (s: string) => Number(/(\d+)h(\d+)/.exec(s)![1]);
    expect(hrs(r.spatial.routeStrict.sentence)).toBeGreaterThan(hrs(r.spatial.routeControl.sentence));
  });

  it('the per-operation asymmetry reaches the report: route ok, matrix refused', async () => {
    const r = await runDemo();
    expect(r.spatial.routeStrict.status).toBe('ok');
    expect(r.spatial.matrixSameProfile.status).toBe('refused');
    expect(r.spatial.arbitration.route).toEqual([]);
    expect(r.spatial.arbitration.matrix).toEqual(['height']);
  });

  it('all THREE state readings appear — the fixture discriminates', async () => {
    // An earlier fixture had every load stale, so `unobserved` was the only
    // outcome and the silence plant was indistinguishable from the background.
    const kinds = new Set((await runDemo()).lifecycle.map(l => l.reading));
    expect([...kinds].sort()).toEqual(['known', 'no_history', 'unobserved']);
  });

  it('PLANT 1 — exactly one load has gone silent, and it is L-2', async () => {
    const silent = (await runDemo()).lifecycle.filter(l => l.reading === 'unobserved');
    expect(silent.map(l => l.loadId)).toEqual(['L-2']);
    expect(silent[0].detail).toContain('WAS in_transit');
  });

  it('PLANT 9 — L-3 is no_history, explicitly not "booked" by default', async () => {
    const l3 = (await runDemo()).lifecycle.find(l => l.loadId === 'L-3')!;
    expect(l3.reading).toBe('no_history');
    expect(l3.detail).toContain('not `booked` by default');
  });

  it('PLANT 7 — an exception with no action is suppressed AND recorded', async () => {
    const e = (await runDemo()).exceptions.find(x => x.loadId === 'L-2')!;
    expect(e.status).toBe('suppressed');
    expect(e.detail).toContain('no_action_available');
  });

  it('the incommensurable materiality is suppressed, not silently compared', async () => {
    const e = (await runDemo()).exceptions.find(x => x.loadId === 'L-5')!;
    expect(e.status).toBe('suppressed');
    expect(e.detail).toContain('incommensurable_materiality');
  });

  it('one exception genuinely FIRES — the gate is not suppressing everything', async () => {
    // A detector suppressing everything is exactly as informative as one firing
    // constantly. The demo must show both outcomes or it shows neither.
    const fired = (await runDemo()).exceptions.filter(x => x.status === 'fired');
    expect(fired.length).toBeGreaterThan(0);
    expect(fired[0].loadId).toBe('L-1');
  });

  it('PLANTS 3 and 4 — the total is a floor, with both reasons named', async () => {
    const r = await runDemo();
    expect(r.impact.assessed).toHaveLength(1);
    expect(r.impact.unassessed.join(' ')).toContain('contribution_unknown');
    expect(r.impact.unassessed.join(' ')).toContain('no_appointment');
    expect(r.impact.unassessed.join(' ')).toContain('breach=null');
  });

  it('PLANT 5 — the mixed-currency total refuses rather than summing', async () => {
    const r = await runDemo();
    expect(r.impact.refusedTotal).not.toBeNull();
    expect(r.impact.refusedTotal!).toContain('MIXED_CURRENCY');
    expect(r.impact.refusedTotal!).toContain('USD');
  });

  it('PLANT 6 — the reefer excursion breaches, and the clean control holds', async () => {
    const r = await runDemo();
    expect(r.notary.condition.startsWith('breached')).toBe(true);
    expect(r.notary.condition).toContain('9.4 temperature_c');
    // Without the control, `breached` could be coming from anything.
    expect(r.notary.conditionClean.startsWith('held')).toBe(true);
  });

  it('PLANT 2 — custody is unproven on the single-signed handoff', async () => {
    const r = await runDemo();
    expect(r.notary.custody.startsWith('unproven')).toBe(true);
    expect(r.notary.custody).toContain('unsigned handoff');
  });

  it('the refusal list is populated and every entry is real', async () => {
    const r = await runDemo();
    expect(r.refusals.length).toBeGreaterThanOrEqual(6);
    expect(r.refusals).toContain('impact: MIXED_CURRENCY');
    expect(r.refusals.some(x => x.includes('unobserved'))).toBe(true);
  });

  it('the run holds no clock — two runs are byte-identical', async () => {
    expect(JSON.stringify(await runDemo(DEMO_NOW))).toBe(JSON.stringify(await runDemo(DEMO_NOW)));
  });

  it('and moving the clock changes the answer — the parameter is not decorative', async () => {
    const later = await runDemo('2026-09-02T18:00:00.000Z');
    // Two days on, the loads that were `known` have gone quiet.
    expect(later.lifecycle.filter(l => l.reading === 'unobserved').length)
      .toBeGreaterThan((await runDemo(DEMO_NOW)).lifecycle.filter(l => l.reading === 'unobserved').length);
  });
});

describe('the reefer fixture is not vacuous', () => {
  it('the excursion run and the clean run genuinely differ', () => {
    const bad = reeferReadings(), good = reeferReadingsClean();
    expect(bad.length).toBe(good.length);
    expect(bad.some((r, i) => r.valueMilli !== good[i].valueMilli)).toBe(true);
  });

  it('the excursion is long enough to breach the stated tolerance', () => {
    const over = reeferReadings().filter(r => r.valueMilli > 8000);
    // 9 readings at 5-minute spacing = 40 minutes, against a 10-minute tolerance.
    expect(over.length).toBeGreaterThanOrEqual(9);
  });

  it('every load in the book has a distinct id', () => {
    expect(new Set(LOADS.map(l => l.loadId)).size).toBe(LOADS.length);
  });
});
