/**
 * OSIRIS — Flow / dependency graph over the canonical economy state.
 *
 * Nodes are entities; edges are material flows (directional, quantified) and
 * typed dependencies. Traversal answers "what feeds this?" (upstream) and
 * "what does this feed?" (downstream) with cycle-safe breadth-first walks.
 */

import type { Dependency, EconomyState, Entity, Flow } from './types';
import { toKtPerYear } from './types';

export interface FlowEdge {
  kind: 'flow';
  id: string;
  from: string;
  to: string;
  /** kt Cu/y where convertible, else null (edge kept, quantity unknown). */
  ktPerYear: number | null;
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

  const edges: GraphEdge[] = [];
  for (const f of state.flows) {
    edges.push({ kind: 'flow', id: f.id, from: f.fromEntityId, to: f.toEntityId, ktPerYear: toKtPerYear(f.quantity, f.unit), flow: f });
  }
  for (const d of state.dependencies) {
    // located_in is geography, not material structure — keep it out of the
    // traversal graph so "upstream of Escondida" never returns "Chile".
    if (d.type === 'located_in') continue;
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

/** Total material throughput (in + out, kt/y) per node — flow edges only. */
export function nodeThroughput(graph: EconomyGraph): Map<string, { inKt: number; outKt: number; flowIds: string[] }> {
  const acc = new Map<string, { inKt: number; outKt: number; flowIds: string[] }>();
  const get = (id: string) => {
    if (!acc.has(id)) acc.set(id, { inKt: 0, outKt: 0, flowIds: [] });
    return acc.get(id)!;
  };
  for (const edge of graph.edges) {
    if (edge.kind !== 'flow' || edge.ktPerYear === null) continue;
    const from = get(edge.from); from.outKt += edge.ktPerYear; from.flowIds.push(edge.id);
    const to = get(edge.to); to.inKt += edge.ktPerYear; to.flowIds.push(edge.id);
  }
  return acc;
}
