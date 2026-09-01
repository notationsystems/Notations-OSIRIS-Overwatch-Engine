/**
 * Payload Terminal — the claim validator (final order F-3; the round-1
 * contract, built in phase 36).
 *
 * A claim arrives from whatever model the analyst is using; the verdict
 * comes from the substrate. The validator judges ONLY the support
 * relation between the claim's numbers and the records it cites:
 *
 *   - it never recomputes the analytics (STRUCTURAL: this module imports
 *     nothing from the engine/graph/analytics operations — pinned by a
 *     source-text test, the same shape as the export surface's GET-only
 *     pin);
 *   - it never supplies missing evidence from its own or anyone's
 *     knowledge — an empty or unresolvable evidence chain is
 *     `unsupported`, never an error and never repaired;
 *   - a claim resting on ANY representative-attested input is
 *     `inadmissible` — which today is every facility-level record in
 *     this corpus, and the verdict says so rather than softening it;
 *   - a claim more precise than its inputs is `overstated` — the most
 *     common real verdict, because prose smooths uncertainty by default.
 */

import type { EconomyState } from './types';

export type ClaimVerdict = 'supported' | 'partially_supported' | 'unsupported' | 'overstated' | 'inadmissible';

export interface ValidationResult {
  verdict: ClaimVerdict;
  reason: string;
  /** Cited records whose values the claim's numbers state exactly. */
  supporting: string[];
  /** Cited ids that do not exist, are not knowable at the knowledge
   *  state, or carry no value the claim states. */
  contradicting: string[];
  /** Precision mismatches, named: what the claim says vs what the record carries. */
  mismatches: Array<{ claimed: number; record_id: string; record_value: number; note: string }>;
  /** The numeric assertions extracted from the claim text. */
  extracted: number[];
}

interface CitedRecord {
  id: string;
  value: number;
  unit: string;
  valueKind: string;
  knownAt: string;
}

/** Resolve cited ids across observations, flows and capacities — the three
 *  quantitative record families. knowableBy: under as_known_then, a record
 *  not knowable at asOf cannot support anything (hindsight evidence). */
function resolveCited(state: EconomyState, ids: string[], knowableBy: string | null): { resolved: CitedRecord[]; unresolved: string[] } {
  const resolved: CitedRecord[] = [];
  const unresolved: string[] = [];
  for (const id of ids) {
    const o = state.observations.find(x => x.id === id);
    if (o) {
      const knownAt = o.knownAt ?? o.provenance.retrievedAt.slice(0, 10);
      if (knowableBy && knownAt > knowableBy) { unresolved.push(id); continue; }
      resolved.push({ id, value: o.value, unit: o.unit, valueKind: o.valueKind, knownAt });
      continue;
    }
    const f = state.flows.find(x => x.id === id);
    if (f) {
      resolved.push({ id, value: f.quantity, unit: f.unit, valueKind: f.valueKind, knownAt: f.provenance.retrievedAt.slice(0, 10) });
      continue;
    }
    const c = state.capacities.find(x => x.id === id);
    if (c) {
      resolved.push({ id, value: c.value, unit: c.unit, valueKind: c.valueKind, knownAt: c.provenance.retrievedAt.slice(0, 10) });
      continue;
    }
    unresolved.push(id);
  }
  return { resolved, unresolved };
}

/** Numeric assertions in the claim text. Bare 4-digit years (1900–2099)
 *  are dates, not quantities, and are not extracted. */
