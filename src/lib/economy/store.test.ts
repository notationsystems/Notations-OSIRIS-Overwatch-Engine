import { describe, it, expect, afterEach } from 'vitest';
import { getEconomyState, entityDetail } from './store';
import { entityAttestation } from './analytics';
import { registerAdapter, unregisterAdapter } from './adapters';

describe('economy store (curated copper assembly)', () => {
  it('assembles a valid copper state from the curated adapter', async () => {
    const { state, issues, providers } = await getEconomyState('copper');
    expect(providers).toContain('curated-copper-v1');
    expect(issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(state.entities.length).toBeGreaterThan(40);
    expect(state.flows.length).toBeGreaterThan(20);
    expect(state.observations.length).toBeGreaterThan(40);
  });

  it('rejects a commodity with no adapter', async () => {
    await expect(getEconomyState('unobtainium')).rejects.toThrow(/No adapter/);
  });

  it('preserves provenance on every observation, flow, capacity and event', async () => {
    const { state } = await getEconomyState('copper');
    const all = [...state.observations, ...state.flows, ...state.capacities, ...state.dependencies, ...state.events];
    for (const rec of all) {
      expect(rec.provenance.sourceId, `record ${rec.id}`).toBeTruthy();
      expect(rec.provenance.retrievedAt, `record ${rec.id}`).toBeTruthy();
    }
  });

  it('every entity is attested by at least one provenance-bearing record — identity is never self-standing', async () => {
    // Entities are identity records and deliberately carry no provenance of
    // their own; provenance totality holds because every EVIDENCE record
    // (observation, flow, capacity, dependency, event) carries it, and every
    // entity must be reachable from at least one such record. An entity
    // nothing references would be an unattested identity — the one shape
    // provenance totality would silently miss.
    const { state } = await getEconomyState('copper');
    const attested = new Set<string>();
    for (const o of state.observations) { attested.add(o.entityId); if (o.partnerEntityId) attested.add(o.partnerEntityId); }
    for (const f of state.flows) { attested.add(f.fromEntityId); attested.add(f.toEntityId); }
    for (const c of state.capacities) attested.add(c.entityId);
    for (const d of state.dependencies) { attested.add(d.fromEntityId); attested.add(d.toEntityId); }
    for (const ev of state.events) if (ev.entityId) attested.add(ev.entityId);
    const orphans = state.entities.filter(e => !attested.has(e.id));
    expect(orphans.map(e => e.id)).toEqual([]);
  });

  it('attestation carries its class: WHAT attests an entity, not just that something does', async () => {
    // The identity-level sibling of valueKind: an entity whose strongest
    // attesting class is representative (or below) exists purely on
    // curation — a real name carried entirely by synthetic-class numbers.
    const { state } = await getEconomyState('copper');
    const att = entityAttestation(state);
    // Every entity classified (the orphan test above guarantees coverage).
    for (const e of state.entities) expect(att.get(e.id), e.id).toBeTruthy();
    // The measured finding this label exists to surface: country-level
    // identities are reported-attested (live USGS series), but even the
    // corpus's best-known FACILITY is representative-attested — every
    // facility-level quantity is curation-class. The label now says so.
    expect(att.get('ent:country:cl')).toBe('reported');
    expect(att.get('ent:mine:escondida')).toBe('representative');
    // The JV operating vehicles are attested by dependency edges alone —
    // structural_only by construction (round 11: curated pass-through
    // vehicles), and the label now says so rather than the panel implying
    // measured evidence exists.
    expect(att.get('ent:company:antamina-jv')).toBe('structural_only');
    expect(att.get('ent:company:collahuasi-jv')).toBe('structural_only');
  });

  it('keeps curated records representative; reported/estimated only from live providers', async () => {
    const { state } = await getEconomyState('copper');
    const LIVE_SOURCES = new Set(['usgs-mcs2025-live', 'usgs-mcs2024-vintage', 'un-comtrade-preview', 'yahoo-hg-chart', 'cftc-cot', 'westmetall-lme-stocks']);
    for (const rec of [...state.observations, ...state.flows, ...state.capacities]) {
      if (LIVE_SOURCES.has(rec.provenance.sourceId)) {
        // 'derived' appears when OSIRIS computes a total the reporter did not
        // publish (e.g. a Comtrade world aggregate summed from partner rows).
        expect(['reported', 'estimated', 'derived'], `live record ${rec.id}`).toContain(rec.valueKind);
      } else {
        expect(rec.valueKind, `curated record ${rec.id}`).toBe('representative');
      }
    }
  });

  it('derives located_in dependencies from countryCode', async () => {
    const { state } = await getEconomyState('copper');
    const locs = state.dependencies.filter(d => d.type === 'located_in');
    expect(locs.length).toBeGreaterThan(20);
    const escondida = locs.find(d => d.fromEntityId === 'ent:mine:escondida');
    expect(escondida?.toEntityId).toBe('ent:country:cl');
    // Derived records must say they are derived, not sourced.
    expect(escondida?.provenance.sourceId).toBe('osiris-derived');
  });

  describe('graceful source degradation', () => {
    afterEach(() => unregisterAdapter('test-dead-provider'));

    it('tolerates a failing adapter with a warning instead of losing the state', async () => {
      registerAdapter({
        providerId: 'test-dead-provider',
        providerName: 'Deliberately broken test provider',
        commodities: ['copper'],
        async load() { throw new Error('provider unreachable'); },
      });
      const { state, issues, providers } = await getEconomyState('copper', { fresh: true });
      expect(state.entities.length).toBeGreaterThan(40);
      expect(providers).toContain('curated-copper-v1');
      expect(providers).not.toContain('test-dead-provider');
      expect(issues.some(i => i.severity === 'warning' && i.message.includes('test-dead-provider'))).toBe(true);
    });

    it('throws only when every adapter fails', async () => {
      registerAdapter({
        providerId: 'test-dead-provider',
        providerName: 'Only provider, broken',
        commodities: ['unobtainium-live'],
        async load() { throw new Error('provider unreachable'); },
      });
      await expect(getEconomyState('unobtainium-live', { fresh: true })).rejects.toThrow(/All adapters failed/);
    });
  });

  it('carries multi-year series observations for temporal analytics', async () => {
    const { state } = await getEconomyState('copper');
    const clCurated = state.observations.filter(o =>
      o.entityId === 'ent:country:cl' && o.metric === 'production'
      && !['usgs-mcs2025-live', 'usgs-mcs2024-vintage'].includes(o.provenance.sourceId));
    expect(clCurated.length).toBe(10); // curated: 2015–2023 series + 2024 snapshot
    expect(new Set(clCurated.map(o => o.period.end)).size).toBe(10); // no duplicate years within the curated set
    // The live USGS provider adds same-period reported/estimated evidence on
    // top — coexisting observations, resolved by observationsAt at read time.
    const clAll = state.observations.filter(o => o.entityId === 'ent:country:cl' && o.metric === 'production');
    // curated 10 + MCS2025 (2023, 2024) + MCS2024 vintage (2022, 2023) = 14
    expect(clAll.length).toBe(14);
    const paZero = state.observations.find(o => o.id === 'obs:prod:pa:2024');
    expect(paZero?.value).toBe(0);
  });

  it('entityDetail returns observations, flows and events for a mine', async () => {
    const { state } = await getEconomyState('copper');
    const detail = entityDetail(state, 'ent:mine:grasberg');
    expect(detail).not.toBeNull();
    expect(detail!.observations.some(o => o.metric === 'production')).toBe(true);
    expect(detail!.flowsOut.length).toBeGreaterThan(0);
    expect(detail!.events.some(e => e.id === 'evt:grasberg-mud-rush-2025')).toBe(true);
    expect(entityDetail(state, 'ent:mine:nope')).toBeNull();
  });
});
