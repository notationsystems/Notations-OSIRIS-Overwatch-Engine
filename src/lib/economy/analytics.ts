/**
 * OSIRIS — First analytical layer over the canonical economy state.
 *
 * Deliberately small and interpretable: HHI concentration, flow centrality,
 * candidate bottleneck scoring, and simple anomaly primitives. Every result
 * is wrapped in AnalyticalResult so operation / execution / evidence
 * identities stay separate, and each derived number can be traced back to
 * the observation/flow ids it was computed from.
 */

import type { AnalyticalResult, EconomyState, Metric, Observation } from './types';
import type { EconomyGraph } from './graph';
import { nodeThroughput } from './graph';

const ENGINE = 'osiris-economy-analytics/0.1';

function wrap<T>(
  name: string,
  params: Record<string, string | number | undefined>,
  inputs: AnalyticalResult<T>['inputs'],
  result: T,
): AnalyticalResult<T> {
  return { operation: { name, params }, execution: { executedAt: new Date().toISOString(), engine: ENGINE }, inputs, result };
}

/* ── Concentration (HHI) ── */

export interface ConcentrationShare {
  entityId: string;
  name: string;
  value: number;
  share: number; // 0..1
}

export interface Concentration {
  metric: Metric;
  hhi: number; // 0..10000 (shares in %, squared and summed)
  /** DOJ-style bands: <1500 unconcentrated, 1500–2500 moderate, >2500 high. */
  band: 'unconcentrated' | 'moderate' | 'high';
  total: number;
  unit: string;
  shares: ConcentrationShare[];
}

/**
 * Concentration of a metric across the entities that report it, restricted
 * to one entity kind so country totals and facility figures never mix in a
 * single calculation (they would double-count the same material).
 */
export function concentration(
  state: EconomyState,
  metric: Metric,
  kind: 'country' | 'mine' | 'smelter' | 'refinery' | 'region',
): AnalyticalResult<Concentration> {
  const obs = state.observations.filter(o => {
    if (o.metric !== metric) return false;
    const ent = state.entities.find(e => e.id === o.entityId);
    return ent?.kind === kind;
  });
  const total = obs.reduce((s, o) => s + o.value, 0);
  const shares: ConcentrationShare[] = obs
    .map(o => ({
      entityId: o.entityId,
      name: state.entities.find(e => e.id === o.entityId)?.name ?? o.entityId,
      value: o.value,
      share: total > 0 ? o.value / total : 0,
    }))
    .sort((a, b) => b.share - a.share);
  const hhi = Math.round(shares.reduce((s, x) => s + (x.share * 100) ** 2, 0));
  const band = hhi > 2500 ? 'high' : hhi >= 1500 ? 'moderate' : 'unconcentrated';
  return wrap(
    'concentration',
    { metric, kind },
    { observationIds: obs.map(o => o.id) },
    { metric, hhi, band, total, unit: obs[0]?.unit ?? '', shares },
  );
}

/**
 * Concentration of installed capacity at a supply stage, grouped by country.
 * Uses Capacity records (constraints), not Observations — smelting/refining
 * structure is a capacity fact even where production splits are unreported.
 */
export function capacityConcentration(
  state: EconomyState,
  stage: 'smelting' | 'refining' | 'production',
): AnalyticalResult<Concentration> {
  const caps = state.capacities.filter(c => c.stage === stage);
  const byCountry = new Map<string, { name: string; value: number; entityId: string }>();
  for (const c of caps) {
    const ent = state.entities.find(e => e.id === c.entityId);
    const code = ent?.countryCode ?? 'unknown';
    const country = state.entities.find(e => e.kind === 'country' && e.countryCode === code);
    const key = country?.id ?? `ent:country:${code}`;
    if (!byCountry.has(key)) byCountry.set(key, { name: country?.name ?? ent?.country ?? code, value: 0, entityId: key });
    byCountry.get(key)!.value += c.value;
  }
  const total = [...byCountry.values()].reduce((s, x) => s + x.value, 0);
  const shares: ConcentrationShare[] = [...byCountry.values()]
    .map(x => ({ entityId: x.entityId, name: x.name, value: x.value, share: total > 0 ? x.value / total : 0 }))
    .sort((a, b) => b.share - a.share);
  const hhi = Math.round(shares.reduce((s, x) => s + (x.share * 100) ** 2, 0));
  const band = hhi > 2500 ? 'high' : hhi >= 1500 ? 'moderate' : 'unconcentrated';
  return wrap(
    'capacityConcentration',
    { stage },
    { capacityIds: caps.map(c => c.id) },
    { metric: 'throughput', hhi, band, total, unit: caps[0]?.unit ?? '', shares },
  );
}

