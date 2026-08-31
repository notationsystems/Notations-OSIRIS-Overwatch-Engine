/**
 * Payload — Curated aluminium dataset (round 25: the second commodity).
 *
 * The substrate-falsification experiment: aluminium was chosen because it
 * BREAKS copper's shape deliberately — the chain is bauxite → alumina →
 * primary metal (chemical refining BEFORE electrolytic smelting, inverting
 * copper's device order), alumina is measured on its own basis, and
 * electricity is a first-class input. Every strain this dataset put on the
 * model is recorded in the ledger (phase 24), not smoothed over.
 *
 * Curation discipline (same as copper's core): real names, real geography,
 * public-record magnitudes — valueKind 'representative' throughout, because
 * curated figures are curation-class whatever their fidelity. The live USGS
 * adapter layers reported/estimated country figures on top from the same
 * world file the copper adapter fetches.
 *
 * Flows are quantified in CONTAINED METAL (metal_content), converted from
 * public gross figures at the standard metallurgical ratios (bauxite ~25%
 * Al, calcined alumina 52.9% Al) and noted as such — the copper convention.
 * The general stage-conversion machinery (gross bauxite/alumina flows
 * converting like corridor grades) is an identified gap, recorded unbuilt.
 */

import type {
  Capacity, Dependency, EconEvent, Entity, Flow, Observation, Provenance,
} from '@/lib/economy/types';
import type { AdapterPayload, EconomyAdapter } from '@/lib/economy/adapters';

const RETRIEVED = '2026-08-27T00:00:00Z';

const curated = (note?: string): Provenance => ({
  sourceId: 'curated-aluminium-v1',
  sourceName: 'Payload Terminal curated aluminium dataset (USGS/IAI-derived representative data)',
  retrievedAt: RETRIEVED,
  note,
});

const news = (note: string): Provenance => ({
  sourceId: 'curated-aluminium-v1',
  sourceName: 'Payload Terminal curated aluminium dataset — public event record',
  retrievedAt: RETRIEVED,
  note,
});

/* ── Entities ── */

const country = (code: string, name: string, lat: number, lng: number): Entity => ({
  id: `ent:country:${code}`, kind: 'country', name, commodity: 'aluminium',
  countryCode: code.toUpperCase(), country: name, lat, lng, geoPrecision: 'country',
});

const ALUMINIUM_COUNTRIES: Entity[] = [
  country('cn', 'China', 35.0, 103.0), country('in', 'India', 21.0, 78.0),
  country('ru', 'Russia', 60.0, 90.0), country('ca', 'Canada', 56.0, -106.0),
  country('ae', 'United Arab Emirates', 24.0, 54.0), country('bh', 'Bahrain', 26.0, 50.5),
  country('au', 'Australia', -25.0, 134.0), country('no', 'Norway', 62.0, 10.0),
  country('is', 'Iceland', 65.0, -18.0), country('my', 'Malaysia', 4.0, 102.0),
  country('br', 'Brazil', -10.0, -52.0), country('us', 'United States', 39.0, -98.0),
  country('gn', 'Guinea', 10.5, -11.0), country('id', 'Indonesia', -2.0, 118.0),
  country('jm', 'Jamaica', 18.1, -77.3), country('kz', 'Kazakhstan', 48.0, 68.0),
  country('sa', 'Saudi Arabia', 24.0, 45.0), country('vn', 'Vietnam', 16.0, 106.0),
  country('gr', 'Greece', 39.0, 22.0), country('tr', 'Turkey', 39.0, 35.0),
];

