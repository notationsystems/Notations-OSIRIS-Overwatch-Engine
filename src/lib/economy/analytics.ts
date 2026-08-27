/**
 * OSIRIS — First analytical layer over the canonical economy state.
 *
 * Deliberately small and interpretable: HHI concentration, flow centrality,
 * candidate bottleneck scoring, and simple anomaly primitives. Every result
 * is wrapped in AnalyticalResult so operation / execution / evidence
 * identities stay separate, and each derived number can be traced back to
 * the observation/flow ids it was computed from.
 */

import type { AnalyticalResult, EconomyState, MeasurementClass, Metric, Observation } from './types';
import { measurementClassOf } from './types';
import type { EconomyGraph } from './graph';
import { nodeThroughput } from './graph';

/** knownAt with its conservative fallback: retrieval time bounds knowability. */
export function knownAtOf(o: Observation): string {
  return o.knownAt ?? o.provenance.retrievedAt.slice(0, 10);
}

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
  /** DOJ-style bands: <1500 unconcentrated, 1500–2500 moderate, >2500 high.
   *  'no-data' when no observations exist at the evaluation date — a zero
   *  computed from zero evidence must not read as a verdict. */
  band: 'unconcentrated' | 'moderate' | 'high' | 'no-data';
  total: number;
  unit: string;
  shares: ConcentrationShare[];
  /**
   * HHI has a floor of 10000/n: a finer partition yields a lower index
   * whatever the underlying structure, so raw HHIs over unequal partitions
   * are NOT comparable. These travel with every index so the comparison is
   * done against the partition, never across partitions raw:
   *   groupCount       n — the partition size
   *   effectiveGroups  10000/HHI — the equivalent number of equal groups
   *   partitionFloor   10000/n — the minimum HHI this partition permits
   */
  groupCount: number;
  effectiveGroups: number;
  partitionFloor: number;
  /**
   * Facility-level concentrations only: how much of each country the facility
   * model covers. Differential coverage biases facility HHI systematically —
   * a country that is 73% modeled looks more concentrated than one 22%
   * modeled purely because more of it is visible. The range travels with the
   * number so the bias cannot be read as structure.
   */
  coverageBias?: { minRatio: number; maxRatio: number; countries: number; note: string };
  /**
   * The weakest evidence class among the inputs this index was computed
   * from — contamination propagates: one representative input taints a
   * derived quantity, whatever the others are. null when there were no
   * inputs. See the lattice note at weakestInputClass(): this is the
   * OPPOSITE direction from strongestAttestingClass, and both are correct.
   */
  weakestInputClass: Observation['valueKind'] | null;
}

/** When two sources cover the same (entity, metric, period), the harder
 *  evidence wins: reported beats estimated beats curated-representative
 *  beats derived. */
const VALUE_KIND_RANK: Record<Observation['valueKind'], number> = {
  reported: 3, estimated: 2, representative: 1, derived: 0,
};
const CONF_RANK = { high: 2, medium: 1, low: 0 } as const;

/** True when `candidate` is harder evidence than `incumbent` for the same
 *  (entity, metric, period): higher valueKind rank, then higher confidence. */
export function outranksObservation(candidate: Observation, incumbent: Observation): boolean {
  return outranks(candidate, incumbent);
}

/* ── Evidence-class aggregation: two questions, opposite lattice directions ──
 *
 * The codebase holds BOTH directions and both are correct — never unify them
 * into a bare "sourceClass":
 *
 *   weakestInputClass        derived quantities — contamination propagates:
 *                            one representative input taints the result.
 *   strongestAttestingClass  entity existence — one good witness is enough:
 *                            no quantity of representative records
 *                            subtracts from a reported one.
 *
 * Someone will eventually notice the asymmetry and be tempted to "fix" it.
 * The asymmetry is the point. */

/** Weakest evidence class among a derived quantity's inputs (contamination
 *  direction). null for an empty input set — no inputs is not clean inputs. */
export function weakestInputClass(kinds: Iterable<Observation['valueKind']>): Observation['valueKind'] | null {
  let weakest: Observation['valueKind'] | null = null;
  for (const k of kinds) {
    if (!weakest || VALUE_KIND_RANK[k] < VALUE_KIND_RANK[weakest]) weakest = k;
  }
  return weakest;
}

/* ── Entity attestation ── */

export type AttestationKind = Observation['valueKind'] | 'event_only' | 'structural_only';

