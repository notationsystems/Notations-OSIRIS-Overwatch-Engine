import { describe, it, expect } from 'vitest';
import { detectAnomalies } from './analytics';
import { detectDivergences } from './divergence';
import { buildGraph } from './graph';
import { runEngine } from './engine';
import type { EngineRun } from './engine';
import { generateAlerts, reconcileAlerts } from './alerts';
import type { Alert } from './alerts';
import { backtestAlerts, monthEnds } from './alertBacktest';
import { syntheticState } from './fixtures';
import type { EconomyState } from './types';

/** Minimal EngineRun over a synthetic state — alerts only read frame, state
 *  and the anomaly/divergence system outputs. */
function fakeRun(state: EconomyState, asOf: string): EngineRun {
  const graph = buildGraph(state);
  return {
    commodity: state.commodity,
    asOf,
    knowledge: 'best_known',
    frame: { kind: 'reconstruction', asOf, knowledge: 'best_known' },
    state,
    graph,
    providers: [],
    systems: { anomalies: detectAnomalies(state), divergence: detectDivergences(state) },
  };
}

describe('alert derivation', () => {
  it('fires on a fresh monthly anomaly, and never on reflexive positioning', () => {
    const s = syntheticState(); // inventory break at 2024-08 (100 → 60)
    const prov = s.observations[0].provenance;
    // A positioning series with the same shape must produce NO alert.
    [10, 11, 9, 10, 11, 10, 10, -40].forEach((v, i) => s.observations.push({
      id: `obs:pos:${i}`, entityId: 'ent:port:gate', metric: 'net_positioning', value: v, unit: 'contracts',
      period: { start: `2024-0${i + 1}-01`, end: `2024-0${i + 1}-28` },
      valueKind: 'reported', confidence: 'high', provenance: prov,
    }));
    const alerts = generateAlerts(fakeRun(s, '2024-12-31'));
    expect(alerts.some(a => a.kind === 'anomaly' && a.entityId === 'ent:port:gate' && a.signalKey.includes('inventory'))).toBe(true);
    expect(alerts.some(a => a.signalKey.includes('net_positioning'))).toBe(false);
  });

  it('cadence gate: an annual-series anomaly stays an anomaly, never an alert', () => {
    const s = syntheticState();
    const prov = s.observations[0].provenance;
    // 2017–2023, joining the fixture's existing 2024 point — all annual.
    [800, 810, 790, 805, 800, 795, 400].forEach((v, i) => s.observations.push({
      id: `obs:aa:prod:${2017 + i}`, entityId: 'ent:country:aa', metric: 'production', value: v, unit: 'kt/y',
      period: { start: `${2017 + i}-01-01`, end: `${2017 + i}-12-31` },
      valueKind: 'reported', confidence: 'high', provenance: prov,
    }));
    const run = fakeRun(s, '2025-06-30');
    // The signal exists — the anomaly system keeps it…
    const anomalies = detectAnomalies(s).result;
    expect(anomalies.some(a => a.entityId === 'ent:country:aa' && a.metric === 'production')).toBe(true);
    // …but a year-long aggregate is history at publication, not an alert.
    const alerts = generateAlerts(run);
    expect(alerts.some(a => a.entityId === 'ent:country:aa' && a.signalKey.includes('production'))).toBe(false);
  });

  it('suppression memory: a signal already explained by a divergence must not fire', () => {
    const s = syntheticState();
    const base = s.observations.find(o => o.id === 'obs:inv:7')!; // the 60 break point
    // A second provider says the break never happened — a representative
    // figure of 100 for the same period. Resolution keeps the reported 60,
    // divergence classes the disagreement 'coverage', and the alert layer
    // must withhold the anomaly with the divergence as the reason.
    s.observations.push({
      ...base, id: 'obs:inv:7:alt', value: 100, valueKind: 'representative',
      provenance: { ...base.provenance, sourceId: 'other-provider' },
    });
    const alerts = generateAlerts(fakeRun(s, '2024-12-31'));
    const inv = alerts.filter(a => a.signalKey.includes('inventory') && a.signalPeriod === '2024-08');
    expect(inv.length).toBeGreaterThan(0);
    for (const a of inv) {
      expect(a.status).toBe('suppressed');
      expect(a.suppressedBy!.divergenceClass).toBe('coverage');
      expect(a.suppressedBy!.divergenceId).toMatch(/^div:/);
      expect(a.suppressedBy!.reason).toContain('coverage');
    }
  });

  it('event alerts carry detection latency, and hypotheticals never alert', async () => {
    const run = await runEngine('copper', { asOf: '2025-09-15', knowledge: 'as_known_then' });
    const alerts = generateAlerts(run);
    const grasberg = alerts.find(a => a.signalKey === 'event:evt:grasberg-mud-rush-2025')!;
    expect(grasberg).toBeDefined();
    expect(grasberg.detectionLatencyDays).toBe(2); // occurred 09-08, reported 09-10
    expect(grasberg.detectedAt).toBe('2025-09-10');

    const cf = await runEngine('copper', {
      asOf: '2025-09-15',
      scenario: { id: 'x', label: 'x', events: [{ entityId: 'ent:mine:escondida', type: 'strike', title: 'x', start: '2025-09-01', severity: 'high' }] },
    });
    expect(generateAlerts(cf).some(a => a.signalKey.startsWith('event:evt:scenario:'))).toBe(false);
  });

  it('an event not yet publicly reported cannot alert under as_known_then', async () => {
    // Drawdown began 2026-02-01 but was first reported 2026-03-01: at the
    // February month-end the alert must not exist; at March month-end it must.
    const feb = generateAlerts(await runEngine('copper', { asOf: '2026-02-28', knowledge: 'as_known_then' }));
    expect(feb.some(a => a.signalKey === 'event:evt:lme-stock-drawdown')).toBe(false);
    const mar = generateAlerts(await runEngine('copper', { asOf: '2026-03-31', knowledge: 'as_known_then' }));
    const dd = mar.find(a => a.signalKey === 'event:evt:lme-stock-drawdown')!;
    expect(dd).toBeDefined();
    expect(dd.detectionLatencyDays).toBe(28);
  });
});

