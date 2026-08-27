/**
 * Sea Dog Terminal — session telemetry (work order 3.7).
 *
 * Instrument telemetry for the researcher afternoon: what was asked, what
 * missed, what the system refused, which entities were inspected. The
 * point is that the session produces EVIDENCE rather than an impression —
 * twenty-six rounds of interaction on record are all builder validation,
 * and this is the counter set that makes a real session measurable.
 *
 * NO PERSONAL DATA, by construction: counters and canonical entity ids
 * only. Query STRINGS are never held here — the miss log's vocabulary
 * gate governs the one place query text is retained, and this module
 * records only that a person-shaped query was counted (the same
 * counted-not-retained rule, applied to telemetry).
 *
 * In-memory, per server process: an afternoon's session is one process;
 * the digest is read at the end and the counters die with the process.
 */

export interface SessionDigest {
  startedAt: string;
  /** Entity-register searches served. */
  queries: number;
  /** True misses (no results, nothing withheld) — each also appended to
   *  the persistent miss log by the search route. */
  misses: number;
  /** Queries whose matches were withheld by the knowledge state. */
  withheldQueries: number;
  /** Misses whose query string the vocabulary gate refused to retain —
   *  counted here, string discarded everywhere. */
  personShapedCounted: number;
  /** Evidence-layer queries by kind (refused/stale/contested/vintage). */
  evidenceQueriesByKind: Record<string, number>;
  /** Refusal digests exported. */
  refusalDigestsServed: number;
  /** Corpus-table/grid exports served — the one POSITIVE demand signal:
   *  an export is someone carrying a number into their own work. */
  exportsServed: number;
  /** Canonical entity ids inspected via the entity endpoint. */
  entitiesInspected: string[];
  note: string;
}

const state = {
  startedAt: new Date().toISOString(),
  queries: 0,
  misses: 0,
  withheldQueries: 0,
  personShapedCounted: 0,
  evidenceQueriesByKind: {} as Record<string, number>,
  refusalDigestsServed: 0,
  exportsServed: 0,
  entitiesInspected: new Set<string>(),
};

export function recordQuery(outcome: { miss: boolean; withheld: number; personShaped: boolean }): void {
  state.queries += 1;
  if (outcome.miss) state.misses += 1;
  if (outcome.withheld > 0) state.withheldQueries += 1;
  if (outcome.personShaped) state.personShapedCounted += 1;
}

export function recordEvidenceQuery(kind: string): void {
  state.evidenceQueriesByKind[kind] = (state.evidenceQueriesByKind[kind] ?? 0) + 1;
}

export function recordRefusalDigest(): void {
  state.refusalDigestsServed += 1;
}

export function recordExport(): void {
  state.exportsServed += 1;
}

export function recordEntityInspected(entityId: string): void {
  state.entitiesInspected.add(entityId);
}

export function sessionDigest(): SessionDigest {
  return {
    startedAt: state.startedAt,
    queries: state.queries,
    misses: state.misses,
    withheldQueries: state.withheldQueries,
    personShapedCounted: state.personShapedCounted,
    evidenceQueriesByKind: { ...state.evidenceQueriesByKind },
    refusalDigestsServed: state.refusalDigestsServed,
    exportsServed: state.exportsServed,
    entitiesInspected: [...state.entitiesInspected].sort(),
    note: 'Instrument telemetry: counters and canonical entity ids only. Query strings are never retained here; the miss log\'s vocabulary gate governs the one place query text persists.',
  };
}

/** Test seam: a simulated session must start from zero. */
export function resetSessionTelemetry(): void {
  state.startedAt = new Date().toISOString();
  state.queries = 0;
  state.misses = 0;
  state.withheldQueries = 0;
  state.personShapedCounted = 0;
  state.evidenceQueriesByKind = {};
  state.refusalDigestsServed = 0;
  state.exportsServed = 0;
  state.entitiesInspected.clear();
}
