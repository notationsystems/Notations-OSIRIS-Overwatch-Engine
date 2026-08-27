/**
 * OSIRIS — Event propagation system.
 *
 * The engine loop the platform is built around:
 *
 *   event arrives → entity state changes → consequences propagate through
 *   the flow graph → analytics evaluate exposure → projections re-render.
 *
 * For each disruptive event this system evaluates, from canonical state:
 *   - the flows the entity carries (what physically stops moving)
 *   - downstream entities within reach of the loss (who feels it)
 *   - alternative capacity at the same stage (who could absorb it)
 *   - explicit dependents (who has no alternative by construction)
 *
 * Everything is traceable: each impact names the event, flow, capacity and
 * dependency ids it was derived from. This is structural exposure, not a
 * forecast — it says where a loss lands, not how prices react.
 */

import type { AnalyticalResult, EconEvent, EconomyState } from './types';
import type { EconomyGraph, EdgeFilter } from './graph';
import { downstream, nodeThroughput, OPERATIONAL_EDGE_FILTER } from './graph';

export interface EventImpact {
  eventId: string;
  eventTitle: string;
  eventType: EconEvent['type'];
  severity: EconEvent['severity'];
  /** Whether the event window covers `asOf` (state-changing now) or is historical context. */
  active: boolean;
  entityId: string;
  entityName: string;
  /** kt/y of material the entity carries in the flow graph (max of in/out).
   *  null when the figure cannot be stated: the evaluation date predates the
   *  flow topology's period (a 2017 event against 2024 flows — the topology
   *  describes a world that did not yet exist), or a regulatory event has no
   *  scope. "No entity in scope" is 0; "cannot answer at this date" is null —
   *  the two must never render alike. */
  disruptedKtPerYear: number | null;
  /** Downstream entities within the propagation walk. */
  affected: Array<{ entityId: string; name: string; kind: string; depth: number }>;
  /** Same-kind, same-stage entities with stated spare capacity. */
  alternatives: Array<{ entityId: string; name: string; spareKtPerYear: number }>;
  /** Entities declaring depends_on this node, with strength. */
  dependents: Array<{ entityId: string; name: string; strength: number | null }>;
  /** Evidence identity. */
  flowIds: string[];
  capacityIds: string[];
  dependencyIds: string[];
  explanation: string[];
}

export const DISRUPTIVE_EVENT_TYPES: EconEvent['type'][] = ['outage', 'strike', 'closure', 'disruption', 'weather', 'sanction', 'insolvency', 'policy'];
const DISRUPTIVE = DISRUPTIVE_EVENT_TYPES;

/**
 * What KIND of lever an event pulls — which decides the edges it may
 * traverse. The role split (operator/shareholder) is the mechanism; the
 * event class says which roles it travels along:
 *
 *   operational   strike, accident, outage, weather — control over the
 *                 workforce and the plant: OPERATOR edges only.
 *   financial     sanction, insolvency — attaches to OWNERS, not managers:
 *                 operator AND shareholder edges. Grasberg is the case:
 *                 Freeport-operated, majority state-held — a state-holding
 *                 sanction reaches it through the 51% no operational event
 *                 could use.
 *   regulatory    policy — attaches to TERRITORY: neither attribution role
 *                 carries it; it propagates by jurisdiction + scope instead
 *                 (regulatoryImpact below), and without a scope is refused.
 */
export function eventClassOf(type: EconEvent['type']): 'operational' | 'financial' | 'regulatory' {
  switch (type) {
    case 'sanction':
    case 'insolvency':
      return 'financial';
    case 'policy':
      return 'regulatory';
    default:
      return 'operational';
  }
}

/** The class-derived edge filter — the window is the event's own structure,
 *  never a choice made at the call site. */
export function traversableEdgeFilter(type: EconEvent['type']): EdgeFilter {
  if (eventClassOf(type) === 'financial') {
    // Owners and managers both: every operated_by edge traverses.
    return () => true;
  }
  return OPERATIONAL_EDGE_FILTER;
}

/** Whether an event's window covers the evaluation date. */
export function isEventActive(ev: EconEvent, asOf: string): boolean {
  return ev.start <= asOf && (!ev.end || ev.end >= asOf);
}

