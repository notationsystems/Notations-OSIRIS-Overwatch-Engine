/**
 * OSIRIS — Divergence analysis: disagreement as evidence.
 *
 * Series resolution (analytics.ts) collapses same-period multi-provider
 * observations to the hardest evidence, which is correct for computing state
 * — but the residual, the fact that observers disagreed, is itself one of
 * the highest-value signals in trade intelligence. This system keeps it:
 *
 *   multi-provider  two sources measured the same (entity, metric, period)
 *                   and differ — revision lag, coverage gaps, or a real
 *                   contradiction.
 *   mirror          exporter-declared A→B vs importer-declared A→B: two
 *                   independent measurements of the same physical flow.
 *                   Persistent directional gaps are the standard route to
 *                   transshipment, misinvoicing and reporter suppression.
 *
 * The distinction that keeps this safe: an ANOMALY says the world moved; a
 * DIVERGENCE says the observers disagree about whether it moved. They are
 * computed by different systems, rendered in different sections, and never
 * share a ranking.
 */

import type { AnalyticalResult, Divergence, DivergenceClaim, EconomyState, Metric, Observation } from './types';
import { knownAtOf, outranksObservation } from './analytics';
import { CONCENTRATE_GRADE_BAND, CONCENTRATE_GRADE_FRACTION_BAND, REFERENCE_CONCENTRATE_GRADE } from './basis';

const MIRROR_PAIRS: Array<[exportMetric: Metric, importMetric: Metric]> = [
  ['concentrate_exports', 'concentrate_imports'],
  ['refined_exports', 'refined_imports'],
];

/**
 * Reclassification keys on DRIFT of the residual against the corridor's own
 * history, never on its level: the level is confounded by the corridor's
 * unknown true grade (a genuine 30%-grade corridor with perfectly honest
 * declarations shows +20% at the 25% reference — firing on level would
 * reintroduce, one layer down, exactly the false-positive class the gate
 * was built to prevent). Grade is a slowly-moving physical property, an
 * approximately constant offset per corridor, and first-differencing
 * removes it: a corridor sitting stably at +18% is a 29.5%-grade corridor;
 * one that moves from +0.8% to +15% in a period has had something change.
 */
const DRIFT_THRESHOLD = 0.10;

interface BasisVerdict {
  class: 'definitional';
  explanation: string;
  normalization?: Divergence['basisNormalization'];
}

/**
 * Copper concentrate typically grades 20–33% Cu, so contained-metal and
 * gross-weight declarations of the SAME flow differ by a factor of ~3.0–5.0.
 * A mirror ratio landing inside that band is the fingerprint of a basis
 * mismatch, not of suppression. The gate runs BEFORE 'unexplained' can be
 * assigned — unexplained is the hardest class to earn, never the default
 * residue — but classing definitional is not dismissal: the pair is
 * NORMALIZED at the reference grade and the residual becomes the watched
 * quantity. "Basis explains the entire gap" is a statement, and a baseline.
 */
function basisGate(
  metric: Metric,
  values: number[],
  declaredBases: Set<string>,
): BasisVerdict | null {
  const known = [...declaredBases].filter(b => b !== 'unspecified');
  if (new Set(known).size > 1) {
    return {
      class: 'definitional',
      explanation: `Claims declare different mass bases (${known.join(' vs ')}) — the gap measures the basis difference, not the world. Normalize bases before comparing; the residual after normalization would be the finding.`,
    };
  }
  if (!metric.startsWith('concentrate')) return null;
  const hi = Math.max(...values);
  const lo = Math.min(...values);
  if (lo <= 0) return null;
  const ratio = hi / lo;
  if (ratio < CONCENTRATE_GRADE_BAND.minRatio || ratio > CONCENTRATE_GRADE_BAND.maxRatio) return null;

  // Normalize: treat the larger value as gross weight, the smaller as
  // contained metal, and convert the gross side at the fixed reference grade
  // (NEVER the pair's own implied grade, which zeroes every residual by
  // construction). What survives normalization is the real statement.
  const impliedGrade = lo / hi;
  const residual = lo / (hi * REFERENCE_CONCENTRATE_GRADE) - 1;
  const [gLo, gHi] = CONCENTRATE_GRADE_FRACTION_BAND;
  const residualBand: [number, number] = [lo / (hi * gHi) - 1, lo / (hi * gLo) - 1];
  const normalization: Divergence['basisNormalization'] = {
    referenceGrade: REFERENCE_CONCENTRATE_GRADE,
    impliedGrade: Number(impliedGrade.toFixed(4)),
    residual: Number(residual.toFixed(4)),
    residualBand: [Number(residualBand[0].toFixed(4)), Number(residualBand[1].toFixed(4))],
  };
  const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
  const fingerprint = `Ratio ${ratio.toFixed(2)}x implies ${(impliedGrade * 100).toFixed(1)}% Cu content — inside the typical concentrate grade band (20–33%): contained metal on one side, gross shipped weight on the other (candidate basis mismatch).`;
  const verdict = Math.abs(residual) <= 0.02
    ? 'the basis explains the entire gap; no material suppression signal in this corridor'
    : 'consistent with the basis mismatch at a corridor grade off the 25% reference — the level is grade-confounded, not a signal';

  return {
    class: 'definitional',
    explanation: `${fingerprint} Normalized at the ${(REFERENCE_CONCENTRATE_GRADE * 100).toFixed(0)}% reference grade the residual is ${pct(residual)} — ${verdict}. The residual is the watched baseline: reclassification keys on DRIFT against this corridor's own history (a stable offset is a grade; a step is a change).`,
    normalization,
  };
}