/* ── Flow centrality ── */

export interface CentralityRow {
  entityId: string;
  name: string;
  kind: string;
  inKt: number;
  outKt: number;
  throughputKt: number;
  /** Share of the sum of all node throughputs (0..1). */
  share: number;
}

export function flowCentrality(state: EconomyState, graph: EconomyGraph): AnalyticalResult<CentralityRow[]> {
  const throughput = nodeThroughput(graph);
  const flowIds = new Set<string>();
  let grand = 0;
  for (const t of throughput.values()) { grand += t.inKt + t.outKt; t.flowIds.forEach(id => flowIds.add(id)); }

  const rows: CentralityRow[] = [...throughput.entries()]
    .map(([entityId, t]) => {
      const ent = graph.nodes.get(entityId);
      return {
        entityId,
        name: ent?.name ?? entityId,
        kind: ent?.kind ?? 'unknown',
        inKt: t.inKt,
        outKt: t.outKt,
        throughputKt: t.inKt + t.outKt,
        share: grand > 0 ? (t.inKt + t.outKt) / grand : 0,
      };
    })
    .sort((a, b) => b.throughputKt - a.throughputKt);

  return wrap('flowCentrality', { commodity: state.commodity }, { flowIds: [...flowIds] }, rows);
}

/* ── Candidate bottlenecks ── */

export interface BottleneckCandidate {
  entityId: string;
  name: string;
  kind: string;
  /** 0..1 — explicitly a CANDIDATE score, not validated constraint risk. */
  score: number;
  components: {
    throughputShare: number;   // material passing through, vs network max
    utilization: number | null; // flow-through vs capacity, when capacity known
    redundancy: number;         // 1 - (alternatives at same stage / max) — higher = fewer alternatives
    dependencyLoad: number;     // downstream dependents with strength, normalized
  };
  explanation: string[];
  /** Evidence behind the score. */
  flowIds: string[];
  capacityIds: string[];
  dependencyIds: string[];
}

/**
 * Candidate bottleneck score: high flow + high utilization + low redundancy
 * + high dependency load. Weights are transparent and equal-ish by design —
 * this is a triage signal for a researcher, not a validated risk model.
 */