/**
 * Whether the flow topology can describe the world at the evaluation date.
 *
 * asOf filters what was KNOWN; the flow records claim what WAS — and only one
 * vintage of that claim exists. The statuses follow the same selection rule
 * as every other quantity ("latest claim at or before asOf"):
 *
 *   within        asOf inside the union of flow periods.
 *   extrapolated  asOf after the period: the snapshot is the latest-known
 *                 structure and serves, labeled — the standard latest-
 *                 observation-forward convention, not a silent guess.
 *   predates      asOf BEFORE any flow period: no admissible vintage exists
 *                 and the world demonstrably differed (2017 export routes
 *                 are not 2024's). Flow-derived quantities are null, never
 *                 zero — "no entity in scope" is an answer, "topology out of
 *                 period" is not, and the two must not render alike.
 *
 * The structural fix is flow VINTAGES (several periods coexisting, asOf
 * selecting among them — the MCS-vintage shape); until then this guard makes
 * the mismatch an enforced invariant instead of a documented special case.
 */
export interface TopologyValidity {
  /** Union of flow periods in the state; null when no flows are modeled. */
  topologyPeriod: { start: string; end: string } | null;
  evaluatedAt: string;
  status: 'within' | 'extrapolated' | 'predates';
  /** Days between the topology period's end and the evaluation date —
   *  extrapolation QUANTIFIED, not just flagged: against a fixed snapshot
   *  the status is permanently 'extrapolated' for live evaluations, so the
   *  distance is the number that actually moves (and the number the
   *  extrapolation-bound guard watches). Present only when extrapolated. */
  extrapolationDays?: number;
  /** Human-readable statement of the mismatch; absent when within. */
  note?: string;
}

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);

export function topologyValidity(state: EconomyState, asOf: string): TopologyValidity {
  if (state.flows.length === 0) {
    return { topologyPeriod: null, evaluatedAt: asOf, status: 'within' };
  }
  let start = state.flows[0].period.start;
  let end = state.flows[0].period.end;
  for (const f of state.flows) {
    if (f.period.start < start) start = f.period.start;
    if (f.period.end > end) end = f.period.end;
  }
  const status = asOf < start ? 'predates' : asOf > end ? 'extrapolated' : 'within';
  return {
    topologyPeriod: { start, end },
    evaluatedAt: asOf,
    status,
    ...(status === 'predates'
      ? { note: `Flow topology describes ${start}–${end}; a ${asOf} evaluation predates it. Flow-derived tonnage is null (unknown), not zero; reach shown is structural only. Flow vintages are the recorded fix.` }
      : status === 'extrapolated'
        ? {
            extrapolationDays: daysBetween(end, asOf),
            note: `Flow topology describes ${start}–${end}; the ${asOf} evaluation uses it as latest-known structure, ${daysBetween(end, asOf)} days past the period.`,
          }
        : {}),
  };
}

/**
 * Regulatory propagation: territory + scope, not attribution edges.
 *
 *   direction 'export'  the sharp shape — CROSSING flows stop while
 *                       production continues: foreign receivers of
 *                       in-jurisdiction flows lose supply (and their
 *                       downstream with them); domestic receivers keep it.
 *   direction 'all'     in-scope entities halt: they and everything
 *                       downstream of them are affected.
 *
 * A regulatory event without a scope is REFUSED (no jurisdiction to reach
 * through), never guessed from its entity.
 */
