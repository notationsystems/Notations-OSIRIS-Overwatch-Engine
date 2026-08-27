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

export interface BasisConversion {
  /** Corridor-implied Cu mass fraction applied to the gross quantity. */
  grade: number;
  /** kt/y range across the concentrate grade uncertainty band. */
  ktRange: [number, number];
  /** Mirror observation ids the grade was implied from. */
  derivedFrom: [string, string];
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
}

export function buildGraph(state: EconomyState): EconomyGraph {
  const nodes = new Map<string, Entity>();
  for (const e of state.entities) nodes.set(e.id, e);

  // Basis handling: a gross-weight flow must never enter throughput at face
  // value (mixed bases skew inbound shares toward the fat-basis supplier) —
  // but it must not enter as zero either, which claims the flow carries
  // nothing and inverts supplier counts and redundancy. Convert where the
  // mirror system has implied a corridor grade; refuse visibly where not.
  const corridorGrades = impliedCorridorGrades(state);

  const edges: GraphEdge[] = [];
  for (const f of state.flows) {
    const raw = toKtPerYear(f.quantity, f.unit);
    let ktPerYear: number | null = raw;
    let basisConversion: BasisConversion | undefined;
    let basisUnresolved: true | undefined;
    if (f.basis === 'gross_weight') {
      const g = corridorGrades.get(`${f.fromEntityId}|${f.toEntityId}`);
      if (g && raw !== null) {
        ktPerYear = raw * g.grade;
        basisConversion = { grade: g.grade, ktRange: [raw * g.band[0], raw * g.band[1]], derivedFrom: g.derivedFrom };
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
    // Shareholder operated_by edges are economic interest — a claim on
    // output, not a lever over operations. Disruption does not propagate
    // through a shareholding, so only operator-of-record edges traverse:
    // a Rio Tinto event must not reach Escondida via its 30%.
    if (d.type === 'operated_by' && d.role !== 'operator') continue;
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

  return { nodes, edges, out, in: inn };
}

export interface TraversalStep {
  entityId: string;
  depth: number;
  /** Edge that reached this node from the previous ring. */
  viaEdgeId: string;
  viaKind: GraphEdge['kind'];
}

/**
 * Upstream = walk flow edges backwards (who ships material toward `entityId`)
 * and dependency edges forwards (what `entityId` depends_on). Both answer
 * "what does this node's operation rest on".
 */
export function upstream(graph: EconomyGraph, entityId: string, maxDepth = 6): TraversalStep[] {
  return walk(graph, entityId, maxDepth, node => [
    ...(graph.in.get(node) ?? []).filter(e => e.kind === 'flow').map(e => ({ next: e.from, edge: e })),
    ...(graph.out.get(node) ?? []).filter(e => e.kind === 'dependency').map(e => ({ next: e.to, edge: e })),
  ]);
}

/** Downstream = who receives material from here / who depends on this node. */
export function downstream(graph: EconomyGraph, entityId: string, maxDepth = 6): TraversalStep[] {
  return walk(graph, entityId, maxDepth, node => [
    ...(graph.out.get(node) ?? []).filter(e => e.kind === 'flow').map(e => ({ next: e.to, edge: e })),
    ...(graph.in.get(node) ?? []).filter(e => e.kind === 'dependency').map(e => ({ next: e.from, edge: e })),
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