export function bottleneckCandidates(state: EconomyState, graph: EconomyGraph): AnalyticalResult<BottleneckCandidate[]> {
  const throughput = nodeThroughput(graph);
  const maxThroughput = Math.max(1, ...[...throughput.values()].map(t => t.inKt + t.outKt));

  // Alternatives: nodes of the same kind+stage that also carry flow.
  const stageCounts = new Map<string, number>();
  for (const [id] of throughput) {
    const ent = graph.nodes.get(id);
    if (!ent) continue;
    const key = `${ent.kind}:${ent.stage ?? ''}`;
    stageCounts.set(key, (stageCounts.get(key) ?? 0) + 1);
  }
  const maxAlternatives = Math.max(1, ...stageCounts.values());

  const candidates: BottleneckCandidate[] = [];
  const allFlowIds = new Set<string>();
  const allCapIds = new Set<string>();
  const allDepIds = new Set<string>();

  for (const [entityId, t] of throughput) {
    const ent = graph.nodes.get(entityId);
    if (!ent) continue;
    // Demand regions and countries are sinks/aggregates, not chokepoints.
    if (ent.kind === 'country' || ent.kind === 'region') continue;

    const through = t.inKt + t.outKt;
    const throughputShare = through / maxThroughput;

    const caps = state.capacities.filter(c => c.entityId === entityId);
    const capKt = caps.reduce((s, c) => s + c.value, 0);
    // Material handled once (max of in/out), against stated capacity.
    const utilization = capKt > 0 ? Math.min(1.5, Math.max(t.inKt, t.outKt) / capKt) : null;

    const key = `${ent.kind}:${ent.stage ?? ''}`;
    const alternatives = (stageCounts.get(key) ?? 1) - 1;
    const redundancy = 1 - Math.min(1, alternatives / maxAlternatives);

    const deps = state.dependencies.filter(d => d.type === 'depends_on' && d.toEntityId === entityId);
    const dependencyLoad = Math.min(1, deps.reduce((s, d) => s + (d.strength ?? 0.5), 0) / 2);

    const score =
      0.35 * throughputShare +
      0.25 * (utilization ?? 0.5 * throughputShare) + // unknown capacity: fall back to flow pressure, discounted
      0.25 * redundancy +
      0.15 * dependencyLoad;

    const explanation: string[] = [];
    explanation.push(`${Math.round(through)} kt/y passes through (${Math.round(throughputShare * 100)}% of network max)`);
    if (utilization !== null) explanation.push(`utilization ≈ ${Math.round(utilization * 100)}% of stated capacity`);
    else explanation.push('no stated capacity — flow pressure used as proxy');
    explanation.push(alternatives === 0 ? 'no modeled alternative at this stage' : `${alternatives} modeled alternative(s) at this stage`);
    if (deps.length > 0) explanation.push(`${deps.length} entity(ies) explicitly depend on it`);

    t.flowIds.forEach(id => allFlowIds.add(id));
    caps.forEach(c => allCapIds.add(c.id));
    deps.forEach(d => allDepIds.add(d.id));

    candidates.push({
      entityId, name: ent.name, kind: ent.kind,
      score: Math.min(1, score),
      components: { throughputShare, utilization, redundancy, dependencyLoad },
      explanation,
      flowIds: t.flowIds,
      capacityIds: caps.map(c => c.id),
      dependencyIds: deps.map(d => d.id),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return wrap(
    'bottleneckCandidates',
    { commodity: state.commodity },
    { flowIds: [...allFlowIds], capacityIds: [...allCapIds] },
    candidates,
  );
}

/* ── Anomaly primitives ── */

export interface SeriesPoint { period: string; value: number; observationId: string }

export interface AnomalySignal {
  entityId: string;
  metric: Metric;
  kind: 'rolling-deviation' | 'rate-of-change';
  period: string;
  value: number;
  /** Standard deviations from the rolling mean, or period-over-period %Δ. */
  magnitude: number;
  observationIds: string[];
  explanation: string;
}

/** Extract an ordered time series for one entity+metric from observations. */
export function extractSeries(state: EconomyState, entityId: string, metric: Metric): SeriesPoint[] {
  return state.observations
    .filter(o => o.entityId === entityId && o.metric === metric)
    .sort((a, b) => a.period.start.localeCompare(b.period.start))
    .map(o => ({ period: o.period.start.slice(0, 7), value: o.value, observationId: o.id }));
}

/**
 * Interpretable anomaly pass over every (entity, metric) series with ≥6
 * points: rolling z-score against the trailing window, and month-over-month
 * rate of change. No ML — a researcher can recompute either by hand.
 */
export function detectAnomalies(state: EconomyState, { window = 6, zThreshold = 2, rocThreshold = 0.12 } = {}): AnalyticalResult<AnomalySignal[]> {
  const seriesKeys = new Map<string, Observation[]>();
  for (const o of state.observations) {
    const key = `${o.entityId}|${o.metric}`;
    if (!seriesKeys.has(key)) seriesKeys.set(key, []);
    seriesKeys.get(key)!.push(o);
  }

  const signals: AnomalySignal[] = [];
  const usedObs = new Set<string>();

  for (const [key, obsList] of seriesKeys) {
    if (obsList.length < window) continue;
    const [entityId, metric] = key.split('|') as [string, Metric];
    const series = extractSeries(state, entityId, metric);

    for (let i = window; i < series.length; i++) {
      const trailing = series.slice(i - window, i).map(p => p.value);
      const mean = trailing.reduce((s, v) => s + v, 0) / trailing.length;
      const sd = Math.sqrt(trailing.reduce((s, v) => s + (v - mean) ** 2, 0) / trailing.length);
      const point = series[i];

      if (sd > 0) {
        const z = (point.value - mean) / sd;
        if (Math.abs(z) >= zThreshold) {
          series.slice(i - window, i + 1).forEach(p => usedObs.add(p.observationId));
          signals.push({
            entityId, metric, kind: 'rolling-deviation', period: point.period, value: point.value,
            magnitude: Number(z.toFixed(2)),
            observationIds: series.slice(i - window, i + 1).map(p => p.observationId),
            explanation: `${point.period}: ${point.value} is ${z.toFixed(1)}σ from the trailing ${window}-period mean (${mean.toFixed(1)})`,
          });
        }
      }

      const prev = series[i - 1];
      if (prev.value !== 0) {
        const roc = (point.value - prev.value) / prev.value;
        if (Math.abs(roc) >= rocThreshold) {
          usedObs.add(prev.observationId); usedObs.add(point.observationId);
          signals.push({
            entityId, metric, kind: 'rate-of-change', period: point.period, value: point.value,
            magnitude: Number((roc * 100).toFixed(1)),
            observationIds: [prev.observationId, point.observationId],
            explanation: `${point.period}: ${(roc * 100).toFixed(1)}% change vs ${prev.period} (${prev.value} → ${point.value})`,
          });
        }
      }
    }
  }

  signals.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
  return wrap('detectAnomalies', { window, zThreshold, rocThreshold }, { observationIds: [...usedObs] }, signals);
}
