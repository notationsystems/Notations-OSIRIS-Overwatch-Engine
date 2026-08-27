/**
 * OSIRIS — Alert backtest: measure the detector before anyone sees a panel.
 *
 * knownAt + vintages make something rare possible: the detector can be run
 * against history at each historical knowledge state — strictly
 * as_known_then, no lookahead — and its precision measured against the
 * curated event record before a single alert reaches a person. If precision
 * comes back low, alerts are not ready no matter how good the panel looks;
 * if it comes back high with real lead time, there is something worth
 * waking someone for. Either answer is worth more than the wiring.
 *
 * Honesty constraints baked in:
 *   - every evaluation runs knowledge=as_known_then at a month-end date;
 *   - the no-lookahead invariant is CHECKED, not assumed: an alert whose
 *     evidence postdates its evaluation date is counted as a violation and
 *     the report carries the count (it must be zero);
 *   - event-kind alerts never enter precision — they are notifications of
 *     the ground truth itself, and scoring them would grade the detector on
 *     information it did not derive;
 *   - the ground-truth event set is small and curated; the report says so
 *     rather than dressing per-cent figures in false generality.
 */

import type { EconEvent } from './types';
import { runEngine } from './engine';
import { buildGraph } from './graph';
import type { Alert } from './alerts';
import { generateAlerts, reconcileAlerts } from './alerts';
import { DISRUPTIVE_EVENT_TYPES } from './propagation';
import type { EventHorizon, InformationHorizon } from './horizon';
import { informationHorizons } from './horizon';
import { knownAtOf, periodCadence } from './analytics';

export interface BacktestAlertRecord {
  alert: Alert;
  /** Evaluation date the alert first fired. */
  firedAt: string;
  matchedEventId?: string;
  /** matched event's firstReportedAt − firedAt, days: positive = the alert
   *  preceded the public report. */
  leadDays?: number;
  disposition: 'true_positive' | 'false_positive';
}

export interface BacktestTruthRow {
  id: string;
  title: string;
  entityId: string;
  start: string;
  firstReportedAt: string;
  /** How the event entered the record — 'post_hoc' events cannot score the
   *  detector (they were curated after observing its output, or written
   *  around a series it runs on). Missing curation is treated as post_hoc. */
  curation: 'independent' | 'post_hoc';
  detected: boolean;
  /** Best lead among matching fired alerts (days, positive = early). */
  detectionLeadDays?: number;
  /** Month-end of the first material move (|MoM| ≥ 5%) in the COMEX price
   *  series around the event — the market benchmark. Price grades the
   *  detector here; it never feeds physical analytics. Monthly resolution. */
  priceReactionAt?: string;
  /** priceReactionAt − first detection, days: positive = OSIRIS detected
   *  before the (month-resolution) price reaction. Lead over journalism and
   *  lead over the market are different claims; this is the second. */
  leadVsPriceDays?: number;
}

export interface AlertScorecard {
  /** Events curated independent of detector output — the only ones that may
   *  score the detector. */
  preRegisteredEvents: string[];
  /** Events curated after observing detector firings (or written around a
   *  series the detector runs on). Real events, unusable as evidence. */
  postHocEvents: string[];
  /**
   * THE headline number: precision over the pre-registered truth set only,
   * with post-hoc-matched alerts excluded from the denominator entirely.
   * Null when no measurement is possible (no pre-registered event is
   * detectable and no alert went unmatched) — and null IS the honest current
   * answer, not a defect of the scorecard.
   */
  precisionPreRegisteredOnly: number | null;
  /** Precision over the full truth set — reported, never quoted alone. */
  precisionAll: number | null;
  /** An episode is a contiguous run of alerts on one subject (gap ≤ 45
   *  days): 16 alerts on one drawdown are one success, not sixteen. */
  episodes: { total: number; matched: number; unmatched: number };
  /** The attribution window is a free parameter that raises precision and
   *  lead together — so it is reported, not buried. */
  attributionSensitivity: Array<{ preWindowDays: number; precisionAll: number | null; medianLeadDays: number | null }>;
  /** What precision cannot see: firing behaviour when nothing is happening.
   *  First-firings per month across months outside every event window. */
  quietPeriodAlertRate: number;
  quietMonths: number;
}

