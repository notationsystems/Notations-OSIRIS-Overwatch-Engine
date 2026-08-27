/**
 * OSIRIS — Evidence-layer search: the last item of the search arc.
 *
 * Search finds entities; this finds the EPISTEMIC STATE — the places where
 * the system refused to answer, where observers disagree, where evidence has
 * gone stale, and which source vintages the corpus holds. The states are
 * TYPED because they accumulated as distinct conditions with distinct
 * remedies: a single `refused` bucket would be less useful than the
 * machinery deserves — typed refusals let an analyst find the ones with a
 * shared fix, which is the actual research move.
 *
 * Refusal taxonomy (each type = one mechanism, one remedy):
 *   refused:basis        flow tonnage refused — gross-weight basis, no
 *                        corridor grade (graph basisUnresolved).
 *   refused:component    bottleneck score null — a component is
 *                        unquantifiable at this node.
 *   refused:topology     propagation tonnage null — the evaluation date
 *                        predates the flow topology.
 *   refused:scope        regulatory event with no jurisdiction scope.
 *   refused:attribution  operator index null — zero attributed tonnage.
 *   refused:resolution   an identifier a source proposed that the register
 *                        could not resolve (work order 3.3) — the raw
 *                        identifier, its source, row count, near-match
 *                        candidates (never merged), and the remedy.
 *
 * Staleness taxonomy (four conditions, four responses):
 *   stale:source         corpus health source_stale (arrival gap exceeded).
 *   stale:ladder         degradation ladder pinned to a snapshot rung.
 *   stale:suspect        plausibility gate rejected fresh data.
 *   stale:topology       extrapolated topology under structural
 *                        contradiction (the evidence trigger).
 *
 * `contested` = divergence records, typed by their class.
 * `vintage`   = the source editions the corpus holds, with knownAt ranges.
 */

import type { EconomyState } from './types';
import type { EconomyGraph } from './graph';
import { bottleneckCandidates, knownAtOf, operatorConcentration } from './analytics';
import { detectDivergences } from './divergence';
import { propagateEvents, topologyValidity } from './propagation';
import { corpusHealthSignals } from './horizon';

export interface EvidenceHit {
  kind: 'refused' | 'stale' | 'contested' | 'vintage';
  /** The typed condition (refusal/staleness type, divergence class, sourceId). */
  type: string;
  entityId?: string;
  entityName?: string;
  title: string;
  /** The mechanism's own explanation, verbatim where one exists. */
  detail: string;
  /** What would resolve it — shared across a type, which is what makes the
   *  type worth having. Empty for vintages (inventory, not a condition). */
  remedy: string;
  evidenceIds: string[];
}

export interface EvidenceQuery {
  kind: EvidenceHit['kind'];
  type?: string;
  /** Free filter terms matched against the hit's text. */
  terms: string[];
}

const KIND_RE = /^(refused|stale|contested|vintages?)(?::([a-z_]+))?$/;

/** Recognize an evidence-layer query: first token names the kind (optionally
 *  typed, `refused:basis`); remaining tokens filter. Returns null for
 *  ordinary entity queries. */
export function parseEvidenceQuery(q: string): EvidenceQuery | null {
  const tokens = q.trim().toLowerCase().split(/\s+/);
  const m = tokens[0]?.match(KIND_RE);
  if (!m) return null;
  const kind = (m[1] === 'vintages' ? 'vintage' : m[1]) as EvidenceHit['kind'];
  return { kind, type: m[2], terms: tokens.slice(1) };
}

const REMEDY: Record<string, string> = {
  'refused:basis': 'Curate a corridor grade (mirror-implied or documented assay) for the gross-weight flow, or — where the FORM pins the conversion (bauxite, alumina) — a documented form-level stage constant; either converts with its band as uncertainty.',
  'refused:component': 'Resolve the refused flow basis feeding this node — the score computes when its components do.',
  'refused:topology': 'Country flow vintages serve 2017+ at country granularity; before the earliest vintage no topology exists. Facility tonnage under a country vintage needs the country↔facility allocation model (deferred — work order scope).',
  'refused:scope': 'Curate regulatoryScope (jurisdiction + commodity/stages/direction) on the event.',
  'refused:attribution': 'Curate operated_by edges for the facilities in scope.',
  'stale:source': 'Check the source; if it has moved or died, the adapter needs re-pointing — the lead ceiling has already degraded.',
  'stale:ladder': 'The adapter is serving a snapshot rung; restore live acquisition or accept the pinned vintage explicitly.',
  'stale:suspect': 'Fresh data failed the plausibility gate — inspect before trusting; do NOT prefer it over the stale-but-plausible rung.',
  'stale:topology': 'Refresh the flow vintage: the listed events are first-hand evidence the structure moved.',
};

