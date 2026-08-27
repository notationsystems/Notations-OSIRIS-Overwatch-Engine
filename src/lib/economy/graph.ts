/**
 * OSIRIS — Flow / dependency graph over the canonical economy state.
 *
 * Nodes are entities; edges are material flows (directional, quantified) and
 * typed dependencies. Traversal answers "what feeds this?" (upstream) and
 * "what does this feed?" (downstream) with cycle-safe breadth-first walks.
 */

import type { Dependency, EconomyState, Entity, Flow } from './types';
import { toKtPerYear } from './types';
import { impliedCorridorGrades } from './basis';
import { formConversionFor } from './stageConversion';

export interface BasisConversion {
  /** Contained-metal mass fraction applied to the gross quantity. */
  grade: number;
  /** kt/y range across the conversion's uncertainty band. */
  ktRange: [number, number];
  /** Mirror observation ids — present when a corridor grade converted the
   *  edge (copper concentrate: per-corridor, mirror-implied). */
  derivedFrom?: [string, string];
  /** Documented form-level constant's provenance — present when a stage
   *  conversion converted the edge (work order 3.5: bauxite/alumina).
   *  Exactly one of derivedFrom/source is set. */
  source?: string;
}

export interface FlowEdge {
  kind: 'flow';
  id: string;
  from: string;
  to: string;
  /** kt Cu/y where convertible (directly or via corridor grade), else null. */
  ktPerYear: number | null;
  /** Present when a gross-weight quantity was converted to Cu content. */
  basisConversion?: BasisConversion;
  /**
   * True when the flow declares gross weight and no corridor grade exists to
   * convert it. The edge stays in the graph (reachability is real) but its
   * tonnage is REFUSED, not zeroed: zero is a value — the claim that the
   * flow carries nothing — and consumers must surface the refusal instead of
   * silently dropping the supplier from shares and redundancy.
   */
  basisUnresolved?: boolean;
  flow: Flow;
}

export interface DependencyEdge {
  kind: 'dependency';
  id: string;
  /** Directed as "from depends_on/feeds/… to". */
  from: string;
  to: string;
  dependency: Dependency;
}

export type GraphEdge = FlowEdge | DependencyEdge;

export interface EconomyGraph {
  nodes: Map<string, Entity>;
  edges: GraphEdge[];
  /** Edges leaving a node (flow direction / dependency direction). */
  out: Map<string, GraphEdge[]>;
  /** Edges arriving at a node. */
  in: Map<string, GraphEdge[]>;
  /**
   * The topology this graph was built from. Every consumer that states a
   * flow-derived figure must classify its evaluation date against THIS
   * selection, never re-select from state — a graph built for one date
   * evaluated under another date's validity is how a facility tonnage gets
   * served under a country-vintage label (the incoherence work order 3.2's
   * wiring briefly created and this field exists to make impossible).
   */
  selection: TopologySelection;
}

/* ── Topology selection (work order 3.2) ──
 *
 * Two topologies can now coexist in one state: the facility-level snapshot
 * (2024) and country-level flow vintages (2017+, reporter-declared Comtrade
 * exports). They are DIFFERENT GRANULARITIES and never share a graph — a
 * country flow beside facility flows would double-count tonnage and let a
 * country-granularity result render as a facility one. Selection follows
 * the standard rule (latest claim at or before asOf):
 *
 *   asOf within/after the facility period  → facility flows only.
 *   asOf before it                         → the latest country vintage
 *                                            whose year ≤ asOf; none → an
 *                                            empty topology (predates).
 */
export interface TopologySelection {
  flows: Flow[];
  granularity: 'facility' | 'country';
  /** Union of the SELECTED flows' periods; null when nothing selected. */
  period: { start: string; end: string } | null;
  /** Earliest period start across ALL topology material — 'predates' fires
   *  only before this, not before the facility snapshot. */
  earliestStart: string | null;
  vintageYear?: string;
}

const isCountryFlow = (f: Flow) =>
  f.fromEntityId.startsWith('ent:country:') && f.toEntityId.startsWith('ent:country:');

function periodUnion(flows: Flow[]): { start: string; end: string } | null {
  if (flows.length === 0) return null;
  let start = flows[0].period.start, end = flows[0].period.end;
  for (const f of flows) {
    if (f.period.start < start) start = f.period.start;
    if (f.period.end > end) end = f.period.end;
  }
  return { start, end };
}

