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
