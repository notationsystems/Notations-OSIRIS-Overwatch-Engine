/**
 * OSIRIS — Canonical economy state assembly.
 *
 * Merges adapter payloads into one validated EconomyState per commodity and
 * derives the relationships that are mechanical consequences of the data
 * (located_in from countryCode, feeds from flows) so adapters never have to
 * hand-author them. Derived dependencies carry a provenance that names the
 * derivation — they are inference, and must look like it.
 */

import type { Dependency, EconomyState, Entity, ValidationIssue } from './types';
import { validateState } from './types';
import { adaptersFor, type RowAccounting } from './adapters';
import { nameCandidates, sortUnresolved } from './resolution';

export interface AssembledState {
  state: EconomyState;
  issues: ValidationIssue[];
  providers: string[];
  /** Row accounting from every adapter that fetched anything — filtering is
   *  never free; see RowAccounting. */
  accounting: RowAccounting[];
}

/** Derive located_in country dependencies from entity.countryCode. */
function deriveLocatedIn(entities: Entity[]): Dependency[] {
  const countryByCode = new Map<string, Entity>();
  for (const e of entities) if (e.kind === 'country' && e.countryCode) countryByCode.set(e.countryCode, e);

  const deps: Dependency[] = [];
  for (const e of entities) {
    if (e.kind === 'country' || !e.countryCode) continue;
    const country = countryByCode.get(e.countryCode);
    if (!country) continue; // Port in a non-modeled country (e.g. Tanzania) — fine, skip.
    deps.push({
      id: `dep:located:${e.id.replace(/^ent:/, '').replace(/:/g, '-')}`,
      fromEntityId: e.id,
      type: 'located_in',
      toEntityId: country.id,
      provenance: {
        sourceId: 'osiris-derived',
        sourceName: 'OSIRIS derivation: located_in from entity countryCode',
        retrievedAt: new Date().toISOString(),
      },
    });
  }
  return deps;
}

const stateCache = new Map<string, { promise: Promise<AssembledState>; at: number }>();
/** Assembly memo TTL — long enough to serve a browsing session from one
 *  assembly, short enough that live-adapter refreshes propagate. */
const ASSEMBLY_TTL_MS = 10 * 60 * 1000;

/**
 * Assemble (and memoize) the canonical state for a commodity from every
 * registered adapter that serves it. The memo expires so adapters with live
 * providers get re-consulted; they manage their own fetch TTLs behind load().
 */
export function getEconomyState(commodity: string, { fresh = false } = {}): Promise<AssembledState> {
  const cached = stateCache.get(commodity);
  if (!fresh && cached && Date.now() - cached.at < ASSEMBLY_TTL_MS) return cached.promise;
  const promise = assemble(commodity);
  stateCache.set(commodity, { promise, at: Date.now() });
  // A failed assembly must not poison the cache forever.
  promise.catch(() => stateCache.delete(commodity));
  return promise;
}

async function assemble(commodity: string): Promise<AssembledState> {
  const adapters = adaptersFor(commodity);
  if (adapters.length === 0) throw new Error(`No adapter registered for commodity "${commodity}"`);

  // Graceful source degradation: one dead provider must not take down the
  // canonical state. Failures become warnings; only total failure throws.
  const issues: ValidationIssue[] = [];
  const settled = await Promise.allSettled(adapters.map(a => a.load(commodity)));
  const payloads = [];
  const providers: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      payloads.push(result.value);
      providers.push(adapters[i].providerId);
    } else {
      issues.push({
        severity: 'warning',
        message: `Adapter ${adapters[i].providerId} failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      });
    }
  }
  if (payloads.length === 0) {
    throw new Error(`All adapters failed for commodity "${commodity}":\n` + issues.map(i => `  - ${i.message}`).join('\n'));
  }

  const state: EconomyState = {
    commodity,
    commodityName: payloads[0].commodityName,
    entities: [], observations: [], flows: [], capacities: [], dependencies: [], events: [], sources: [],
  };

  const seenEntity = new Set<string>();
  const seenSource = new Set<string>();
  for (const p of payloads) {
    for (const e of p.entities) {
      if (seenEntity.has(e.id)) continue; // First adapter wins on entity identity.
      seenEntity.add(e.id);
      state.entities.push(e);
    }
    state.observations.push(...p.observations);
    state.flows.push(...p.flows);
    state.capacities.push(...p.capacities);
    state.dependencies.push(...p.dependencies);
    state.events.push(...p.events);
    for (const s of p.sources) {
      if (seenSource.has(s.sourceId)) continue;
      seenSource.add(s.sourceId);
      state.sources.push(s);
    }
  }

  state.dependencies.push(...deriveLocatedIn(state.entities));

  const validation = validateState(state);
  const errors = validation.filter(i => i.severity === 'error');
  if (errors.length > 0) {
    // A state that fails referential integrity must never reach analytics/UI.
    throw new Error(`Economy state for "${commodity}" failed validation:\n` + errors.map(e => `  - ${e.message}`).join('\n'));
  }

  // The resolution gate's residue (work order 3.3): typed unresolved
  // identifiers from every adapter, deterministically ordered, with
  // near-match CANDIDATES computed here against the assembled register —
  // adapters do not hold the register, and candidates are informational
  // only (similarity never merges; the note on each candidate says so).
  // Records from different drop sites that name the SAME (source, scheme,
  // identifier) merge here — occurrences summed, contexts joined — so a
  // researcher sees one record per unresolved identifier; the per-site
  // reconciliation against row accounting is pinned at the drop sites.
  const merged = new Map<string, NonNullable<EconomyState['unresolved']>[number]>();
  for (const u of payloads.flatMap(p => p.unresolved ?? [])) {
    const key = `${u.sourceId}|${u.scheme}|${u.identifier}`;
    const prev = merged.get(key);
    if (!prev) merged.set(key, { ...u });
    else {
      prev.occurrences += u.occurrences;
      if (u.context && prev.context !== u.context) prev.context = [prev.context, u.context].filter(Boolean).join('; ');
    }
  }
  state.unresolved = sortUnresolved([...merged.values()])
    .map(u => {
      const candidates = u.candidates ?? nameCandidates(u.identifier, state.entities);
      return candidates ? { ...u, candidates } : u;
    });

  const accounting = payloads.flatMap(p => p.accounting ?? []);
  return { state, issues: [...issues, ...validation], providers, accounting };
}

/* ── Lookup helpers ── */

export interface EntityDetail {
  entity: Entity;
  observations: EconomyState['observations'];
  capacities: EconomyState['capacities'];
  flowsIn: EconomyState['flows'];
  flowsOut: EconomyState['flows'];
  dependencies: EconomyState['dependencies'];
  events: EconomyState['events'];
}

export function entityDetail(state: EconomyState, entityId: string): EntityDetail | null {
  const entity = state.entities.find(e => e.id === entityId);
  if (!entity) return null;
  return {
    entity,
    observations: state.observations.filter(o => o.entityId === entityId),
    capacities: state.capacities.filter(c => c.entityId === entityId),
    flowsIn: state.flows.filter(f => f.toEntityId === entityId),
    flowsOut: state.flows.filter(f => f.fromEntityId === entityId),
    dependencies: state.dependencies.filter(d => d.fromEntityId === entityId || d.toEntityId === entityId),
    events: state.events.filter(ev => ev.entityId === entityId),
  };
}