function entityName(state: EconomyState, id?: string): string | undefined {
  return id ? state.entities.find(e => e.id === id)?.name ?? id : undefined;
}

/**
 * The one place a propagation refusal's TYPE is derived from its
 * explanation. This coupling of diagnosis to prose is a recorded hazard —
 * a wording change in propagation.ts would silently retype the refusal
 * queue (the wrong-attribution species, phase 33) — and it is guarded,
 * not remembered: `typed-refusal-emission-unbuilt` in ledgerGuards runs a
 * planted instance of every mechanism through the real pipeline and this
 * classifier, and fires if any lands in the wrong bucket. The durable fix
 * (mechanisms emit their type; text rendered FROM it) is the deferred
 * build that guard exists for.
 */
export function classifyRefusalExplanation(text: string): 'scope' | 'topology' | 'basis' {
  return text.includes('WITHOUT A SCOPE') ? 'scope'
    : text.includes('FACILITY-LEVEL PROPAGATION REFUSED') ? 'topology'
    : text.includes('REFUSED') && text.includes('corridor grade') ? 'basis'
    : 'topology';
}

export function searchEvidence(
  state: EconomyState,
  graph: EconomyGraph,
  query: EvidenceQuery,
  { asOf, knowledge = 'best_known', limit = 20 }: { asOf?: string; knowledge?: 'best_known' | 'as_known_then'; limit?: number } = {},
): EvidenceHit[] {
  const evalDate = asOf ?? new Date().toISOString().slice(0, 10);
  const hits: EvidenceHit[] = [];
  const push = (h: Omit<EvidenceHit, 'remedy'> & { remedy?: string }) =>
    hits.push({ remedy: REMEDY[`${h.kind}:${h.type}`] ?? '', ...h });

  if (query.kind === 'refused') {
    // basis — unconverted gross-weight flows, straight off the graph.
    for (const edge of graph.edges) {
      if (edge.kind !== 'flow' || !edge.basisUnresolved) continue;
      push({
        kind: 'refused', type: 'basis',
        entityId: edge.from, entityName: entityName(state, edge.from),
        title: `${entityName(state, edge.from)} → ${entityName(state, edge.to)}: tonnage refused`,
        detail: 'Gross-weight basis with no corridor grade and no form-level stage constant — the flow enters as structure, never as tonnage; zero would claim it carries nothing.',
        evidenceIds: [edge.id],
      });
    }
    // component — bottleneck scores refused.
    for (const b of bottleneckCandidates(state, graph).result) {
      if (b.score !== null) continue;
      push({
        kind: 'refused', type: 'component',
        entityId: b.entityId, entityName: b.name,
        title: `${b.name}: bottleneck score refused`,
        detail: b.explanation.join(' '),
        evidenceIds: [b.entityId],
      });
    }
    // topology / scope / basis — null propagation tonnage, split by
    // mechanism (each type is one remedy): no jurisdiction → scope; every
    // in-scope corridor refused conversion → basis (the corridor grade is
    // the fix, same as the graph-edge refusals above); a date the topology
    // frame cannot carry (predates, or facility attribution under a
    // country vintage) → topology.
    for (const i of propagateEvents(state, graph, { asOf: evalDate, knowledge }).result) {
      if (i.disruptedKtPerYear !== null) continue;
      const text = i.explanation.join(' ');
      const type = classifyRefusalExplanation(text);
      push({
        kind: 'refused', type,
        entityId: i.entityId, entityName: i.entityName,
        title: `${i.eventTitle}: disrupted tonnage refused`,
        detail: text,
        evidenceIds: [i.eventId, ...i.flowIds],
      });
    }
    // resolution — the gate's residue, typed records off the state.
    for (const u of state.unresolved ?? []) {
      const cand = (u.candidates ?? []).map(c => `${c.name} (${c.entityId}) — ${c.note}`);
      push({
        kind: 'refused', type: 'resolution',
        title: `${u.scheme} "${u.identifier}": resolution refused`,
        detail: `${u.occurrences} row(s) from ${u.sourceId} carried this identifier and were dropped at the resolution gate${u.context ? ` (${u.context})` : ''}.${cand.length > 0 ? ` Near matches, NEVER merged: ${cand.join('; ')}.` : ''}`,
        remedy: u.remedy,
        evidenceIds: [`${u.sourceId}:${u.scheme}:${u.identifier}`],
      });
    }
    // attribution — null operator indices.
    for (const basis of ['control', 'economic_interest'] as const) {
      const r = operatorConcentration(state, 'production', ['mine'], basis, evalDate).result;
      if (r.hhi !== null) continue;
      push({
        kind: 'refused', type: 'attribution',
        title: `Operator concentration (${basis}): index refused`,
        detail: `Zero attributed tonnage across ${r.facilityCount} facility(ies) — an index over an empty attributed set has no value; 0 would read as "perfectly unconcentrated".`,
        evidenceIds: [],
      });
    }
  }

  if (query.kind === 'stale') {
    const TYPE_OF = { source_stale: 'source', ladder_rung_pinned: 'ladder', source_suspect: 'suspect' } as const;
    for (const s of corpusHealthSignals(state, evalDate)) {
      push({
        kind: 'stale', type: TYPE_OF[s.kind],
        title: `${s.sourceId}: ${s.kind}${s.loadBearing ? ' (LOAD-BEARING)' : ''}`,
        detail: s.explanation,
        evidenceIds: [s.sourceId],
      });
    }
    const v = topologyValidity(state, evalDate, knowledge);
    if (v.status === 'extrapolated' && v.structuralEvidence?.length) {
      push({
        kind: 'stale', type: 'topology',
        title: `Flow topology extrapolated under structural contradiction (${v.structuralEvidence.length} event(s))`,
        detail: v.note ?? '',
        evidenceIds: v.structuralEvidence.map(e => e.id),
      });
    }
  }

  if (query.kind === 'contested') {
    for (const d of detectDivergences(state).result) {
      push({
        kind: 'contested', type: d.class,
        entityId: d.entityId, entityName: entityName(state, d.entityId),
        title: `${entityName(state, d.entityId)}${d.partnerEntityId ? ` ↔ ${entityName(state, d.partnerEntityId)}` : ''} ${d.metric} (${d.class})`,
        detail: d.explanation,
        remedy: d.class === 'unexplained'
          ? 'Investigate — basis cannot be the mechanism here; this class is the hardest to earn.'
          : 'Classified and watched (residual/drift baseline); reclassifies on drift, not level.',
        evidenceIds: [d.id, ...d.claims.map(c => c.observationId)],
      });
    }
  }

  if (query.kind === 'vintage') {
    // The vintage inventory: one row per source edition actually held, with
    // its knownAt range — what "as known then" can and cannot reconstruct.
    const bySource = new Map<string, { name: string; count: number; minKnown: string; maxKnown: string }>();
    for (const o of state.observations) {
      const id = o.provenance.sourceId;
      const known = knownAtOf(o);
      const cur = bySource.get(id);
      if (!cur) bySource.set(id, { name: o.provenance.sourceName, count: 1, minKnown: known, maxKnown: known });
      else {
        cur.count += 1;
        if (known < cur.minKnown) cur.minKnown = known;
        if (known > cur.maxKnown) cur.maxKnown = known;
      }
    }
    for (const [id, v] of bySource) {
      push({
        kind: 'vintage', type: id,
        title: `${v.name}`,
        detail: `${v.count} observation(s), knowable ${v.minKnown.slice(0, 10)} → ${v.maxKnown.slice(0, 10)}.`,
        remedy: '',
        evidenceIds: [id],
      });
    }
    hits.sort((a, b) => a.type.localeCompare(b.type));
  }

  // Type filter, then free-term filter over the hit's text.
  const typed = query.type ? hits.filter(h => h.type === query.type) : hits;
  const filtered = query.terms.length === 0 ? typed : typed.filter(h => {
    const hay = `${h.type} ${h.entityId ?? ''} ${h.entityName ?? ''} ${h.title} ${h.detail}`.toLowerCase();
    return query.terms.every(t => hay.includes(t));
  });
  // Interactive search caps at 20; the refusals DIGEST passes Infinity —
  // a work queue that silently truncated would read as "covered".
  return filtered.slice(0, limit);
}
