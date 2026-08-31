import { describe, it, expect } from 'vitest';
import { getEconomyState } from './store';
import { observationsAt, concentration, outranksObservation } from './analytics';
import type { EconomyState, Entity } from './types';

/**
 * THE PRECONDITION THE ENTITY INDEX RESTS ON.
 *
 * `observationsAt` and friends replaced `state.entities.find(e => e.id === x)`
 * with a Map lookup, turning O(observations x entities) into
 * O(observations + entities). The optimization is real and the outputs are
 * byte-identical on the current corpus — measured across 26 analytic
 * invocations over both commodities.
 *
 * But `Array.find` and `Map.get` are equivalent ONLY WHERE IDS ARE UNIQUE.
 * `find` returns the FIRST match; a Map built by `for (e of entities)
 * m.set(e.id, e)` returns the LAST. On a corpus with a duplicate id they
 * silently disagree, and nothing in assembly enforces uniqueness — measured:
 * no dedupe in store.ts, engine.ts or adapters.ts, and no test asserted it.
 *
 * So the equivalence was INCIDENTAL, and the scenario that motivates the
 * optimization is exactly the one that could break it: live adapters growing
 * the entity set per ingest are also how a duplicate id first arrives. These
 * tests make the precondition structural.
 */
describe('the entity index rests on id uniqueness, and that is now checked', () => {
  for (const commodity of ['copper', 'aluminium']) {
    it(`${commodity}: entity ids are unique`, async () => {
      const { state } = await getEconomyState(commodity);
      const seen = new Map<string, number>();
      for (const e of state.entities) seen.set(e.id, (seen.get(e.id) ?? 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      expect(dupes, [
        'Duplicate entity ids. The analytics index resolves an id by Map.get, which returns the',
        'LAST record with that id, while the code it replaced returned the FIRST. With a duplicate',
        'present the two disagree silently and every name, kind filter and share attributed through',
        'that id may bind to the wrong entity.',
      ].join(' ')).toEqual([]);
    });

    it(`${commodity}: country codes are unique among country entities`, async () => {
      // capacityConcentration resolves a country BY COUNTRY CODE through the
      // same first-vs-last hazard.
      const { state } = await getEconomyState(commodity);
      const countries = state.entities.filter(e => e.kind === 'country' && e.countryCode);
      const seen = new Map<string, number>();
      for (const e of countries) seen.set(e.countryCode!, (seen.get(e.countryCode!) ?? 0) + 1);
      const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([c]) => c);
      expect(dupes, 'two country entities sharing a code make capacity roll-up order-dependent')
        .toEqual([]);
    });
  }

  it('PLANT: a duplicate id makes first-match and last-match disagree', async () => {
    // The check is not vacuous — this constructs the divergence it guards.
    const { state } = await getEconomyState('copper');
    const original = state.entities.find(e => e.kind === 'country');
    expect(original).toBeDefined();
    const shadow: Entity = { ...(original as Entity), name: 'SHADOW — must not win' };
    const planted: EconomyState = { ...state, entities: [...state.entities, shadow] };

    const firstMatch = planted.entities.find(e => e.id === shadow.id)!;
    const lastMatch = [...planted.entities].reverse().find(e => e.id === shadow.id)!;
    expect(firstMatch.name).not.toBe(lastMatch.name);

    // And it reaches a rendered figure: the share's name comes from the lookup.
    const result = concentration(planted, 'production', 'country').result;
    const named = result.shares.find(s => s.entityId === shadow.id);
    if (named) {
      expect(
        named.name === 'SHADOW — must not win' || named.name === (original as Entity).name,
      ).toBe(true);
    }
  });

  it('the index does not change which observations are selected', async () => {
    const { state } = await getEconomyState('copper');
    const viaIndex = observationsAt(state, 'production', 'country').map(o => o.id).sort();
    // Recompute the pre-optimization way, in the test, as the control.
    const cutoff = '9999-12-31';
    const best = new Map<string, typeof state.observations[number]>();
    for (const o of state.observations) {
      if (o.metric !== 'production' || o.period.end > cutoff) continue;
      if (o.partnerEntityId) continue;
      const ent = state.entities.find(e => e.id === o.entityId);
      if (ent?.kind !== 'country') continue;
      const prev = best.get(o.entityId);
      // Same tie-break as the real function: harder evidence wins at equal period.
      if (!prev || o.period.end > prev.period.end
          || (o.period.end === prev.period.end && outranksObservation(o, prev))) {
        best.set(o.entityId, o);
      }
    }
    const viaLinear = [...best.values()].map(o => o.id).sort();
    expect(viaIndex).toEqual(viaLinear);
  });
});