/**
 * The STRONGEST evidence class attesting each entity's existence — the
 * identity-level sibling of per-record valueKind. An entity whose best
 * attesting class is 'representative' (or below) exists, within OSIRIS,
 * purely on curation: a real name carried entirely by synthetic-class
 * numbers, which is the round-3 concern one level up, at identity rather
 * than quantity. (Strongest, not weakest, is the right aggregate here —
 * the witness direction of the lattice note above.) Tiers below the
 * valueKind ladder: 'event_only' — attested solely by curated real-world
 * events (a reported occurrence, but no quantity of any class);
 * 'structural_only' — attested solely by dependency edges (a curated
 * relationship claim; the JV operating vehicles live here by construction).
 */
export function strongestAttestingClass(state: EconomyState): Map<string, AttestationKind> {
  const best = new Map<string, Observation['valueKind']>();
  const consider = (id: string | undefined, vk: Observation['valueKind']) => {
    if (!id) return;
    const cur = best.get(id);
    if (!cur || VALUE_KIND_RANK[vk] > VALUE_KIND_RANK[cur]) best.set(id, vk);
  };
  for (const o of state.observations) { consider(o.entityId, o.valueKind); consider(o.partnerEntityId, o.valueKind); }
  for (const f of state.flows) { consider(f.fromEntityId, f.valueKind); consider(f.toEntityId, f.valueKind); }
  for (const c of state.capacities) consider(c.entityId, c.valueKind);
  const eventAttested = new Set<string>();
  for (const ev of state.events) if (ev.entityId) eventAttested.add(ev.entityId);
  const depAttested = new Set<string>();
  for (const d of state.dependencies) { depAttested.add(d.fromEntityId); depAttested.add(d.toEntityId); }
  const out = new Map<string, AttestationKind>();
  for (const e of state.entities) {
    const vk = best.get(e.id);
    if (vk) out.set(e.id, vk);
    else if (eventAttested.has(e.id)) out.set(e.id, 'event_only');
    else if (depAttested.has(e.id)) out.set(e.id, 'structural_only');
    // An entity setting nothing here is unattested — the store test pins
    // that none exist.
  }
  return out;
}

function outranks(candidate: Observation, incumbent: Observation): boolean {
  if (VALUE_KIND_RANK[candidate.valueKind] !== VALUE_KIND_RANK[incumbent.valueKind]) {
    return VALUE_KIND_RANK[candidate.valueKind] > VALUE_KIND_RANK[incumbent.valueKind];
  }
  if (CONF_RANK[candidate.confidence] !== CONF_RANK[incumbent.confidence]) {
    return CONF_RANK[candidate.confidence] > CONF_RANK[incumbent.confidence];
  }
  // Equal rank and confidence: the later vintage wins (revisions supersede).
  return knownAtOf(candidate) > knownAtOf(incumbent);
}

/**
 * One observation per entity for a metric: the latest whose period ends at or
 * before `asOf` (default: latest available). This is what makes time-series
 * state safe — a ten-year production series must never be summed as if the
 * years were siblings. Same-period duplicates from different providers
 * resolve by valueKind rank, then confidence.
 */
export function observationsAt(
  state: EconomyState,
  metric: Metric,
  kind: 'country' | 'mine' | 'smelter' | 'refinery' | 'region',
  asOf?: string,
): Observation[] {
  const cutoff = asOf ?? '9999-12-31';
  const best = new Map<string, Observation>();
  for (const o of state.observations) {
    if (o.metric !== metric || o.period.end > cutoff) continue;
    if (o.partnerEntityId) continue; // bilateral mirror evidence, not an aggregate
    const ent = state.entities.find(e => e.id === o.entityId);
    if (ent?.kind !== kind) continue;
    const prev = best.get(o.entityId);
    if (!prev || o.period.end > prev.period.end || (o.period.end === prev.period.end && outranks(o, prev))) {
      best.set(o.entityId, o);
    }
  }
  return [...best.values()];
}

/**
 * Concentration of a metric across the entities that report it, restricted
 * to one entity kind so country totals and facility figures never mix in a
 * single calculation (they would double-count the same material). With
 * `asOf`, computed from each entity's latest observation at that date.
 */
