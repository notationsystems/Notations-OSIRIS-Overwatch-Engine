/**
 * Payload — Evidence-layer search: the last item of the search arc.
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

// The type group accepts the EMPTY string: `refused:` is how the docs and
// the runbook NAME the queue in prose ("`refused:` is a work queue"), and a
// researcher copies what they read. Before this, the trailing colon failed
// the pattern outright, fell through to the ENTITY register, matched
// nothing, and returned a source-registry miss note about copper — the
// worst possible landing for a first contact with the refusal layer.
const KIND_RE = /^(refused|stale|contested|vintages?)(?::([a-z_]*))?$/;

/** Recognize an evidence-layer query: first token names the kind (optionally
 *  typed, `refused:basis`); remaining tokens filter. Returns null for
 *  ordinary entity queries. */
export function parseEvidenceQuery(q: string): EvidenceQuery | null {
  const tokens = q.trim().toLowerCase().split(/\s+/);
  const m = tokens[0]?.match(KIND_RE);
  if (!m) return null;
  const kind = (m[1] === 'vintages' ? 'vintage' : m[1]) as EvidenceHit['kind'];
  return { kind, type: m[2] || undefined, terms: tokens.slice(1) };
}

/**
 * The DECLARED taxonomy per kind — what a typed query may name.
 *
 * It exists so an unrecognised type can be REFUSED instead of answered with
 * an empty list: `refused:bassis` and `refused:basis`-with-no-instances are
 * different states of the world, and an empty array says neither. `vintage`
 * has no static taxonomy (its type is a sourceId, which is corpus state),
 * so it is resolved from the served hits instead.
 *
 * A hand-written list of what the code can produce is precisely the literal
 * that agrees with itself and not with the world, so it is not trusted:
 * `evidenceSearch.test.ts` sweeps every kind at several vintages and fails
 * if any mechanism emits a type this list does not declare.
 */
export const EVIDENCE_TYPES: Record<EvidenceHit['kind'], readonly string[] | null> = {
  refused: ['basis', 'component', 'topology', 'scope', 'attribution', 'resolution'],
  stale: ['source', 'ladder', 'suspect', 'topology'],
  contested: ['revision_lag', 'coverage', 'definitional', 'unexplained'],
  vintage: null,
};

/**
 * What each declared type MEANS — the condition that produces it.
 *
 * Shown when a typed query comes back empty, which is the state the runbook
 * actually sends a first-time reader into: `refused:basis` has no instances
 * in today's facility topology because the corpus's gross-weight corridors
 * are country-level, so the type is live at the 2017 country vintage and
 * silent at today's. "Nothing here" and "nothing here BECAUSE" are different
 * screens, and only the second one is an instrument.
 *
 * Every declared type must have a line (asserted in evidenceSearch.test.ts —
 * a taxonomy that documents five of six types is the more dangerous half).
 */
export const TYPE_CONDITION: Record<string, string> = {
  'refused:basis': 'Fires on a gross-weight flow with no corridor grade and no form-level stage constant — country-granularity corridors, so it is live under a country flow vintage (set the evaluation date to 2017-06-30) and silent under today\'s facility topology.',
  'refused:component': 'Fires when a bottleneck node has an unquantifiable component — it is downstream of refused:basis, so it is silent whenever that is.',
  'refused:topology': 'Fires when an event is evaluated at a date the flow map cannot carry: before the earliest vintage, or facility attribution under a country vintage.',
  'refused:scope': 'Fires on a regulatory event curated without a jurisdiction scope — silent while every such event carries one.',
  'refused:attribution': 'Fires when an operator index would run over zero attributed tonnage — silent while operated_by edges cover the facilities in scope.',
  'refused:resolution': 'Fires on an identifier a source proposed that the register could not resolve — the standing queue, and the one type that is normally non-empty.',
  'stale:source': 'Fires when a source exceeds its expected arrival gap.',
  'stale:ladder': 'Fires when an adapter is serving a pinned snapshot rung instead of live acquisition.',
  'stale:suspect': 'Fires when the plausibility gate rejects fresh data — silent while fresh data passes.',
  'stale:topology': 'Fires when the flow topology is extrapolated AND structural events contradict it.',
  'contested:revision_lag': 'Two observers disagree because one has revised and the other has not yet.',
  'contested:coverage': 'The gap is a population difference — the observers are counting different sets.',
  'contested:definitional': 'The gap measures a basis or definition difference, not the world.',
  'contested:unexplained': 'The residual survives normalization and drifts — the hardest class to earn, never the default residue.',
};

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

/**
 * The FULL accounting of one evidence query — what was found, what was
 * shown, and what the rest of the kind holds.
 *
 * The array-returning `searchEvidence` below is the convenience wrapper, and
 * its silent `.slice(0, limit)` was the defect this type exists to close:
 * the standing refusal queue held 30 records, the route served 20, the
 * search bar rendered 6, and none of the three surfaces said so. Worse than
 * the count: the slice is ORDER-DEPENDENT over a list built type-by-type, so
 * a whole refusal TYPE can vanish behind a fuller one — the researcher reads
 * "these are the refusals" and a mechanism is simply absent. Every drop is
 * now accounted for, and `byType` is censused BEFORE the type filter and the
 * slice, so an empty typed query can still say what the kind does hold.
 */