export interface BacktestReport {
  commodity: string;
  from: string;
  to: string;
  knowledge: 'as_known_then';
  evaluations: string[];
  truthEvents: BacktestTruthRow[];
  /** Every anomaly alert that ever fired, with its disposition. */
  records: BacktestAlertRecord[];
  /** The population-split scorecard — precisionPreRegisteredOnly is the
   *  headline; everything else here is context for it. */
  scorecard: AlertScorecard;
  /** TP / (TP + FP) over fired anomaly alerts vs the FULL truth set —
   *  kept for continuity; superseded by scorecard.precisionAll and never
   *  the headline. */
  precision: number | null;
  /** Detected truth events / truth events; null when the truth set is empty. */
  recall: number | null;
  medianLeadDays: number | null;
  suppressedCount: number;
  retractedCount: number;
  /** Alerts whose evidence postdated their evaluation date. Must be 0. */
  lookaheadViolations: number;
  /**
   * The corpus's information horizon — the ceiling on lead time as a
   * property of the SOURCES, computable without a detector. This is the
   * headline the precision figure is subordinate to: if no physical source
   * has a bestCaseLead beating the event record's reporting delay, alerting
   * is an acquisition problem, and no detector work changes the answer.
   */
  horizons: { sources: InformationHorizon[]; events: EventHorizon | null };
  /** Revision alerts (knowledge moved, not the world): reported separately —
   *  scoring a publisher's explicit act against the disruption record would
   *  be a category error, so they never enter precision. */
  revisionAlerts: Alert[];
  /** Corpus-health alerts (the system watching its own blindness) — also
   *  outside precision. */
  corpusAlerts: Alert[];
  caveats: string[];
  /** Final reconciled ledger (fired + suppressed + retracted). */
  ledger: Alert[];
}

