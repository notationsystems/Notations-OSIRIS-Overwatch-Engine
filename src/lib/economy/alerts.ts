/**
 * Payload — Alert derivation with suppression memory and retraction.
 *
 * This system has already produced two findings that would have fired as
 * alerts and were wrong — a 10.3σ splice artifact and a 75% "suppression"
 * gap that was a units mismatch. Both were caught in review; neither would
 * have been caught by a user at 7am. So alerting here is built in trust
 * order, UI last:
 *
 *   1. derivation   an alert is a projection of signals the engine already
 *                   computed (anomalies, newly-reported events) — never a
 *                   fresh computation of its own;
 *   2. suppression  an alert whose signal is already explained by the
 *                   divergence system (definitional / coverage /
 *                   revision_lag) must not fire — the explaining record is
 *                   referenced, not discarded;
 *   3. retraction   a fired alert whose signal is later reclassified or no
 *                   longer derivable is RETRACTED with its reason. A system
 *                   that cannot withdraw a claim becomes one nobody reads;
 *   4. backtest     (alertBacktest.ts) precision is measured against
 *                   historical knowledge states before any panel exists.
 *
 * Reflexive market context (financial positioning) never fires an alert:
 * positioning responds to expectations about the very disruptions the
 * physical layer detects, and waking someone for it would let sentiment
 * manufacture urgency.
 */

import type { AnalyticalResult, Divergence, EconEvent, EconomyState } from './types';
import type { AnomalySignal } from './analytics';
import { knownAtOf } from './analytics';
import type { EngineRun } from './engine';
import { DISRUPTIVE_EVENT_TYPES } from './propagation';
import { arrivalGapDays, corpusHealthSignals } from './horizon';

export type AlertStatus = 'fired' | 'suppressed' | 'retracted';

export interface Alert {
  /** "alert:" + signalKey. */
  id: string;
  /** Stable identity of the underlying signal across evaluations. */
  signalKey: string;
  kind: 'anomaly' | 'event' | 'corpus';
  /** What produced the signal. 'revision' = the world's best estimate moved
   *  (a publisher's explicit act); 'corpus_health' = the corpus's own
   *  warning capability degraded — both scored separately from disruption
   *  detection everywhere downstream. */
  signalKind: 'rolling-deviation' | 'rate-of-change' | 'revision' | 'event' | 'corpus_health';
  entityId: string;
  entityName: string;
  title: string;
  severity: 'low' | 'medium' | 'high';
  /**
   * When the signal first became derivable: for an event, firstReportedAt;
   * for an anomaly, the latest knownAt among its evidence observations. The
   * no-lookahead invariant: detectedAt never exceeds the evaluation date of
   * the run that produced the alert.
   */
  detectedAt: string;
  /** What the signal describes (YYYY-MM for anomalies, event start date). */
  signalPeriod: string;
  /**
   * Events: firstReportedAt − occurrence start, in days — how much warning
   * the public record itself allowed. Reported alongside every event alert
   * so no one mistakes notification speed for detection skill.
   */
  detectionLatencyDays: number | null;
  status: AlertStatus;
  suppressedBy?: { divergenceId: string; divergenceClass: Divergence['class']; reason: string };
  retraction?: { at: string; reason: string; divergenceId?: string };
  evidence: { observationIds?: string[]; eventId?: string };
  explanation: string;
}

/** Divergence classes that EXPLAIN a signal (observer- or basis-produced,
 *  not world-produced). 'unexplained' never suppresses — a real observer
 *  conflict can coexist with a real world move. */
const SUPPRESSING_CLASSES: Divergence['class'][] = ['definitional', 'coverage', 'revision_lag'];

/**
 * An alert must describe something actionable near real time. What
 * disqualifies annual production z-scores is not that the period is a year —
 * it is that the INFORMATION ARRIVES a year late. So the gate keys on
 * arrival cadence (spacing of the signal's evidence knownAt dates), not on
 * period length. Usually the same axis, with one exception the period-length
 * gate wrongly threw away: a REVISION to an annual series is new information
 * delivered on a known date — "our best estimate of 2024 just moved 8%" is a
 * statement about the present state of knowledge, knowable the day the
 * edition publishes — so revision signals bypass this gate entirely.
 * A series whose evidence all arrived on one date (curated backfill,
 * retrieval-time fallback) has no measurable arrival cadence and is refused.
 */
const MAX_ARRIVAL_GAP_DAYS = 45;

function arrivalAdmissible(s: AnomalySignal, knownAts: string[]): boolean {
  if (s.kind === 'revision') return true; // arrival IS the event
  const gap = arrivalGapDays(knownAts);
  return gap !== null && gap <= MAX_ARRIVAL_GAP_DAYS;
}

const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

function anomalySeverity(s: AnomalySignal): Alert['severity'] {
  const m = Math.abs(s.magnitude);
  if (s.kind === 'rolling-deviation') return m >= 4 ? 'high' : m >= 2.5 ? 'medium' : 'low';
  if (s.kind === 'revision') return m >= 10 ? 'high' : m >= 5 ? 'medium' : 'low'; // % move of best estimate
  return m >= 40 ? 'high' : m >= 20 ? 'medium' : 'low'; // rate-of-change, in %
}