function regulatoryImpact(
  state: EconomyState,
  graph: EconomyGraph,
  ev: EconEvent,
  entityName: string,
  asOf: string,
  maxDepth: number,
  validity: TopologyValidity,
): EventImpact {
  const active = isEventActive(ev, asOf);
  const scope = ev.regulatoryScope;
  const explanation: string[] = [
    active ? 'Event window covers the evaluation date — treated as a live state change.' : 'Event window closed — shown as structural context.',
  ];

  if (!scope) {
    explanation.push('REGULATORY EVENT WITHOUT A SCOPE: jurisdiction unknown — propagation refused rather than guessed. Curate regulatoryScope to give it reach.');
    return {
      eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
      entityId: ev.entityId!, entityName,
      // Refused, not answered: null, never a zero a reader could take as "no effect".
      disruptedKtPerYear: null, affected: [], alternatives: [], dependents: [],
      flowIds: [], capacityIds: [], dependencyIds: [], explanation,
    };
  }

  const inScope = (id: string): boolean => {
    const e = graph.nodes.get(id);
    if (!e) return false;
    if (e.countryCode !== scope.jurisdictionCountryCode) return false;
    if (scope.stages && (!e.stage || !scope.stages.includes(e.stage))) return false;
    if (scope.commodity && e.commodity && e.commodity !== scope.commodity) return false;
    return true;
  };

  const affectedMap = new Map<string, { entityId: string; name: string; kind: string; depth: number }>();
  const addAffected = (id: string, depth: number) => {
    const e = graph.nodes.get(id);
    if (!e) return;
    const prev = affectedMap.get(id);
    if (!prev || depth < prev.depth) affectedMap.set(id, { entityId: id, name: e.name, kind: e.kind, depth });
  };
  const flowIds: string[] = [];
  let disrupted = 0;
  // Predating evaluation: the flow walk still yields structural reach, but
  // its tonnage describes the topology's period, not asOf's world.
  const predates = validity.status === 'predates';
  const ktText = (n: number) => predates ? 'tonnage null — topology out of period' : `~${Math.round(n)} kt/y`;

  if (scope.direction === 'export') {
    // Crossing flows halt; production does not. Foreign receivers and their
    // downstream feel it; domestic receivers are spared.
    for (const edge of graph.edges) {
      if (edge.kind !== 'flow') continue;
      const from = graph.nodes.get(edge.from);
      const to = graph.nodes.get(edge.to);
      if (!from || !to || !inScope(edge.from)) continue;
      if (to.countryCode === scope.jurisdictionCountryCode) continue; // domestic — spared
      if (scope.commodity && edge.flow.commodity !== scope.commodity) continue;
      flowIds.push(edge.id);
      disrupted += edge.ktPerYear ?? 0;
      addAffected(edge.from, 1); // the blocked exporter
      addAffected(edge.to, 1);   // the foreign receiver
      for (const step of downstream(graph, edge.to, maxDepth - 1)) addAffected(step.entityId, step.depth + 1);
    }
    explanation.push(`Export halt in ${scope.jurisdictionCountryCode}: ${flowIds.length} crossing flow(s) (${ktText(disrupted)}) stop while production continues — domestic receivers keep supply, foreign receivers and their downstream lose it.`);
  } else {
    // All in-scope activity halts: in-scope entities and their downstream.
    for (const [id] of graph.nodes) {
      if (!inScope(id)) continue;
      addAffected(id, 0);
      for (const edge of graph.out.get(id) ?? []) {
        if (edge.kind !== 'flow') continue;
        flowIds.push(edge.id);
        disrupted += edge.ktPerYear ?? 0;
      }
      for (const step of downstream(graph, id, maxDepth)) addAffected(step.entityId, step.depth);
    }
    explanation.push(`Jurisdiction-wide halt in ${scope.jurisdictionCountryCode}${scope.stages ? ` (${scope.stages.join(', ')})` : ''}: ${affectedMap.size} entity(ies) in scope or downstream; ${ktText(disrupted)} of outbound flow interrupted.`);
  }
  if (validity.note) explanation.push(validity.note);

  return {
    eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
    entityId: ev.entityId!, entityName,
    disruptedKtPerYear: predates ? null : Math.round(disrupted),
    affected: [...affectedMap.values()].sort((a, b) => a.depth - b.depth),
    alternatives: [], dependents: [],
    flowIds: [...new Set(flowIds)],
    capacityIds: [], dependencyIds: [],
    explanation,
  };
}