export interface EvidenceCensus {
  /** The served page — `shown` of `total`. */
  hits: EvidenceHit[];
  /** Matching the kind + type + terms, before the cap. */
  total: number;
  shown: number;
  truncated: boolean;
  /** Every type in this KIND (after term filtering, before the type filter),
   *  with its full count — so nothing is invisible behind the cap. */
  byType: Array<{ type: string; count: number }>;
  /** Set when the query named a type the kind's taxonomy does not declare.
   *  Zero hits is then a REFUSAL to interpret, not a statement about the
   *  world — the two are different and an empty array says neither. */
  unknownType?: { type: string; declared: string[] };
}

export function searchEvidenceCensus(
  state: EconomyState,
  graph: EconomyGraph,
  query: EvidenceQuery,
  { asOf, knowledge = 'best_known', limit = 20 }: { asOf?: string; knowledge?: 'best_known' | 'as_known_then'; limit?: number } = {},
): EvidenceCensus {
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

  // Free-term filter first, so the type census below describes the same
  // population the researcher is looking at.
  const termed = query.terms.length === 0 ? hits : hits.filter(h => {
    const hay = `${h.type} ${h.entityId ?? ''} ${h.entityName ?? ''} ${h.title} ${h.detail}`.toLowerCase();
    return query.terms.every(t => hay.includes(t));
  });
  const counts = new Map<string, number>();
  for (const h of termed) counts.set(h.type, (counts.get(h.type) ?? 0) + 1);
  const byType = [...counts].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));

  // A type the kind does not declare is a REFUSAL, never an empty answer.
  // For `vintage` the taxonomy is corpus state (sourceIds), so the served
  // set is the taxonomy.
  const declared = EVIDENCE_TYPES[query.kind] ?? [...counts.keys()].sort();
  if (query.type && !declared.includes(query.type)) {
    return { hits: [], total: 0, shown: 0, truncated: false, byType, unknownType: { type: query.type, declared: [...declared] } };
  }

  const typed = query.type ? termed.filter(h => h.type === query.type) : termed;
  // Interactive search caps at 20; the refusals DIGEST passes Infinity —
  // a work queue that silently truncated would read as "covered". The cap
  // is now REPORTED either way, which is what makes it a page instead of
  // an omission.
  const page = typed.slice(0, limit);
  return { hits: page, total: typed.length, shown: page.length, truncated: page.length < typed.length, byType };
}

/** Array-returning convenience over `searchEvidenceCensus`. Callers that use
 *  this see the page and NOT the accounting — every user-facing surface
 *  should take the census instead. */
export function searchEvidence(
  state: EconomyState,
  graph: EconomyGraph,
  query: EvidenceQuery,
  opts: { asOf?: string; knowledge?: 'best_known' | 'as_known_then'; limit?: number } = {},
): EvidenceHit[] {
  return searchEvidenceCensus(state, graph, query, opts).hits;
}

/**
 * The sentence a surface shows when the census is not self-evident: an empty
 * result, a refused type, or a truncated page. Returns null when the page IS
 * the whole answer and needs no gloss.
 *
 * This is the fix for the researcher's wall. `refused:basis` is the query the
 * runbook sends a first-time reader to, and today's facility topology serves
 * ZERO of them (the corpus's gross-weight corridors are country-level, so the
 * type is live at the 2017 vintage and empty at today's). Before this the
 * screen was simply blank — indistinguishable from a typo, a broken fetch, or
 * a mechanism that does not exist.
 */
export function evidenceNote(query: EvidenceQuery, census: EvidenceCensus, asOf?: string): string | null {
  const at = asOf ? `on ${asOf}` : 'in the current topology';
  if (census.unknownType) {
    return `"${query.kind}:${census.unknownType.type}" is not a declared ${query.kind} type — REFUSED rather than answered empty, because an empty list would read as "none exist". Declared: ${census.unknownType.declared.map(t => `${query.kind}:${t}`).join(', ')}.`;
  }
  const others = census.byType.filter(t => t.type !== query.type);
  if (census.total === 0) {
    const elsewhere = others.length > 0
      ? ` The ${query.kind} layer holds ${others.reduce((s, t) => s + t.count, 0)} record(s) ${at}: ${others.map(t => `${query.kind}:${t.type} (${t.count})`).join(', ')}.`
      : ` The ${query.kind} layer is empty ${at} — nothing is being withheld.`;
    const condition = query.type ? TYPE_CONDITION[`${query.kind}:${query.type}`] : undefined;
    return query.type
      ? `No ${query.kind}:${query.type} ${at}. This is a statement about the corpus, not a failure: the mechanism exists and found nothing to declare.${condition ? ` ${condition}` : ''}${elsewhere}`
      : `No ${query.kind} records ${at}.${elsewhere}`;
  }
  if (census.truncated) {
    // Untyped, the census IS the breakdown; typed, it names what else the
    // kind holds. Calling the whole census "other types" on an untyped
    // query would misdescribe it — a small wording defect, but the note
    // exists precisely because misdescription is the failure mode here.
    const census_list = census.byType.map(t => `${query.kind}:${t.type} (${t.count})`).join(', ');
    const rest = query.type
      ? (others.length > 0 ? ` Other types in this kind: ${others.map(t => `${query.kind}:${t.type} (${t.count})`).join(', ')}.` : '')
      : (census.byType.length > 0 ? ` By type: ${census_list}.` : '');
    return `Showing ${census.shown} of ${census.total} ${query.kind}${query.type ? `:${query.type}` : ''} record(s) ${at} — the page is capped, the queue is not.${rest}`;
  }
  if (!query.type && others.length > 1) {
    return `${census.total} ${query.kind} record(s) ${at}: ${census.byType.map(t => `${query.kind}:${t.type} (${t.count})`).join(', ')}.`;
  }
  return null;
}
