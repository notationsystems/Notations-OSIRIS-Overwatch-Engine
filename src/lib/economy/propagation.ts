/**
 * Payload — Event propagation system.
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
import type { EconomyGraph, EdgeFilter, TopologySelection } from './graph';
import { downstream, nodeThroughput, selectTopology, OPERATIONAL_EDGE_FILTER } from './graph';

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
  /** Period of the SELECTED topology (facility snapshot, or the vintage
   *  serving asOf); null when nothing is selectable. */
  topologyPeriod: { start: string; end: string } | null;
  evaluatedAt: string;
  status: 'within' | 'extrapolated' | 'predates';
  /** Which topology serves this evaluation — a country-granularity result
   *  must never render indistinguishably from a facility one (work order
   *  3.2 hazard #3). */
  granularity: 'facility' | 'country';
  /** Set when a country flow vintage serves the evaluation. */
  vintageYear?: string;
  /** Days between the topology period's end and the evaluation date —
   *  extrapolation QUANTIFIED, not just flagged: against a fixed snapshot
   *  the status is permanently 'extrapolated' for live evaluations, so the
   *  distance is the number that actually moves (and the number the
   *  extrapolation-bound guard watches). Present only when extrapolated. */
  extrapolationDays?: number;
  /** First-hand evidence the structure has MOVED since the snapshot: curated
   *  structural events postdating the topology period (and occurred by
   *  asOf — no future leak). Elapsed time is a proxy for "something
   *  probably changed"; the event register holds the thing itself. Present
   *  only when extrapolated and non-empty. */
  structuralEvidence?: Array<{ id: string; title: string; start: string; type: EconEvent['type'] }>;
  /** Human-readable statement of the mismatch; absent when within. */
  note?: string;
}

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(toISO) - Date.parse(fromISO)) / 86_400_000);

/**
 * Events that are first-hand evidence of topology movement, when they
 * postdate the snapshot period: a closure or expansion changes what exists;
 * a scoped regulatory event rewires crossing flows; a sanction/insolvency
 * re-routes counterparties; an OPEN-ENDED high-severity disruption is the
 * force-majeure shape (a disruption with a curated end is transience — the
 * structure came back).
 *
 * Two date filters, two different questions. The POSTDATING condition is
 * about the world and always uses occurrence (ev.start > periodEnd). The
 * VISIBILITY condition depends on the knowledge mode: best_known admits an
 * event from its occurrence; as_known_then admits it only from its first
 * report — in the window between the two, the contradiction exists but
 * nobody could yet know it, and firing there would be hindsight leakage in
 * the mode built to exclude it. (The engine's asKnownThen filter also
 * removes unreported events upstream, but that protection is positional —
 * this makes the property local to the function.)
 */
export function structuralTopologyEvidence(
  state: EconomyState,
  periodEnd: string,
  asOf: string,
  knowledge: 'best_known' | 'as_known_then' = 'best_known',
): NonNullable<TopologyValidity['structuralEvidence']> {
  const visibleAt = (ev: EconEvent): string =>
    knowledge === 'as_known_then' ? (ev.firstReportedAt ?? ev.start) : ev.start;
  return state.events
    .filter(ev => ev.start > periodEnd && visibleAt(ev) <= asOf)
    .filter(ev =>
      ev.type === 'closure'
      || ev.type === 'expansion'
      || eventClassOf(ev.type) === 'financial'
      || (eventClassOf(ev.type) === 'regulatory' && !!ev.regulatoryScope)
      || (!ev.end && ev.severity === 'high' && DISRUPTIVE.includes(ev.type)))
    .map(ev => ({ id: ev.id, title: ev.title, start: ev.start, type: ev.type }));
}