const ALUMINIUM_FACILITIES: Entity[] = [
  // Bauxite mines (stage production; bauxite moves as 'ore').
  { id: 'ent:mine:weipa', kind: 'mine', name: 'Weipa', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -12.68, lng: 141.92, geoPrecision: 'site', stage: 'production', operator: 'Rio Tinto' },
  { id: 'ent:mine:huntly', kind: 'mine', name: 'Huntly', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -32.62, lng: 116.05, geoPrecision: 'site', stage: 'production', operator: 'Alcoa', notes: 'World-scale Darling Range bauxite mine feeding Pinjarra/Kwinana.' },
  { id: 'ent:mine:sangaredi', kind: 'mine', name: 'Sangarédi (CBG)', commodity: 'aluminium', countryCode: 'GN', country: 'Guinea', lat: 11.11, lng: -13.82, geoPrecision: 'site', stage: 'production', operator: 'CBG' },
  { id: 'ent:mine:boffa', kind: 'mine', name: 'Boffa (SMB)', commodity: 'aluminium', countryCode: 'GN', country: 'Guinea', lat: 10.18, lng: -14.04, geoPrecision: 'region', stage: 'production', operator: 'SMB-Winning', notes: 'SMB-Winning consortium mining area; aggregate of several pits.' },
  { id: 'ent:mine:trombetas', kind: 'mine', name: 'Trombetas (MRN)', commodity: 'aluminium', countryCode: 'BR', country: 'Brazil', lat: -1.47, lng: -56.38, geoPrecision: 'site', stage: 'production', operator: 'MRN' },
  // Alumina refineries (stage refining — CHEMICAL refining; the aluminium
  // chain refines before it smelts, inverting copper's device order).
  { id: 'ent:refinery:pinjarra', kind: 'refinery', name: 'Pinjarra Alumina Refinery', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -32.63, lng: 115.88, geoPrecision: 'site', stage: 'refining', operator: 'Alcoa' },
  { id: 'ent:refinery:worsley', kind: 'refinery', name: 'Worsley Alumina', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -33.32, lng: 116.03, geoPrecision: 'site', stage: 'refining', operator: 'South32' },
  { id: 'ent:refinery:qal-gladstone', kind: 'refinery', name: 'Queensland Alumina (QAL)', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -23.87, lng: 151.22, geoPrecision: 'site', stage: 'refining', operator: 'Rio Tinto' },
  { id: 'ent:refinery:alunorte', kind: 'refinery', name: 'Alunorte', commodity: 'aluminium', countryCode: 'BR', country: 'Brazil', lat: -1.55, lng: -48.70, geoPrecision: 'site', stage: 'refining', operator: 'Norsk Hydro', notes: 'Largest alumina refinery outside China.' },
  { id: 'ent:refinery:shandong-alumina', kind: 'refinery', name: 'Shandong Alumina Complex (aggregated)', commodity: 'aluminium', countryCode: 'CN', country: 'China', lat: 36.70, lng: 117.50, geoPrecision: 'region', stage: 'refining', notes: 'Aggregation of the Shandong coastal alumina refineries (Weiqiao, Xinfa and others) — the Chinese import gateway for seaborne bauxite, folded to one node like copper\'s Shanghai gateway.' },
  { id: 'ent:refinery:al-taweelah-refinery', kind: 'refinery', name: 'Al Taweelah Alumina Refinery', commodity: 'aluminium', countryCode: 'AE', country: 'United Arab Emirates', lat: 24.75, lng: 54.65, geoPrecision: 'site', stage: 'refining', operator: 'EGA' },
  // Smelters (stage smelting — ELECTROLYTIC; produce the final metal).
  { id: 'ent:smelter:weiqiao-binzhou', kind: 'smelter', name: 'Weiqiao Binzhou complex', commodity: 'aluminium', countryCode: 'CN', country: 'China', lat: 37.38, lng: 118.02, geoPrecision: 'region', stage: 'smelting', operator: 'China Hongqiao', notes: 'World\'s largest smelting complex; aggregate of the Binzhou sites.' },
  { id: 'ent:smelter:bratsk', kind: 'smelter', name: 'Bratsk Aluminium Smelter', commodity: 'aluminium', countryCode: 'RU', country: 'Russia', lat: 56.15, lng: 101.63, geoPrecision: 'site', stage: 'smelting', operator: 'Rusal' },
  { id: 'ent:smelter:krasnoyarsk', kind: 'smelter', name: 'Krasnoyarsk Aluminium Smelter', commodity: 'aluminium', countryCode: 'RU', country: 'Russia', lat: 56.02, lng: 92.91, geoPrecision: 'site', stage: 'smelting', operator: 'Rusal' },
  { id: 'ent:smelter:ega-al-taweelah', kind: 'smelter', name: 'EGA Al Taweelah Smelter', commodity: 'aluminium', countryCode: 'AE', country: 'United Arab Emirates', lat: 24.76, lng: 54.66, geoPrecision: 'site', stage: 'smelting', operator: 'EGA' },
  { id: 'ent:smelter:alba', kind: 'smelter', name: 'Alba (Aluminium Bahrain)', commodity: 'aluminium', countryCode: 'BH', country: 'Bahrain', lat: 26.13, lng: 50.54, geoPrecision: 'site', stage: 'smelting', operator: 'Alba' },
  { id: 'ent:smelter:kitimat', kind: 'smelter', name: 'Kitimat Smelter', commodity: 'aluminium', countryCode: 'CA', country: 'Canada', lat: 54.05, lng: -128.65, geoPrecision: 'site', stage: 'smelting', operator: 'Rio Tinto' },
  { id: 'ent:smelter:karmoy', kind: 'smelter', name: 'Karmøy', commodity: 'aluminium', countryCode: 'NO', country: 'Norway', lat: 59.28, lng: 5.30, geoPrecision: 'site', stage: 'smelting', operator: 'Norsk Hydro' },
  { id: 'ent:smelter:jharsuguda', kind: 'smelter', name: 'Jharsuguda', commodity: 'aluminium', countryCode: 'IN', country: 'India', lat: 21.85, lng: 84.01, geoPrecision: 'site', stage: 'smelting', operator: 'Vedanta' },
  { id: 'ent:smelter:boyne-island', kind: 'smelter', name: 'Boyne Island', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -23.95, lng: 151.35, geoPrecision: 'site', stage: 'smelting', operator: 'Rio Tinto' },
  // Ports.
  { id: 'ent:port:kamsar', kind: 'port', name: 'Port of Kamsar', commodity: 'aluminium', countryCode: 'GN', country: 'Guinea', lat: 10.65, lng: -14.61, geoPrecision: 'site', stage: 'logistics', notes: 'CBG/SMB bauxite export gateway.' },
  { id: 'ent:port:gladstone-al', kind: 'port', name: 'Port of Gladstone', commodity: 'aluminium', countryCode: 'AU', country: 'Australia', lat: -23.84, lng: 151.25, geoPrecision: 'site', stage: 'logistics' },
  // Demand regions.
  { id: 'ent:region:china-fabrication-al', kind: 'region', name: 'China fabrication demand', commodity: 'aluminium', countryCode: 'CN', region: 'East Asia', lat: 31.5, lng: 117.0, geoPrecision: 'region', stage: 'demand' },
  { id: 'ent:region:europe-fabrication-al', kind: 'region', name: 'Europe fabrication demand', commodity: 'aluminium', region: 'Europe', lat: 50.0, lng: 10.0, geoPrecision: 'region', stage: 'demand' },
  { id: 'ent:region:north-america-fabrication-al', kind: 'region', name: 'North America fabrication demand', commodity: 'aluminium', region: 'North America', lat: 41.0, lng: -87.0, geoPrecision: 'region', stage: 'demand' },
  { id: 'ent:region:india-fabrication-al', kind: 'region', name: 'India fabrication demand', commodity: 'aluminium', countryCode: 'IN', region: 'South Asia', lat: 22.0, lng: 78.0, geoPrecision: 'region', stage: 'demand' },
  // Electricity as first-class input: a smelter is a power contract with
  // metal attached (~14 MWh/t). Modeled as infrastructure the smelter
  // declares depends_on — the dependency type existed; aluminium is the
  // first commodity to need it as a real constraint.
  { id: 'ent:infrastructure:kemano-hydro', kind: 'infrastructure', name: 'Kemano hydropower', commodity: 'aluminium', countryCode: 'CA', country: 'Canada', lat: 53.56, lng: -127.94, geoPrecision: 'site', notes: 'Rio Tinto\'s dedicated 896 MW hydro plant; Kitimat exists because of it.' },
  { id: 'ent:infrastructure:norwegian-hydro-grid', kind: 'infrastructure', name: 'Norwegian hydro grid', commodity: 'aluminium', countryCode: 'NO', country: 'Norway', lat: 61.0, lng: 8.0, geoPrecision: 'country', notes: 'Hydro-dominated grid underpinning Norwegian smelting economics.' },
  // Companies (operator-of-record attribution).
  { id: 'ent:company:rusal', kind: 'company', name: 'Rusal', commodity: 'aluminium', countryCode: 'RU', country: 'Russia' },
  { id: 'ent:company:hongqiao', kind: 'company', name: 'China Hongqiao', commodity: 'aluminium', countryCode: 'CN', country: 'China' },
  { id: 'ent:company:rio-tinto-al', kind: 'company', name: 'Rio Tinto', commodity: 'aluminium', countryCode: 'GB' },
  { id: 'ent:company:alcoa', kind: 'company', name: 'Alcoa', commodity: 'aluminium', countryCode: 'US', country: 'United States' },
  { id: 'ent:company:norsk-hydro', kind: 'company', name: 'Norsk Hydro', commodity: 'aluminium', countryCode: 'NO', country: 'Norway' },
  { id: 'ent:company:ega', kind: 'company', name: 'Emirates Global Aluminium', commodity: 'aluminium', countryCode: 'AE', country: 'United Arab Emirates' },
  { id: 'ent:company:south32', kind: 'company', name: 'South32', commodity: 'aluminium', countryCode: 'AU', country: 'Australia' },
  { id: 'ent:company:vedanta', kind: 'company', name: 'Vedanta', commodity: 'aluminium', countryCode: 'IN', country: 'India' },
  { id: 'ent:company:alba-co', kind: 'company', name: 'Aluminium Bahrain (Alba)', commodity: 'aluminium', countryCode: 'BH', country: 'Bahrain' },
];

