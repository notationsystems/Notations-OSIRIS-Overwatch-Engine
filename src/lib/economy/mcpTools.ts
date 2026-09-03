/**
 * Payload Terminal — the MCP tool surface (final order F-2).
 *
 * The operator's pivot: external models attach to the substrate rather
 * than a reasoning layer being built inside it. That moves the
 * enforcement point out of this codebase and into the interface, so the
 * interface carries the discipline:
 *
 *   1. Knowledge state is REQUIRED on every tool — `asOf` and `mode`,
 *      never defaulted. A model that must state the knowledge state
 *      cannot silently answer from the present.
 *   2. Every quantitative return carries record ids, the five axes and
 *      a SERVER-RENDERED CLAIM SENTENCE at the top level of the result —
 *      not in a metadata blob a client will drop. A model handed a
 *      correct sentence pastes it, because pasting is cheaper than
 *      reconstructing; that is the only mechanism that reaches a model
 *      we do not control.
 *   3. Refusals return SUCCESSFULLY: value null + refusalType + remedy.
 *      Never an error code — an error invites a retry or a workaround,
 *      a null-with-remedy invites a report.
 *   4. Nothing accepts writes. Every tool is a projection over GET/POST
 *      compute routes; state is never mutated (pinned structurally in
 *      mcpTools.test.ts by fingerprinting state across every tool).
 *   5. No parameter VALUE ever reaches the MCP session log (F-4), and
 *      the canonical-vocabulary boundaries of the underlying routes
 *      (e.g. the `ent:` subject regex) hold unchanged — free text is
 *      refused before it can reach any log.
 *
 * Tools call the SAME HTTP routes a human's browser uses, carrying the
 * machine-client header so machine traffic never lands in the frozen
 * S-7 demand instruments (machineClient.ts). One logic path — the MCP
 * surface cannot drift from what the terminal serves.
 */

import { MACHINE_CLIENT_HEADER } from './machineClient';
import { recordMcpCall } from './mcpSession';
import { SOURCE_REGISTRY, mayRedistributeToMachines, redistributionPostureOf } from './sourceRegistry';
import { env } from './envCompat';

export interface KnowledgeState {
  asOf: string;
  mode: 'best_known' | 'as_known_then';
}

export interface McpContext {
  /** Fetch a route path (e.g. "/api/economy/table?…") and parse JSON.
   *  The default context speaks HTTP to a running instance; tests inject
   *  an in-process adapter over the same route handlers. */
  fetchJson(path: string, init?: { method?: string; body?: string; headers?: Readonly<Record<string, string>> }): Promise<{ status: number; body: unknown }>;
}

