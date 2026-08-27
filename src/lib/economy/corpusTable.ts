/**
 * Sea Dog Terminal — corpus table and export surface (operator addition to
 * the shipping order, placed before S-6).
 *
 * A PROJECTION over canonical state: no new number, no new consumer of
 * analytics — every field below already rides on the records. Never
 * authoritative, never editable, never re-importable (the route is
 * GET-only and no parser for the export format exists in this codebase).
 *
 * The export carries the axes or it does not export: a flat table of bare
 * numbers is the incommensurability defect at distribution scale. A row
 * with an unknown axis exports it as null AND FLAGGED — omission is how a
 * reader assumes; null is how they check. Refusal records (the resolution
 * gate's residue) export as rows with null values and their remedy: the
 * corpus table and the refusals queue are the same object seen from two
 * sides.
 *
 * Each row also carries a server-rendered CLAIM sentence — the value with
 * every axis attached, ready to paste. An external client (a person or a
 * model attached via any future tool surface) that copies the sentence
 * carries the epistemics with it; reconstructing a sentence from the JSON
 * is strictly more work than pasting the honest one.
 */

import { createHash } from 'node:crypto';
import type { EconomyState, Observation } from './types';
import { knownAtOf, strongestAttestingClass, structuralClassProfile, type AttestationKind } from './analytics';

export interface CorpusRow {
  record_id: string;
  subject_id: string;
  subject_label: string;
  metric: string;
  /** null on a refusal row — unknown, never zero. */
  value: number | null;
  unit: string | null;
  /** metal_content | gross_weight | unspecified | null (flagged). */
  basis: string | null;
  value_kind: string | null;
  confidence: string | null;
  source_id: string;
  source_name: string;
  period_start: string | null;
  period_end: string | null;
  known_at: string | null;
  supersedes: string | null;
  attestation: AttestationKind | null;
  /** Refusal rows only: the typed reason and its remedy. */
  refusal?: { type: string; remedy: string };
  /** Every axis the row could not state, named — never silently omitted. */
  flags: string[];
  /** The server-rendered sentence: the value with its axes attached. */
  claim: string;
}

export interface CorpusHeader {
  generated_at: string;
  knowledge_state: { as_of: string | null; mode: 'best_known' | 'as_known_then' };
  baseline_fingerprint: string;
  query: Record<string, string | null>;
  row_count: number;
  /** Rows the knowledge state withheld — counted, never silently absent. */
  withheld: number;
  /** Row accounting carried through to the export. */
  filtered: Array<{ predicate: string; count: number }>;
  caveats: string[];
}

export interface CorpusTable { header: CorpusHeader; rows: CorpusRow[] }

/** Deterministic fingerprint of the state a table was computed from: an
 *  exported number in someone's deck six months from now can be checked
 *  against the state it came from — the one thing that stops export being
 *  where provenance goes to die. */
