/**
 * Synthetic economy-state fixture for deterministic tests.
 * A tiny 2-mine → port → smelter → demand chain with hand-computable numbers.
 * Not imported by application code.
 */

import type { EconomyState, Provenance } from './types';

export const FIXTURE_PROV: Provenance = {
  sourceId: 'test-fixture',
  sourceName: 'Synthetic test fixture',
  retrievedAt: '2026-01-01T00:00:00Z',
};

/**
 * Month label for the synthetic inventory series, ZERO-PADDED.
 *
 * Exported so the padding can be pinned at lengths the fixture does not yet
 * use. `2024-0${i + 1}` is correct for the first nine elements and produces
 * `2024-010-01` at the tenth — and V8's `Date.parse` ACCEPTS that, returning
 * the right instant, so the defect would be silent.
 *
 * Where it bites is string comparison, which this codebase does constantly:
 * `'2024-010-01'.slice(0, 7)` is `'2024-01'`, so October, November and December
 * all key as JANUARY. Measured on a twelve-element version that briefly reached
 * the tree: `extractSeries` returned four points labelled `2024-01` and the
 * planted structural break moved from position 8 to position 11 of 12.
 *
 * The series is eight elements today, so the defect is LATENT, not live. It is
 * fixed here rather than when someone extends the series, because the person
 * who extends it will be thinking about inventory levels and not about
 * `padStart`.
 */
export function fixtureMonth(index: number): string {
  return String(index + 1).padStart(2, '0');
}

export function syntheticState(): EconomyState {
  return {
    commodity: 'testium',
    commodityName: 'Testium',
    entities: [
      { id: 'ent:country:aa', kind: 'country', name: 'Alandia', countryCode: 'AA', lat: 10, lng: 10, geoPrecision: 'country' },
      { id: 'ent:country:bb', kind: 'country', name: 'Borland', countryCode: 'BB', lat: 20, lng: 20, geoPrecision: 'country' },
      { id: 'ent:mine:alpha', kind: 'mine', name: 'Alpha Mine', countryCode: 'AA', lat: 11, lng: 11, geoPrecision: 'site', stage: 'production' },
      { id: 'ent:mine:beta', kind: 'mine', name: 'Beta Mine', countryCode: 'AA', lat: 12, lng: 12, geoPrecision: 'site', stage: 'production' },
      { id: 'ent:port:gate', kind: 'port', name: 'Gate Port', countryCode: 'AA', lat: 13, lng: 13, geoPrecision: 'site', stage: 'logistics' },
      { id: 'ent:smelter:omega', kind: 'smelter', name: 'Omega Smelter', countryCode: 'BB', lat: 21, lng: 21, geoPrecision: 'site', stage: 'smelting' },
      { id: 'ent:region:demand', kind: 'region', name: 'Demand Region', countryCode: 'BB', lat: 22, lng: 22, geoPrecision: 'region', stage: 'manufacturing' },
    ],
    observations: [
      // Country production: 80/20 split → HHI = 80² + 20² = 6800.
      { id: 'obs:prod:aa', entityId: 'ent:country:aa', metric: 'production', value: 800, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'obs:prod:bb', entityId: 'ent:country:bb', metric: 'production', value: 200, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      // Inventory series with a clean structural break at 2024-08.
      ...[100, 101, 99, 100, 101, 100, 100, 60].map((v, i) => ({
        id: `obs:inv:${i}`,
        entityId: 'ent:port:gate' as const,
        metric: 'inventory' as const,
        value: v,
        unit: 'kt',
        period: { start: `2024-${fixtureMonth(i)}-01`, end: `2024-${fixtureMonth(i)}-28` },
        // Month-end stocks are knowable at period end — stamped so the
        // series has a measurable arrival cadence (the alert gate refuses
        // series whose knowability collapses to a single retrieval date).
        knownAt: `2024-${fixtureMonth(i)}-28`,
        valueKind: 'reported' as const,
        confidence: 'high' as const,
        provenance: FIXTURE_PROV,
      })),
    ],
    flows: [
      { id: 'flow:alpha-gate', fromEntityId: 'ent:mine:alpha', toEntityId: 'ent:port:gate', commodity: 'testium', form: 'concentrate', quantity: 300, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, mode: 'rail', valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'flow:beta-gate', fromEntityId: 'ent:mine:beta', toEntityId: 'ent:port:gate', commodity: 'testium', form: 'concentrate', quantity: 100, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, mode: 'road', valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'flow:gate-omega', fromEntityId: 'ent:port:gate', toEntityId: 'ent:smelter:omega', commodity: 'testium', form: 'concentrate', quantity: 400, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, mode: 'sea', valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
      { id: 'flow:omega-demand', fromEntityId: 'ent:smelter:omega', toEntityId: 'ent:region:demand', commodity: 'testium', form: 'refined', quantity: 380, unit: 'kt/y', period: { start: '2024-01-01', end: '2024-12-31' }, mode: 'internal', valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    ],
    capacities: [
      { id: 'cap:omega', entityId: 'ent:smelter:omega', stage: 'smelting', value: 420, unit: 'kt/y', valueKind: 'reported', confidence: 'high', provenance: FIXTURE_PROV },
    ],
    dependencies: [
      { id: 'dep:omega-gate', fromEntityId: 'ent:smelter:omega', type: 'depends_on', toEntityId: 'ent:port:gate', strength: 0.9, provenance: FIXTURE_PROV },
    ],
    events: [],
    sources: [{ sourceId: 'test-fixture', sourceName: 'Synthetic test fixture' }],
  };
}