export const ALUMINIUM_ENTITIES: Entity[] = [
  { id: 'ent:commodity:aluminium', kind: 'commodity', name: 'Aluminium', commodity: 'aluminium' },
  ...ALUMINIUM_COUNTRIES,
  ...ALUMINIUM_FACILITIES,
];

/* ── Flows (contained metal, representative) ── */

const Y2024 = { start: '2024-01-01', end: '2024-12-31' };

const flow = (
  id: string, from: string, to: string, form: Flow['form'], kt: number,
  mode: Flow['mode'], confidence: Flow['confidence'], note?: string,
): Flow => ({
  id: `flow:${id}`, fromEntityId: from, toEntityId: to, commodity: 'aluminium',
  form, quantity: kt, unit: 'kt/y', basis: 'metal_content', period: Y2024, mode,
  valueKind: 'representative', confidence,
  provenance: curated(note ?? 'Contained-Al kt/y converted from public gross figures at standard ratios (bauxite ~25% Al, calcined alumina 52.9% Al); representative magnitude.'),
});

export const ALUMINIUM_FLOWS: Flow[] = [
  // Bauxite (form 'ore').
  flow('sangaredi-kamsar', 'ent:mine:sangaredi', 'ent:port:kamsar', 'ore', 3600, 'rail', 'medium'),
  flow('boffa-kamsar', 'ent:mine:boffa', 'ent:port:kamsar', 'ore', 7000, 'mixed', 'low', 'SMB river-barge/rail chain folded to the Kamsar node; representative.'),
  flow('kamsar-shandong', 'ent:port:kamsar', 'ent:refinery:shandong-alumina', 'ore', 10000, 'sea', 'medium', 'Guinea→China seaborne bauxite, the dominant bauxite trade.'),
  flow('trombetas-alunorte', 'ent:mine:trombetas', 'ent:refinery:alunorte', 'ore', 2500, 'sea', 'medium'),
  flow('weipa-qal', 'ent:mine:weipa', 'ent:refinery:qal-gladstone', 'ore', 2800, 'sea', 'medium'),
  flow('weipa-shandong', 'ent:mine:weipa', 'ent:refinery:shandong-alumina', 'ore', 4000, 'sea', 'medium', 'Australian bauxite exports to Chinese refineries.'),
  flow('huntly-pinjarra', 'ent:mine:huntly', 'ent:refinery:pinjarra', 'ore', 2400, 'rail', 'medium'),
  // Alumina.
  flow('qal-weiqiao', 'ent:refinery:qal-gladstone', 'ent:smelter:weiqiao-binzhou', 'alumina', 900, 'sea', 'low', 'Australian alumina to Chinese smelting; representative slice of the AU→CN alumina trade.'),
  flow('pinjarra-ega', 'ent:refinery:pinjarra', 'ent:smelter:ega-al-taweelah', 'alumina', 700, 'sea', 'low'),
  flow('shandong-weiqiao', 'ent:refinery:shandong-alumina', 'ent:smelter:weiqiao-binzhou', 'alumina', 2800, 'internal', 'medium'),
  flow('alunorte-karmoy', 'ent:refinery:alunorte', 'ent:smelter:karmoy', 'alumina', 140, 'sea', 'medium', 'The Hydro integrated chain.'),
  // Primary metal (form 'refined').
  flow('weiqiao-cn-fab', 'ent:smelter:weiqiao-binzhou', 'ent:region:china-fabrication-al', 'refined', 5800, 'internal', 'medium'),
  flow('bratsk-eu-fab', 'ent:smelter:bratsk', 'ent:region:europe-fabrication-al', 'refined', 900, 'rail', 'low', 'Pre-2022 pattern; Russian metal has pivoted east — representative of the modeled 2024 snapshot.'),
  flow('krasnoyarsk-cn-fab', 'ent:smelter:krasnoyarsk', 'ent:region:china-fabrication-al', 'refined', 1000, 'rail', 'medium'),
  flow('kitimat-na-fab', 'ent:smelter:kitimat', 'ent:region:north-america-fabrication-al', 'refined', 400, 'sea', 'medium'),
  flow('karmoy-eu-fab', 'ent:smelter:karmoy', 'ent:region:europe-fabrication-al', 'refined', 260, 'sea', 'medium'),
  flow('alba-eu-fab', 'ent:smelter:alba', 'ent:region:europe-fabrication-al', 'refined', 800, 'sea', 'low'),
  flow('ega-na-fab', 'ent:smelter:ega-al-taweelah', 'ent:region:north-america-fabrication-al', 'refined', 500, 'sea', 'low'),
  flow('jharsuguda-in-fab', 'ent:smelter:jharsuguda', 'ent:region:india-fabrication-al', 'refined', 1600, 'rail', 'medium'),
];

