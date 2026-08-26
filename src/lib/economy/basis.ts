/**
 * OSIRIS — Quantity-basis normalization.
 *
 * Contained metal and gross shipped weight differ by the ore grade (~4x for
 * copper concentrate). Two failure modes bracket the handling of that fact:
 *
 *   MIXING   a gross-weight edge feeding throughput carries ~4x its true
 *            weight — inbound shares skew toward the fat-basis supplier.
 *   ZEROING  discarding the edge instead claims the flow carries NOTHING:
 *            supplier counts drop, redundancy inverts, a disruption at a
 *            gross-reported supplier propagates nothing. The error runs
 *            opposite to the skew it prevents, which makes it harder to spot.
 *
 * The way out is conversion: the divergence system's mirror analysis already
 * computes the corridor-implied grade (content-declared ÷ gross-declared for
 * pairs whose ratio sits in the concentrate grade band). This module feeds
 * that grade back as the conversion factor for the corridor, carrying the
 * grade band as uncertainty. Where no grade is available at all, consumers
 * must REFUSE to compute shares — visibly — rather than substitute zero.
 */

import type { EconomyState, Metric, Period } from './types';

/**
 * Copper concentrate typically grades 20–33% Cu, so contained-metal and
 * gross-weight declarations of the SAME flow differ by a factor of ~3.0–5.0.
 * A mirror ratio inside that band is the fingerprint of a basis mismatch.
 */
export const CONCENTRATE_GRADE_BAND = { minRatio: 3.0, maxRatio: 5.0 };

/** The same band as mass fractions of contained Cu. */
export const CONCENTRATE_GRADE_FRACTION_BAND: [number, number] = [0.20, 0.33];

/**
 * Reference grade for basis normalization: ~25% Cu, the typical world
 * concentrate grade. Residuals are computed against this fixed reference —
 * never against a pair's own implied grade, which would make every residual
 * zero by construction.
 */
export const REFERENCE_CONCENTRATE_GRADE = 0.25;

export interface CorridorGrade {
  /** The corridor: exporter → importer (matches flow direction). */
  exporterEntityId: string;
  importerEntityId: string;
  /** Implied Cu mass fraction: content-declared ÷ gross-declared. */
  grade: number;
  /** Uncertainty: the typical concentrate grade band. */
  band: [number, number];
  /** Evidence identity: the two mirror observation ids the grade came from. */
  derivedFrom: [string, string];
  period: Period;
}

const MIRROR_PAIRS: Array<[exportMetric: Metric, importMetric: Metric]> = [
  ['concentrate_exports', 'concentrate_imports'],
];

/**
 * Corridor-implied concentrate grades from Comtrade mirror pairs: for each
 * exporter→importer corridor where the two declarations differ by a ratio in
 * the grade band, the implied grade (lo/hi) becomes the corridor's conversion
 * factor. Latest period wins when several are available.
 */
export function impliedCorridorGrades(state: EconomyState): Map<string, CorridorGrade> {
  const grades = new Map<string, CorridorGrade>();
  const partnerScoped = state.observations.filter(o => o.partnerEntityId);
  for (const [exportMetric, importMetric] of MIRROR_PAIRS) {
    for (const exp of partnerScoped) {
      if (exp.metric !== exportMetric) continue;
      const imp = partnerScoped.find(o =>
        o.metric === importMetric
        && o.entityId === exp.partnerEntityId
        && o.partnerEntityId === exp.entityId
        && o.period.start === exp.period.start
        && o.unit === exp.unit);
      if (!imp) continue;
      const hi = Math.max(exp.value, imp.value);
      const lo = Math.min(exp.value, imp.value);
      if (lo <= 0) continue;
      const ratio = hi / lo;
      if (ratio < CONCENTRATE_GRADE_BAND.minRatio || ratio > CONCENTRATE_GRADE_BAND.maxRatio) continue;
      const key = `${exp.entityId}|${exp.partnerEntityId}`;
      const prev = grades.get(key);
      if (prev && prev.period.start >= exp.period.start) continue;
      grades.set(key, {
        exporterEntityId: exp.entityId,
        importerEntityId: exp.partnerEntityId!,
        grade: lo / hi,
        band: CONCENTRATE_GRADE_FRACTION_BAND,
        derivedFrom: [exp.id, imp.id],
        period: exp.period,
      });
    }
  }
  return grades;
}
