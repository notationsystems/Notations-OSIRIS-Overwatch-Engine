import { describe, it, expect } from 'vitest';
import { buildUnresolvedRecords, nameCandidates, sortUnresolved, type UnresolvedTally } from './resolution';
import { buildCountryFlowVintages } from './flowVintages';
import { parseMcsWorldCsvAccounted, accountComtradeResponsesFull, MCS2025_SPEC } from './liveAdapters';
import { MCS_SNAPSHOT_CSV } from '@/data/economy/snapshots/mcs2025-world-copper';
import comtradeSnapshot from '@/data/economy/snapshots/comtrade-copper.json';
import vintageSnapshot from '@/data/economy/snapshots/comtrade-flow-vintages.json';
import { getEconomyState } from './store';
import { searchEvidence } from './evidenceSearch';
import { buildGraph } from './graph';
import type { Entity, Provenance } from './types';

const PROV: Provenance = {
  sourceId: 'test', sourceName: 'test', retrievedAt: '2026-08-27T00:00:00Z',
};

const REGISTER: Entity[] = [
  { id: 'ent:country:pe', kind: 'country', name: 'Peru', countryCode: 'PE', commodity: 'copper' },
  { id: 'ent:mine:antamina', kind: 'mine', name: 'Antamina', countryCode: 'PE', commodity: 'copper' },
  { id: 'ent:company:antamina-jv', kind: 'company', name: 'Antamina JV (operating company)', commodity: 'copper' },
];

describe('the resolution gate (work order 3.3)', () => {
  it('near matches surface as candidates and NEVER merge — both colliding entities survive, the proposal stays unresolved', () => {
    // 'Perú' (diacritic variant) folds equal to the register's 'Peru'; the
    // gate names the candidate and refuses to assign — resolution happens
    // only through curated scheme maps, and name similarity (exact folded
    // equality included) is never sufficient.
    const tally: UnresolvedTally = new Map([['Perú', { occurrences: 3, context: 'planted' }]]);
    const records = buildUnresolvedRecords('mcs-country-name', 'test', tally, REGISTER, 'curate');
    expect(records).toHaveLength(1);
    expect(records[0].identifier).toBe('Perú'); // raw, verbatim
    expect(records[0].candidates!.map(c => c.entityId)).toContain('ent:country:pe');
    expect(records[0].candidates![0].note).toContain('never sufficient to merge');
    // A near-collision inside the register: 'ANTAMINA' matches the mine AND
    // the operating company — BOTH survive as candidates, neither absorbs
    // the other, and the register itself is untouched.
    const collided = nameCandidates('ANTAMINA', REGISTER)!;
    expect(collided.map(c => c.entityId).sort()).toEqual(['ent:company:antamina-jv', 'ent:mine:antamina']);
    expect(REGISTER).toHaveLength(3);
  });

  it('is deterministic: same proposals + same register → same records in the same order, independent of tally insertion order', () => {
    const a: UnresolvedTally = new Map([['608', { occurrences: 2 }], ['100', { occurrences: 5 }], ['724', { occurrences: 1 }]]);
    const b: UnresolvedTally = new Map([['724', { occurrences: 1 }], ['100', { occurrences: 5 }], ['608', { occurrences: 2 }]]);
    const ra = buildUnresolvedRecords('comtrade-m49-partner', 's', a, REGISTER, 'r');
    const rb = buildUnresolvedRecords('comtrade-m49-partner', 's', b, REGISTER, 'r');
    expect(ra).toEqual(rb);
    expect(ra.map(r => r.identifier)).toEqual(['100', '608', '724']); // sorted
  });

  it('reconciles with row accounting at every resolution drop site — every counted drop has a record', () => {
    // Flow vintages: the unmapped-partner filtered count equals the sum of
    // unresolved occurrences — same tally feeds both, and this pin holds
    // them together.
    const snap = vintageSnapshot as { responses: Parameters<typeof buildCountryFlowVintages>[0] };
    const v = buildCountryFlowVintages(snap.responses, '2026-08-27T00:00:00Z');
    const vCount = v.accounting.filtered.find(f => f.predicate.includes('partner M49'))?.count ?? 0;
    expect(vCount).toBeGreaterThan(0); // vacuity: the drop site is live
    expect(v.unresolved.reduce((s, u) => s + u.occurrences, 0)).toBe(vCount);
    // MCS world CSV: COUNTRY drops (aggregates + unmapped reporters).
    const m = parseMcsWorldCsvAccounted(MCS_SNAPSHOT_CSV, ref => ({ ...PROV, sourceRef: ref }), MCS2025_SPEC);
    const mCount = m.accounting.filtered.find(f => f.predicate.startsWith('COUNTRY'))?.count ?? 0;
    expect(mCount).toBeGreaterThan(0);
    expect(m.unresolved.reduce((s, u) => s + u.occurrences, 0)).toBe(mCount);
    // Comtrade bilateral: reporter + partner M49 drops.
    const responses = (comtradeSnapshot as { responses: Parameters<typeof accountComtradeResponsesFull>[0] }).responses;
    const c = accountComtradeResponsesFull(responses);
    const cCount = c.accounting.filtered
      .filter(f => f.predicate.includes('M49'))
      .reduce((s, f) => s + f.count, 0);
    expect(c.unresolved.reduce((s, u) => s + u.occurrences, 0)).toBe(cCount);
  });

  it('the assembled state carries the gate residue, deterministically ordered, and the search surfaces it as refused:resolution', async () => {
    const { state, accounting } = await getEconomyState('copper');
    const unresolved = state.unresolved ?? [];
    expect(unresolved.length).toBeGreaterThan(0);
    // Deterministic order (sourceId, scheme, identifier).
    expect(unresolved).toEqual(sortUnresolved(unresolved));
    // The vintage ingest's known gap is a RECORD now, not just a count:
    // partner 608 (Philippines — Indonesia's largest 2017 receiver, 418 kt)
    // is dropped because the M49 map has no entry for it.
    const ph = unresolved.find(u => u.scheme === 'comtrade-m49-partner' && u.identifier === '608');
    expect(ph).toBeDefined();
    expect(ph!.sourceId).toBe('un-comtrade-preview');
    expect(ph!.remedy).toContain('M49_TO_ENTITY');
    // And it is searchable, carrying identifier + source + remedy.
    const hits = searchEvidence(state, buildGraph(state), { kind: 'refused', type: 'resolution', terms: ['608'] });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].title).toContain('"608"');
    expect(hits[0].detail).toContain('un-comtrade-preview');
    expect(hits[0].remedy).toContain('M49_TO_ENTITY');
    // Row accounting still holds at the state level: the counted drops the
    // records came from are present in the served accounting.
    expect(accounting.some(a => a.filtered.some(f => f.predicate.includes('M49')))).toBe(true);
  });

  it('the aluminium gate residue names the deliberately-unmapped reporters as records, not a count', async () => {
    // Round 25 left Germany/Ireland/Spain alumina rows unmapped with a
    // comment in the countryMap; the gate turns the comment into typed,
    // searchable records — measured here against the real corpus. (None
    // has a register candidate: the aluminium register carries no entity
    // with these names — the near-collision path is pinned by the planted
    // test above, where it is exercised for real.)
    const { state } = await getEconomyState('aluminium');
    const ids = (state.unresolved ?? []).map(u => u.identifier);
    expect(ids).toContain('Germany');
    expect(ids).toContain('Ireland');
    expect(ids).toContain('Spain');
    expect(ids).toContain('World total (rounded)'); // aggregates: out-of-scope decision, also on record
  });
});