export function stateFingerprint(state: EconomyState): string {
  const canon = JSON.stringify({
    c: state.commodity,
    e: state.entities.map(x => x.id).sort(),
    o: state.observations.map(x => [x.id, x.value, knownAtOf(x)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    f: state.flows.map(x => [x.id, x.quantity]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    cap: state.capacities.map(x => [x.id, x.value]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    u: (state.unresolved ?? []).map(x => [x.scheme, x.identifier, x.occurrences]),
  });
  return createHash('sha256').update(canon).digest('hex').slice(0, 16);
}

const label = (state: EconomyState, id: string): string =>
  state.entities.find(e => e.id === id)?.name ?? id;

function claimSentence(r: Omit<CorpusRow, 'claim'>): string {
  if (r.refusal) {
    return `${r.subject_label}: ${r.metric} REFUSED (${r.refusal.type}) — ${r.refusal.remedy}`;
  }
  const basis = r.basis ?? 'basis UNSTATED';
  const known = r.known_at ? `knowable from ${r.known_at.slice(0, 10)}` : 'knowability unstated';
  return `${r.subject_label} ${r.metric} ${r.period_start?.slice(0, 4) ?? '?'}: ${r.value} ${r.unit ?? '(unit unstated)'} [${basis}, ${r.value_kind}, ${r.attestation ?? 'attestation unknown'}-attested subject, ${r.source_id}, ${known}]`;
}

export function buildCorpusTable(
  state: EconomyState,
  query: { metric?: string; subject?: string },
  { asOf = null as string | null, knowledge = 'best_known' as 'best_known' | 'as_known_then' } = {},
): CorpusTable {
  const attestation = strongestAttestingClass(state);
  const rows: CorpusRow[] = [];
  let withheld = 0;
  let partnerScoped = 0;
  const restrict = knowledge === 'as_known_then' && asOf ? asOf : null;

  for (const o of state.observations) {
    if (o.partnerEntityId) { partnerScoped += 1; continue; } // bilateral rows live with the divergence system
    if (query.metric && o.metric !== query.metric) continue;
    if (query.subject && o.entityId !== query.subject) continue;
    if (restrict && knownAtOf(o) > restrict) { withheld += 1; continue; }
    const flags: string[] = [];
    if (!o.basis) flags.push('basis unspecified — flagged, not defaulted');
    const base: Omit<CorpusRow, 'claim'> = {
      record_id: o.id,
      subject_id: o.entityId,
      subject_label: label(state, o.entityId),
      metric: o.metric,
      value: o.value,
      unit: o.unit,
      basis: o.basis ?? null,
      value_kind: o.valueKind,
      confidence: o.confidence ?? null,
      source_id: o.provenance.sourceId,
      source_name: o.provenance.sourceName,
      period_start: o.period.start,
      period_end: o.period.end,
      known_at: knownAtOf(o),
      supersedes: o.supersedes ?? null,
      attestation: attestation.get(o.entityId) ?? null,
      flags,
    };
    rows.push({ ...base, claim: claimSentence(base) });
  }

  // The resolution gate's residue as rows — a refused subject is a row
  // with a null value and its remedy, never an omission.
  let refusalRows = 0;
  if (!query.metric || query.metric === 'resolution') {
    for (const u of state.unresolved ?? []) {
      if (query.subject) continue; // unresolved identifiers have no subject id yet — that is the point
      refusalRows += 1;
      const base: Omit<CorpusRow, 'claim'> = {
        record_id: `${u.sourceId}:${u.scheme}:${u.identifier}`,
        subject_id: `unresolved:${u.scheme}:${u.identifier}`,
        subject_label: `[unresolved ${u.scheme}] "${u.identifier}"`,
        metric: 'resolution',
        value: null, unit: null, basis: null, value_kind: null, confidence: null,
        source_id: u.sourceId, source_name: u.sourceId,
        period_start: null, period_end: null, known_at: null, supersedes: null,
        attestation: null,
        refusal: { type: 'resolution', remedy: u.remedy },
        flags: [`${u.occurrences} source row(s) dropped at the resolution gate`],
      };
      rows.push({ ...base, claim: claimSentence(base) });
    }
  }

  const profile = structuralClassProfile(state);
  const header: CorpusHeader = {
    generated_at: new Date().toISOString(),
    knowledge_state: { as_of: asOf, mode: knowledge },
    baseline_fingerprint: stateFingerprint(state),
    query: { commodity: state.commodity, metric: query.metric ?? null, subject: query.subject ?? null },
    row_count: rows.length,
    withheld,
    filtered: [
      ...(partnerScoped > 0 ? [{ predicate: 'partner-scoped bilateral row — served by the divergence system, not this table', count: partnerScoped }] : []),
      ...(refusalRows > 0 ? [{ predicate: 'resolution-gate refusal exported as null-valued row (not an omission)', count: refusalRows }] : []),
    ],
    caveats: [
      profile.note,
      'Every facility-level identity in this corpus is representative-attested (curation); country identities may be live-attested — the attestation column says which, per row.',
    ],
  };
  return { header, rows };
}

/* ── The two-axis grid: period × source edition ──
 * Reading down a column is one edition's account of history; reading
 * across a row is the revision history of one fact. An EMPTY cell is a
 * period that edition did not cover — different from zero, and it must
 * never render like one. */
export interface VintageGrid {
  subject_id: string;
  subject_label: string;
  metric: string;
  unit: string | null;
  basis: string | null;
  /** Column order = editions by earliest knowability. */
  editions: string[];
  rows: Array<{
    period: string;
    /** Aligned with `editions`; null = NOT COVERED by that edition (not zero). */
    cells: Array<{ value: number; value_kind: string; known_at: string } | null>;
  }>;
  legend: string;
}

export function buildVintageGrid(state: EconomyState, subject: string, metric: string): VintageGrid {
  const obs = state.observations.filter(o => o.entityId === subject && o.metric === metric && !o.partnerEntityId);
  const editionFirstKnown = new Map<string, string>();
  for (const o of obs) {
    const ed = o.provenance.sourceId;
    const k = knownAtOf(o);
    if (!editionFirstKnown.has(ed) || k < editionFirstKnown.get(ed)!) editionFirstKnown.set(ed, k);
  }
  const editions = [...editionFirstKnown.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([ed]) => ed);
  const periods = [...new Set(obs.map(o => o.period.start.slice(0, 4)))].sort();
  const cellFor = (period: string, edition: string) => {
    const o = obs.find(x => x.period.start.startsWith(period) && x.provenance.sourceId === edition);
    return o ? { value: o.value, value_kind: o.valueKind, known_at: knownAtOf(o) } : null;
  };
  return {
    subject_id: subject,
    subject_label: label(state, subject),
    metric,
    unit: obs[0]?.unit ?? null,
    basis: obs[0]?.basis ?? null,
    editions,
    rows: periods.map(period => ({ period, cells: editions.map(ed => cellFor(period, ed)) })),
    legend: 'A dash is a period this edition did not cover — NOT a zero. A single-populated row is a fact never revised. Reading across a row is the revision history of one fact; down a column, one edition\'s account of history.',
  };
}

/* ── Markdown rendering — same objects, same values as the JSON ── */

export function renderTableMarkdown(t: CorpusTable): string {
  const h = t.header;
  const lines: string[] = [
    `# Sea Dog Terminal — corpus table`,
    '',
    '```',
    `generated_at          ${h.generated_at}`,
    `knowledge_state       ${h.knowledge_state.mode}${h.knowledge_state.as_of ? ` @ ${h.knowledge_state.as_of}` : ''}`,
    `baseline_fingerprint  ${h.baseline_fingerprint}`,
    `query                 ${JSON.stringify(h.query)}`,
    `row_count             ${h.row_count}`,
    `withheld              ${h.withheld}`,
    ...h.filtered.map(f => `filtered              ${f.count} — ${f.predicate}`),
    ...h.caveats.map(c => `caveat                ${c}`),
    '```',
    '',
    '| subject | metric | value | unit | basis | value_kind | source | period | known_at | attestation | flags |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of t.rows) {
    lines.push(`| ${r.subject_label} | ${r.metric} | ${r.value ?? 'null (refused)'} | ${r.unit ?? '—'} | ${r.basis ?? 'NULL(flagged)'} | ${r.value_kind ?? '—'} | ${r.source_id} | ${r.period_start?.slice(0, 4) ?? '—'} | ${r.known_at?.slice(0, 10) ?? '—'} | ${r.attestation ?? '—'} | ${r.flags.join('; ') || ''} |`);
  }
  lines.push('', '## Claims (paste these, not bare numbers)', '');
  for (const r of t.rows) lines.push(`- ${r.claim}`);
  return lines.join('\n');
}

export function renderGridMarkdown(g: VintageGrid): string {
  const lines = [
    `# ${g.subject_label} — ${g.metric} (${g.unit ?? 'unit unstated'}, ${g.basis ?? 'basis UNSTATED'})`,
    '',
    `> ${g.legend}`,
    '',
    `| period \\ edition | ${g.editions.join(' | ')} |`,
    `|---|${g.editions.map(() => '---').join('|')}|`,
  ];
  for (const row of g.rows) {
    lines.push(`| ${row.period} | ${row.cells.map(c => c === null ? '—' : `${c.value}${c.value_kind === 'estimated' ? ' (e)' : ''}`).join(' | ')} |`);
  }
  return lines.join('\n');
}