/* ── Capacities ── */

const cap = (entity: string, stage: Capacity['stage'], kt: number, confidence: Capacity['confidence'], note?: string): Capacity => ({
  id: `cap:${entity.split(':')[2]}`, entityId: entity, stage, value: kt, unit: 'kt/y',
  period: Y2024, valueKind: 'representative', confidence, provenance: curated(note),
});

export const ALUMINIUM_CAPACITIES: Capacity[] = [
  cap('ent:smelter:weiqiao-binzhou', 'smelting', 6000, 'medium', 'Aggregated Binzhou complex.'),
  cap('ent:smelter:bratsk', 'smelting', 1010, 'medium'),
  cap('ent:smelter:krasnoyarsk', 'smelting', 1020, 'medium'),
  cap('ent:smelter:ega-al-taweelah', 'smelting', 1300, 'medium'),
  cap('ent:smelter:alba', 'smelting', 1620, 'medium'),
  cap('ent:smelter:kitimat', 'smelting', 430, 'high'),
  cap('ent:smelter:karmoy', 'smelting', 270, 'high'),
  cap('ent:smelter:jharsuguda', 'smelting', 1800, 'medium'),
  cap('ent:smelter:boyne-island', 'smelting', 590, 'medium'),
  // Alumina refining capacities are GROSS calcined-alumina mass — a
  // different basis from smelting capacity (metal); noted, never mixed.
  cap('ent:refinery:pinjarra', 'refining', 4200, 'medium', 'Gross calcined alumina kt/y.'),
  cap('ent:refinery:worsley', 'refining', 4600, 'medium', 'Gross calcined alumina kt/y.'),
  cap('ent:refinery:qal-gladstone', 'refining', 3950, 'medium', 'Gross calcined alumina kt/y.'),
  cap('ent:refinery:alunorte', 'refining', 6300, 'medium', 'Gross calcined alumina kt/y.'),
  cap('ent:refinery:shandong-alumina', 'refining', 30000, 'low', 'Aggregated Shandong coastal refineries; gross calcined alumina kt/y.'),
  cap('ent:refinery:al-taweelah-refinery', 'refining', 2400, 'medium', 'Gross calcined alumina kt/y.'),
];