/** Relative gaps below this read as measurement noise, not disagreement. */
const MIN_RELATIVE_SPREAD = 0.005;

function claimOf(o: Observation, perspective?: 'reporter' | 'partner'): DivergenceClaim {
  return {
    observationId: o.id, sourceId: o.provenance.sourceId,
    value: o.value, unit: o.unit, valueKind: o.valueKind, confidence: o.confidence,
    perspective,
  };
}

function slug(entityId: string): string {
  return entityId.replace(/^ent:[^:]+:/, '');
}

export function detectDivergences(state: EconomyState): AnalyticalResult<Divergence[]> {
  const records: Divergence[] = [];
  const usedObs = new Set<string>();

  /* ── Multi-provider: same subject, same period, different sources ── */
  const bySubject = new Map<string, Observation[]>();
  for (const o of state.observations) {
    if (o.partnerEntityId) continue;
    const key = `${o.entityId}|${o.metric}|${o.period.start}|${o.period.end}|${o.unit}`;
    if (!bySubject.has(key)) bySubject.set(key, []);
    bySubject.get(key)!.push(o);
  }
  // Track per (entity, metric) sequences for persistence.
  const seqDir = new Map<string, Array<{ periodStart: string; direction: string; record: Divergence }>>();

  for (const group of bySubject.values()) {
    if (group.length < 2) continue;
    let winner = group[0];
    for (const o of group.slice(1)) if (outranksObservation(o, winner)) winner = o;
    const others = group.filter(o => o !== winner);
    const values = group.map(o => o.value);
    const maxAbs = Math.max(...values.map(Math.abs));
    const spread = Math.max(...values) - Math.min(...values);
    const relativeSpread = maxAbs > 0 ? spread / maxAbs : 0;
    if (relativeSpread < MIN_RELATIVE_SPREAD) continue;

    // Class heuristic, most specific first. The basis gate runs before
    // anything can be called unexplained.
    const basisVerdict = basisGate(winner.metric, values, new Set(group.map(o => o.basis ?? 'unspecified')));
    const supersedesLink = group.some(a => group.some(b => a.supersedes === b.id));
    const sameFamily = new Set(group.map(o => o.provenance.sourceId.replace(/\d{4}.*$/, ''))).size === 1;
    const hasRepresentative = others.some(o => o.valueKind === 'representative');
    const cls: Divergence['class'] = basisVerdict ? basisVerdict.class
      : supersedesLink || sameFamily ? 'revision_lag'
        : hasRepresentative ? 'coverage'
          : 'unexplained';

    const direction: Divergence['direction'] = group.length === 2
      ? (winner.value > others[0].value ? 'resolved_higher' : 'resolved_lower')
      : 'unsigned';

    const rec: Divergence = {
      id: `div:multi:${slug(winner.entityId)}:${winner.metric}:${winner.period.start.slice(0, 7)}`,
      kind: 'multi-provider',
      entityId: winner.entityId,
      metric: winner.metric,
      period: winner.period,
      claims: group
        .slice()
        .sort((a, b) => Number(b === winner) - Number(a === winner))
        .map(o => claimOf(o)),
      resolvedTo: winner.id,
      spread: Number(spread.toFixed(3)),
      relativeSpread: Number(relativeSpread.toFixed(4)),
      direction,
      persistence: 1, // filled below
      class: cls,
      basisNormalization: basisVerdict?.normalization,
      explanation: basisVerdict ? basisVerdict.explanation
        : cls === 'revision_lag'
          ? `Later vintage (${winner.provenance.sourceId}, knowable ${knownAtOf(winner)}) revises an earlier figure for the same period.`
          : cls === 'coverage'
            ? `Curated representative figure differs from the resolved ${winner.valueKind} value by ${(relativeSpread * 100).toFixed(1)}% — the gap measures curated-model coverage, not a world change.`
            : `Independent sources disagree by ${(relativeSpread * 100).toFixed(1)}% on the same subject and period.`,
    };
    group.forEach(o => usedObs.add(o.id));
    records.push(rec);
    const sk = `${winner.entityId}|${winner.metric}`;
    if (!seqDir.has(sk)) seqDir.set(sk, []);
    seqDir.get(sk)!.push({ periodStart: winner.period.start, direction, record: rec });
  }

  /* ── Mirror: exporter-declared vs importer-declared bilateral flows ── */
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
      const maxAbs = Math.max(Math.abs(exp.value), Math.abs(imp.value));
      const spread = Math.abs(exp.value - imp.value);
      const relativeSpread = maxAbs > 0 ? spread / maxAbs : 0;
      // Basis gate first: a grade-band ratio is a units artifact, not a
      // finding. Then: weight-based mirror gaps have no CIF/FOB component;
      // below ~8% they are usually timing (year-boundary shipments) and
      // coverage. Only what survives both gates earns 'unexplained'.
      const basisVerdict = basisGate(exportMetric, [exp.value, imp.value], new Set([exp.basis ?? 'unspecified', imp.basis ?? 'unspecified']));
      const cls: Divergence['class'] = basisVerdict ? basisVerdict.class
        : relativeSpread < 0.08 ? 'coverage' : 'unexplained';
      const rec: Divergence = {
        id: `div:mirror:${slug(exp.entityId)}-${slug(imp.entityId)}:${exportMetric}:${exp.period.start.slice(0, 4)}`,
        kind: 'mirror',
        entityId: exp.entityId,
        partnerEntityId: imp.entityId,
        metric: exportMetric,
        period: exp.period,
        claims: [claimOf(exp, 'reporter'), claimOf(imp, 'partner')],
        // Bilateral evidence never feeds aggregate analytics; neither side
        // is "the" resolved value.
        resolvedTo: '',
        spread: Number(spread.toFixed(3)),
        relativeSpread: Number(relativeSpread.toFixed(4)),
        direction: exp.value > imp.value ? 'reporter_higher' : 'partner_higher',
        persistence: 1,
        class: cls,
        basisNormalization: basisVerdict?.normalization,
        explanation: basisVerdict ? `Exporter declares ${exp.value.toLocaleString()}; importer records ${imp.value.toLocaleString()} ${exp.unit}. ${basisVerdict.explanation}`
          : cls === 'coverage'
            ? `Exporter and importer declarations differ by ${(relativeSpread * 100).toFixed(1)}% — within the range year-boundary timing and coverage normally explain.`
            : `Exporter declares ${exp.value.toLocaleString()} ${exp.unit}; importer records ${imp.value.toLocaleString()} — a ${(relativeSpread * 100).toFixed(0)}% gap. Persistent directional gaps of this size are the standard signature of transshipment re-attribution, reporter suppression or misdeclaration; investigate before concluding.`,
      };
      usedObs.add(exp.id); usedObs.add(imp.id);
      records.push(rec);
      const sk = `mirror|${exp.entityId}|${imp.entityId}|${exportMetric}`;
      if (!seqDir.has(sk)) seqDir.set(sk, []);
      seqDir.get(sk)!.push({ periodStart: exp.period.start, direction: rec.direction, record: rec });
    }
  }

  /* ── Persistence + residual drift, per (corridor, metric) sequence ── */
  for (const seq of seqDir.values()) {
    seq.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    let run = 0;
    let prevDir: string | null = null;
    const residuals: number[] = [];
    for (const item of seq) {
      run = item.direction === prevDir ? run + 1 : 1;
      prevDir = item.direction;
      item.record.persistence = run;

      // Drift: residual vs the median of this corridor's PRIOR residuals.
      // First-differencing removes the unknown-but-constant grade offset,
      // so drift can distinguish "a 30%-grade corridor" (stable level) from
      // "something changed" (a step) — which level alone cannot.
      const bn = item.record.basisNormalization;
      if (!bn) continue;
      if (residuals.length > 0) {
        const sorted = [...residuals].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const drift = bn.residual - median;
        bn.residualDrift = Number(drift.toFixed(4));
        if (Math.abs(drift) > DRIFT_THRESHOLD && item.record.class === 'definitional') {
          item.record.class = 'unexplained';
          item.record.explanation += ` RECLASSIFIED on drift: the residual moved from a corridor median of ${(median * 100).toFixed(1)}% to ${(bn.residual * 100).toFixed(1)}% (${(drift * 100).toFixed(1)} points in one step). Grade is a slowly-moving physical property — a step this size is not a grade difference; something changed in this corridor.`;
        }
      }
      residuals.push(bn.residual);
    }
  }

  // Largest, most persistent, least explained first. Normalized pairs rank
  // on drift where history exists (the grade-corrected quantity), residual
  // otherwise — never the raw spread, which measures the ore grade and
  // would either bury a drifting corridor under its own dismissal or keep a
  // fully-explained one artificially prominent.
  const clsRank = { unexplained: 3, coverage: 2, definitional: 1, revision_lag: 0 } as const;
  const effectiveSpread = (d: Divergence) =>
    d.basisNormalization
      ? Math.abs(d.basisNormalization.residualDrift ?? d.basisNormalization.residual)
      : d.relativeSpread;
  records.sort((a, b) =>
    clsRank[b.class] - clsRank[a.class]
    || b.persistence - a.persistence
    || effectiveSpread(b) - effectiveSpread(a));

  return {
    operation: { name: 'detectDivergences', params: { minRelativeSpread: MIN_RELATIVE_SPREAD } },
    execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
    inputs: { observationIds: [...usedObs] },
    result: records,
  };
}
