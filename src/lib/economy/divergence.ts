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

const MIRROR_PAIRS: Array<[exportMetric: Metric, importMetric: Metric]> = [
  ['concentrate_exports', 'concentrate_imports'],
  ['refined_exports', 'refined_imports'],
];

/**
 * Copper concentrate typically grades 20–33% Cu, so contained-metal and
 * gross-weight declarations of the SAME flow differ by a factor of ~3.0–5.0.
 * A mirror ratio landing inside that band is the fingerprint of a basis
 * mismatch, not of suppression — the gap reproduces the industry grade, and
 * chasing it would send an analyst after phantom tonnage. The gate runs
 * BEFORE 'unexplained' can be assigned: unexplained is the hardest class to
 * earn, never the default residue.
 */
const CONCENTRATE_GRADE_BAND = { minRatio: 3.0, maxRatio: 5.0 };

interface BasisVerdict { class: 'definitional'; explanation: string }

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
  if (ratio >= CONCENTRATE_GRADE_BAND.minRatio && ratio <= CONCENTRATE_GRADE_BAND.maxRatio) {
    const impliedGrade = (100 / ratio).toFixed(1);
    return {
      class: 'definitional',
      explanation: `Ratio ${ratio.toFixed(2)}x implies ${impliedGrade}% Cu content — inside the typical concentrate grade band (20–33%). Almost certainly contained metal on one side and gross shipped weight on the other (candidate basis mismatch), not suppression or transshipment. The residual after basis normalization, much smaller, would be the finding.`,
    };
  }
  return null;
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
    const cls: Divergence['class'] = basisVerdict ? 'definitional'
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
      const cls: Divergence['class'] = basisVerdict ? 'definitional'
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

  /* ── Persistence: consecutive periods with consistent direction ── */
  for (const seq of seqDir.values()) {
    seq.sort((a, b) => a.periodStart.localeCompare(b.periodStart));
    let run = 0;
    let prevDir: string | null = null;
    for (const item of seq) {
      run = item.direction === prevDir ? run + 1 : 1;
      prevDir = item.direction;
      item.record.persistence = run;
    }
  }

  // Largest, most persistent, least explained first.
  const clsRank = { unexplained: 3, coverage: 2, definitional: 1, revision_lag: 0 } as const;
  records.sort((a, b) =>
    clsRank[b.class] - clsRank[a.class]
    || b.persistence - a.persistence
    || b.relativeSpread - a.relativeSpread);

  return {
    operation: { name: 'detectDivergences', params: { minRelativeSpread: MIN_RELATIVE_SPREAD } },
    execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
    inputs: { observationIds: [...usedObs] },
    result: records,
  };
}