export function propagateEvents(
  state: EconomyState,
  graph: EconomyGraph,
  { asOf = new Date().toISOString().slice(0, 10), maxDepth = 4 } = {},
): AnalyticalResult<EventImpact[]> {
  const throughput = nodeThroughput(graph);
  // asOf filters what was KNOWN; the flow topology claims what WAS, and only
  // one vintage of it exists. Evaluate the mismatch once for the whole pass.
  const validity = topologyValidity(state, asOf);
  const predates = validity.status === 'predates';

  const impacts: EventImpact[] = [];
  for (const ev of state.events) {
    if (!ev.entityId || !DISRUPTIVE.includes(ev.type)) continue;
    const entity = graph.nodes.get(ev.entityId);
    if (!entity) continue;

    // Regulatory events attach to territory: a distinct propagation shape,
    // scoped by what the regulation governs — never the entity walk.
    if (eventClassOf(ev.type) === 'regulatory') {
      impacts.push(regulatoryImpact(state, graph, ev, entity.name, asOf, maxDepth, validity));
      continue;
    }

    const active = isEventActive(ev, asOf);
    const t = throughput.get(ev.entityId);
    const disrupted = t ? Math.max(t.inKt, t.outKt) : 0;

    const affected = downstream(graph, ev.entityId, maxDepth, traversableEdgeFilter(ev.type)).map(s => {
      const e = graph.nodes.get(s.entityId);
      return { entityId: s.entityId, name: e?.name ?? s.entityId, kind: e?.kind ?? 'unknown', depth: s.depth };
    });

    // Spare capacity among peers: same kind + stage, capacity minus carried flow.
    const alternatives: EventImpact['alternatives'] = [];
    const altCapacityIds: string[] = [];
    for (const [otherId, other] of graph.nodes) {
      if (otherId === ev.entityId || other.kind !== entity.kind || other.stage !== entity.stage) continue;
      const caps = state.capacities.filter(c => c.entityId === otherId);
      if (caps.length === 0) continue;
      const capKt = caps.reduce((s, c) => s + c.value, 0);
      const ot = throughput.get(otherId);
      const used = ot ? Math.max(ot.inKt, ot.outKt) : 0;
      const spare = capKt - used;
      if (spare > 0) {
        alternatives.push({ entityId: otherId, name: other.name, spareKtPerYear: Math.round(spare) });
        caps.forEach(c => altCapacityIds.push(c.id));
      }
    }
    alternatives.sort((a, b) => b.spareKtPerYear - a.spareKtPerYear);

    const deps = state.dependencies.filter(d => d.type === 'depends_on' && d.toEntityId === ev.entityId);
    const dependents = deps.map(d => ({
      entityId: d.fromEntityId,
      name: graph.nodes.get(d.fromEntityId)?.name ?? d.fromEntityId,
      strength: d.strength ?? null,
    }));

    const totalSpare = alternatives.reduce((s, a) => s + a.spareKtPerYear, 0);
    const unquantified = t?.unquantifiedFlowIds ?? [];
    const explanation: string[] = [];
    explanation.push(active ? 'Event window covers the evaluation date — treated as a live state change.' : 'Event window closed — shown as structural context.');
    if (predates) {
      // The flow walk yields structural reach; its tonnage describes the
      // topology's period, not asOf's world — the figure cannot be stated.
      explanation.push(validity.note!);
    } else if (disrupted > 0) explanation.push(`~${Math.round(disrupted)} kt/y of material moves through ${entity.name} in the modeled graph.`);
    else if (unquantified.length > 0) explanation.push(`${entity.name} carries ${unquantified.length} flow(s) whose tonnage is REFUSED (gross-weight basis with no corridor grade) — disrupted tonnage is unknown, not zero; impact below is structural reach only.`);
    else explanation.push(`${entity.name} carries no modeled flow — impact is structural (capacity/dependency), not flow interruption.`);
    if (!predates && disrupted > 0 && unquantified.length > 0) explanation.push(`${unquantified.length} additional flow(s) at this node could not be quantified — the disrupted tonnage is a lower bound.`);
    explanation.push(affected.length > 0 ? `${affected.length} downstream entity(ies) within ${maxDepth} hops.` : 'No modeled downstream entities.');
    if (!predates && disrupted > 0) {
      explanation.push(totalSpare >= disrupted
        ? `Stated spare capacity at peers (~${totalSpare} kt/y) could nominally absorb the loss.`
        : `Stated spare capacity at peers (~${totalSpare} kt/y) does NOT cover the disrupted volume — constraint candidate.`);
    }
    if (!predates && validity.note) explanation.push(validity.note);
    for (const d of dependents) {
      explanation.push(`${d.name} declares dependency on this node${d.strength !== null ? ` (strength ${d.strength})` : ''}.`);
    }

    impacts.push({
      eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
      entityId: ev.entityId, entityName: entity.name,
      disruptedKtPerYear: predates ? null : Math.round(disrupted),
      affected, alternatives, dependents,
      flowIds: [...(t?.flowIds ?? []), ...unquantified],
      capacityIds: altCapacityIds,
      dependencyIds: deps.map(d => d.id),
      explanation,
    });
  }

  // Live, severe, large first; a null figure ("cannot state") sorts below
  // any stated figure, zero included — unknown never outranks known.
  const sevRank = { high: 2, medium: 1, low: 0 } as const;
  impacts.sort((a, b) =>
    Number(b.active) - Number(a.active) ||
    sevRank[b.severity] - sevRank[a.severity] ||
    (b.disruptedKtPerYear ?? -1) - (a.disruptedKtPerYear ?? -1));

  return {
    operation: {
      name: 'propagateEvents',
      params: {
        asOf, maxDepth,
        topologyStatus: validity.status,
        topologyPeriod: validity.topologyPeriod ? `${validity.topologyPeriod.start}..${validity.topologyPeriod.end}` : undefined,
      },
    },
    execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
    inputs: {
      flowIds: [...new Set(impacts.flatMap(i => i.flowIds))],
      capacityIds: [...new Set(impacts.flatMap(i => i.capacityIds))],
      entityIds: impacts.map(i => i.entityId),
    },
    result: impacts,
  };
}