export function concentration(
  state: EconomyState,
  metric: Metric,
  kind: 'country' | 'mine' | 'smelter' | 'refinery' | 'region',
  asOf?: string,
): AnalyticalResult<Concentration> {
  const cls = measurementClassOf(metric);
  if (cls === 'market_price' || cls === 'financial_positioning') {
    // A market signal has no population shares; an HHI over it is a category
    // error, so refuse rather than return a plausible-looking number.
    throw new Error(`concentration() rejects ${cls} metric "${metric}" — physical measurements only`);
  }
  const obs = observationsAt(state, metric, kind, asOf);
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
  const band = shares.length === 0 ? 'no-data' as const : hhi > 2500 ? 'high' as const : hhi >= 1500 ? 'moderate' as const : 'unconcentrated' as const;
  return wrap(
    'concentration',
    { metric, kind, asOf },
    { observationIds: obs.map(o => o.id) },
    {
      metric, hhi, band, total, unit: obs[0]?.unit ?? '', shares,
      ...partitionContext(hhi, shares.length),
      weakestInputClass: weakestInputClass(obs.map(o => o.valueKind)),
    },
  );
}

/** The comparability fields every HHI must carry — see Concentration. */
export function partitionContext(hhi: number, groupCount: number): { groupCount: number; effectiveGroups: number; partitionFloor: number } {
  return {
    groupCount,
    effectiveGroups: hhi > 0 ? Number((10000 / hhi).toFixed(1)) : 0,
    partitionFloor: groupCount > 0 ? Math.round(10000 / groupCount) : 0,
  };
}

export interface TrajectoryPoint {
  period: string;   // year, e.g. "2019"
  hhi: number;
  band: Concentration['band'];
  topName: string;
  topShare: number; // 0..1
  participants: number;
}

/**
 * How concentration evolved: HHI recomputed at each year-end from the
 * observations available then. Years where fewer than `minParticipants`
 * entities report are dropped rather than shown as spuriously concentrated.
 */