/* ── Operator attribution + electricity dependencies ── */

const op = (facility: string, company: string, share: number, role: 'operator' | 'shareholder', note?: string): Dependency => ({
  id: `dep:op:${facility.split(':')[2]}:${company.split(':')[2]}`,
  fromEntityId: facility, type: 'operated_by', toEntityId: company, strength: share, role,
  basis: 'Operating/ownership attribution, representative; public disclosures.',
  provenance: curated(note),
});

export const ALUMINIUM_DEPENDENCIES: Dependency[] = [
  op('ent:mine:weipa', 'ent:company:rio-tinto-al', 1.0, 'operator'),
  op('ent:mine:huntly', 'ent:company:alcoa', 1.0, 'operator', 'AWAC JV (Alcoa-operated).'),
  op('ent:mine:trombetas', 'ent:company:rio-tinto-al', 0.12, 'shareholder', 'MRN consortium stake; operator of record is MRN itself (unmodeled — falls to the remainder).'),
  op('ent:refinery:pinjarra', 'ent:company:alcoa', 1.0, 'operator'),
  op('ent:refinery:worsley', 'ent:company:south32', 0.86, 'operator'),
  op('ent:refinery:qal-gladstone', 'ent:company:rio-tinto-al', 0.8, 'operator'),
  op('ent:refinery:alunorte', 'ent:company:norsk-hydro', 0.92, 'operator'),
  op('ent:refinery:al-taweelah-refinery', 'ent:company:ega', 1.0, 'operator'),
  op('ent:smelter:weiqiao-binzhou', 'ent:company:hongqiao', 1.0, 'operator'),
  op('ent:smelter:bratsk', 'ent:company:rusal', 1.0, 'operator'),
  op('ent:smelter:krasnoyarsk', 'ent:company:rusal', 1.0, 'operator'),
  op('ent:smelter:ega-al-taweelah', 'ent:company:ega', 1.0, 'operator'),
  op('ent:smelter:alba', 'ent:company:alba-co', 1.0, 'operator'),
  op('ent:smelter:kitimat', 'ent:company:rio-tinto-al', 1.0, 'operator'),
  op('ent:smelter:karmoy', 'ent:company:norsk-hydro', 1.0, 'operator'),
  op('ent:smelter:jharsuguda', 'ent:company:vedanta', 1.0, 'operator'),
  op('ent:smelter:boyne-island', 'ent:company:rio-tinto-al', 0.59, 'operator'),
  // Electricity as a declared dependency — the aluminium-specific edge.
  {
    id: 'dep:power:kitimat:kemano', fromEntityId: 'ent:smelter:kitimat', type: 'depends_on',
    toEntityId: 'ent:infrastructure:kemano-hydro', strength: 1.0,
    basis: 'Dedicated hydropower: Kitimat draws its entire load from Kemano; no grid alternative at smelter scale.',
    provenance: curated(),
  },
  {
    id: 'dep:power:karmoy:no-grid', fromEntityId: 'ent:smelter:karmoy', type: 'depends_on',
    toEntityId: 'ent:infrastructure:norwegian-hydro-grid', strength: 0.9,
    basis: 'Hydro-grid supply underpinning Norwegian smelting economics.',
    provenance: curated(),
  },
];