export function selectTopology(state: EconomyState, asOf?: string): TopologySelection {
  const evalDate = asOf ?? new Date().toISOString().slice(0, 10);
  const facility = state.flows.filter(f => !isCountryFlow(f));
  const vintages = state.flows.filter(isCountryFlow);
  const facilityPeriod = periodUnion(facility);
  const all = periodUnion(state.flows);
  const earliestStart = all?.start ?? null;
  if (facilityPeriod && evalDate >= facilityPeriod.start) {
    return { flows: facility, granularity: 'facility', period: facilityPeriod, earliestStart };
  }
  const years = [...new Set(vintages.map(f => f.period.start.slice(0, 4)))].sort();
  const year = [...years].reverse().find(y => y <= evalDate.slice(0, 4));
  if (!year) {
    // Nothing serves this date. Granularity names the material that WOULD
    // serve nearest ahead: with no vintages at all (aluminium today) the
    // only topology is the facility snapshot — labeling the empty selection
    // 'country' there would route facility events into the allocation
    // refusal, which names a model that has no vintage to allocate.
    return { flows: [], granularity: vintages.length > 0 ? 'country' : 'facility', period: null, earliestStart };
  }
  const selected = vintages.filter(f => f.period.start.slice(0, 4) === year);
  return { flows: selected, granularity: 'country', period: periodUnion(selected), earliestStart, vintageYear: year };
}

export function buildGraph(state: EconomyState, asOf?: string): EconomyGraph {
  const nodes = new Map<string, Entity>();
  for (const e of state.entities) nodes.set(e.id, e);
  const selection = selectTopology(state, asOf);

  // Basis handling: a gross-weight flow must never enter throughput at face
  // value (mixed bases skew inbound shares toward the fat-basis supplier) —
  // but it must not enter as zero either, which claims the flow carries
  // nothing and inverts supplier counts and redundancy. Convert where the
  // mirror system has implied a corridor grade; refuse visibly where not.
  const corridorGrades = impliedCorridorGrades(state);

  const edges: GraphEdge[] = [];
  for (const f of selection.flows) {
    const raw = toKtPerYear(f.quantity, f.unit);
    let ktPerYear: number | null = raw;
    let basisConversion: BasisConversion | undefined;
    let basisUnresolved: true | undefined;
    if (f.basis === 'gross_weight') {
      const g = corridorGrades.get(`${f.fromEntityId}|${f.toEntityId}`);
      // Most specific first: a mirror-implied corridor grade (per-corridor
      // measured variance). Then a documented FORM-level stage-conversion
      // constant keyed by (commodity, form) — the aluminium chain's path
      // (work order 3.5), which can never serve another commodity. Neither
      // → the tonnage refuses visibly.
      const fc = formConversionFor(f.commodity, f.form);
      if (g && raw !== null) {
        ktPerYear = raw * g.grade;
        basisConversion = { grade: g.grade, ktRange: [raw * g.band[0], raw * g.band[1]], derivedFrom: g.derivedFrom };
      } else if (fc && raw !== null) {
        ktPerYear = raw * fc.factor;
        basisConversion = { grade: fc.factor, ktRange: [raw * fc.band[0], raw * fc.band[1]], source: fc.source };
      } else {
        ktPerYear = null;
        basisUnresolved = true;
      }
    }
    edges.push({ kind: 'flow', id: f.id, from: f.fromEntityId, to: f.toEntityId, ktPerYear, basisConversion, basisUnresolved, flow: f });
  }
  for (const d of state.dependencies) {
    // located_in is geography, not material structure — keep it out of the
    // traversal graph so "upstream of Escondida" never returns "Chile".
    if (d.type === 'located_in') continue;
    // Shareholder operated_by edges stay IN the graph as structure, but
    // whether they TRAVERSE depends on the event class (see the default
    // edge filter below and propagation's traversableEdgeFilter): a strike
    // propagates through the operator, a sanction through the owners.
    edges.push({ kind: 'dependency', id: d.id, from: d.fromEntityId, to: d.toEntityId, dependency: d });
  }

  const out = new Map<string, GraphEdge[]>();
  const inn = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (!out.has(edge.from)) out.set(edge.from, []);
    out.get(edge.from)!.push(edge);
    if (!inn.has(edge.to)) inn.set(edge.to, []);
    inn.get(edge.to)!.push(edge);
  }

  return { nodes, edges, out, in: inn, selection };
}

