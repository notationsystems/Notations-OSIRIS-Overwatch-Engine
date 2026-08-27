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

  it('arrival gate: an annual-series LEVEL anomaly stays an anomaly, but its REVISION alerts', () => {
    const s = syntheticState();
    const prov = s.observations[0].provenance;
    // 2017–2023, joining the fixture's existing 2024 point — all annual,
    // arriving once a year (knownAt = end of the following January).
    [800, 810, 790, 805, 800, 795, 400].forEach((v, i) => s.observations.push({
      id: `obs:aa:prod:${2017 + i}`, entityId: 'ent:country:aa', metric: 'production', value: v, unit: 'kt/y',
      period: { start: `${2017 + i}-01-01`, end: `${2017 + i}-12-31` },
      knownAt: `${2018 + i}-01-31`,
      valueKind: 'reported', confidence: 'high', provenance: prov,
    }));
    // A later vintage revises 2023 down 8% — new information on a known date.
    s.observations.push({
      id: 'obs:aa:prod:2023:v2', entityId: 'ent:country:aa', metric: 'production', value: 368, unit: 'kt/y',
      period: { start: '2023-01-01', end: '2023-12-31' },
      knownAt: '2025-01-31', supersedes: 'obs:aa:prod:2023',
      valueKind: 'reported', confidence: 'high', provenance: { ...prov, sourceId: 'test-vintage-2025' },
    });
    const run = fakeRun(s, '2025-06-30');
    // The level signal exists — the anomaly system keeps it…
    const anomalies = detectAnomalies(s).result;
    expect(anomalies.some(a => a.entityId === 'ent:country:aa' && a.kind === 'rolling-deviation')).toBe(true);
    const alerts = generateAlerts(run);
    // …but information that arrives annually is history at publication —
    // the LEVEL never alerts (the gate keys on arrival cadence, not period
    // length)…
    expect(alerts.some(a => a.entityId === 'ent:country:aa' && a.signalKind !== 'revision')).toBe(false);
    // …while the REVISION is news on its publication date and does alert,
    // with detection stamped to the revising vintage's knownAt.
    const rev = alerts.find(a => a.entityId === 'ent:country:aa' && a.signalKind === 'revision')!;
    expect(rev).toBeDefined();
    expect(rev.detectedAt).toBe('2025-01-31');
    expect(rev.title).toContain('revised -8%');
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
    id: 'alert:x', signalKey: 'x', kind: 'anomaly', signalKind: 'rolling-deviation', entityId: 'ent:port:gate', entityName: 'Gate',
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

describe('corpus health (the system watching its own blindness)', () => {
  const dailyStockObs = (s: EconomyState, lastDay: number, note?: string) => {
    const prov = s.observations[0].provenance;
    for (let d = 1; d <= lastDay; d++) {
      const date = `2026-03-${String(d).padStart(2, '0')}`;
      s.observations.push({
        id: `obs:daily:${date}`, entityId: 'ent:port:gate', metric: 'inventory', value: 100 + d, unit: 'kt',
        period: { start: date, end: date }, knownAt: date,
        valueKind: 'reported', confidence: 'medium',
        provenance: { ...prov, sourceId: 'test-daily-scrape', ...(note ? { note } : {}) },
      });
    }
  };

  it('fires when the lead ceiling degrades — not merely when a fetch fails', () => {
    const s = syntheticState();
    // A daily source whose newest knowable value is 16 days old, served from
    // the snapshot rung: graceful degradation on the only daily source is
    // indistinguishable from working unless something says so.
    dailyStockObs(s, 15, 'bundled snapshot (live fetch failed)');
    const alerts = generateAlerts(fakeRun(s, '2026-03-31'));
    const scrape = alerts.find(a => a.kind === 'corpus' && a.entityId === 'test-daily-scrape')!;
    expect(scrape).toBeDefined();
    expect(scrape.signalKind).toBe('corpus_health');
    expect(scrape.signalKey).toBe('corpus:ladder_rung_pinned:test-daily-scrape');
    expect(scrape.severity).toBe('high'); // the best-lead source is load-bearing
    expect(scrape.explanation).toContain('16d old');
    expect(scrape.explanation).toContain('BEST-LEAD SOURCE');
    // A current daily source stays silent.
    const healthy = syntheticState();
    dailyStockObs(healthy, 30);
    expect(generateAlerts(fakeRun(healthy, '2026-03-31')).filter(a => a.kind === 'corpus' && a.entityId === 'test-daily-scrape')).toEqual([]);
  });

  it('a cleared condition resolves — it is not a withdrawn claim', () => {
    const stale = syntheticState();
    dailyStockObs(stale, 15);
    const fired = generateAlerts(fakeRun(stale, '2026-03-31')).filter(a => a.kind === 'corpus' && a.entityId === 'test-daily-scrape');
    expect(fired.length).toBe(1);
    const recovered = syntheticState();
    dailyStockObs(recovered, 31);
    const current = generateAlerts(fakeRun(recovered, '2026-04-01')).filter(a => a.kind === 'corpus' && a.entityId === 'test-daily-scrape');
    expect(current).toEqual([]);
    const ledger = reconcileAlerts(fired, current, '2026-04-01');
    expect(ledger[0].status).toBe('retracted');
    expect(ledger[0].retraction!.reason).toContain('Condition cleared');
  });
});

describe('alert backtest (decade of monthly knowledge states)', () => {
  it('pins the procedure and the horizon — the numbers move as curation and acquisition improve', async () => {
    const r = await backtestAlerts('copper', { from: '2016-01-01', to: '2026-08-31' });
    // Hybrid grid: 128 month-ends plus a daily grid where daily evidence
    // exists (the daily stocks stream) — evaluation cadence was the binding
    // constraint on measurable lead after the daily adapter landed.
    expect(r.evaluations.length).toBeGreaterThan(128);
    expect(r.knowledge).toBe('as_known_then');

    /* ── Procedure invariants (these never move) ── */
    // No alert ever relied on evidence that postdated its evaluation date.
    expect(r.lookaheadViolations).toBe(0);
    // Metrics are computed and bounded, but their VALUES are measurements of
    // the current corpus + curation, not properties of the detector — an
    // earlier revision of this test pinned precision 0.438, and completing
    // the event record moved it to 1.0 with the detector untouched. Pinned
    // values would enshrine curation state as detector quality.
    expect(r.precision).not.toBeNull();
    expect(r.precision!).toBeGreaterThanOrEqual(0);
    expect(r.precision!).toBeLessThanOrEqual(1);
    expect(r.recall).not.toBeNull();
    // Undetected events are reported as undetected, never omitted.
    expect(r.truthEvents.length).toBeGreaterThanOrEqual(11);
    expect(r.truthEvents.some(t => !t.detected)).toBe(true);
    // Revision alerts never enter precision (a publisher's explicit act is
    // not a disruption detection) — and the channel is alive.
    expect(r.records.every(rec => rec.alert.signalKind !== 'revision')).toBe(true);
    expect(r.revisionAlerts.length).toBeGreaterThan(0);
    expect(r.revisionAlerts.every(a => a.signalKind === 'revision')).toBe(true);
    expect(r.caveats.length).toBeGreaterThan(0);

    /* ── The scorecard: populations split, knob visible, volume reported ── */
    const sc = r.scorecard;
    // Both LME events are post-hoc (one curated after detector firings, one
    // written around the series the detector runs on); every mine/logistics
    // event is independent public record.
    expect(sc.postHocEvents.sort()).toEqual(['evt:lme-stock-drawdown', 'evt:lme-tariff-drawdown-2025']);
    expect(sc.preRegisteredEvents.length).toBeGreaterThanOrEqual(9);
    // THE headline: on the clean (pre-registered) truth set, no measurement
    // is currently possible — no independent event is detectable and no
    // alert went unmatched. Null IS the honest answer; a number here must
    // come from detecting an independent event, never from curation.
    expect(sc.precisionPreRegisteredOnly).toBeNull();
    // precisionAll exists for context and is never the headline.
    expect(sc.precisionAll).not.toBeNull();
    // Episodes, not alerts: many firings on one drawdown are one success.
    expect(sc.episodes.total).toBeLessThan(r.records.length);
    expect(sc.episodes.matched + sc.episodes.unmatched).toBe(sc.episodes.total);
    // The attribution window is exposed as the knob it is — tightening it to
    // zero pre-window days must change the measured answer.
    expect(sc.attributionSensitivity.map(row => row.preWindowDays)).toEqual([0, 30, 60, 90]);
    const w0 = sc.attributionSensitivity[0];
    const w90 = sc.attributionSensitivity[3];
    expect(w0.precisionAll !== w90.precisionAll || w0.medianLeadDays !== w90.medianLeadDays).toBe(true);
    // The axis precision cannot see: firing volume when nothing happens.
    expect(sc.quietMonths).toBeGreaterThan(0);
    expect(sc.quietPeriodAlertRate).toBe(0); // silent in quiet months — corpus fact

    /* ── Lead vs the market (COMEX benchmarks, never feeds) ── */
    for (const t of r.truthEvents.filter(x => x.detected && x.leadVsPriceDays !== undefined)) {
      // Corpus fact, predicted before measurement: on exchange-stock series
      // the price reaction is simultaneous-or-earlier at monthly resolution
      // — the +lead over journalism is NOT a lead over the market.
      expect(t.leadVsPriceDays!).toBeLessThanOrEqual(0);
    }

    /* ── The horizon (corpus facts — the honest headline) ── */
    const sources = r.horizons.sources;
    const daily = sources.find(s => s.sourceId === 'westmetall-lme-stocks')!;
    expect(daily.cadence).toBe('daily');
    expect(daily.maxAchievableLead.bestCaseLead).toBeGreaterThanOrEqual(-2);
    // Every other physical series can only trail the world by a month+:
    const annuals = sources.filter(s => s.sourceId.startsWith('usgs'));
    expect(annuals.length).toBeGreaterThan(0);
    for (const a of annuals) {
      expect(a.maxAchievableLead.bestCaseLead).toBeLessThanOrEqual(-30);
      expect(a.maxAchievableLead.typicalLead).toBeLessThanOrEqual(-180);
    }
    expect(r.horizons.events).not.toBeNull();
    expect(r.horizons.events!.eventDelay.p50).toBeLessThanOrEqual(2);

    /* ── Corpus facts the current data demonstrably supports ── */
    // With the daily stock stream, the 2026 drawdown reaches a NON-NEGATIVE
    // first-detection lead — the first in the system's history; before the
    // daily adapter this stream's ceiling was −30 days.
    const dd2026 = r.truthEvents.find(t => t.id === 'evt:lme-stock-drawdown')!;
    expect(dd2026.detected).toBe(true);
    expect(dd2026.detectionLeadDays!).toBeGreaterThanOrEqual(0);
    // The 2025 tariff drawdown predates the daily series (year-to-date
    // depth) and is detected only via the monthly curated stream — late.
    const dd2025 = r.truthEvents.find(t => t.id === 'evt:lme-tariff-drawdown-2025')!;
    expect(dd2025.detected).toBe(true);
    expect(dd2025.detectionLeadDays!).toBeLessThan(0);
    // Mine-level events remain undetectable: no daily/weekly series near them.
    for (const id of ['evt:escondida-strike-2017', 'evt:grasberg-mud-rush-2025', 'evt:kakula-seismic-2025', 'evt:peru-covid-shutdown-2020']) {
      expect(r.truthEvents.find(t => t.id === id)!.detected).toBe(false);
    }
  }, 120_000);

  it('monthEnds produces correct month boundaries', () => {
    expect(monthEnds('2024-01-01', '2024-03-31')).toEqual(['2024-01-31', '2024-02-29', '2024-03-31']);
    expect(monthEnds('2023-11-01', '2024-02-01')).toEqual(['2023-11-30', '2023-12-31', '2024-01-31', '2024-02-29']);
  });
});