/* ── Observations (curated facility figures; country figures come live) ── */

const obs = (
  id: string, entityId: string, metric: Observation['metric'], value: number,
  basis: NonNullable<Observation['basis']>, confidence: Observation['confidence'], note?: string,
): Observation => ({
  id: `obs:al:${id}`, entityId, metric, value, unit: 'kt/y', basis,
  period: Y2024, valueKind: 'representative', confidence, provenance: curated(note),
});

export const ALUMINIUM_OBSERVATIONS: Observation[] = [
  obs('prod:weiqiao:2024', 'ent:smelter:weiqiao-binzhou', 'refined_production', 5800, 'metal_content', 'medium'),
  obs('prod:bratsk:2024', 'ent:smelter:bratsk', 'refined_production', 1000, 'metal_content', 'medium'),
  obs('prod:kitimat:2024', 'ent:smelter:kitimat', 'refined_production', 400, 'metal_content', 'medium'),
  obs('prod:karmoy:2024', 'ent:smelter:karmoy', 'refined_production', 260, 'metal_content', 'high'),
  obs('prod:jharsuguda:2024', 'ent:smelter:jharsuguda', 'refined_production', 1600, 'metal_content', 'medium'),
  obs('alumina:alunorte:2024', 'ent:refinery:alunorte', 'intermediate_production', 5900, 'gross_weight', 'medium', 'Gross calcined alumina.'),
  obs('alumina:pinjarra:2024', 'ent:refinery:pinjarra', 'intermediate_production', 4100, 'gross_weight', 'medium', 'Gross calcined alumina.'),
  obs('bauxite:sangaredi:2024', 'ent:mine:sangaredi', 'production', 14500, 'gross_weight', 'medium', 'Gross dry bauxite.'),
  obs('bauxite:boffa:2024', 'ent:mine:boffa', 'production', 28000, 'gross_weight', 'low', 'Gross dry bauxite; SMB aggregate.'),
  obs('bauxite:weipa:2024', 'ent:mine:weipa', 'production', 35000, 'gross_weight', 'medium', 'Gross dry bauxite.'),
];