export function extractClaimNumbers(claim: string): number[] {
  const out: number[] = [];
  for (const m of claim.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
    const raw = m[0].replaceAll(',', '');
    if (/^(19|20)\d{2}$/.test(raw)) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

const EPS = 1e-9;
/** Near, but not what the record says: the overstatement band. */
const NEAR_REL = 0.005;

export function validateClaim(
  state: EconomyState,
  claim: string,
  recordIds: string[],
  { knowableBy = null as string | null } = {},
): ValidationResult {
  const { resolved, unresolved } = resolveCited(state, recordIds, knowableBy);
  const extracted = extractClaimNumbers(claim);

  if (resolved.length === 0) {
    return {
      verdict: 'unsupported',
      reason: recordIds.length === 0
        ? 'empty evidence chain: the claim cites no records — unsupported, not an error, and the validator will not supply evidence the claim did not cite'
        : `none of the ${recordIds.length} cited record(s) resolve${knowableBy ? ` as knowable at ${knowableBy}` : ''}: [${unresolved.join(', ')}]`,
      supporting: [], contradicting: unresolved, mismatches: [], extracted,
    };
  }

  // Admissibility is PRIOR to numeric support: one representative input
  // taints the claim whatever the other inputs are (the contamination
  // lattice direction — weakest input governs derived assertions).
  const representative = resolved.filter(r => r.valueKind === 'representative');
  if (representative.length > 0) {
    return {
      verdict: 'inadmissible',
      reason: `the claim rests on ${representative.length} representative-class record(s) [${representative.map(r => r.id).join(', ')}] — curated magnitudes that prove the pipeline, not reported data. Every facility-level quantity in this corpus is currently representative-class, so every facility-level claim is inadmissible today; that is the honest state of the corpus, not a defect in the claim.`,
      supporting: [], contradicting: [], mismatches: [], extracted,
    };
  }

  if (extracted.length === 0) {
    return {
      verdict: 'unsupported',
      reason: 'no quantitative assertion could be extracted from the claim; the validator judges numeric support relations and does not certify prose structure',
      supporting: [], contradicting: unresolved, mismatches: [], extracted,
    };
  }

  const supporting = new Set<string>();
  const mismatches: ValidationResult['mismatches'] = [];
  let unmatched = 0;
  for (const t of extracted) {
    const exact = resolved.find(r => Math.abs(r.value - t) <= EPS);
    if (exact) { supporting.add(exact.id); continue; }
    const near = resolved.find(r => Math.abs(r.value - t) / Math.max(Math.abs(r.value), 1) <= NEAR_REL);
    if (near) {
      mismatches.push({ claimed: t, record_id: near.id, record_value: near.value, note: `claim states ${t}; ${near.id} carries ${near.value} (${near.valueKind}) — the extra precision is the claim's, not the record's` });
    } else {
      unmatched += 1;
    }
  }

  if (mismatches.length > 0) {
    return {
      verdict: 'overstated',
      reason: `the claim is more precise than its inputs: ${mismatches.map(m => m.note).join('; ')}`,
      supporting: [...supporting], contradicting: unresolved, mismatches, extracted,
    };
  }
  if (supporting.size > 0 && unmatched === 0 && unresolved.length === 0) {
    return {
      verdict: 'supported',
      reason: `every numeric assertion in the claim is carried exactly by a cited record (${[...supporting].join(', ')}). Supported means the cited records state these numbers — not that the claim is true.`,
      supporting: [...supporting], contradicting: [], mismatches: [], extracted,
    };
  }
  if (supporting.size > 0) {
    return {
      verdict: 'partially_supported',
      reason: `${supporting.size} assertion(s) carried by cited records; ${unmatched} numeric assertion(s) match no cited record${unresolved.length > 0 ? `; ${unresolved.length} cited id(s) do not resolve` : ''}`,
      supporting: [...supporting], contradicting: unresolved, mismatches: [], extracted,
    };
  }
  return {
    verdict: 'unsupported',
    reason: `no numeric assertion in the claim is carried by any cited record — the cited evidence contradicts the claim as stated (cited: ${resolved.map(r => `${r.id}=${r.value} ${r.unit}`).join(', ')})`,
    supporting: [], contradicting: [...resolved.map(r => r.id), ...unresolved], mismatches: [], extracted,
  };
}