export interface TraversalStep {
  entityId: string;
  depth: number;
  /** Edge that reached this node from the previous ring. */
  viaEdgeId: string;
  viaKind: GraphEdge['kind'];
}

/**
 * Which edges a traversal may cross. The default is the OPERATIONAL view:
 * shareholder operated_by edges are inert (a shareholding is a claim on
 * output, not a lever over operations — a Rio Tinto strike must not reach
 * Escondida through its 30%). Financial/legal event classes override this
 * via propagation's class-derived filter, because sanctions and insolvency
 * attach to owners, not managers.
 */
export type EdgeFilter = (edge: GraphEdge) => boolean;

export const OPERATIONAL_EDGE_FILTER: EdgeFilter = e =>
  !(e.kind === 'dependency' && e.dependency.type === 'operated_by' && e.dependency.role !== 'operator');

/**
 * Upstream = walk flow edges backwards (who ships material toward `entityId`)
 * and dependency edges forwards (what `entityId` depends_on). Both answer
 * "what does this node's operation rest on".
 */
export function upstream(graph: EconomyGraph, entityId: string, maxDepth = 6, edgeFilter: EdgeFilter = OPERATIONAL_EDGE_FILTER): TraversalStep[] {
  return walk(graph, entityId, maxDepth, node => [
    ...(graph.in.get(node) ?? []).filter(e => e.kind === 'flow').map(e => ({ next: e.from, edge: e })),
    ...(graph.out.get(node) ?? []).filter(e => e.kind === 'dependency' && edgeFilter(e)).map(e => ({ next: e.to, edge: e })),
  ]);
}

/** Downstream = who receives material from here / who depends on this node. */
export function downstream(graph: EconomyGraph, entityId: string, maxDepth = 6, edgeFilter: EdgeFilter = OPERATIONAL_EDGE_FILTER): TraversalStep[] {
  return walk(graph, entityId, maxDepth, node => [
    ...(graph.out.get(node) ?? []).filter(e => e.kind === 'flow').map(e => ({ next: e.to, edge: e })),
    ...(graph.in.get(node) ?? []).filter(e => e.kind === 'dependency' && edgeFilter(e)).map(e => ({ next: e.from, edge: e })),
  ]);
}

function walk(
  graph: EconomyGraph,
  start: string,
  maxDepth: number,
  neighbors: (node: string) => Array<{ next: string; edge: GraphEdge }>,
): TraversalStep[] {
  const visited = new Set<string>([start]);
  const result: TraversalStep[] = [];
  let ring = [start];
  for (let depth = 1; depth <= maxDepth && ring.length > 0; depth++) {
    const nextRing: string[] = [];
    for (const node of ring) {
      for (const { next, edge } of neighbors(node)) {
        if (visited.has(next)) continue;
        visited.add(next);
        result.push({ entityId: next, depth, viaEdgeId: edge.id, viaKind: edge.kind });
        nextRing.push(next);
      }
    }
    ring = nextRing;
  }
  return result;
}

export interface NodeThroughput {
  inKt: number;
  outKt: number;
  flowIds: string[];
  /**
   * Flow edges at this node whose tonnage could not be quantified (a
   * gross-weight basis with no corridor grade, or an unconvertible unit).
   * Non-empty means inKt/outKt are LOWER BOUNDS and any share computed from
   * them is unsafe — consumers must refuse shares for this node, visibly.
   */
  unquantifiedFlowIds: string[];
}

/** Total material throughput (in + out, kt/y) per node — flow edges only. */
export function nodeThroughput(graph: EconomyGraph): Map<string, NodeThroughput> {
  const acc = new Map<string, NodeThroughput>();
  const get = (id: string) => {
    if (!acc.has(id)) acc.set(id, { inKt: 0, outKt: 0, flowIds: [], unquantifiedFlowIds: [] });
    return acc.get(id)!;
  };
  for (const edge of graph.edges) {
    if (edge.kind !== 'flow') continue;
    if (edge.ktPerYear === null) {
      // A node reached only by unquantifiable flows must still EXIST here —
      // vanishing from the throughput map is how nodes went dark before.
      get(edge.from).unquantifiedFlowIds.push(edge.id);
      get(edge.to).unquantifiedFlowIds.push(edge.id);
      continue;
    }
    const from = get(edge.from); from.outKt += edge.ktPerYear; from.flowIds.push(edge.id);
    const to = get(edge.to); to.inKt += edge.ktPerYear; to.flowIds.push(edge.id);
  }
  return acc;
}