/** Month-end evaluation dates from `from` to `to` (inclusive months). */
export function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    out.push(`${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * Signal months within [event start − preWindowDays, event end (or open) +
 * 60 days]. The pre-window is the free parameter that maps alerts to events
 * — it raises precision and lead time together, which is why the scorecard
 * publishes precision at several settings instead of hiding the knob.
 *
 * The DEFAULT is set by causal mechanism, not by which value it produces —
 * and no mechanism has been argued for pre-event anticipation on the
 * current signal classes: for an exchange-stock event the event IS the
 * number moving, so "the series anticipated the event" is incoherent (a
 * draw preceding the curated start is the event starting earlier than
 * curated, not foresight). Absent an argued mechanism, zero is the
 * conservative default; a future signal class with a real anticipation
 * mechanism (e.g. consumers drawing inventory ahead of a disruption
 * becoming public) should raise it WITH the argument stated here.
 */
export const DEFAULT_PRE_WINDOW_DAYS = 0;

function withinEventWindow(signalMonth: string, ev: EconEvent, horizon: string, preWindowDays: number): boolean {
  const lo = new Date(Date.parse(ev.start) - preWindowDays * DAY_MS).toISOString().slice(0, 7);
  const endBase = ev.end ?? horizon;
  const hi = new Date(Date.parse(endBase) + 60 * DAY_MS).toISOString().slice(0, 7);
  return lo <= signalMonth && signalMonth <= hi;
}

/**
 * Month-end of the first material move (|MoM| ≥ 5%) in the COMEX monthly
 * price series inside [event start − 35d, event start + 95d]. Price is a
 * BENCHMARK here, never an input — the reflexivity firewall (price cannot
 * feed physical analytics) stands; grading the detector against the market
 * is exactly what price is for. Monthly closes bound the resolution: a
 * reaction "at" a month-end may have happened any day inside that month.
 */
function priceReactionAt(state: { observations: Array<{ metric: string; partnerEntityId?: string; period: { start: string; end: string }; value: number }> }, ev: EconEvent): string | null {
  const series = state.observations
    .filter(o => o.metric === 'price' && !o.partnerEntityId)
    .sort((a, b) => a.period.start.localeCompare(b.period.start));
  const lo = Date.parse(ev.start) - 35 * DAY_MS;
  const hi = Date.parse(ev.start) + 95 * DAY_MS;
  for (let i = 1; i < series.length; i++) {
    const t = Date.parse(series[i].period.end);
    if (t < lo || t > hi) continue;
    const prev = series[i - 1].value;
    if (prev === 0) continue;
    if (Math.abs((series[i].value - prev) / prev) >= 0.05) return series[i].period.end;
  }
  return null;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

export async function backtestAlerts(
  commodity: string,
  { from, to }: { from: string; to: string },
): Promise<BacktestReport> {
  // Hybrid evaluation grid: month-ends everywhere, plus a DAILY grid where
  // daily evidence exists — a daily source made evaluation cadence the
  // binding constraint on measurable lead, and a monthly grid would keep
  // reporting −30 days against data that was knowable the next morning.
  const probe = await runEngine(commodity, {});
  const dailyKnownAts = new Set<string>();
  for (const o of probe.state.observations) {
    if (o.partnerEntityId) continue;
    if (periodCadence(o) !== 'daily') continue;
    const k = knownAtOf(o);
    if (k >= from && k <= to) dailyKnownAts.add(k);
  }
  const evaluations = [...new Set([...monthEnds(from, to), ...dailyKnownAts])].sort();

  let ledger: Alert[] = [];
  const firedAtByKey = new Map<string, string>();
  let lookaheadViolations = 0;

  for (const asOf of evaluations) {
    const run = await runEngine(commodity, { asOf, knowledge: 'as_known_then' });
    const current = generateAlerts(run);
    for (const a of current) {
      if (a.detectedAt > asOf) lookaheadViolations += 1;
    }
    ledger = reconcileAlerts(ledger, current, asOf);
    for (const a of ledger) {
      if (a.status === 'fired' && !firedAtByKey.has(a.signalKey)) firedAtByKey.set(a.signalKey, asOf);
    }
  }

  // Ground truth from the full best-known record: disruptive events plus
  // demand surges (an inventory detector's legitimate target), inside the
  // window. Scenario injections can never appear here — the engine brands
  // them and generateAlerts skips them.
  const best = probe; // full best-known run from the grid probe above
  const truthTypes: EconEvent['type'][] = [...DISRUPTIVE_EVENT_TYPES, 'demand_surge'];
  const truth = best.state.events.filter(ev =>
    ev.entityId && truthTypes.includes(ev.type) && ev.start >= from && ev.start <= to);

  // Structural adjacency for matching: an anomaly at a port can legitimately
  // detect an event at the mine feeding it. One hop over flow/dependency
  // edges (located_in already excluded by buildGraph).
  const graph = buildGraph(best.state);
  const adjacent = (a: string, b: string): boolean => {
    if (a === b) return true;
    return graph.edges.some(e => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  };

  const firedAnomalies = ledger.filter(a =>
    a.kind === 'anomaly' && a.signalKind !== 'revision'
    && (a.status === 'fired' || a.status === 'retracted') && firedAtByKey.has(a.signalKey));
  const revisionAlerts = ledger.filter(a => a.signalKind === 'revision');
  const corpusAlerts = ledger.filter(a => a.kind === 'corpus');

  const curationOf = (ev: EconEvent): 'independent' | 'post_hoc' => ev.curation ?? 'post_hoc';
  // Match preferring pre-registered events, so an alert explicable by an
  // independent event is never attributed to a post-hoc one by accident.
  const matchFor = (alert: Alert, preWindowDays: number): EconEvent | undefined => {
    const candidates = truth.filter(ev =>
      adjacent(alert.entityId, ev.entityId!) && withinEventWindow(alert.signalPeriod, ev, to, preWindowDays));
    return candidates.find(ev => curationOf(ev) === 'independent') ?? candidates[0];
  };

  const buildRecords = (preWindowDays: number): BacktestAlertRecord[] => firedAnomalies.map(alert => {
    const firedAt = firedAtByKey.get(alert.signalKey)!;
    const match = matchFor(alert, preWindowDays);
    if (!match) return { alert, firedAt, disposition: 'false_positive' as const };
    return {
      alert,
      firedAt,
      matchedEventId: match.id,
      leadDays: daysBetween(firedAt, match.firstReportedAt ?? match.start),
      disposition: 'true_positive' as const,
    };
  });
  const records = buildRecords(DEFAULT_PRE_WINDOW_DAYS);
  const tp = records.filter(r => r.disposition === 'true_positive');

  const truthRows: BacktestTruthRow[] = truth.map(ev => {
    const matches = records.filter(r => r.matchedEventId === ev.id);
    const bestLead = matches.length > 0 ? Math.max(...matches.map(m => m.leadDays!)) : undefined;
    const firstFired = matches.length > 0 ? matches.map(m => m.firedAt).sort()[0] : undefined;
    const priceAt = matches.length > 0 ? priceReactionAt(best.state, ev) : null;
    return {
      id: ev.id, title: ev.title, entityId: ev.entityId!,
      start: ev.start, firstReportedAt: ev.firstReportedAt ?? ev.start,
      curation: curationOf(ev),
      detected: matches.length > 0,
      ...(bestLead !== undefined ? { detectionLeadDays: bestLead } : {}),
      ...(priceAt && firstFired ? { priceReactionAt: priceAt, leadVsPriceDays: daysBetween(firstFired, priceAt) } : {}),
    };
  });

  // Lead time is a property of FIRST detection: an alert that re-confirms an
  // event already public is a true positive for precision, but counting its
  // lag as "lead time" would grade the detector on echoes. One lead per
  // detected event — the earliest.
  const median = (xs: number[]): number | null => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 === 1 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
  };
  const medianLeadDays = median(truthRows.filter(t => t.detectionLeadDays !== undefined).map(t => t.detectionLeadDays!));

  /* ── Scorecard: split the populations, count episodes, expose the knob ── */
  const preRegisteredEvents = truth.filter(ev => curationOf(ev) === 'independent').map(ev => ev.id);
  const postHocEvents = truth.filter(ev => curationOf(ev) === 'post_hoc').map(ev => ev.id);
  const isPostHocMatch = (r: BacktestAlertRecord) => r.matchedEventId !== undefined && postHocEvents.includes(r.matchedEventId);
  const tpPre = tp.filter(r => !isPostHocMatch(r));
  const fp = records.filter(r => r.disposition === 'false_positive');
  const preDenominator = tpPre.length + fp.length;

  const episodesOf = (recs: BacktestAlertRecord[]) => {
    const byEntity = new Map<string, BacktestAlertRecord[]>();
    for (const r of recs) {
      if (!byEntity.has(r.alert.entityId)) byEntity.set(r.alert.entityId, []);
      byEntity.get(r.alert.entityId)!.push(r);
    }
    const episodes: BacktestAlertRecord[][] = [];
    for (const group of byEntity.values()) {
      group.sort((a, b) => a.firedAt.localeCompare(b.firedAt));
      let current: BacktestAlertRecord[] = [];
      for (const r of group) {
        if (current.length > 0 && daysBetween(current[current.length - 1].firedAt, r.firedAt) > 45) {
          episodes.push(current);
          current = [];
        }
        current.push(r);
      }
      if (current.length > 0) episodes.push(current);
    }
    return episodes;
  };
  const episodes = episodesOf(records);
  const matchedEpisodes = episodes.filter(ep => ep.some(r => r.disposition === 'true_positive'));

  const attributionSensitivity = [0, 30, 60, 90].map(preWindowDays => {
    const recs = buildRecords(preWindowDays);
    const wTp = recs.filter(r => r.disposition === 'true_positive');
    const perEventBest = new Map<string, number>();
    for (const r of wTp) {
      const prev = perEventBest.get(r.matchedEventId!);
      if (prev === undefined || r.leadDays! > prev) perEventBest.set(r.matchedEventId!, r.leadDays!);
    }
    return {
      preWindowDays,
      precisionAll: recs.length > 0 ? Number((wTp.length / recs.length).toFixed(3)) : null,
      medianLeadDays: median([...perEventBest.values()]),
    };
  });

  // Quiet months: no truth-event window (start − default pre-window .. end +
  // 60d) touches them. Firing rate there is the operational axis precision
  // cannot see.
  const allMonths = monthEnds(from, to).map(d => d.slice(0, 7));
  const quietMonthList = allMonths.filter(m =>
    !truth.some(ev => withinEventWindow(m, ev, to, DEFAULT_PRE_WINDOW_DAYS)));
  const quietFirings = records.filter(r => quietMonthList.includes(r.firedAt.slice(0, 7)));

  const scorecard: AlertScorecard = {
    preRegisteredEvents,
    postHocEvents,
    precisionPreRegisteredOnly: preDenominator > 0 ? Number((tpPre.length / preDenominator).toFixed(3)) : null,
    precisionAll: records.length > 0 ? Number((tp.length / records.length).toFixed(3)) : null,
    episodes: { total: episodes.length, matched: matchedEpisodes.length, unmatched: episodes.length - matchedEpisodes.length },
    attributionSensitivity,
    quietPeriodAlertRate: quietMonthList.length > 0 ? Number((quietFirings.length / quietMonthList.length).toFixed(3)) : 0,
    quietMonths: quietMonthList.length,
  };

  return {
    commodity,
    from,
    to,
    knowledge: 'as_known_then',
    evaluations,
    truthEvents: truthRows,
    records,
    scorecard,
    precision: scorecard.precisionAll,
    recall: truthRows.length > 0 ? Number((truthRows.filter(t => t.detected).length / truthRows.length).toFixed(3)) : null,
    medianLeadDays,
    suppressedCount: ledger.filter(a => a.status === 'suppressed').length,
    retractedCount: ledger.filter(a => a.status === 'retracted').length,
    lookaheadViolations,
    horizons: informationHorizons(best.state).result,
    revisionAlerts,
    corpusAlerts,
    caveats: [
      `Ground truth is the curated event record: ${truthRows.length} event(s) in window (${preRegisteredEvents.length} pre-registered, ${postHocEvents.length} post-hoc) — treat the percentages as small-n measurements, not general performance claims.`,
      'precisionAll pools post-hoc events (curated after observing detector output) with independent ones; only precisionPreRegisteredOnly may be quoted as detector quality, and null there means "no measurement possible on the clean truth set", which is itself the finding.',
      'Annual production series can only be detected at publication (the following year): production-derived detections structurally lag occurrence.',
      `Matching allows one structural hop and a −${DEFAULT_PRE_WINDOW_DAYS}d/+60d window. The pre-window default is set by causal mechanism, not outcome: no anticipation mechanism has been argued for the current signal classes, so it is zero; the knob's effect is published in scorecard.attributionSensitivity.`,
      'leadVsPrice uses monthly COMEX closes as a benchmark (never an input): its resolution is one month, and a reaction "at" a month-end may have occurred any day inside that month.',
      'Evaluation grid is hybrid: month-ends everywhere plus daily dates where daily evidence exists.',
      'Comtrade is a single-version source revised in place: as_known_then is blind before the release date of the held version, and pre-revision vintages that predate OSIRIS\'s archive (begun 2026-08) are permanently unrecoverable.',
    ],
    ledger,
  };
}
