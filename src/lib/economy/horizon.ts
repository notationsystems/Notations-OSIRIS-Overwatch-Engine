/**
 * OSIRIS — Information horizon: what the corpus can know, and when.
 *
 * Alert lead time has a hard ceiling set by the sources, and that ceiling is
 * computable WITHOUT a detector: for every source, the distribution of
 * information delay (knownAt − periodEnd for observations; firstReportedAt −
 * occurredAt for events). No threshold tuning moves it — a monthly
 * period-end series with a month of publication lag cannot in principle fire
 * before an event occurring inside the period it describes. This table is
 * therefore the more honest headline than any precision figure: it says
 * whether alerting is an acquisition problem or a detector problem, and it
 * converts "we need better data" into a shopping list with numbers attached.
 */

import type { AnalyticalResult, EconomyState } from './types';
import { knownAtOf } from './analytics';

export type Cadence = 'daily' | 'weekly' | 'monthly' | 'annual' | 'irregular';

export interface DelayStats { p50: number; p90: number; max: number }

export interface InformationHorizon {
  sourceId: string;
  cadence: Cadence;
  /** How stale is a value the moment it becomes knowable? knownAt − periodEnd, days. */
  publicationDelay: DelayStats;
  /**
   * The ceiling on alert lead from this source, in days:
   *   bestCaseLead     −min(publicationDelay): an event at the very end of a
   *                    period, published as fast as this source has ever
   *                    published. ≤ 0 always — a source can only tie the
   *                    world, never beat it.
   *   typicalLead      −(p50 delay + half the period length): an event
   *                    mid-period, typical publication. This is the number
   *                    that disqualifies annual sources — the wait to period
   *                    end dominates the publication lag.
   * To alert before the PUBLIC report of an event, bestCaseLead must exceed
   * −(typical event reporting delay); with the curated record's median
   * report delay of ~2 days, any source with bestCaseLead < −2 can only
   * confirm, never warn.
   */
  maxAchievableLead: { bestCaseLead: number; typicalLead: number };
  observationCount: number;
  /** Median period length the source's values describe, days. */
  periodDays: number;
  measurementNote?: string;
}

export interface EventHorizon {
  /** firstReportedAt − occurredAt across the curated event record, days.
   *  Negative p-values mean advance notice (e.g. announced strikes). */
  eventDelay: DelayStats;
  eventCount: number;
}

const DAY_MS = 86_400_000;
const days = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