export function concentrationTrajectory(
  state: EconomyState,
  metric: Metric,
  kind: 'country' | 'mine' | 'smelter' | 'refinery' | 'region',
  { minParticipants = 5 } = {},
): AnalyticalResult<TrajectoryPoint[]> {
  const years = new Set<string>();
  for (const o of state.observations) {
    if (o.metric === metric) years.add(o.period.end.slice(0, 4));
  }
  const points: TrajectoryPoint[] = [];
  const usedObs = new Set<string>();
  for (const year of [...years].sort()) {
    // Only observations FROM that year — a year where most reporters are
    // stale carry-forwards would fabricate a concentration figure.
    const obs = observationsAt(state, metric, kind, `${year}-12-31`)
      .filter(o => o.period.end.slice(0, 4) === year);
    if (obs.length < minParticipants) continue;
    const total = obs.reduce((s, o) => s + o.value, 0);
    if (total <= 0) continue;
    const shares = obs.map(o => ({
      name: state.entities.find(e => e.id === o.entityId)?.name ?? o.entityId,
      share: o.value / total,
    })).sort((a, b) => b.share - a.share);
    const hhi = Math.round(shares.reduce((s, x) => s + (x.share * 100) ** 2, 0));
    obs.forEach(o => usedObs.add(o.id));
    points.push({
      period: year,
      hhi,
      band: hhi > 2500 ? 'high' : hhi >= 1500 ? 'moderate' : 'unconcentrated',
      topName: shares[0].name,
      topShare: shares[0].share,
      participants: obs.length,
    });
  }
  return wrap(
    'concentrationTrajectory',
    { metric, kind, minParticipants },
    { observationIds: [...usedObs] },
    points,
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
  const band = shares.length === 0 ? 'no-data' as const : hhi > 2500 ? 'high' as const : hhi >= 1500 ? 'moderate' as const : 'unconcentrated' as const;
  return wrap(
    'capacityConcentration',
    { stage },
    { capacityIds: caps.map(c => c.id) },
    {
      metric: 'throughput', hhi, band, total, unit: caps[0]?.unit ?? '', shares,
      ...partitionContext(hhi, shares.length),
      weakestInputClass: weakestInputClass(caps.map(c => c.valueKind)),
    },
  );
}

/* ── Facility coverage ── */

export interface CoverageRow {
  countryId: string;
  countryName: string;
  metric: Metric;
  /** The country's own latest observation at asOf. */
  direct: number;
  directObservationId: string;
  /** Sum of the latest facility observations rolled up via countryCode. */
  rolledUp: number;
  facilityCount: number;
  facilityObservationIds: string[];
  /** rolledUp / direct. ≈1 complete facility model; <1 unmodelled share;
   *  >1 a real contradiction — one side is wrong. */
  ratio: number;
  status: 'complete' | 'partial' | 'contradiction';
  unit: string;
}

/**
 * Coverage denominator for the facility model: for each country carrying both
 * a direct observation and rolled-up facility observations of the same metric,
 * report what fraction of the country's output the modeled facilities account
 * for. Diagnostic, not an error — the gap IS the unmodelled capacity, and a
 * ratio above one is a contradiction worth chasing. This is also the standing
 * integrity check that keeps facility- and country-level populations from
 * ever being silently conflated: they meet only here, explicitly, as a ratio.
 */
export function facilityCoverage(
  state: EconomyState,
  metric: Metric,
  facilityKinds: Array<'mine' | 'smelter' | 'refinery'>,
  asOf?: string,
): AnalyticalResult<CoverageRow[]> {
  const direct = observationsAt(state, metric, 'country', asOf);
  const facilityObs = facilityKinds.flatMap(kind => observationsAt(state, metric, kind, asOf));
  const entityById = new Map(state.entities.map(e => [e.id, e]));

  const rows: CoverageRow[] = [];
  for (const d of direct) {
    const country = entityById.get(d.entityId);
    if (!country?.countryCode) continue;
    const facilities = facilityObs.filter(o => {
      const ent = entityById.get(o.entityId);
      // Units must agree — a gross-weight figure must not roll up against
      // a copper-content denominator.
      return ent?.countryCode === country.countryCode && o.unit === d.unit;
    });
    if (facilities.length === 0) continue;
    const rolledUp = facilities.reduce((s, o) => s + o.value, 0);
    // A zero country total with zero facility output (e.g. Panama after the
    // closure) is a COMPLETE model of nothing — not a contradiction. Facilities
    // producing against a zero country figure IS one; keep it finite for JSON.
    const ratio = d.value > 0 ? rolledUp / d.value : (rolledUp === 0 ? 1 : 99.999);
    rows.push({
      countryId: d.entityId,
      countryName: country.name,
      metric,
      direct: d.value,
      directObservationId: d.id,
      rolledUp: Math.round(rolledUp),
      facilityCount: facilities.length,
      facilityObservationIds: facilities.map(o => o.id),
      ratio: Number(ratio.toFixed(3)),
      status: ratio > 1.02 ? 'contradiction' : ratio >= 0.95 ? 'complete' : 'partial',
      unit: d.unit,
    });
  }
  rows.sort((a, b) => b.direct - a.direct);
  return wrap(
    'facilityCoverage',
    { metric, facilityKinds: facilityKinds.join(','), asOf },
    { observationIds: [...new Set([...rows.map(r => r.directObservationId), ...rows.flatMap(r => r.facilityObservationIds)])] },
    rows,
  );
}

/* ── Operator concentration ── */

/**
 * What an operator attribution MEANS — the same shape as QuantityBasis, one
 * level up, and never defaulted:
 *   control            100% of an asset to its operator of record — the
 *                      lever a strike, distress or sanction pulls. This is
 *                      what propagation and correlated-disruption analysis
 *                      answer: "who can stop it".
 *   economic_interest  ownership shares — "who owns the loss". A legitimate
 *                      second view, and a different question.
 * Grasberg is the sharp case: majority state-held, Freeport-operated — the
 * two bases disagree hardest on one of the largest nodes.
 */
export type AttributionBasis = 'control' | 'economic_interest';

/** Shape-compatible with Concentration so every projection that renders an
 *  HHI block renders this one — plus the attribution fields that must
 *  travel with the number. */
export interface OperatorConcentration {
  metric: Metric;
  /** The attribution basis is stated ON the number, always. */
  attributionBasis: AttributionBasis;
  /** HHI over ATTRIBUTED company shares (renormalized to the allocated
   *  total) — the attribution coverage travels with it, exactly as
   *  geographic coverage travels with the facility HHI. NULL when nothing
   *  is attributed: an index over an empty set has nothing to say, and 0
   *  would read as "perfectly unconcentrated" — the maximally wrong
   *  reading, the same failure the precision scorecard's min-trials floor
   *  removes. */
  hhi: number | null;
  band: 'unconcentrated' | 'moderate' | 'high' | 'no-data';
  /** The ALLOCATED total (the HHI base). The raw facility total is totalKt. */
  total: number;
  unit: string;
  /** share = share of the allocated total (the HHI basis of `hhi`). */
  shares: Array<{ entityId: string; name: string; value: number; share: number }>;
  /** Partition comparability — see Concentration. */
  groupCount: number;
  effectiveGroups: number;
  partitionFloor: number;
  /** Contamination direction — see Concentration.weakestInputClass. Includes
   *  the attribution edges (curated, representative-class by construction),
   *  so this index cannot read stronger than the structure it stands on. */
  weakestInputClass: Observation['valueKind'] | null;
  /**
   * The FOURTH comparability axis: a renormalized index over c of the
   * universe inflates every share by 1/c and the HHI by ~1/c². `hhi` is
   * the renormalized (attributed-only) figure; `hhiWithRemainder` restores
   * the unattributed tonnage — each unattributed facility enumerated as its
   * own group, since distinct facilities have distinct (unmodeled, not
   * unknown) operators; a facility's residual minority holders lump as one
   * group per facility, which biases slightly toward concentration and is
   * said so. ONLY hhiWithRemainder is comparable against an index computed
   * over the full universe.
   */
  hhiWithRemainder: number;
  remainderTreatment: 'none' | 'enumerated';
  totalKt: number;
  /** allocated / total: the share of facility output the operator model
   *  attributes. Partial attribution is reported, never hidden. */
  attributionCoverage: number;
  unattributedKt: number;
  facilityCount: number;
  note: string;
}

/**
 * Concentration by OPERATOR: facility output allocated to companies via
 * operated_by edges (strength = attribution share). A commodity can be
 * geographically diversified and operationally concentrated at once — a
 * single operator's labour dispute, financial distress or sanctions
 * exposure hits assets in several countries simultaneously, which is
 * correlated risk that country-HHI scores as diversified. The divergence
 * between operator-HHI and country-HHI is the finding.
 */
export function operatorConcentration(
  state: EconomyState,
  metric: Metric,
  facilityKinds: Array<'mine' | 'smelter' | 'refinery'>,
  basis: AttributionBasis,
  asOf?: string,
): AnalyticalResult<OperatorConcentration> {
  const cls = measurementClassOf(metric);
  if (cls === 'market_price' || cls === 'financial_positioning') {
    throw new Error(`operatorConcentration() rejects ${cls} metric "${metric}" — physical measurements only`);
  }
  const companyName = new Map(state.entities.filter(e => e.kind === 'company').map(e => [e.id, e.name]));
  const opEdges = state.dependencies.filter(d => d.type === 'operated_by');
  const usedObs: string[] = [];
  const usedDeps: string[] = [];

  const allocated = new Map<string, number>();
  /** Per-facility unattributed tonnage — enumerated groups for
   *  hhiWithRemainder, never an anonymous pool. */
  const facilityRemainders: number[] = [];
  let totalKt = 0;
  let allocatedKt = 0;
  let facilityCount = 0;
  let unit = 'kt/y';
  for (const kind of facilityKinds) {
    for (const o of observationsAt(state, metric, kind, asOf)) {
      totalKt += o.value;
      unit = o.unit;
      facilityCount += 1;
      usedObs.push(o.id);
      let facilityAllocated = 0;
      if (basis === 'control') {
        // 100% of an asset to its operator of record. A JV-operated facility
        // with no modeled operator falls to the reported unattributed
        // remainder — never force-assigned to a shareholder.
        const operator = opEdges.find(x => x.fromEntityId === o.entityId && x.role === 'operator');
        if (operator) {
          allocated.set(operator.toEntityId, (allocated.get(operator.toEntityId) ?? 0) + o.value);
          facilityAllocated = o.value;
          usedDeps.push(operator.id);
        }
      } else {
        // economic_interest: ownership shares — who owns the loss.
        for (const d of opEdges.filter(x => x.fromEntityId === o.entityId)) {
          const share = Math.max(0, Math.min(1, d.strength ?? 1));
          allocated.set(d.toEntityId, (allocated.get(d.toEntityId) ?? 0) + o.value * share);
          facilityAllocated += o.value * share;
          usedDeps.push(d.id);
        }
      }
      allocatedKt += facilityAllocated;
      const remainder = o.value - facilityAllocated;
      if (remainder > 0.5) facilityRemainders.push(remainder);
    }
  }
  const unattributedKt = Math.max(0, totalKt - allocatedKt);

  const shares = [...allocated.entries()]
    .map(([companyId, value]) => ({
      entityId: companyId,
      name: companyName.get(companyId) ?? companyId,
      value: Number(value.toFixed(1)),
      share: allocatedKt > 0 ? value / allocatedKt : 0,
    }))
    .sort((a, b) => b.value - a.value);
  // An index over zero attributed tonnage is NULL, not 0 — zero is a value
  // ("perfectly unconcentrated") that empty evidence cannot support.
  const hhi = allocatedKt > 0
    ? Math.round(shares.reduce((s, x) => s + (x.share * 100) ** 2, 0))
    : null;
  const band: OperatorConcentration['band'] = hhi === null ? 'no-data'
    : hhi > 2500 ? 'high' : hhi >= 1500 ? 'moderate' : 'unconcentrated';

  // The comparable figure: shares of the FULL universe, unattributed
  // facilities enumerated as their own groups.
  const hhiWithRemainder = totalKt > 0
    ? Math.round(
      [...allocated.values(), ...facilityRemainders]
        .reduce((s, v) => s + ((v / totalKt) * 100) ** 2, 0))
    : 0;

  return wrap(
    'operatorConcentration',
    { metric, facilityKinds: facilityKinds.join(','), basis, asOf },
    { observationIds: usedObs },
    {
      metric,
      attributionBasis: basis,
      hhi, band,
      hhiWithRemainder,
      remainderTreatment: facilityRemainders.length > 0 ? 'enumerated' as const : 'none' as const,
      total: Number(allocatedKt.toFixed(1)),
      unit,
      shares,
      ...partitionContext(hhi ?? 0, shares.length),
      totalKt: Number(totalKt.toFixed(1)),
      attributionCoverage: totalKt > 0 ? Number((allocatedKt / totalKt).toFixed(3)) : 0,
      unattributedKt: Number(unattributedKt.toFixed(1)),
      facilityCount,
      // Contamination direction: the index's inputs are the facility
      // observations AND the attribution edges. Dependency edges carry no
      // valueKind — they are curated structural claims, representative-class
      // by construction — so the operator index stays representative even on
      // the day facility observations become reported, until the attribution
      // edges themselves come from reported disclosures.
      weakestInputClass: weakestInputClass([
        ...state.observations.filter(o => usedObs.includes(o.id)).map(o => o.valueKind),
        ...(usedDeps.length > 0 ? ['representative' as const] : []),
      ]),
      note: basis === 'control'
        ? 'CONTROL basis: 100% of each facility to its operator of record — who can stop it. JV-operated facilities without a modeled operator fall to the unattributed remainder. `hhi` is renormalized over attributed tonnage (inflated by 1/completeness²); ONLY hhiWithRemainder — unattributed facilities enumerated as their own groups — is comparable against a full-universe index.'
        : 'ECONOMIC-INTEREST basis: ownership shares — who owns the loss. A different question from control; never pool the two. `hhi` is renormalized over attributed tonnage; ONLY hhiWithRemainder is comparable against a full-universe index (per-facility minority residues lump as one group each, biasing slightly toward concentration).',
    },
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
  /**
   * Share of the sum of all node throughputs (0..1) — or null, REFUSED,
   * when unquantifiable flows touch this node: zero would be a claim (the
   * flow carries nothing), and a share over a known-incomplete total is a
   * fabrication. Refusal is visible; zero isn't.
   */
  share: number | null;
  /** Flow ids whose tonnage could not be quantified at this node. */
  unquantifiedFlowIds?: string[];
}

export function flowCentrality(state: EconomyState, graph: EconomyGraph): AnalyticalResult<CentralityRow[]> {
  const throughput = nodeThroughput(graph);
  const flowIds = new Set<string>();
  let grand = 0;
  for (const t of throughput.values()) { grand += t.inKt + t.outKt; t.flowIds.forEach(id => flowIds.add(id)); }

  const rows: CentralityRow[] = [...throughput.entries()]
    .map(([entityId, t]) => {
      const ent = graph.nodes.get(entityId);
      const refused = t.unquantifiedFlowIds.length > 0;
      return {
        entityId,
        name: ent?.name ?? entityId,
        kind: ent?.kind ?? 'unknown',
        inKt: t.inKt,
        outKt: t.outKt,
        throughputKt: t.inKt + t.outKt,
        share: refused ? null : grand > 0 ? (t.inKt + t.outKt) / grand : 0,
        ...(refused ? { unquantifiedFlowIds: t.unquantifiedFlowIds } : {}),
      };
    })
    .sort((a, b) => b.throughputKt - a.throughputKt);

  const unquantified = rows.flatMap(r => r.unquantifiedFlowIds ?? []);
  return wrap(
    'flowCentrality',
    { commodity: state.commodity, ...(unquantified.length > 0 ? { unquantifiedFlows: unquantified.length } : {}) },
    { flowIds: [...new Set([...flowIds, ...unquantified])] },
    rows,
  );
}

/* ── Candidate bottlenecks ── */

export interface BottleneckCandidate {
  entityId: string;
  name: string;
  kind: string;
  /**
   * 0..1 — explicitly a CANDIDATE score, not validated constraint risk.
   * Null = REFUSED: unquantifiable flows touch this node, so throughput
   * share, utilization and redundancy would all be computed against numbers
   * known to be wrong in a known direction. A refused candidate sorts FIRST —
   * the researcher must see the refusal, not a plausible ranking without it.
   */
  score: number | null;
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

    const refused = t.unquantifiedFlowIds.length > 0;
    const explanation: string[] = [];
    if (refused) {
      explanation.push(`SCORE REFUSED: ${t.unquantifiedFlowIds.length} flow(s) at this node (${t.unquantifiedFlowIds.join(', ')}) declare gross weight with no corridor grade (or an unconvertible unit) — shares and redundancy would be computed against a total known to be wrong. Supply a mirror-implied corridor grade or a cu_content declaration.`);
      explanation.push(`Quantified lower bound: ${Math.round(through)} kt/y.`);
    } else {
      explanation.push(`${Math.round(through)} kt/y passes through (${Math.round(throughputShare * 100)}% of network max)`);
      if (utilization !== null) explanation.push(`utilization ≈ ${Math.round(utilization * 100)}% of stated capacity`);
      else explanation.push('no stated capacity — flow pressure used as proxy');
      explanation.push(alternatives === 0 ? 'no modeled alternative at this stage' : `${alternatives} modeled alternative(s) at this stage`);
      if (deps.length > 0) explanation.push(`${deps.length} entity(ies) explicitly depend on it`);
    }

    t.flowIds.forEach(id => allFlowIds.add(id));
    t.unquantifiedFlowIds.forEach(id => allFlowIds.add(id));
    caps.forEach(c => allCapIds.add(c.id));
    deps.forEach(d => allDepIds.add(d.id));

    candidates.push({
      entityId, name: ent.name, kind: ent.kind,
      score: refused ? null : Math.min(1, score),
      components: { throughputShare, utilization, redundancy, dependencyLoad },
      explanation,
      flowIds: [...t.flowIds, ...t.unquantifiedFlowIds],
      capacityIds: caps.map(c => c.id),
      dependencyIds: deps.map(d => d.id),
    });
  }

  // Refusals first — the researcher must see them — then by score.
  candidates.sort((a, b) =>
    Number(b.score === null) - Number(a.score === null)
    || (b.score ?? 0) - (a.score ?? 0));
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
  /** What kind of thing moved — the UI partitions physical signals from
   *  market context (positioning is reflexive: a corroborating layer, not
   *  physical evidence). */
  measurementClass: MeasurementClass;
  /**
   * rolling-deviation / rate-of-change say the WORLD moved. 'revision' says
   * the world's best estimate moved: a supersedes chain where the revising
   * value differs materially from the superseded one. A revision is news on
   * a known date (knownAt of the revising vintage) regardless of how old the
   * period it describes is — and it is an explicit act by the publisher,
   * not an inference from noise.
   */
  kind: 'rolling-deviation' | 'rate-of-change' | 'revision';
  period: string;
  value: number;
  /** Standard deviations from the rolling mean, or period-over-period %Δ. */
  magnitude: number;
  observationIds: string[];
  explanation: string;
}

/**
 * Extract an ordered time series for one entity+metric from observations.
 * Multiple providers can cover the same period (curated + live): each period
 * resolves to its hardest evidence via the same ranking observationsAt uses.
 * Without this, provider disagreement would masquerade as period-over-period
 * change and fabricate anomaly signals.
 */
/** Period-length class of an observation. A series is a sequence of
 *  SAME-CADENCE measurements: a daily stock point and a monthly stock point
 *  are different measurements of different things, and treating one as the
 *  successor of the other fabricates period-over-period change — the same
 *  splice class that once produced 10.3σ from provider duplicates. */
export function periodCadence(o: Observation): 'daily' | 'weekly' | 'monthly' | 'annual' {
  const days = (Date.parse(o.period.end) - Date.parse(o.period.start)) / 86_400_000;
  if (days <= 2) return 'daily';
  if (days <= 9) return 'weekly';
  if (days <= 45) return 'monthly';
  return 'annual';
}

export function extractSeries(state: EconomyState, entityId: string, metric: Metric, cadence?: ReturnType<typeof periodCadence>): SeriesPoint[] {
  const byPeriod = new Map<string, Observation>();
  for (const o of state.observations) {
    if (o.entityId !== entityId || o.metric !== metric) continue;
    if (o.partnerEntityId) continue; // bilateral mirror evidence, not an aggregate series
    if (cadence && periodCadence(o) !== cadence) continue;
    const key = `${o.period.start}|${o.period.end}`;
    const prev = byPeriod.get(key);
    if (!prev || outranks(o, prev)) byPeriod.set(key, o);
  }
  return [...byPeriod.values()]
    .sort((a, b) => a.period.start.localeCompare(b.period.start))
    .map(o => ({ period: o.period.start.slice(0, 7), value: o.value, observationId: o.id }));
}

/**
 * Interpretable anomaly pass over every (entity, metric) series with ≥6
 * points: rolling z-score against the trailing window, and month-over-month
 * rate of change. No ML — a researcher can recompute either by hand.
 */
export function detectAnomalies(state: EconomyState, { window = 6, zThreshold = 2, rocThreshold = 0.12, revisionThreshold = 0.05 } = {}): AnalyticalResult<AnomalySignal[]> {
  const seriesKeys = new Set<string>();
  for (const o of state.observations) seriesKeys.add(`${o.entityId}|${o.metric}`);

  const signals: AnomalySignal[] = [];
  const usedObs = new Set<string>();

  // Revision pass: supersedes chains where the best estimate moved
  // materially. The signal's date of existence is the REVISING value's
  // knownAt — current news, however old the described period — which is why
  // this channel survives cadence gating that annual level-signals fail.
  const obsById = new Map(state.observations.map(o => [o.id, o]));
  for (const o of state.observations) {
    if (!o.supersedes) continue;
    const prev = obsById.get(o.supersedes);
    if (!prev || prev.value === 0) continue;
    const delta = (o.value - prev.value) / Math.abs(prev.value);
    if (Math.abs(delta) < revisionThreshold) continue;
    usedObs.add(prev.id); usedObs.add(o.id);
    signals.push({
      entityId: o.entityId, metric: o.metric, measurementClass: measurementClassOf(o.metric),
      kind: 'revision', period: o.period.start.slice(0, 7), value: o.value,
      magnitude: Number((delta * 100).toFixed(1)),
      observationIds: [prev.id, o.id],
      explanation: `${o.provenance.sourceId} revises ${o.period.start.slice(0, 4)} ${o.metric}: ${prev.value} → ${o.value} (${(delta * 100).toFixed(1)}%). Best estimate moved — knowable ${knownAtOf(o)}.`,
    });
  }

  for (const baseKey of seriesKeys) {
    const [entityId, metric] = baseKey.split('|') as [string, Metric];
    // The continuous front-month price series carries roll discontinuities —
    // contract-expiry artifacts, not market moves. Until roll-adjusted, it is
    // excluded from anomaly detection rather than allowed to flag rolls.
    if (measurementClassOf(metric) === 'market_price') continue;
    // One (entity, metric) can carry several cadences (daily live stocks
    // alongside a monthly curated series). Each cadence is its own series —
    // mixing them would fabricate period-over-period change at the seams.
    const cadences = new Set(
      state.observations
        .filter(o => o.entityId === entityId && o.metric === metric && !o.partnerEntityId)
        .map(o => periodCadence(o)));
    for (const cadence of cadences) {
    // Length is judged on the RESOLVED series — raw observation counts would
    // let same-period provider duplicates fake a longer history.
    const series = extractSeries(state, entityId, metric, cadence);
    if (series.length < window) continue;

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
            entityId, metric, measurementClass: measurementClassOf(metric),
            kind: 'rolling-deviation', period: point.period, value: point.value,
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
            entityId, metric, measurementClass: measurementClassOf(metric),
            kind: 'rate-of-change', period: point.period, value: point.value,
            magnitude: Number((roc * 100).toFixed(1)),
            observationIds: [prev.observationId, point.observationId],
            explanation: `${point.period}: ${(roc * 100).toFixed(1)}% change vs ${prev.period} (${prev.value} → ${point.value})`,
          });
        }
      }
    }
    }
  }

  signals.sort((a, b) => Math.abs(b.magnitude) - Math.abs(a.magnitude));
  return wrap('detectAnomalies', { window, zThreshold, rocThreshold }, { observationIds: [...usedObs] }, signals);
}