/** The divergence record (if any) that explains this anomaly signal. */
function explainingDivergence(signal: AnomalySignal, divergences: Divergence[]): Divergence | undefined {
  return divergences.find(d => {
    if (!SUPPRESSING_CLASSES.includes(d.class)) return false;
    if (d.entityId !== signal.entityId || d.metric !== signal.metric) return false;
    // Precise link: the disputed observation is part of the signal's own
    // evidence. Fallback: the divergence's period covers the signal month.
    const claimed = d.claims.some(c => signal.observationIds.includes(c.observationId));
    const covers = d.period.start.slice(0, 7) <= signal.period && signal.period <= d.period.end.slice(0, 7);
    return claimed || covers;
  });
}

/**
 * Derive alerts from one engine run. Pure projection: everything here was
 * already computed by a registered system; this function only decides what
 * is worth a person's attention and what must be withheld, with reasons.
 */
export function generateAlerts(run: EngineRun): Alert[] {
  const state = run.state;
  const entityName = new Map(state.entities.map(e => [e.id, e.name]));
  const asOf = run.frame.asOf ?? new Date().toISOString().slice(0, 10);
  const anomalies = (run.systems.anomalies as AnalyticalResult<AnomalySignal[]>).result;
  const divergences = (run.systems.divergence as AnalyticalResult<Divergence[]>).result;
  const obsById = new Map(state.observations.map(o => [o.id, o]));

  const alerts: Alert[] = [];
  // A daily series produces several same-month signals sharing one signal
  // identity — one alert per (entity, metric, kind, month), keeping the
  // earliest detection and the largest magnitude's explanation.
  const anomalyByKey = new Map<string, Alert>();
  const sevRank = { high: 2, medium: 1, low: 0 } as const;

  for (const s of anomalies) {
    // Reflexive context never wakes anyone.
    if (s.measurementClass === 'financial_positioning') continue;
    // The signal exists only once its latest evidence observation was
    // knowable — this is what the backtest's no-lookahead check pins.
    const knownAts = s.observationIds
      .map(id => obsById.get(id))
      .filter((o): o is NonNullable<typeof o> => o !== undefined)
      .map(o => knownAtOf(o));
    // Arrival-cadence gate (revisions bypass: their arrival IS the news).
    if (!arrivalAdmissible(s, knownAts)) continue;
    const signalKey = `anomaly:${s.entityId}:${s.metric}:${s.kind}:${s.period}`;
    const detectedAt = knownAts.length > 0 ? knownAts.reduce((a, b) => (a > b ? a : b)) : asOf;
    // Suppression never applies to revision signals: a revision does not
    // claim the world moved, so "explained by revision_lag" is not a
    // counter-claim — it is the signal itself, seen by the divergence system.
    const div = s.kind === 'revision' ? undefined : explainingDivergence(s, divergences);
    const name = entityName.get(s.entityId) ?? s.entityId;
    const base: Alert = {
      id: `alert:${signalKey}`,
      signalKey,
      kind: 'anomaly',
      signalKind: s.kind,
      entityId: s.entityId,
      entityName: name,
      title: s.kind === 'revision'
        ? `${s.metric} best estimate revised ${s.magnitude > 0 ? '+' : ''}${s.magnitude}% — ${name}`
        : `${s.metric} ${s.kind === 'rolling-deviation' ? `${s.magnitude}σ deviation` : `${s.magnitude}% move`} — ${name}`,
      severity: anomalySeverity(s),
      detectedAt,
      signalPeriod: s.period,
      detectionLatencyDays: null,
      status: 'fired',
      evidence: { observationIds: s.observationIds },
      explanation: s.explanation,
    };
    if (div) {
      base.status = 'suppressed';
      base.suppressedBy = {
        divergenceId: div.id,
        divergenceClass: div.class,
        reason: `Signal is already classed ${div.class} by the divergence system — the movement is ${div.class === 'definitional' ? 'a measurement-basis artifact' : div.class === 'coverage' ? 'a coverage gap between observers' : 'a source revision'}, not evidence the world moved. See ${div.id}.`,
      };
    }
    const standing = anomalyByKey.get(signalKey);
    if (!standing) {
      anomalyByKey.set(signalKey, base);
    } else {
      anomalyByKey.set(signalKey, {
        ...(sevRank[base.severity] > sevRank[standing.severity] ? base : standing),
        detectedAt: standing.detectedAt < base.detectedAt ? standing.detectedAt : base.detectedAt,
      });
    }
  }
  alerts.push(...anomalyByKey.values());

  const alertableEventTypes: EconEvent['type'][] = [...DISRUPTIVE_EVENT_TYPES, 'demand_surge'];
  for (const ev of state.events) {
    if (!ev.entityId || !alertableEventTypes.includes(ev.type)) continue;
    if (ev.provenance.sourceId === 'payload-scenario') continue; // hypotheticals never alert
    const reportedAt = ev.firstReportedAt ?? ev.start;
    if (reportedAt > asOf) continue; // not yet knowable at this evaluation date
    alerts.push({
      id: `alert:event:${ev.id}`,
      signalKey: `event:${ev.id}`,
      kind: 'event',
      signalKind: 'event',
      entityId: ev.entityId,
      entityName: entityName.get(ev.entityId) ?? ev.entityId,
      title: ev.title,
      severity: ev.severity,
      detectedAt: reportedAt,
      signalPeriod: ev.start,
      detectionLatencyDays: daysBetween(ev.start, reportedAt),
      status: 'fired',
      evidence: { eventId: ev.id },
      explanation: ev.description ?? ev.title,
    });
  }

  // Corpus health: the system watching its own blindness. Fires when a
  // source's lead ceiling degrades (not merely when a fetch fails) — the one
  // alert class ready to wake someone regardless of the detector verdict:
  // "best achievable warning fell from +1d to −Nd because the only daily
  // source has served snapshot for N days" outranks any market signal the
  // system could produce in that window.
  for (const s of corpusHealthSignals(state, asOf)) {
    alerts.push({
      id: `alert:corpus:${s.kind}:${s.sourceId}`,
      signalKey: `corpus:${s.kind}:${s.sourceId}`,
      kind: 'corpus',
      signalKind: 'corpus_health',
      entityId: s.sourceId,
      entityName: s.sourceId,
      title: s.kind === 'source_suspect'
        ? `SOURCE SUSPECT: ${s.sourceId} rejected its live data on a plausibility violation`
        : `${s.loadBearing ? 'WARNING CAPABILITY DEGRADED: ' : ''}${s.sourceId} ${s.kind === 'ladder_rung_pinned' ? 'pinned to snapshot' : 'stale'} — lead ceiling ${s.leadCeilingBefore >= 0 ? '+' : ''}${s.leadCeilingBefore}d → ${s.leadCeilingNow}d`,
      severity: s.kind === 'source_suspect' || s.loadBearing ? 'high' : 'medium',
      detectedAt: asOf,
      signalPeriod: asOf.slice(0, 7),
      detectionLatencyDays: null,
      status: 'fired',
      evidence: {},
      explanation: s.explanation,
    });
  }

  alerts.sort((a, b) =>
    Number(a.status === 'suppressed') - Number(b.status === 'suppressed')
    || sevRank[b.severity] - sevRank[a.severity]
    || b.detectedAt.localeCompare(a.detectedAt));
  return alerts;
}