export function httpContext(baseUrl = env('PAYLOAD_URL') ?? 'http://localhost:3000'): McpContext {
  return {
    async fetchJson(path, init) {
      const res = await fetch(`${baseUrl}${path}`, {
        method: init?.method ?? 'GET',
        headers: {
          [MACHINE_CLIENT_HEADER]: 'machine',
          ...(init?.body ? { 'content-type': 'application/json' } : {}),
          ...init?.headers,
        },
        body: init?.body,
      });
      return { status: res.status, body: await res.json() };
    },
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Contract 1: the knowledge state is never defaulted. The error names
 *  the missing parameter — the acceptance criterion's exact demand. */
export function requireKnowledge(args: Record<string, unknown>): KnowledgeState {
  const asOf = args.asOf;
  if (typeof asOf !== 'string' || !DATE_RE.test(asOf)) {
    throw new Error('missing required parameter: asOf — the knowledge state is never defaulted; state the evaluation date (YYYY-MM-DD)');
  }
  const mode = args.mode;
  if (mode !== 'best_known' && mode !== 'as_known_then') {
    throw new Error('missing required parameter: mode — the knowledge state is never defaulted; state "best_known" (hindsight reconstruction) or "as_known_then" (only what was knowable at asOf)');
  }
  return { asOf, mode };
}

const ks = (k: KnowledgeState) => `asOf=${k.asOf}&knowledge=${k.mode}`;

/* ── D-13: machine-consumer redistribution gate ──
 *
 * Serving data onward to an external machine consumer is a different act
 * from reading it internally. Each registered source carries a posture;
 * an UNRESOLVED posture REFUSES rather than defaulting permissive,
 * because defaulting to yes is how a licensing question becomes a
 * licensing incident. A withheld source is not omitted: it comes back as
 * a typed refusal with the remedy (resolve the posture, or license the
 * feed), exactly like every other refusal in this system.
 */
const SERVEABLE_SOURCE_IDS = new Set(SOURCE_REGISTRY.filter(mayRedistributeToMachines).map(s => s.sourceId));

/** Map an observation/record sourceId onto its registry entry id. Adapter
 *  source ids are versioned per edition (usgs-mcs2024, usgs-mcs2025), so
 *  the match is by prefix against the registry's stable ids. */
export function registrySourceIdFor(recordSourceId: string): string | null {
  let best: string | null = null;
  for (const s of SOURCE_REGISTRY) {
    const stem = s.sourceId.replace(/-lme$|-cot$|-hg$/, '');
    if (recordSourceId === s.sourceId || recordSourceId.startsWith(s.sourceId) || recordSourceId.startsWith(stem)) {
      if (!best || s.sourceId.length > best.length) best = s.sourceId;
    }
  }
  return best;
}

export function machineServeable(recordSourceId: string): boolean {
  const id = registrySourceIdFor(recordSourceId);
  if (!id) return false; // unknown source: unresolved, therefore refused
  return SERVEABLE_SOURCE_IDS.has(id);
}

/** Partition rows by whether their source may be served to a machine
 *  consumer, returning the withheld ones as typed refusals. */
export function gateRowsForMachines<T extends { record_id?: string; source_id: string; subject_id?: string }>(
  rows: T[],
): { served: T[]; refusals: ToolRefusal[] } {
  const served: T[] = [];
  const withheldBySource = new Map<string, number>();
  for (const r of rows) {
    if (machineServeable(r.source_id)) { served.push(r); continue; }
    withheldBySource.set(r.source_id, (withheldBySource.get(r.source_id) ?? 0) + 1);
  }
  const refusals: ToolRefusal[] = [...withheldBySource.entries()].map(([sourceId, count]) => {
    const registryId = registrySourceIdFor(sourceId);
    const entry = SOURCE_REGISTRY.find(s => s.sourceId === registryId);
    const posture = entry ? redistributionPostureOf(entry) : 'unresolved';
    return {
      subject: `source:${sourceId}`,
      value: null as null,
      refusalType: 'redistribution-posture',
      remedy: posture === 'internal_only'
        ? `${count} row(s) from ${sourceId} are withheld from machine clients: this source is carried for INTERNAL research and its terms do not cover onward machine redistribution${entry?.redistributionNote ? ` — ${entry.redistributionNote}` : ''}. Remedy: license the feed, or read it through the human surface.`
        : `${count} row(s) from ${sourceId} are withheld from machine clients: no redistribution posture has been established for this source, and unresolved REFUSES rather than defaulting permissive. Remedy: record the posture in the source registry.`,
    };
  });
  return { served, refusals };
}

/** A refusal surfaced through a tool — the successful-return shape. */
export interface ToolRefusal {
  subject: string;
  value: null;
  refusalType: string;
  remedy: string;
}

export interface McpToolResult {
  knowledge_state: { as_of: string; mode: string };
  /** Server-rendered sentences — paste these, not bare numbers. */
  claims: string[];
  /** Evidence identity of everything quantitative in `data`. */
  record_ids: string[];
  /** Refusal-shaped content in this result, as null-with-remedy records. */
  refusals: ToolRefusal[];
  data: unknown;
  caveats: string[];
}

export interface McpToolDef {
  name: string;
  /** The contract — the one place the doctrine travels into a client we
   *  did not build. Written as contract, not label. */
  description: string;
  /** Parameter names → human description; asOf/mode are on every tool. */
  params: Record<string, string>;
  handler(args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult>;
}

const KNOWLEDGE_PARAMS = {
  asOf: 'REQUIRED. Evaluation date, YYYY-MM-DD. Every figure returned is bounded by this date and the mode.',
  mode: 'REQUIRED. "best_known" = reconstruction with hindsight; "as_known_then" = only what was knowable on asOf. Never defaulted — you must state which world you are asking about.',
};

const CONTRACT_FOOTER =
  ' Returns null values when the system refuses to answer — a refusal is a SUCCESSFUL return carrying refusalType and remedy. Do not substitute external knowledge for a refused value; report the refusal and its remedy. Every figure is bounded by the asOf and mode you supplied. Paste the server-rendered `claims` sentences rather than restating bare numbers: they carry the unit, basis, evidence class, source and knowability the number is meaningless without.';

interface BottleneckLike {
  entityId: string;
  name: string;
  kind: string;
  score: number | null;
  explanation: string[];
  flowIds?: string[];
  capacityIds?: string[];
  dependencyIds?: string[];
}

interface ConcentrationLike {
  metric?: string;
  hhi: number | null;
  band?: string;
  total?: number;
  unit?: string;
  shares?: Array<{ entityId: string; name: string; value: number; share: number }>;
  groupCount?: number;
  effectiveGroups?: number;
  partitionFloor?: number;
  coverageBias?: { minRatio: number; maxRatio: number; countries: number; note: string };
  weakestInputClass?: string | null;
  reason?: string;
  remainder?: { share?: number; note?: string };
}

function isConcentrationLike(v: unknown): v is ConcentrationLike {
  return !!v && typeof v === 'object' && 'hhi' in (v as Record<string, unknown>);
}

/** The operator's example sentence, rendered from what the index carries —
 *  and only from what it carries: a missing axis is SAID to be missing. */
export function renderConcentrationClaim(name: string, c: ConcentrationLike): string {
  if (c.hhi === null || c.band === 'no-data') {
    return `${name}: REFUSED (${c.band === 'no-data' ? 'no observations at the evaluation date' : c.reason ?? 'not computable from admissible inputs'}) — the index is null, not zero.`;
  }
  const top = c.shares?.[0];
  const topText = top ? `${top.name} ${(top.share * 100).toFixed(0)}% of ${c.metric ?? name}` : `${name}`;
  const partition = `HHI ${Math.round(c.hhi)} across ${c.groupCount ?? '?'} groups (effective ${c.effectiveGroups ?? '?'}, floor ${c.partitionFloor ? Math.round(c.partitionFloor) : '?'})`;
  const coverage = c.coverageBias ? `, facility coverage ${(c.coverageBias.minRatio * 100).toFixed(0)}–${(c.coverageBias.maxRatio * 100).toFixed(0)}% by country` : '';
  const cls = c.weakestInputClass ? `, weakest input ${c.weakestInputClass}` : ', input class UNSTATED';
  const remainder = c.remainder?.share !== undefined ? `, unattributed remainder ${(c.remainder.share * 100).toFixed(0)}%` : '';
  return `${topText} — ${partition}${coverage}${cls}${remainder} [${c.total?.toLocaleString() ?? '?'} ${c.unit ?? '(unit unstated)'} total]. Not comparable raw against a different partition; compare effectiveGroups.`;
}

function concentrationAxes(name: string, c: ConcentrationLike): Record<string, unknown> {
  return {
    basis: null, // mass basis is not carried on an index — flagged, never defaulted
    basis_flag: 'index-level mass basis unstated; per-record basis is on the observations (get_observations)',
    population: { index: name, metric: c.metric ?? null },
    universe: { total: c.total ?? null, unit: c.unit ?? null },
    partition: { groupCount: c.groupCount ?? null, effectiveGroups: c.effectiveGroups ?? null, partitionFloor: c.partitionFloor ?? null },
    completeness: { weakestInputClass: c.weakestInputClass ?? null, coverageBias: c.coverageBias ?? null, remainder: c.remainder ?? null },
  };
}

interface ImpactLike {
  eventId: string; eventTitle: string; eventType: string; severity: string; active: boolean;
  entityId: string; entityName: string; disruptedKtPerYear: number | null;
  affected: Array<{ name: string }>; flowIds: string[]; capacityIds: string[]; dependencyIds: string[];
  explanation: string[];
}

export function renderImpactClaim(i: ImpactLike): string {
  if (i.disruptedKtPerYear === null) {
    return `${i.eventTitle} at ${i.entityName}: tonnage REFUSED — ${i.explanation[i.explanation.length - 1] ?? 'cannot be stated at this evaluation date'} (reach still shown: ${i.affected.length} downstream).`;
  }
  return `${i.eventTitle} (${i.eventType}, ${i.severity}${i.active ? ', active' : ', historical'}) at ${i.entityName}: ~${i.disruptedKtPerYear.toLocaleString()} kt/y of graph throughput touched, ${i.affected.length} downstream entit${i.affected.length === 1 ? 'y' : 'ies'} in the propagation walk [evidence: ${i.flowIds.length} flows, ${i.capacityIds.length} capacities].`;
}

function get(obj: unknown, key: string): unknown {
  return obj && typeof obj === 'object' ? (obj as Record<string, unknown>)[key] : undefined;
}

async function fetchOk(ctx: McpContext, path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const { status, body } = await ctx.fetchJson(path, init);
  if (status >= 400) {
    throw new Error(typeof get(body, 'error') === 'string' ? (get(body, 'error') as string) : `route returned ${status}`);
  }
  return body;
}

function result(k: KnowledgeState, partial: Omit<McpToolResult, 'knowledge_state'>): McpToolResult {
  return { knowledge_state: { as_of: k.asOf, mode: k.mode }, ...partial };
}

/* ── The tools ── */

export const MCP_TOOLS: McpToolDef[] = [
  {
    // FIRST BY RANK, on the operator's instruction. The runbook's opening
    // move is "find a constraint: open the Bottlenecks list", and until now
    // that capability existed in the UI and not in the tool list. A model
    // attaching to this instrument tries the same question first, finds no
    // tool for it, and answers from training data instead — which is the
    // one failure mode the whole MCP surface exists to prevent. An
    // asymmetry between what the humans can ask and what the machines can
    // is not a missing feature; it is a route around the substrate.
    name: 'bottlenecks',
    description: 'Candidate chokepoints in the flow graph at the stated knowledge state, ranked: how much CONTAINED METAL the graph routes through each node, its utilization against stated capacity, how many modeled alternatives exist at its stage, and what explicitly depends on it. This is the instrument\'s answer to "where would this chain break", and the first question its own runbook tells a researcher to ask. These are TRIAGE SIGNALS, not validated risk: the score ranks structural exposure in the modeled graph, and the model is not the world. A null score is a REFUSAL — a component could not be quantified — and arrives with its remedy. AN EMPTY LIST IS A CLAIM, NOT AN ABSENCE: it arrives with `empty_because` naming which nothing it is (no flow topology at this date, or a topology whose nodes are aggregates rather than sited structure), and must never be reported as "there are no bottlenecks".' + CONTRACT_FOOTER,
    params: { commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const data = await fetchOk(ctx, `/api/economy?commodity=${args.commodity ?? 'copper'}&view=analytics&${ks(k)}`);
      const block = get(data, 'bottlenecks') as Record<string, unknown>;
      const candidates = ((get(block, 'result') as BottleneckLike[]) ?? []);
      const emptyBecause = get(block, 'emptyBecause') as string | undefined;

      const refused = candidates.filter(c => c.score === null);
      const scored = candidates.filter(c => c.score !== null);
      // Every refusal is rendered; the scored list is capped and the cap is
      // STATED. A ranked list served short without saying so reads as the
      // whole ranking (phase 39).
      const RENDER = 10;
      const shown = scored.slice(0, RENDER);
      const claims: string[] = [
        ...refused.map(c => `${c.name} (${c.entityId}, ${c.kind}): bottleneck score REFUSED — ${c.explanation.join(' ')}`),
        ...shown.map(c => `${c.name} (${c.entityId}, ${c.kind}): bottleneck score ${(c.score as number).toFixed(2)} of 1 — ${c.explanation.join('; ')}.`),
      ];
      if (scored.length > shown.length) {
        claims.push(`${shown.length} of ${scored.length} scored candidate(s) rendered as claims, highest first; all ${candidates.length} are in \`data\`, ranked, with refusals first.`);
      }
      if (candidates.length === 0 && emptyBecause) claims.push(emptyBecause);

      return result(k, {
        claims,
        record_ids: [...new Set(candidates.flatMap(c => [...(c.flowIds ?? []), ...(c.capacityIds ?? []), ...(c.dependencyIds ?? [])]))],
        refusals: refused.map(c => ({
          subject: c.entityId,
          value: null,
          refusalType: 'component',
          remedy: c.explanation.find(e => e.includes('Supply')) ?? c.explanation[0] ?? 'a component of the score could not be quantified at this date',
        })),
        data: { candidates, empty_because: emptyBecause ?? null, rendered_as_claims: shown.length, scored: scored.length, refused: refused.length },
        caveats: [
          'Triage signals over the MODELED graph, not validated risk: a chokepoint absent from the corpus cannot rank, and facility-level records in this corpus are representative-attested.',
          'Throughput is CONTAINED METAL by construction — gross-weight edges are converted at a corridor grade or refused — so the figure is comparable across nodes; where converted flows contribute, the explanation says so and that share carries the grade\'s band.',
          ...(candidates.length === 0
            ? ['An empty ranking is NOT evidence that the chain has no chokepoints. Report `empty_because` verbatim; it names the condition, not a verdict.']
            : []),
        ],
      });
    },
  },
  {
    name: 'search_entities',
    description: 'Search the canonical entity register (mines, smelters, refineries, ports, companies, countries) by name, operator, country or kind. The index IS the register — there is no parallel list. Under mode=as_known_then, entities with no knowable record at asOf are WITHHELD AND COUNTED in `withheld`; a smaller result set under an earlier date is the system being honest, not incomplete.' + CONTRACT_FOOTER,
    params: { q: 'Search text (min 2 chars). Person-shaped text matches nothing and is never retained in any log.', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const q = String(args.q ?? '');
      const data = await fetchOk(ctx, `/api/economy/search?commodity=${args.commodity ?? 'copper'}&q=${encodeURIComponent(q)}&${ks(k)}`);
      const results = (get(data, 'results') as Array<{ id: string; name: string; headline?: string; attestation?: string }>) ?? [];
      const withheld = (get(data, 'withheld') as number) ?? 0;
      const claims = results.map(r => `${r.name} (${r.id}): ${r.headline ?? 'no quantified headline'} — ${r.attestation ?? 'attestation unknown'}-attested identity.`);
      if (withheld > 0) claims.push(`${withheld} matching entit${withheld === 1 ? 'y was' : 'ies were'} withheld: not knowable at ${k.asOf} under ${k.mode}.`);
      return result(k, {
        claims,
        record_ids: results.map(r => r.id),
        refusals: withheld > 0 ? [{ subject: `query:${results.length} shown`, value: null, refusalType: 'knowledge-state', remedy: `re-ask under mode=best_known or a later asOf to see the ${withheld} withheld entit${withheld === 1 ? 'y' : 'ies'}` }] : [],
        data,
        caveats: ['A miss here is a register gap, not proof of nonexistence — see data.registryGaps when present.'],
      });
    },
  },
  {
    name: 'search_evidence',
    description: 'Search the EPISTEMIC STATE instead of the register: kind=refused (what the system declines to quantify, optionally typed basis|component|topology|scope|attribution|resolution), stale (source|ladder|suspect|topology), contested (observer disagreement, typed by class), vintage (edition history). This is the instrument\'s account of its own limits — treat a result here as a finding about the evidence, not about the world. ZERO ITEMS IS AN ANSWER, NOT AN ABSENCE OF ONE: the returned `note` says which zero it is — none of that type in the topology at your asOf (with the condition that produces one, and often a date where it is live), or a type that does not exist, which is refused by name rather than answered empty. Report the note; do not conclude from an empty list that a mechanism is missing.' + CONTRACT_FOOTER,
    params: { kind: 'refused | stale | contested | vintage', type: 'Optional refusal/staleness type filter, e.g. basis.', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const kind = String(args.kind ?? '');
      if (!['refused', 'stale', 'contested', 'vintage'].includes(kind)) throw new Error('kind must be refused | stale | contested | vintage');
      const q = args.type ? `${kind}:${args.type}` : kind;
      const data = await fetchOk(ctx, `/api/economy/search?commodity=${args.commodity ?? 'copper'}&q=${encodeURIComponent(q)}&${ks(k)}`);
      const ev = (get(data, 'evidenceResults') as Array<Record<string, unknown>>) ?? [];
      // An undeclared type is refused AT THE BOUNDARY, like free text on an
      // entity id: an attached model handed an empty array cannot tell a
      // typo from a corpus that holds none of that type, and the wrong one
      // of those becomes "the instrument has no basis refusals" in prose.
      const undeclared = get(data, 'evidenceRefused') as { type?: string; declared?: string[] } | undefined;
      if (undeclared) {
        throw new Error(`"${kind}:${undeclared.type}" is not a declared ${kind} type. Declared: ${(undeclared.declared ?? []).join(', ')}.`);
      }
      const total = Number(get(data, 'evidenceTotal') ?? ev.length);
      const truncated = Boolean(get(data, 'evidenceTruncated'));
      const note = get(data, 'evidenceNote') as string | null | undefined;
      const byType = (get(data, 'evidenceByType') as Array<{ type: string; count: number }>) ?? [];
      const refusals: ToolRefusal[] = kind === 'refused'
        ? ev.map(e => ({ subject: String(e.subject ?? e.entityId ?? e.id ?? 'unknown'), value: null, refusalType: String(e.type ?? kind), remedy: String(e.remedy ?? e.explanation ?? 'see item') }))
        : [];
      return result(k, {
        // The count sentence states BOTH numbers, because "20 items" beside
        // a 30-deep queue is the same overstatement the validator exists to
        // catch, made by the substrate itself.
        claims: [
          `${ev.length} of ${total} ${kind} item(s) served at ${k.asOf} under ${k.mode}${truncated ? ' — the page is capped, the queue is not' : ''}.`,
          ...(byType.length > 0 ? [`By type: ${byType.map(t => `${kind}:${t.type} (${t.count})`).join(', ')}.`] : []),
          ...(note ? [note] : []),
        ],
        record_ids: ev.map(e => String(e.id ?? e.subject ?? '')).filter(Boolean),
        refusals,
        data,
        caveats: [
          'Evidence-layer results are computed from the knowledge-filtered state: a refusal that entered the corpus later never surfaces early.',
          ...(total === 0 ? ['Zero items is a statement about this corpus at this asOf, NOT evidence that the mechanism is absent — see the note for the condition that produces one.'] : []),
          ...(truncated ? [`Only ${ev.length} of ${total} served; GET /api/economy/refusals returns the full queue uncapped.`] : []),
        ],
      });
    },
  },
  {
    name: 'get_entity',
    description: 'Full canonical state of one entity at the stated knowledge state: observations with unit/basis/valueKind/source/knownAt, capacities, flows in/out, events, upstream/downstream chains. Every number arrives with its axes; a missing axis arrives as null AND flagged, never silently.' + CONTRACT_FOOTER,
    params: { id: 'Canonical entity id (ent:kind:slug), from search_entities.', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const id = String(args.id ?? '');
      if (!/^ent:[a-z-]+:[a-z0-9-]+$/.test(id)) throw new Error('id must be a canonical ent: identifier (free text is refused at the boundary)');
      const data = await fetchOk(ctx, `/api/economy/entity?commodity=${args.commodity ?? 'copper'}&id=${encodeURIComponent(id)}&${ks(k)}`);
      const obs = (get(data, 'observations') as Array<Record<string, unknown>>) ?? [];
      const claims = obs.slice(0, 12).map(o =>
        `${get(data, 'entity') && (get(get(data, 'entity'), 'name') as string)} ${o.metric} ${String((o.period as Record<string, unknown>)?.start ?? '').slice(0, 4)}: ${o.value} ${o.unit ?? '(unit unstated)'} [${o.basis ?? 'basis UNSTATED'}, ${o.valueKind}, ${(o.provenance as Record<string, unknown>)?.sourceId}]`);
      return result(k, {
        claims,
        record_ids: obs.map(o => String(o.id)),
        refusals: [],
        data,
        caveats: ['Facility-level identities in this corpus are representative-attested (curation); a claim resting on them is inadmissible under validate_claim.'],
      });
    },
  },
  {
    name: 'get_observations',
    description: 'The corpus as rows (the corpus table), or as the period × edition grid with view=grid. Every row carries record_id, subject, metric, value, unit, basis, value_kind, confidence, source, period, known_at, attestation, flags and a ready-to-paste `claim` sentence. Refused subjects are ROWS with null values and a remedy, not omissions. In the grid, a null cell is a period that edition did not cover — NOT a zero. Under as_known_then the header COUNTS withheld rows.' + CONTRACT_FOOTER,
    params: { subject: 'Optional canonical ent: id filter.', metric: 'Optional metric filter (production, refined_production, …).', view: 'rows (default) or grid (grid requires subject+metric).', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const qs = new URLSearchParams({ commodity: String(args.commodity ?? 'copper'), asOf: k.asOf, knowledge: k.mode, format: 'json' });
      if (args.subject) qs.set('subject', String(args.subject));
      if (args.metric) qs.set('metric', String(args.metric));
      if (args.view === 'grid') qs.set('view', 'grid');
      const data = await fetchOk(ctx, `/api/economy/table?${qs}`);
      if (args.view === 'grid') {
        const grid = get(data, 'grid') as Record<string, unknown>;
        return result(k, {
          claims: [`${get(grid, 'subject_label')} ${get(grid, 'metric')}: ${(get(grid, 'rows') as unknown[])?.length ?? 0} periods × ${(get(grid, 'editions') as unknown[])?.length ?? 0} editions. ${get(grid, 'legend')}`],
          record_ids: [],
          refusals: [],
          data,
          caveats: [String(get(grid, 'legend') ?? '')],
        });
      }
      const allRows = (get(data, 'rows') as Array<Record<string, unknown>>) ?? [];
      const header = get(data, 'header') as Record<string, unknown>;
      // D-13: the redistribution gate. A source whose machine-consumer
      // posture is internal_only or unresolved is WITHHELD from this
      // surface and returned as a typed refusal with its remedy — never
      // omitted, and never served on the assumption that silence is
      // permission. Refusal rows (which carry no servable quantity) pass
      // through: a refusal is ours to state, not the source's data.
      const quantitative = allRows.filter(r => !r.refusal) as Array<Record<string, unknown> & { source_id: string }>;
      const gate = gateRowsForMachines(quantitative);
      const rows: Array<Record<string, unknown>> = [...gate.served, ...allRows.filter(r => r.refusal)];
      const refusals: ToolRefusal[] = [
        ...gate.refusals,
        ...allRows
          .filter(r => r.refusal)
          .map(r => ({ subject: String(r.subject_id), value: null as null, refusalType: String((r.refusal as Record<string, unknown>).type), remedy: String((r.refusal as Record<string, unknown>).remedy) })),
      ];
      const withheld = (get(header, 'withheld') as number) ?? 0;
      const claims = rows.map(r => String(r.claim));
      if (withheld > 0) claims.push(`${withheld} row(s) withheld: not knowable at ${k.asOf} under ${k.mode} — counted, never silently absent.`);
      return result(k, {
        claims,
        record_ids: rows.map(r => String(r.record_id)),
        refusals,
        data: { ...(data as Record<string, unknown>), rows },
        caveats: [
          ...((get(header, 'caveats') as string[]) ?? []),
          ...(gate.refusals.length > 0
            ? ['Some rows are withheld from machine clients by redistribution posture (see refusals). The human surface serves them; this one does not.']
            : []),
        ],
      });
    },
  },
  {
    name: 'concentration',
    description: 'Concentration indices (HHI) for the commodity: by country, by facility, by operator (control AND economic-interest bases), capacity structure, and the trajectory. Every index arrives with its partition (groupCount, effectiveGroups, partitionFloor — raw HHIs across different partitions are NOT comparable), its completeness (weakestInputClass, coverage bias, unattributed remainder) and a rendered claim sentence. A null HHI is a REFUSAL over zero attributed tonnage, not a zero.' + CONTRACT_FOOTER,
    params: { commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const data = await fetchOk(ctx, `/api/economy?commodity=${args.commodity ?? 'copper'}&view=analytics&${ks(k)}`);
      const suite = get(data, 'concentration') as Record<string, unknown>;
      const indices: Array<Record<string, unknown>> = [];
      const claims: string[] = [];
      const recordIds: string[] = [];
      const refusals: ToolRefusal[] = [];
      for (const [name, entry] of Object.entries(suite ?? {})) {
        const inner = get(entry, 'result') ?? entry;
        if (!isConcentrationLike(inner)) continue;
        const claim = renderConcentrationClaim(name, inner);
        claims.push(claim);
        const ids = ((get(get(entry, 'inputs'), 'observationIds') as string[]) ?? []);
        recordIds.push(...ids);
        if (inner.hhi === null || inner.band === 'no-data') {
          refusals.push({ subject: name, value: null, refusalType: inner.hhi === null ? 'attribution' : 'no-data', remedy: inner.reason ?? 'no observations at the evaluation date; widen the date or the mode' });
        }
        indices.push({ name, hhi: inner.hhi, band: inner.band ?? null, claim, record_ids: ids, axes: concentrationAxes(name, inner) });
      }
      return result(k, {
        claims,
        record_ids: [...new Set(recordIds)],
        refusals,
        data: { indices, suite },
        caveats: ['No index in this corpus is reported-class end-to-end (weakestInputClass says which class taints each). Compare effectiveGroups across partitions, never raw HHI.'],
      });
    },
  },
  {
    name: 'propagate',
    description: 'Observed reconstruction: how the recorded disruption events propagate through the flow graph at the stated knowledge state — tonnage touched, downstream reach, alternatives with spare capacity. disruptedKtPerYear null means the figure CANNOT BE STATED at this date (e.g. the flow topology postdates the event) — null and 0 are different answers and arrive differently.' + CONTRACT_FOOTER,
    params: { commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const data = await fetchOk(ctx, `/api/economy?commodity=${args.commodity ?? 'copper'}&view=analytics&${ks(k)}`);
      const prop = get(data, 'propagation') as Record<string, unknown>;
      const impacts = ((get(prop, 'result') as ImpactLike[]) ?? []);
      const refusals: ToolRefusal[] = impacts
        .filter(i => i.disruptedKtPerYear === null)
        .map(i => ({ subject: i.entityId, value: null, refusalType: 'topology', remedy: i.explanation[i.explanation.length - 1] ?? 'evaluation date outside the flow topology period' }));
      return result(k, {
        claims: impacts.map(renderImpactClaim),
        record_ids: [...new Set(impacts.flatMap(i => [...i.flowIds, ...i.capacityIds, ...i.dependencyIds]))],
        refusals,
        data: prop,
        caveats: ['Recall on events is structurally zero outside the curated record: nothing here reads news. Absence of an impact is not absence of a disruption.'],
      });
    },
  },
  {
    name: 'scenario',
    description: 'Counterfactual event injection: hypothetical events run through the SAME propagation engine on an explicit counterfactual frame — the result can never be mistaken for a reconstruction. With mode=as_known_then this backtests the analytical layer: "given only what was knowable on asOf, what would propagation have concluded?" Nothing is written; the scenario exists only in this response.' + CONTRACT_FOOTER,
    params: { label: 'Scenario label.', events: 'Array of {entityId, type, title, start, end?, severity} — canonical ids only.', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const body = JSON.stringify({ commodity: args.commodity ?? 'copper', asOf: k.asOf, knowledge: k.mode, label: args.label ?? 'mcp scenario', events: args.events });
      const data = await fetchOk(ctx, '/api/economy/scenario', { method: 'POST', body });
      const delta = get(data, 'delta') as Record<string, unknown>;
      const newly = (get(delta, 'newlyDisrupted') as unknown[]) ?? [];
      const kt = get(delta, 'disruptedKtPerYear');
      const unobserved = (get(data, 'unobservedStates') as Array<{
        observability?: { reasonCode?: string };
        metric?: { name?: string; value?: null };
        acquisition?: { remedy?: string };
      }>) ?? [];
      const claims = [
        `Counterfactual "${args.label ?? 'mcp scenario'}" at ${k.asOf} (${k.mode}): ${newly.length} newly disrupted entit${newly.length === 1 ? 'y' : 'ies'}${typeof kt === 'number' ? `, ~${kt.toLocaleString()} kt/y newly touched` : kt === null ? `, tonnage REFUSED with ${unobserved.length} typed unobserved state${unobserved.length === 1 ? '' : 's'}` : ''}. This is a HYPOTHETICAL — the frame is counterfactual, never a reconstruction.`,
      ];
      return result(k, {
        claims,
        record_ids: [],
        refusals: unobserved.length > 0
          ? unobserved.map(state => ({
            subject: `unobservedStates.${state.metric?.name ?? 'disruptedKtPerYear'}`,
            value: null,
            refusalType: state.observability?.reasonCode ?? 'impact_evidence_unobserved',
            remedy: state.acquisition?.remedy ?? 'Acquire the missing evidence and replay the scenario.',
          }))
          : kt === null
            ? [{ subject: 'delta.disruptedKtPerYear', value: null, refusalType: 'impact_evidence_unobserved', remedy: 'Acquire the missing impact evidence and replay the scenario.' }]
            : [],
        data,
        caveats: ['Counterfactual frame: nothing in this result describes the observed world.'],
      });
    },
  },
  {
    name: 'refusals_digest',
    description: 'Everything the instrument currently declines to answer, grouped by refusal type with each type\'s shared remedy, most-blocking mechanism first. THIS IS A WORK QUEUE, and the most useful artifact the corpus produces: a refusal here is a typed, remediable gap — never omitted, never guessed over. Do not fill these from external knowledge; the remedy states what would resolve each.' + CONTRACT_FOOTER,
    params: { commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const data = await fetchOk(ctx, `/api/economy/refusals?commodity=${args.commodity ?? 'copper'}&${ks(k)}`);
      const byType = (get(data, 'byType') as Array<{ type: string; remedy: string; count: number; items: Array<Record<string, unknown>> }>) ?? [];
      const refusals: ToolRefusal[] = byType.flatMap(g =>
        g.items.map(it => ({ subject: String(it.entityId ?? it.title ?? 'unknown'), value: null as null, refusalType: g.type, remedy: g.remedy })));
      return result(k, {
        claims: byType.map(g => `${g.count} refusal(s) of type "${g.type}" — remedy: ${g.remedy}`),
        record_ids: [],
        refusals,
        data,
        caveats: ['Uncapped by design: a work queue that silently truncated would read as "covered".'],
      });
    },
  },
  {
    name: 'corpus_health',
    description: 'The instrument watching its own blindness: sources past their measured cadence, degradation-ladder position, plausibility-suspect sources, aging topology. EMPTY IS THE HEALTHY STATE — an empty array means no signal, not no check. Each signal carries its explanation and remedy; the source registry\'s owner/maintenance fields say whose move it is.' + CONTRACT_FOOTER,
    params: { commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const data = await fetchOk(ctx, `/api/economy?commodity=${args.commodity ?? 'copper'}&view=analytics&${ks(k)}`);
      const signals = (get(data, 'corpusHealth') as Array<Record<string, unknown>>) ?? [];
      return result(k, {
        claims: signals.length === 0
          ? ['Corpus healthy at this knowledge state — zero signals (silence is the healthy state).']
          : signals.map(s => `[${s.kind}] ${s.sourceId ?? s.subject ?? ''}: ${s.explanation ?? s.note ?? JSON.stringify(s)}`),
        record_ids: [],
        refusals: [],
        data: signals,
        caveats: ['A signal is the system seeing its own staleness — it does not invalidate served figures, which carry their own knownAt.'],
      });
    },
  },
  {
    name: 'source_registry',
    description: 'Every source the instrument knows: built adapters (with owner and maintenance cadence) AND registered-but-unbuilt sources — the null-adapter entries ARE the gap list, ranked by the miss log\'s demand evidence. A question this corpus cannot answer is often named here with the source that could.' + CONTRACT_FOOTER,
    params: { ...KNOWLEDGE_PARAMS },
    async handler(args) {
      const k = requireKnowledge(args);
      const built = SOURCE_REGISTRY.filter(s => s.adapter !== null);
      const gaps = SOURCE_REGISTRY.filter(s => s.adapter === null);
      return result(k, {
        claims: [
          `${built.length} built source(s), ${gaps.length} registered gap(s).`,
          ...gaps.map(g => `GAP: ${g.name} (${g.cadence}, ${g.accessClass}) — would yield ${g.yields.join('/')}.`),
        ],
        record_ids: SOURCE_REGISTRY.map(s => s.sourceId),
        refusals: [],
        data: SOURCE_REGISTRY,
        caveats: ['Registry entries are declarations, not data: a gap names what a source COULD answer, not what it has.'],
      });
    },
  },
  {
    name: 'validate_claim',
    description: 'Validate a natural-language claim against the records it cites — the claim comes from whatever model produced it, the verdict comes from the substrate. Verdicts: supported | partially_supported | unsupported | overstated (more precise than its inputs — the most common real verdict, because prose smooths uncertainty) | inadmissible (rests on representative-attested input, which today is EVERY facility-level record in this corpus). The validator judges only the support relation: it never recomputes analytics and never supplies missing evidence from its own knowledge. An empty evidence chain is unsupported, not an error.' + CONTRACT_FOOTER,
    params: { claim: 'The claim sentence to validate.', record_ids: 'Array of record ids the claim cites (obs:…, flow:…, cap:…).', commodity: 'copper (default) or aluminium.', ...KNOWLEDGE_PARAMS },
    async handler(args, ctx) {
      const k = requireKnowledge(args);
      const ids = Array.isArray(args.record_ids) ? (args.record_ids as string[]) : [];
      const qs = new URLSearchParams({ commodity: String(args.commodity ?? 'copper'), claim: String(args.claim ?? ''), records: ids.join(','), asOf: k.asOf, knowledge: k.mode });
      const data = await fetchOk(ctx, `/api/economy/validate?${qs}`);
      const verdict = String(get(data, 'verdict'));
      return result(k, {
        claims: [`VERDICT: ${verdict} — ${get(data, 'reason')}`],
        record_ids: ids,
        refusals: verdict === 'inadmissible'
          ? [{ subject: String(args.claim ?? '').slice(0, 80), value: null, refusalType: 'inadmissible-evidence', remedy: String(get(data, 'reason') ?? 'cited records are representative-class') }]
          : [],
        data,
        caveats: ['The validator judges the support relation only. A supported verdict means the cited records support the numbers as stated — not that the claim is true.'],
      });
    },
  },
];

/** How many refusal-shaped things a result surfaced — the F-4 counter.
 *  Counted from the typed refusals array, never inferred from prose. */
export function refusalCount(r: McpToolResult): number {
  return r.refusals.length;
}

/** Run one tool with session logging (F-4). Tool name and refusal COUNT
 *  are logged; no parameter value ever reaches the log. */
export async function runMcpTool(def: McpToolDef, args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult> {
  const res = await def.handler(args, ctx);
  recordMcpCall(def.name, refusalCount(res));
  return res;
}