/* ── Events (real public record) ── */

export const ALUMINIUM_EVENTS: EconEvent[] = [
  {
    id: 'evt:rusal-sanctions-2018', curation: 'independent', entityId: 'ent:company:rusal', type: 'sanction',
    title: 'US OFAC sanctions on Rusal', start: '2018-04-06', end: '2019-01-27',
    firstReportedAt: '2018-04-06', severity: 'high',
    description: 'OFAC SDN designation of Rusal (via En+ ownership), 2018-04-06; delisted 2019-01-27 after ownership restructuring. Alumina and metal markets dislocated globally within days — the canonical financial-class event: it attaches to the OWNER and reaches every operated facility through edges no strike could use.',
    provenance: news('OFAC designations and delisting, public record 2018–2019.'),
  },
  {
    id: 'evt:alunorte-embargo-2018', curation: 'independent', entityId: 'ent:refinery:alunorte', type: 'disruption',
    schemaLimitation: 'facility_scoped_regulation',
    title: 'Alunorte production embargo (court-ordered 50% curtailment)', start: '2018-03-01', end: '2019-05-21',
    firstReportedAt: '2018-03-01', severity: 'high',
    description: 'Brazilian court ordered Alunorte to half production after the Barcarena rain event; lifted May 2019. MODELING NOTE (recorded limitation): this was a REGULATORY act scoped to one facility, but RegulatoryScope is jurisdiction-shaped (country + commodity + direction) and cannot express a facility-scoped order — so the event is modeled as an operational disruption. The scope schema is copper-shaped in this respect; ledger phase 24.',
    provenance: news('Brazilian court orders and Hydro disclosures, 2018–2019.'),
  },
  {
    id: 'evt:kitimat-strike-2021', curation: 'independent', entityId: 'ent:smelter:kitimat', type: 'strike',
    title: 'Kitimat smelter strike (Unifor 2301)', start: '2021-07-25', end: '2021-10-14',
    firstReportedAt: '2021-07-25', severity: 'high',
    description: 'Strike cut Kitimat to roughly a third of capacity for ~11 weeks; operational class — traverses the operator edge, never the power dependency.',
    provenance: news('Rio Tinto and union statements, 2021.'),
  },
];

export const ALUMINIUM_SOURCES = [
  { sourceId: 'curated-aluminium-v1', sourceName: 'Payload Terminal curated aluminium dataset (USGS/IAI-derived representative data)' },
];

export const curatedAluminiumAdapter: EconomyAdapter = {
  providerId: 'curated-aluminium-v1',
  providerName: 'Payload Terminal curated aluminium dataset (USGS/IAI-derived representative data)',
  commodities: ['aluminium'],
  async load(commodity: string): Promise<AdapterPayload> {
    if (commodity !== 'aluminium') throw new Error(`curated-aluminium-v1 cannot serve commodity "${commodity}"`);
    return {
      commodity: 'aluminium',
      commodityName: 'Aluminium',
      entities: ALUMINIUM_ENTITIES,
      observations: ALUMINIUM_OBSERVATIONS,
      flows: ALUMINIUM_FLOWS,
      capacities: ALUMINIUM_CAPACITIES,
      dependencies: ALUMINIUM_DEPENDENCIES,
      events: ALUMINIUM_EVENTS,
      sources: ALUMINIUM_SOURCES,
    };
  },
};