/**
 * Reconcile a new evaluation's alerts against the standing ledger.
 *
 *   - a standing FIRED alert whose signal is now suppressed → RETRACTED,
 *     with the reclassification as the reason;
 *   - a standing FIRED alert whose signal is no longer derivable at all →
 *     RETRACTED (revised evidence removed the signal);
 *   - a standing alert still produced → keeps its ORIGINAL detectedAt
 *     (first detection is the fact worth preserving);
 *   - a new signal → appended as generated.
 *
 * Retractions are records, not deletions: the withdrawn claim stays in the
 * ledger with its reason, because the withdrawal is itself information.
 */
export function reconcileAlerts(previous: Alert[], current: Alert[], asOf: string): Alert[] {
  const currentByKey = new Map(current.map(a => [a.signalKey, a]));
  const out: Alert[] = [];
  const seen = new Set<string>();

  for (const prev of previous) {
    seen.add(prev.signalKey);
    const now = currentByKey.get(prev.signalKey);
    if (prev.status === 'retracted') {
      // A withdrawn claim does not silently return; if the signal re-fires
      // it is recorded as a fresh firing that names its prior retraction.
      if (now && now.status === 'fired') {
        out.push({
          ...now,
          explanation: `${now.explanation} [Previously retracted ${prev.retraction?.at}: ${prev.retraction?.reason}]`,
        });
      } else {
        out.push(prev);
      }
      continue;
    }
    if (prev.status === 'fired' && now?.status === 'suppressed') {
      out.push({
        ...prev,
        status: 'retracted',
        retraction: {
          at: asOf,
          reason: `Reclassified: ${now.suppressedBy!.reason}`,
          divergenceId: now.suppressedBy!.divergenceId,
        },
      });
      continue;
    }
    if (prev.status === 'fired' && !now) {
      out.push({
        ...prev,
        status: 'retracted',
        retraction: {
          at: asOf,
          // A cleared corpus condition is resolution, not a withdrawn claim —
          // the staleness was real while it held.
          reason: prev.kind === 'corpus'
            ? 'Condition cleared — the source resumed its expected arrival cadence.'
            : 'Signal no longer derivable from current evidence — the observations behind it were revised or superseded.',
        },
      });
      continue;
    }
    // Still produced (fired→fired, suppressed→whatever): keep first
    // detection, adopt current classification.
    out.push(now ? { ...now, detectedAt: prev.detectedAt } : prev);
  }

  for (const a of current) {
    if (!seen.has(a.signalKey)) out.push(a);
  }
  return out;
}

/** Convenience: state-level lookup used by tests and the backtest. */
export function eventById(state: EconomyState, id: string): EconEvent | undefined {
  return state.events.find(e => e.id === id);
}
