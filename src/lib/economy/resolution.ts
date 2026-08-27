/**
 * Sea Dog Terminal — the entity resolution gate (work order 3.3).
 *
 * The deterministic gate the resolver contract has assumed since round 1:
 * proposals in, accept / unresolved out, nothing silently dropped. Round 25
 * found unmapped M49 codes and MCS country names being silently discarded;
 * round 26 made the drops COUNTABLE (RowAccounting); this makes them
 * RECORDS: each unresolved identifier is typed, carries its raw form
 * verbatim, its source, its row count, and the remedy that would resolve
 * it, and surfaces through the epistemic-state search as
 * `refused:resolution`.
 *
 * Two rules the gate enforces by construction:
 *
 *   NEVER MERGE ON SIMILARITY. A near match in the register (case,
 *   diacritics, containment — 'Perú' beside 'Peru') surfaces as a
 *   CANDIDATE on the unresolved record, for a curator. Resolution happens
 *   only through the curated scheme maps; a proposal below certainty is
 *   unresolved, not assigned. Both near-colliding entities always survive.
 *
 *   DETERMINISTIC. Same proposals + same register → same records, same
 *   order (sorted by scheme, then identifier). No clock, no randomness.
 */

import type { Entity, UnresolvedIdentifier } from './types';

/** One resolution-layer drop site's tally: raw identifier → occurrences
 *  (+ example context). The adapters build these at the same code points
 *  that feed RowAccounting, so the reconciliation is structural. */
export type UnresolvedTally = Map<string, { occurrences: number; context?: string }>;

/** Case- and diacritic-folded form, for CANDIDATE detection only — never
 *  for resolution. */
const fold = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const NEVER_MERGE_NOTE =
  'name-similar in the register — similarity is never sufficient to merge; curate the mapping explicitly or record the identifier as out of scope';

/** Register entities whose name is similar to the identifier: folded
 *  equality, or folded containment in either direction (≥4 chars, to keep
 *  containment from matching noise). Informational only. */
export function nameCandidates(identifier: string, register: Entity[]): UnresolvedIdentifier['candidates'] {
  const id = fold(identifier);
  if (id.length === 0) return undefined;
  const out: NonNullable<UnresolvedIdentifier['candidates']> = [];
  for (const e of register) {
    const name = fold(e.name);
    const similar = name === id
      || (id.length >= 4 && name.includes(id))
      || (name.length >= 4 && id.includes(name));
    if (similar) out.push({ entityId: e.id, name: e.name, note: NEVER_MERGE_NOTE });
  }
  out.sort((a, b) => a.entityId.localeCompare(b.entityId));
  return out.length > 0 ? out : undefined;
}

/**
 * Build the typed unresolved records for one (scheme, source) drop site.
 * Every tallied identifier becomes exactly one record — the sum of
 * `occurrences` equals the accounting's filtered count for the same
 * predicate, and the reconciliation test holds the two together.
 */
export function buildUnresolvedRecords(
  scheme: string,
  sourceId: string,
  tally: UnresolvedTally,
  register: Entity[],
  remedy: string,
): UnresolvedIdentifier[] {
  const records: UnresolvedIdentifier[] = [];
  for (const [identifier, t] of tally) {
    const candidates = nameCandidates(identifier, register);
    records.push({
      scheme, identifier, sourceId,
      occurrences: t.occurrences,
      ...(t.context ? { context: t.context } : {}),
      ...(candidates ? { candidates } : {}),
      remedy,
    });
  }
  records.sort((a, b) => a.scheme.localeCompare(b.scheme) || a.identifier.localeCompare(b.identifier));
  return records;
}

/** Deterministic order for the assembled state's gate residue. */
export function sortUnresolved(records: UnresolvedIdentifier[]): UnresolvedIdentifier[] {
  return [...records].sort((a, b) =>
    a.sourceId.localeCompare(b.sourceId)
    || a.scheme.localeCompare(b.scheme)
    || a.identifier.localeCompare(b.identifier));
}