export function topologyValidity(
  state: EconomyState,
  asOf: string,
  knowledge: 'best_known' | 'as_known_then' = 'best_known',
  selection?: TopologySelection,
): TopologyValidity {
  // When a graph's own selection is passed, classify against IT: the figure
  // and the label must come from the same frame. Re-selecting from state
  // here while the caller's graph was built for a different date is how a
  // facility tonnage would get served under a country-vintage label.
  const sel = selection ?? selectTopology(state, asOf);
  // What the STATE could serve at this date — named as the remedy when the
  // caller's graph cannot (a graph built without asOf evaluated at 2019
  // predates, but a vintage exists; the note says how to reach it).
  const rebuildRemedy = (): string => {
    if (selection === undefined) return '';
    const would = selectTopology(state, asOf);
    if (would.flows.length === 0 || (would.granularity === sel.granularity && would.vintageYear === sel.vintageYear)) return '';
    return ` A ${would.granularity}-granularity topology${would.vintageYear ? ` (vintage ${would.vintageYear})` : ''} exists for this date — build the graph at the evaluation date to serve it.`;
  };
  if (state.flows.length === 0) {
    return { topologyPeriod: null, evaluatedAt: asOf, status: 'within', granularity: sel.granularity };
  }
  if (sel.flows.length === 0) {
    // Before the earliest topology material of ANY granularity — vintages
    // included, so 'predates' no longer means "before 2024".
    return {
      topologyPeriod: null, evaluatedAt: asOf, status: 'predates', granularity: sel.granularity,
      note: `No flow topology can describe ${asOf}: the earliest material (vintage or snapshot) starts ${sel.earliestStart}. Flow-derived tonnage is null (unknown), not zero; reach shown is structural only.${rebuildRemedy()}`,
    };
  }
  const { start, end } = sel.period!;
  const gLabel = sel.granularity === 'country'
    ? `COUNTRY-granularity vintage ${sel.vintageYear} (reporter-declared trade; facility attribution refused — the allocation model is the remedy)`
    : 'facility-granularity snapshot';
  const status = asOf < start ? 'predates' : asOf > end ? 'extrapolated' : 'within';
  const base = { evaluatedAt: asOf, granularity: sel.granularity, ...(sel.vintageYear ? { vintageYear: sel.vintageYear } : {}) };
  if (status === 'within') {
    return {
      ...base, topologyPeriod: sel.period, status,
      ...(sel.granularity === 'country'
        ? { note: `Serving the ${gLabel}, period ${start}–${end}.` }
        : {}),
    };
  }
  if (status === 'predates') {
    // Reached when the caller's graph was built for a later world than the
    // evaluation date (a no-asOf facility graph evaluated at 2019) — the
    // honest statement is about THAT graph, with the rebuild remedy named.
    return {
      ...base, topologyPeriod: sel.period, status,
      note: `Selected topology (${gLabel}) describes ${start}–${end}; a ${asOf} evaluation predates it. Flow-derived tonnage is null (unknown), not zero.${rebuildRemedy()}`,
    };
  }
  const evidence = structuralTopologyEvidence(state, end, asOf, knowledge);
  const baseNote = `Selected topology (${gLabel}) describes ${start}–${end}; the ${asOf} evaluation uses it as latest-known structure, ${daysBetween(end, asOf)} days past the period.`;
  return {
    ...base, topologyPeriod: sel.period, status,
    extrapolationDays: daysBetween(end, asOf),
    ...(evidence.length > 0 ? { structuralEvidence: evidence } : {}),
    // Two different errors, only one handled: the event mechanism carries
    // the output loss along the MODELED edges; whether the edges themselves
    // still hold is unquantified structural drift. Figures continue because
    // nothing better is modeled, not because the residual is bounded.
    note: evidence.length > 0
      ? `${baseNote} STRUCTURE HAS MOVED since the snapshot: ${evidence.length} post-period structural event(s) [${evidence.map(e => e.id).join(', ')}] contradict extrapolation at the affected entities. Figures continue because no other structure is modeled — the residual there is unquantified structural drift, not a bounded error.`
      : baseNote,
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

  // COUNTRY-granularity scope decisions (work order 3.2). A country node
  // aggregates every stage in its jurisdiction, so an entity-level stage
  // check cannot bind it. A staged scope can still bind a country corridor
  // when the flow's FORM is unambiguous about the stage that produced it:
  // ore and concentrate are pre-smelter output in every modeled chain
  // (bauxite moves as 'ore'), so a production-stage halt stops them. Any
  // other stage/form pairing is UNDECIDABLE at this granularity — excluded
  // VISIBLY, never silently counted either way.
  const PRE_SMELTER_FORMS = new Set(['ore', 'concentrate']);
  type CountryEdgeScope = 'in' | 'undecidable';
  const countryEdgeScope = (edge: { flow: { form: string; commodity: string } }): CountryEdgeScope => {
    if (!scope.stages) return 'in';
    return scope.stages.includes('production') && PRE_SMELTER_FORMS.has(edge.flow.form) ? 'in' : 'undecidable';
  };
  const countryNodeInJurisdiction = (id: string): boolean => {
    const e = graph.nodes.get(id);
    if (!e || e.kind !== 'country') return false;
    if (e.countryCode !== scope.jurisdictionCountryCode) return false;
    if (scope.commodity && e.commodity && e.commodity !== scope.commodity) return false;
    return true;
  };
  let scopeUndecidable = 0;

  const affectedMap = new Map<string, { entityId: string; name: string; kind: string; depth: number }>();
  const addAffected = (id: string, depth: number) => {
    const e = graph.nodes.get(id);
    if (!e) return;
    const prev = affectedMap.get(id);
    if (!prev || depth < prev.depth) affectedMap.set(id, { entityId: id, name: e.name, kind: e.kind, depth });
  };
  const flowIds: string[] = [];
  let disrupted = 0;
  let unquantifiedEdges = 0;
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
      if (!from || !to) continue;
      if (from.kind === 'country') {
        if (!countryNodeInJurisdiction(edge.from)) continue;
        if (countryEdgeScope(edge) === 'undecidable') { scopeUndecidable += 1; continue; }
      } else if (!inScope(edge.from)) continue;
      if (to.countryCode === scope.jurisdictionCountryCode) continue; // domestic — spared
      if (scope.commodity && edge.flow.commodity !== scope.commodity) continue;
      flowIds.push(edge.id);
      if (edge.ktPerYear === null) unquantifiedEdges += 1;
      else disrupted += edge.ktPerYear;
      addAffected(edge.from, 1); // the blocked exporter
      addAffected(edge.to, 1);   // the foreign receiver
      for (const step of downstream(graph, edge.to, maxDepth - 1)) addAffected(step.entityId, step.depth + 1);
    }
    explanation.push(`Export halt in ${scope.jurisdictionCountryCode}: ${flowIds.length} crossing flow(s) (${ktText(disrupted)}) stop while production continues — domestic receivers keep supply, foreign receivers and their downstream lose it.`);
  } else {
    // All in-scope activity halts: in-scope entities and their downstream.
    for (const [id, node] of graph.nodes) {
      if (node.kind === 'country') {
        // The jurisdiction's own country node: its corridors carry the
        // halted output at country granularity — each decided per flow
        // form, since the node itself has no stage to check.
        if (!countryNodeInJurisdiction(id)) continue;
        let counted = false;
        for (const edge of graph.out.get(id) ?? []) {
          if (edge.kind !== 'flow') continue;
          if (scope.commodity && edge.flow.commodity !== scope.commodity) continue;
          if (countryEdgeScope(edge) === 'undecidable') { scopeUndecidable += 1; continue; }
          counted = true;
          flowIds.push(edge.id);
          if (edge.ktPerYear === null) unquantifiedEdges += 1;
          else disrupted += edge.ktPerYear;
          addAffected(edge.to, 1); // the receiver losing supply
          for (const step of downstream(graph, edge.to, maxDepth - 1)) addAffected(step.entityId, step.depth + 1);
        }
        if (counted) addAffected(id, 0);
        continue;
      }
      if (!inScope(id)) continue;
      addAffected(id, 0);
      for (const edge of graph.out.get(id) ?? []) {
        if (edge.kind !== 'flow') continue;
        flowIds.push(edge.id);
        if (edge.ktPerYear === null) unquantifiedEdges += 1;
        else disrupted += edge.ktPerYear;
      }
      for (const step of downstream(graph, id, maxDepth)) addAffected(step.entityId, step.depth);
    }
    explanation.push(`Jurisdiction-wide halt in ${scope.jurisdictionCountryCode}${scope.stages ? ` (${scope.stages.join(', ')})` : ''}: ${affectedMap.size} entity(ies) in scope or downstream; ${ktText(disrupted)} of outbound flow interrupted.`);
  }
  if (scopeUndecidable > 0) {
    explanation.push(`${scopeUndecidable} country-granularity corridor(s) could not be scope-decided (a staged scope against an aggregated country node, and the flow form does not pin the producing stage) — excluded VISIBLY, counted neither as halted nor as spared.`);
  }
  // Basis honesty over vintage topologies: an unconvertible gross flow is
  // REFUSED tonnage, never zero. All-refused → the figure is null with the
  // remedy named; partially refused → the stated sum is a lower bound.
  // GUARDED on !predates: at a predating date the refusal's mechanism is
  // the topology, and pushing the corridor-grade remedy here would be a
  // refusal correct in outcome and WRONG IN ATTRIBUTION — it sends the
  // reader to curate a grade when the actual remedy is a served topology
  // (the 'kt gross/y' unit finding's species, caught by auditing for it).
  if (!predates && unquantifiedEdges > 0 && disrupted === 0) {
    explanation.push(`${unquantifiedEdges} in-scope flow(s) carry gross-weight tonnage with no mirror-implied corridor grade or form-level stage constant — disrupted tonnage is REFUSED (unknown, not zero); reach is real. Remedy: a corridor grade (mirror-implied or documented assay) or a documented stage-conversion constant for the form.`);
  } else if (!predates && unquantifiedEdges > 0) {
    explanation.push(`${unquantifiedEdges} further in-scope flow(s) refused conversion (gross weight, no corridor grade or stage constant) — the stated tonnage is a LOWER BOUND.`);
  }
  // Completeness honesty: the captured vintages are a SUBSET of the world's
  // reporters. A jurisdiction with zero corridors in the serving vintage is
  // not exporting nothing — it is uncaptured, and a 0 here would read
  // absence of capture as absence of flow (the completeness axis of the
  // incommensurability species, at the one place it could slip through).
  const vintageUncovered = validity.granularity === 'country' && !predates
    && !graph.edges.some(e => {
      if (e.kind !== 'flow') return false;
      const from = graph.nodes.get(e.from);
      return from?.kind === 'country' && from.countryCode === scope.jurisdictionCountryCode;
    });
  if (vintageUncovered) {
    explanation.push(`VINTAGE COVERAGE REFUSAL: the ${validity.vintageYear ?? 'serving'} vintage holds no reporter-declared corridors for ${scope.jurisdictionCountryCode} — captured reporters are a subset of the world, and absence of capture is not absence of flow. Disrupted tonnage is null (unknown), not zero. Remedy: capture the ${scope.jurisdictionCountryCode} reporter-year from Comtrade.`);
  }
  if (validity.note) explanation.push(validity.note);

  return {
    eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
    entityId: ev.entityId!, entityName,
    // Null over zero wherever the zero would be a claim the evidence cannot
    // carry: out-of-period, uncaptured jurisdiction, every edge refused
    // conversion, or every edge scope-undecidable.
    disruptedKtPerYear: predates || vintageUncovered
      || (unquantifiedEdges > 0 && disrupted === 0)
      || (scopeUndecidable > 0 && flowIds.length === 0)
      ? null : Math.round(disrupted),
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
  { asOf = new Date().toISOString().slice(0, 10), maxDepth = 4, knowledge = 'best_known' as 'best_known' | 'as_known_then' } = {},
): AnalyticalResult<EventImpact[]> {
  const throughput = nodeThroughput(graph);
  // asOf filters what was KNOWN; the flow topology claims what WAS. The
  // validity is classified against the GRAPH'S OWN selection — the tonnage
  // below comes from that graph's edges, so its label must describe the
  // same frame (a graph built for one date evaluated under another date's
  // state-level selection is how a facility figure would render under a
  // country-vintage label).
  const validity = topologyValidity(state, asOf, knowledge, graph.selection);
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

    // COUNTRY-granularity topology cannot attribute a single facility's
    // share of its country's trade — that is the allocation model, which
    // stays deferred (work order 3.2 scope). A facility event under a
    // vintage topology refuses its tonnage with the remedy named; the
    // dependency-declared structural reach still shows. A PREDATING
    // evaluation takes the predates refusal below instead — naming the
    // allocation model when no vintage serves the date would prescribe the
    // wrong remedy.
    if (validity.granularity === 'country' && !predates && entity.kind !== 'country') {
      const affected = downstream(graph, ev.entityId, maxDepth, traversableEdgeFilter(ev.type)).map(s => {
        const e = graph.nodes.get(s.entityId);
        return { entityId: s.entityId, name: e?.name ?? s.entityId, kind: e?.kind ?? 'unknown', depth: s.depth };
      });
      impacts.push({
        eventId: ev.id, eventTitle: ev.title, eventType: ev.type, severity: ev.severity, active,
        entityId: ev.entityId, entityName: entity.name,
        disruptedKtPerYear: null,
        affected, alternatives: [], dependents: [],
        flowIds: [], capacityIds: [], dependencyIds: [],
        explanation: [
          active ? 'Event window covers the evaluation date — treated as a live state change.' : 'Event window closed — shown as structural context.',
          `FACILITY-LEVEL PROPAGATION REFUSED AT COUNTRY GRANULARITY: the ${validity.vintageYear ?? 'selected'} vintage topology is country-level trade, and attributing ${entity.name}'s share of its country's flows requires the country↔facility ALLOCATION MODEL (deferred). Tonnage is null, not zero; reach shown is declared-dependency structure only.`,
          ...(validity.note ? [validity.note] : []),
        ],
      });
      continue;
    }

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
      // All-refused basis is the regulatory branch's rule applied here too:
      // a node whose every flow refused conversion has UNKNOWN disrupted
      // tonnage, not zero — 0 stays reserved for "carries no modeled flow".
      disruptedKtPerYear: predates || (disrupted === 0 && unquantified.length > 0) ? null : Math.round(disrupted),
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
        topologyGranularity: validity.granularity,
        topologyVintage: validity.vintageYear,
        topologyPeriod: validity.topologyPeriod ? `${validity.topologyPeriod.start}..${validity.topologyPeriod.end}` : undefined,
      },
    },
    execution: { executedAt: new Date().toISOString(), engine: 'payload-economy-engine/0.1' },
    inputs: {
      flowIds: [...new Set(impacts.flatMap(i => i.flowIds))],
      capacityIds: [...new Set(impacts.flatMap(i => i.capacityIds))],
      entityIds: impacts.map(i => i.entityId),
    },
    result: impacts,
  };
}
