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
import type { EconomyGraph } from './graph';
import { downstream, nodeThroughput } from './graph';

export interface EventImpact {
  eventId: string;
  eventTitle: string;
  eventType: EconEvent['type'];
  severity: EconEvent['severity'];
  /** Whether the event window covers `asOf` (state-changing now) or is historical context. */
  active: boolean;
  entityId: string;
  entityName: string;
  /** kt/y of material the entity carries in the flow graph (max of in/out). */
  disruptedKtPerYear: number;
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

export const DISRUPTIVE_EVENT_TYPES: EconEvent['type'][] = ['outage', 'strike', 'closure', 'disruption', 'weather'];
const DISRUPTIVE = DISRUPTIVE_EVENT_TYPES;

/** Whether an event's window covers the evaluation date. */
export function isEventActive(ev: EconEvent, asOf: string): boolean {
  return ev.start <= asOf && (!ev.end || ev.end >= asOf);
}

export function propagateEvents(
  state: EconomyState,
  graph: EconomyGraph,
  { asOf = new Date().toISOString().slice(0, 10), maxDepth = 4 } = {},
): AnalyticalResult<EventImpact[]> {
  const throughput = nodeThroughput(graph);

  const impacts: EventImpact[] = [];
  for (const ev of state.events) {
    if (!ev.entityId || !DISRUPTIVE.includes(ev.type)) continue;
    const entity = graph.nodes.get(ev.entityId);
    if (!entity) continue;

    const active = isEventActive(ev, asOf);
    const t = throughput.get(ev.entityId);
    const disrupted = t ? Math.max(t.inKt, t.outKt) : 0;

    const affected = downstream(graph, ev.entityId, maxDepth).map(s => {
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
    const explanation: string[] = [];
    explanation.push(active ? 'Event window covers the evaluation date — treated as a live state change.' : 'Event window closed — shown as structural context.');
    if (disrupted > 0) explanation.push(`~${Math.round(disrupted)} kt/y of material moves through ${entity.name} in the modeled graph.`);
    else explanation.push(`${entity.name} carries no modeled flow — impact is structural (capacity/dependency), not flow interruption.`);
    explanation.push(affected.length > 0 ? `${affected.length} downstream entity(ies) within ${maxDepth} hops.` : 'No modeled downstream entities.');
    if (disrupted > 0) {
      explanation.push(totalSpare >= disrupted
        ? `Stated spare capacity at peers (~${totalSpare} kt/y) could nominally absorb the loss.`
        : `Stated spare capacity at peers (~${totalSpare} kt/y) does NOT cover the disrupted volume — constraint candidate.`);
    }
    for (const d of dependents) {
      explanation.push(`${d.name} declares dependency on this node${d.strength !== null ? ` (strength ${d.strength})` : ''}.`);
    }

    impacts.push({
      eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
      entityId: ev.entityId, entityName: entity.name,
      disruptedKtPerYear: Math.round(disrupted),
      affected, alternatives, dependents,
      flowIds: t?.flowIds ?? [],
      capacityIds: altCapacityIds,
      dependencyIds: deps.map(d => d.id),
      explanation,
    });
  }

  // Live, severe, large first.
  const sevRank = { high: 2, medium: 1, low: 0 } as const;
  impacts.sort((a, b) =>
    Number(b.active) - Number(a.active) ||
    sevRank[b.severity] - sevRank[a.severity] ||
    b.disruptedKtPerYear - a.disruptedKtPerYear);

  return {
    operation: { name: 'propagateEvents', params: { asOf, maxDepth } },
    execution: { executedAt: new Date().toISOString(), engine: 'osiris-economy-engine/0.1' },
    inputs: {
      flowIds: [...new Set(impacts.flatMap(i => i.flowIds))],
      capacityIds: [...new Set(impacts.flatMap(i => i.capacityIds))],
      entityIds: impacts.map(i => i.entityId),
    },
    result: impacts,
  };
}