function stats(values: number[]): DelayStats {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { p50: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}

function cadenceOf(medianGapDays: number, distinctKnownAts: number): Cadence {
  if (distinctKnownAts < 2) return 'irregular'; // one arrival proves nothing about cadence
  if (medianGapDays <= 2) return 'daily';
  if (medianGapDays <= 9) return 'weekly';
  if (medianGapDays <= 45) return 'monthly';
  if (medianGapDays <= 430) return 'annual';
  return 'irregular';
}

/** Median spacing between successive distinct knownAt dates, days. */
export function arrivalGapDays(knownAts: string[]): number | null {
  const distinct = [...new Set(knownAts)].sort();
  if (distinct.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < distinct.length; i++) gaps.push(days(distinct[i - 1], distinct[i]));
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/* ── Corpus health: the system watching its own blindness ── */

/**
 * After the daily-stocks adapter, exactly one series is capable of positive
 * alert lead — and it is a scrape of a third-party republisher. If its
 * markup changes, the degradation ladder gracefully serves snapshot, the
 * snapshot goes stale, recall silently returns to zero, and nothing says
 * so: graceful degradation on the only load-bearing source is
 * indistinguishable from working, from the outside. These signals fire when
 * the LEAD CEILING degrades — not merely when a fetch fails — with the
 * consequence computed, not asserted.
 */
export interface CorpusHealthSignal {
  /** source_suspect = a plausibility gate rejected a live fetch: freshness
   *  is a liveness property, correctness a safety property — this is the
   *  safety one, and it outranks staleness. */
  kind: 'source_stale' | 'ladder_rung_pinned' | 'source_suspect';
  sourceId: string;
  /** Median arrival gap this source normally shows, days. */
  expectedGapDays: number;
  /** asOf − latest knowable observation, days. */
  observedStalenessDays: number;
  servingRung: 'live' | 'snapshot';
  consecutivePeriodsDegraded: number;
  /** The consequence: best achievable lead from this source, before (its
   *  horizon) and now (bounded by the staleness). */
  leadCeilingBefore: number;
  leadCeilingNow: number;
  /** True when this source holds the best lead ceiling among physical
   *  sources — losing it degrades the whole system's warning capability. */
  loadBearing: boolean;
  explanation: string;
}

/**
 * The POPULATION corpus health was judged over — because "no signals" is
 * the reading that matters most and the one most easily wrong.
 *
 * Two sources can leave the signal set silently: one whose observations are
 * none of them knowable at the evaluation date ("not degraded, just early"),
 * and one whose arrival cadence cannot be measured from a single knownAt
 * ("cannot judge staleness"). Both are correct exclusions and both are
 * INVISIBLE in an empty array — which then reads as a clean bill of health.
 * Measured: at 2017 the panel showed CORPUS HEALTH (0) with no other text,
 * over a corpus where every source's evidence postdates the date by years.
 *
 * A health instrument that cannot distinguish "nothing is wrong" from
 * "nothing was checked" is the one instrument where that distinction is the
 * whole product.
 */
export interface CorpusHealthAccounting {
  signals: CorpusHealthSignal[];
  /** Sources whose staleness could actually be judged at this date. */
  judged: string[];
  /** Knowable-at-date is empty — the source's evidence postdates asOf. */
  notYetKnowable: string[];
  /** One arrival only (or a zero gap): no cadence to be late against. */
  cadenceUnmeasurable: string[];
  /** Set whenever `signals` is empty: which silence this is. */
  emptyBecause?: string;
}

export function corpusHealthAccounting(state: EconomyState, asOf: string): CorpusHealthAccounting {
  const bySource = new Map<string, typeof state.observations>();
  for (const o of state.observations) {
    if (o.partnerEntityId) continue;
    const key = o.provenance.sourceId;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(o);
  }
  const judged: string[] = [];
  const notYetKnowable: string[] = [];
  const cadenceUnmeasurable: string[] = [];
  for (const [sourceId, obs] of bySource) {
    const knownAts = obs.map(o => knownAtOf(o)).filter(k => k <= asOf);
    if (knownAts.length === 0) { notYetKnowable.push(sourceId); continue; }
    const gap = arrivalGapDays(knownAts);
    if (gap === null || gap === 0) { cadenceUnmeasurable.push(sourceId); continue; }
    judged.push(sourceId);
  }
  const signals = corpusHealthSignals(state, asOf);
  const emptyBecause = signals.length > 0 ? undefined
    : judged.length === 0
      ? `NOTHING WAS CHECKED at ${asOf}: of ${bySource.size} source(s), ${notYetKnowable.length} had no observation knowable by this date and ${cadenceUnmeasurable.length} carry too few arrivals to measure a cadence against. This is not a healthy corpus — it is a corpus with no staleness question to ask at this evaluation date. Corpus health describes the corpus AS HELD; read it at the present.`
      : `${judged.length} source(s) were judged at ${asOf} and none is past its own arrival cadence.${notYetKnowable.length > 0 ? ` ${notYetKnowable.length} source(s) had nothing knowable by this date and were not judged.` : ''}${cadenceUnmeasurable.length > 0 ? ` ${cadenceUnmeasurable.length} carry too few arrivals to measure a cadence.` : ''}`;
  return { signals, judged, notYetKnowable, cadenceUnmeasurable, ...(emptyBecause ? { emptyBecause } : {}) };
}

export function corpusHealthSignals(state: EconomyState, asOf: string): CorpusHealthSignal[] {
  const bySource = new Map<string, typeof state.observations>();
  for (const o of state.observations) {
    if (o.partnerEntityId) continue;
    const key = o.provenance.sourceId;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(o);
  }

  // Establish each source's expected arrival gap and current staleness.
  const rows: Array<{ sourceId: string; gap: number; staleness: number; rung: 'live' | 'snapshot'; minDelay: number }> = [];
  for (const [sourceId, obs] of bySource) {
    const knownAts = obs.map(o => knownAtOf(o)).filter(k => k <= asOf);
    if (knownAts.length === 0) continue; // nothing knowable yet — not degraded, just early
    const gap = arrivalGapDays(knownAts);
    if (gap === null || gap === 0) continue; // cadence unmeasurable — cannot judge staleness
    const latest = knownAts.reduce((a, b) => (a > b ? a : b));
    const staleness = days(latest, asOf);
    const rung: 'live' | 'snapshot' = obs.some(o => (o.provenance.note ?? '').includes('bundled snapshot')) ? 'snapshot' : 'live';
    const delays = obs.map(o => days(o.period.end, knownAtOf(o)));
    rows.push({ sourceId, gap, staleness, rung, minDelay: Math.max(0, Math.min(...delays)) });
  }
  if (rows.length === 0) return [];
  const bestCeiling = Math.max(...rows.map(r => -r.minDelay));

  const signals: CorpusHealthSignal[] = [];

  // Safety first: a plausibility-gate rejection means the source served
  // fresh-but-implausible data — reported immediately, independent of
  // staleness, because the wrongness is invisible to every liveness check.
  for (const [sourceId, obs] of bySource) {
    const suspectNote = obs.map(o => o.provenance.note ?? '').find(n => n.includes('plausibility violation'));
    if (!suspectNote) continue;
    const row = rows.find(x => x.sourceId === sourceId);
    signals.push({
      kind: 'source_suspect',
      sourceId,
      expectedGapDays: row?.gap ?? 0,
      observedStalenessDays: row?.staleness ?? 0,
      servingRung: 'snapshot',
      consecutivePeriodsDegraded: row && row.gap > 0 ? Math.floor(row.staleness / row.gap) : 0,
      leadCeilingBefore: row ? -row.minDelay : 0,
      leadCeilingNow: row ? -row.staleness : 0,
      loadBearing: row ? -row.minDelay === bestCeiling : false,
      explanation: `${sourceId} REJECTED its live fetch on a plausibility violation and is serving prior data — the source is reachable but its content failed sanity checks (wrong-column latch, impossible values, or broken ordering). ${suspectNote.slice(suspectNote.indexOf('plausibility violation'))}`,
    });
  }

  for (const r of rows) {
    // Degraded when the newest knowable value is older than the source's own
    // cadence explains (3× the arrival gap, floor 5 days for weekends and
    // holidays on daily sources).
    const threshold = Math.max(5, 3 * r.gap);
    if (r.staleness <= threshold) continue;
    if (signals.some(s => s.sourceId === r.sourceId)) continue; // suspect already covers it
    const loadBearing = -r.minDelay === bestCeiling;
    const before = -r.minDelay;
    const now = -r.staleness;
    signals.push({
      kind: r.rung === 'snapshot' ? 'ladder_rung_pinned' : 'source_stale',
      sourceId: r.sourceId,
      expectedGapDays: r.gap,
      observedStalenessDays: r.staleness,
      servingRung: r.rung,
      consecutivePeriodsDegraded: Math.floor(r.staleness / r.gap),
      leadCeilingBefore: before,
      leadCeilingNow: now,
      loadBearing,
      explanation: `${r.sourceId} normally arrives every ~${r.gap}d but its newest knowable value is ${r.staleness}d old${r.rung === 'snapshot' ? ' and it is serving from the bundled snapshot rung' : ''}. Best achievable warning from this source has fallen from ${before >= 0 ? '+' : ''}${before}d to ${now}d.${loadBearing ? ' THIS IS THE CORPUS\'S BEST-LEAD SOURCE: the whole system\'s warning capability degrades with it.' : ''}`,
    });
  }
  // The flow snapshot as a source with a MAINTENANCE cadence (shipping
  // order S-5): the facility topology is annual-intent curation, and until
  // now the only thing that noticed it aging was the extrapolation clock's
  // 730-day CEILING — a guard, not a cadence. This signal fires when the
  // snapshot is past its intended annual refresh (365d + 90d grace), so
  // corpus health says "the topology is due" long before the guard says
  // "the topology is inadmissible".
  const facilityFlows = state.flows.filter(f =>
    !(f.fromEntityId.startsWith('ent:country:') && f.toEntityId.startsWith('ent:country:')));
  if (facilityFlows.length > 0) {
    const periodEnd = facilityFlows.map(f => f.period.end).reduce((a, b) => (a > b ? a : b));
    const age = days(periodEnd, asOf);
    const FLOW_SNAPSHOT_CADENCE_DAYS = 365;
    if (age > FLOW_SNAPSHOT_CADENCE_DAYS + 90) {
      signals.push({
        kind: 'source_stale',
        sourceId: 'curated-flow-snapshot',
        expectedGapDays: FLOW_SNAPSHOT_CADENCE_DAYS,
        observedStalenessDays: age,
        servingRung: 'snapshot',
        consecutivePeriodsDegraded: Math.floor(age / FLOW_SNAPSHOT_CADENCE_DAYS),
        leadCeilingBefore: 0, leadCeilingNow: 0,
        loadBearing: false,
        explanation: `The facility flow snapshot's period ended ${age}d ago against an annual maintenance cadence — every propagation and throughput figure serves latest-known structure that is ${Math.floor(age / 30)} months old. The extrapolation guard's hard ceiling is 730d; this signal is the cadence, not the ceiling. Remedy: refresh the facility flow snapshot (see the source registry's maintenance entry).`,
      });
    }
  }
  // Load-bearing failures first.
  signals.sort((a, b) => Number(b.loadBearing) - Number(a.loadBearing) || b.observedStalenessDays - a.observedStalenessDays);
  return signals;
}

export function informationHorizons(state: EconomyState): AnalyticalResult<{
  sources: InformationHorizon[];
  events: EventHorizon | null;
}> {
  const bySource = new Map<string, typeof state.observations>();
  for (const o of state.observations) {
    const key = o.provenance.sourceId;
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key)!.push(o);
  }

  const sources: InformationHorizon[] = [];
  const usedObs: string[] = [];
  for (const [sourceId, obs] of bySource) {
    const delays = obs.map(o => days(o.period.end, knownAtOf(o)));
    const periodLens = obs.map(o => days(o.period.start, o.period.end)).sort((a, b) => a - b);
    const periodDays = periodLens[Math.floor(periodLens.length / 2)];
    const knownAts = obs.map(o => knownAtOf(o));
    const gap = arrivalGapDays(knownAts);
    const pub = stats(delays);
    const minDelay = Math.min(...delays);
    const distinct = new Set(knownAts).size;
    sources.push({
      sourceId,
      cadence: cadenceOf(gap ?? Infinity, distinct),
      publicationDelay: pub,
      maxAchievableLead: {
        bestCaseLead: -Math.max(0, minDelay),
        typicalLead: -Math.round(pub.p50 + periodDays / 2),
      },
      observationCount: obs.length,
      periodDays,
      ...(distinct < 2 ? { measurementNote: 'Single arrival date — cadence unmeasurable from this corpus; delays reflect retrieval-time fallback where knownAt is unstamped.' } : {}),
    });
    obs.forEach(o => usedObs.push(o.id));
  }
  sources.sort((a, b) => b.maxAchievableLead.bestCaseLead - a.maxAchievableLead.bestCaseLead);

  const dated = state.events.filter(ev => ev.firstReportedAt);
  const events: EventHorizon | null = dated.length > 0
    ? { eventDelay: stats(dated.map(ev => days(ev.start, ev.firstReportedAt!))), eventCount: dated.length }
    : null;

  return {
    operation: { name: 'informationHorizons', params: { commodity: state.commodity } },
    execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
    inputs: { observationIds: usedObs },
    result: { sources, events },
  };
}
