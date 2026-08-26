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
  detected: boolean;
  /** Best lead among matching fired alerts (days, positive = early). */
  detectionLeadDays?: number;
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
  /** TP / (TP + FP) over fired anomaly alerts; null when none fired. */
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

/** Signal months within [event start − 3 months, event end (or open) + 2 months]. */
function withinEventWindow(signalMonth: string, ev: EconEvent, horizon: string): boolean {
  const start = new Date(ev.start);
  start.setUTCMonth(start.getUTCMonth() - 3);
  const lo = start.toISOString().slice(0, 7);
  const endBase = ev.end ?? horizon;
  const end = new Date(endBase);
  end.setUTCMonth(end.getUTCMonth() + 2);
  const hi = end.toISOString().slice(0, 7);
  return lo <= signalMonth && signalMonth <= hi;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

export async function backtestAlerts(
  commodity: string,
  { from, to }: { from: string; to: string },
): Promise<BacktestReport> {
  const evaluations = monthEnds(from, to);

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
  const best = await runEngine(commodity, {});
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
  const records: BacktestAlertRecord[] = firedAnomalies.map(alert => {
    const firedAt = firedAtByKey.get(alert.signalKey)!;
    const match = truth.find(ev =>
      adjacent(alert.entityId, ev.entityId!) && withinEventWindow(alert.signalPeriod, ev, to));
    if (!match) return { alert, firedAt, disposition: 'false_positive' as const };
    return {
      alert,
      firedAt,
      matchedEventId: match.id,
      leadDays: daysBetween(firedAt, match.firstReportedAt ?? match.start),
      disposition: 'true_positive' as const,
    };
  });

  const tp = records.filter(r => r.disposition === 'true_positive');
  const truthRows: BacktestTruthRow[] = truth.map(ev => {
    const matches = records.filter(r => r.matchedEventId === ev.id);
    const best = matches.length > 0 ? Math.max(...matches.map(m => m.leadDays!)) : undefined;
    return {
      id: ev.id, title: ev.title, entityId: ev.entityId!,
      start: ev.start, firstReportedAt: ev.firstReportedAt ?? ev.start,
      detected: matches.length > 0,
      ...(best !== undefined ? { detectionLeadDays: best } : {}),
    };
  });

  // Lead time is a property of FIRST detection: an alert that re-confirms an
  // event already public is a true positive for precision, but counting its
  // lag as "lead time" would grade the detector on echoes. One lead per
  // detected event — the earliest.
  const leads = truthRows
    .filter(t => t.detectionLeadDays !== undefined)
    .map(t => t.detectionLeadDays!)
    .sort((a, b) => a - b);
  const medianLeadDays = leads.length === 0 ? null
    : leads.length % 2 === 1 ? leads[(leads.length - 1) / 2]
      : Math.round((leads[leads.length / 2 - 1] + leads[leads.length / 2]) / 2);

  return {
    commodity,
    from,
    to,
    knowledge: 'as_known_then',
    evaluations,
    truthEvents: truthRows,
    records,
    precision: records.length > 0 ? Number((tp.length / records.length).toFixed(3)) : null,
    recall: truthRows.length > 0 ? Number((truthRows.filter(t => t.detected).length / truthRows.length).toFixed(3)) : null,
    medianLeadDays,
    suppressedCount: ledger.filter(a => a.status === 'suppressed').length,
    retractedCount: ledger.filter(a => a.status === 'retracted').length,
    lookaheadViolations,
    horizons: informationHorizons(best.state).result,
    revisionAlerts,
    caveats: [
      `Ground truth is the curated event record: ${truthRows.length} event(s) in window — treat the percentages as small-n measurements, not general performance claims.`,
      'Annual production series can only be detected at publication (the following year): production-derived detections structurally lag occurrence.',
      'Matching allows one structural hop and a −3/+2 month window; both parameters are transparent and deliberately loose.',
      'Evaluation runs on a month-end grid, which now bounds measurable lead: a daily-cadence signal can fire at most at the month end after it becomes knowable. With a daily source in the corpus, evaluation cadence is the next binding constraint.',
    ],
    ledger,
  };
}
