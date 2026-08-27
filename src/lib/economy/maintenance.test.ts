import { describe, it, expect } from 'vitest';
import { SOURCE_REGISTRY } from './sourceRegistry';
import { corpusHealthSignals } from './horizon';
import { getEconomyState } from './store';
import { syntheticState } from './fixtures';

/**
 * Shipping order S-5: ownership, cadence, and the flow snapshot as a
 * source that ages visibly.
 */
describe('maintenance ownership and cadence (S-5)', () => {
  it('every source with a built adapter has an owner and a stated maintenance cadence — the property, not the list', () => {
    const built = SOURCE_REGISTRY.filter(s => s.adapter !== null);
    expect(built.length).toBeGreaterThan(0); // vacuity
    for (const s of built) {
      expect(s.owner, `${s.sourceId} owner`).toBeTruthy();
      expect(s.maintenance, `${s.sourceId} maintenance`).toBeTruthy();
    }
    // The registry carries the flow snapshot as a maintained source.
    expect(built.map(s => s.sourceId)).toContain('curated-flow-snapshot');
  });

  it('the flow snapshot appears in corpus health with its age once past the annual cadence', async () => {
    // The real corpus, today: the 2024 facility snapshot is past 365+90d —
    // this is a TRUE standing signal, not a plant. The cadence signal and
    // the extrapolation guard are different questions (is it due vs is it
    // still admissible), and this is the "due" one.
    const { state } = await getEconomyState('copper');
    const now = new Date().toISOString().slice(0, 10);
    const signal = corpusHealthSignals(state, now).find(s => s.sourceId === 'curated-flow-snapshot');
    expect(signal).toBeDefined();
    expect(signal!.kind).toBe('source_stale');
    expect(signal!.observedStalenessDays).toBeGreaterThan(455);
    expect(signal!.explanation).toContain('annual maintenance cadence');
    // Discriminating case: within the cadence window the signal is ABSENT
    // — a signal that fires regardless of age measures nothing.
    const fresh = corpusHealthSignals(syntheticState(), '2025-06-01'); // flows end 2024-12-31 → 152d
    expect(fresh.find(s => s.sourceId === 'curated-flow-snapshot')).toBeUndefined();
    // And a country-vintage-only state has no facility snapshot to age.
    const s = syntheticState();
    s.flows = s.flows.map(f => ({ ...f, fromEntityId: 'ent:country:aa', toEntityId: 'ent:country:bb' }));
    expect(corpusHealthSignals(s, '2027-01-01').find(x => x.sourceId === 'curated-flow-snapshot')).toBeUndefined();
  });
});