describe('alert reconciliation (retraction)', () => {
  const mkAlert = (over: Partial<Alert>): Alert => ({
    id: 'alert:x', signalKey: 'x', kind: 'anomaly', entityId: 'ent:port:gate', entityName: 'Gate',
    title: 't', severity: 'medium', detectedAt: '2024-08-31', signalPeriod: '2024-08',
    detectionLatencyDays: null, status: 'fired', evidence: {}, explanation: 'e',
    ...over,
  });

  it('retracts a fired alert whose signal was reclassified, naming the reason', () => {
    const prev = [mkAlert({})];
    const now = [mkAlert({
      status: 'suppressed',
      suppressedBy: { divergenceId: 'div:multi:gate:inventory:2024-08', divergenceClass: 'coverage', reason: 'Signal is already classed coverage…' },
    })];
    const out = reconcileAlerts(prev, now, '2024-09-30');
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('retracted');
    expect(out[0].retraction!.at).toBe('2024-09-30');
    expect(out[0].retraction!.reason).toContain('Reclassified');
    expect(out[0].retraction!.divergenceId).toBe('div:multi:gate:inventory:2024-08');
  });

  it('retracts a fired alert whose signal is no longer derivable', () => {
    const out = reconcileAlerts([mkAlert({})], [], '2024-09-30');
    expect(out[0].status).toBe('retracted');
    expect(out[0].retraction!.reason).toContain('no longer derivable');
  });

  it('a standing alert keeps its original detection date; a retraction never silently reverts', () => {
    const kept = reconcileAlerts([mkAlert({ detectedAt: '2024-08-31' })], [mkAlert({ detectedAt: '2024-09-30' })], '2024-09-30');
    expect(kept[0].status).toBe('fired');
    expect(kept[0].detectedAt).toBe('2024-08-31'); // first detection is the fact

    const retracted = mkAlert({ status: 'retracted', retraction: { at: '2024-09-30', reason: 'r' } });
    const silent = reconcileAlerts([retracted], [], '2024-10-31');
    expect(silent[0].status).toBe('retracted'); // stays withdrawn
    const refired = reconcileAlerts([retracted], [mkAlert({})], '2024-10-31');
    expect(refired[0].status).toBe('fired');
    expect(refired[0].explanation).toContain('Previously retracted'); // names its history
  });
});

describe('alert backtest (decade of monthly knowledge states)', () => {
  it('measures the detector honestly before any UI exists', async () => {
    const r = await backtestAlerts('copper', { from: '2016-01-01', to: '2026-08-31' });
    expect(r.evaluations.length).toBe(128);
    expect(r.knowledge).toBe('as_known_then');

    // The invariant that makes every other number meaningful: no alert ever
    // relied on evidence that postdated its evaluation date.
    expect(r.lookaheadViolations).toBe(0);

    // The measured verdict on the current data (pinned deliberately — if a
    // data change moves these, the movement itself is the finding):
    //   - precision 0.438: 7 of 16 fired inventory alerts match the curated
    //     record; the 9 false positives are the real-but-uncurated mid-2025
    //     LME drawdown, i.e. partly truth-set incompleteness — but "partly"
    //     is not an excuse the metric is allowed to make for itself.
    //   - recall 0.2: only the exchange-stock event is detectable — the four
    //     mine/logistics events have no monthly-cadence series near them.
    //   - first-detection lead −30 days: monthly period-end knowability means
    //     detection TRAILS public reporting by a month on this stream.
    // Verdict encoded here: alerts are not ready to wake anyone.
    expect(r.precision).toBe(0.438);
    expect(r.recall).toBe(0.2);
    expect(r.medianLeadDays).toBe(-30);

    const lme = r.truthEvents.find(t => t.id === 'evt:lme-stock-drawdown')!;
    expect(lme.detected).toBe(true);
    expect(lme.detectionLeadDays).toBe(-30);
    // Undetected events are reported as undetected, not omitted.
    expect(r.truthEvents.filter(t => !t.detected).map(t => t.id).sort()).toEqual([
      'evt:cobre-panama-closure', 'evt:grasberg-mud-rush-2025', 'evt:kakula-seismic-2025', 'evt:panama-canal-drought',
    ]);

    // The cadence gate held: nothing derived from an annual series fired.
    expect(r.records.every(rec => rec.alert.signalKey.includes('inventory'))).toBe(true);
    expect(r.caveats.length).toBeGreaterThan(0);
  }, 120_000);

  it('monthEnds produces correct month boundaries', () => {
    expect(monthEnds('2024-01-01', '2024-03-31')).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
    expect(monthEnds('2023-11-01', '2024-02-01')).toEqual(['2023-11-30', '2023-12-31', '2024-01-31', '2024-02-29']);
  });
});
