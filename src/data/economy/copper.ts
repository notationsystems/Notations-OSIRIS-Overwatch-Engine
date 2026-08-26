/**
 * OSIRIS — Curated copper dataset (provider payload for the curated adapter).
 *
 * Magnitudes are assembled from public sources (USGS Mineral Commodity
 * Summaries 2025, ICSG World Copper Factbook, company disclosures) and are
 * REPRESENTATIVE: order-of-magnitude faithful, not fresh reported figures.
 * Every record says so via valueKind + confidence + provenance. Facility
 * coordinates are approximate; geoPrecision marks how coarse.
 *
 * Units: country/facility production and flows are expressed as contained
 * copper, kt/y (concentrate flows are copper-content equivalents, not gross
 * concentrate tonnage — see provenance notes).
 */

import type {
  Entity, Observation, Flow, Capacity, Dependency, EconEvent, Provenance,
} from '@/lib/economy/types';

const RETRIEVED = '2026-08-26T00:00:00Z';

const SOURCES = [
  { sourceId: 'usgs-mcs-2025', sourceName: 'USGS Mineral Commodity Summaries 2025 — Copper', sourceUrl: 'https://pubs.usgs.gov/periodicals/mcs2025/mcs2025-copper.pdf' },
  { sourceId: 'icsg-factbook-2024', sourceName: 'ICSG World Copper Factbook 2024', sourceUrl: 'https://icsg.org/copper-factbook/' },
  { sourceId: 'osiris-curated-2026', sourceName: 'OSIRIS curated facility dataset (public company disclosures)', sourceUrl: undefined },
  { sourceId: 'lme-representative', sourceName: 'Representative exchange warehouse stock series (LME-shaped)', sourceUrl: 'https://www.lme.com/en/market-data' },
  { sourceId: 'public-news-2025', sourceName: 'Public news & company statements (2023–2025)', sourceUrl: undefined },
];

const usgs = (ref?: string, note?: string): Provenance =>
  ({ sourceId: 'usgs-mcs-2025', sourceName: SOURCES[0].sourceName, sourceUrl: SOURCES[0].sourceUrl, retrievedAt: RETRIEVED, sourceRef: ref, note });
const icsg = (ref?: string, note?: string): Provenance =>
  ({ sourceId: 'icsg-factbook-2024', sourceName: SOURCES[1].sourceName, sourceUrl: SOURCES[1].sourceUrl, retrievedAt: RETRIEVED, sourceRef: ref, note });
const curated = (note?: string): Provenance =>
  ({ sourceId: 'osiris-curated-2026', sourceName: SOURCES[2].sourceName, retrievedAt: RETRIEVED, note });
const lme = (note?: string): Provenance =>
  ({ sourceId: 'lme-representative', sourceName: SOURCES[3].sourceName, sourceUrl: SOURCES[3].sourceUrl, retrievedAt: RETRIEVED, note });
const news = (note?: string): Provenance =>
  ({ sourceId: 'public-news-2025', sourceName: SOURCES[4].sourceName, retrievedAt: RETRIEVED, note });

const Y2024 = { start: '2024-01-01', end: '2024-12-31' };

/* ── Entities ── */

const countries: Entity[] = [
  { id: 'ent:country:cl', kind: 'country', name: 'Chile', countryCode: 'CL', commodity: 'copper', lat: -30.0, lng: -71.0, geoPrecision: 'country' },
  { id: 'ent:country:pe', kind: 'country', name: 'Peru', countryCode: 'PE', commodity: 'copper', lat: -9.2, lng: -75.0, geoPrecision: 'country' },
  { id: 'ent:country:cd', kind: 'country', name: 'DR Congo', countryCode: 'CD', commodity: 'copper', lat: -4.0, lng: 21.8, geoPrecision: 'country' },
  { id: 'ent:country:cn', kind: 'country', name: 'China', countryCode: 'CN', commodity: 'copper', lat: 35.9, lng: 104.2, geoPrecision: 'country' },
  { id: 'ent:country:us', kind: 'country', name: 'United States', countryCode: 'US', commodity: 'copper', lat: 39.8, lng: -98.6, geoPrecision: 'country' },
  { id: 'ent:country:id', kind: 'country', name: 'Indonesia', countryCode: 'ID', commodity: 'copper', lat: -2.5, lng: 118.0, geoPrecision: 'country' },
  { id: 'ent:country:au', kind: 'country', name: 'Australia', countryCode: 'AU', commodity: 'copper', lat: -25.3, lng: 133.8, geoPrecision: 'country' },
  { id: 'ent:country:zm', kind: 'country', name: 'Zambia', countryCode: 'ZM', commodity: 'copper', lat: -13.1, lng: 27.8, geoPrecision: 'country' },
  { id: 'ent:country:mx', kind: 'country', name: 'Mexico', countryCode: 'MX', commodity: 'copper', lat: 23.6, lng: -102.5, geoPrecision: 'country' },
  { id: 'ent:country:kz', kind: 'country', name: 'Kazakhstan', countryCode: 'KZ', commodity: 'copper', lat: 48.0, lng: 66.9, geoPrecision: 'country' },
  { id: 'ent:country:ru', kind: 'country', name: 'Russia', countryCode: 'RU', commodity: 'copper', lat: 61.5, lng: 105.3, geoPrecision: 'country' },
  { id: 'ent:country:mn', kind: 'country', name: 'Mongolia', countryCode: 'MN', commodity: 'copper', lat: 46.9, lng: 103.8, geoPrecision: 'country' },
  { id: 'ent:country:pl', kind: 'country', name: 'Poland', countryCode: 'PL', commodity: 'copper', lat: 51.9, lng: 19.1, geoPrecision: 'country' },
  { id: 'ent:country:jp', kind: 'country', name: 'Japan', countryCode: 'JP', commodity: 'copper', lat: 36.2, lng: 138.3, geoPrecision: 'country' },
  { id: 'ent:country:kr', kind: 'country', name: 'South Korea', countryCode: 'KR', commodity: 'copper', lat: 35.9, lng: 127.8, geoPrecision: 'country' },
  { id: 'ent:country:de', kind: 'country', name: 'Germany', countryCode: 'DE', commodity: 'copper', lat: 51.2, lng: 10.4, geoPrecision: 'country' },
  { id: 'ent:country:in', kind: 'country', name: 'India', countryCode: 'IN', commodity: 'copper', lat: 20.6, lng: 79.0, geoPrecision: 'country' },
  { id: 'ent:country:pa', kind: 'country', name: 'Panama', countryCode: 'PA', commodity: 'copper', lat: 8.5, lng: -80.8, geoPrecision: 'country' },
  { id: 'ent:country:ca', kind: 'country', name: 'Canada', countryCode: 'CA', commodity: 'copper', lat: 56.1, lng: -106.3, geoPrecision: 'country', notes: 'Carried for live USGS/Comtrade observations; no curated facility detail yet.' },
];

const mines: Entity[] = [
  { id: 'ent:mine:escondida', kind: 'mine', name: 'Escondida', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -24.27, lng: -69.07, geoPrecision: 'site', stage: 'production', operator: 'BHP' },
  { id: 'ent:mine:collahuasi', kind: 'mine', name: 'Collahuasi', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -20.98, lng: -68.70, geoPrecision: 'site', stage: 'production', operator: 'Anglo American / Glencore' },
  { id: 'ent:mine:el-teniente', kind: 'mine', name: 'El Teniente', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -34.08, lng: -70.35, geoPrecision: 'site', stage: 'production', operator: 'Codelco' },
  { id: 'ent:mine:chuquicamata', kind: 'mine', name: 'Chuquicamata', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -22.29, lng: -68.90, geoPrecision: 'site', stage: 'production', operator: 'Codelco' },
  { id: 'ent:mine:cerro-verde', kind: 'mine', name: 'Cerro Verde', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -16.54, lng: -71.59, geoPrecision: 'site', stage: 'production', operator: 'Freeport-McMoRan' },
  { id: 'ent:mine:antamina', kind: 'mine', name: 'Antamina', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -9.54, lng: -77.05, geoPrecision: 'site', stage: 'production', operator: 'BHP / Glencore / Teck' },
  { id: 'ent:mine:las-bambas', kind: 'mine', name: 'Las Bambas', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -14.03, lng: -72.33, geoPrecision: 'site', stage: 'production', operator: 'MMG' },
  { id: 'ent:mine:grasberg', kind: 'mine', name: 'Grasberg', commodity: 'copper', countryCode: 'ID', country: 'Indonesia', lat: -4.06, lng: 137.11, geoPrecision: 'site', stage: 'production', operator: 'Freeport Indonesia' },
  { id: 'ent:mine:kamoa-kakula', kind: 'mine', name: 'Kamoa-Kakula', commodity: 'copper', countryCode: 'CD', country: 'DR Congo', lat: -10.77, lng: 25.86, geoPrecision: 'site', stage: 'production', operator: 'Ivanhoe / Zijin' },
  { id: 'ent:mine:tenke-fungurume', kind: 'mine', name: 'Tenke Fungurume', commodity: 'copper', countryCode: 'CD', country: 'DR Congo', lat: -10.60, lng: 26.20, geoPrecision: 'site', stage: 'production', operator: 'CMOC' },
  { id: 'ent:mine:morenci', kind: 'mine', name: 'Morenci', commodity: 'copper', countryCode: 'US', country: 'United States', lat: 33.05, lng: -109.36, geoPrecision: 'site', stage: 'production', operator: 'Freeport-McMoRan' },
  { id: 'ent:mine:buenavista', kind: 'mine', name: 'Buenavista del Cobre', commodity: 'copper', countryCode: 'MX', country: 'Mexico', lat: 30.97, lng: -110.31, geoPrecision: 'site', stage: 'production', operator: 'Grupo México' },
  { id: 'ent:mine:oyu-tolgoi', kind: 'mine', name: 'Oyu Tolgoi', commodity: 'copper', countryCode: 'MN', country: 'Mongolia', lat: 43.01, lng: 106.87, geoPrecision: 'site', stage: 'production', operator: 'Rio Tinto' },
  { id: 'ent:mine:kansanshi', kind: 'mine', name: 'Kansanshi', commodity: 'copper', countryCode: 'ZM', country: 'Zambia', lat: -12.09, lng: 26.43, geoPrecision: 'site', stage: 'production', operator: 'First Quantum' },
  { id: 'ent:mine:cobre-panama', kind: 'mine', name: 'Cobre Panamá', commodity: 'copper', countryCode: 'PA', country: 'Panama', lat: 8.85, lng: -80.66, geoPrecision: 'site', stage: 'production', operator: 'First Quantum', notes: 'Ordered closed Nov 2023; in preservation. Included because its removal is a live structural fact of the copper market.' },
];

const smelters: Entity[] = [
  { id: 'ent:smelter:guixi', kind: 'smelter', name: 'Guixi Smelter', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 28.29, lng: 117.21, geoPrecision: 'city', stage: 'smelting', operator: 'Jiangxi Copper' },
  { id: 'ent:smelter:daye', kind: 'smelter', name: 'Daye Nonferrous Smelter', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 30.10, lng: 114.97, geoPrecision: 'city', stage: 'smelting', operator: 'Daye Nonferrous' },
  { id: 'ent:smelter:yunnan-kunming', kind: 'smelter', name: 'Yunnan Copper (Kunming)', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 24.88, lng: 102.83, geoPrecision: 'city', stage: 'smelting', operator: 'Yunnan Copper / Chinalco' },
  { id: 'ent:smelter:onsan', kind: 'smelter', name: 'Onsan Smelter', commodity: 'copper', countryCode: 'KR', country: 'South Korea', lat: 35.43, lng: 129.35, geoPrecision: 'city', stage: 'smelting', operator: 'LS MnM' },
  { id: 'ent:smelter:saganoseki', kind: 'smelter', name: 'Saganoseki Smelter', commodity: 'copper', countryCode: 'JP', country: 'Japan', lat: 33.24, lng: 131.88, geoPrecision: 'city', stage: 'smelting', operator: 'JX Advanced Metals' },
  { id: 'ent:smelter:toyo', kind: 'smelter', name: 'Toyo Smelter (Saijo)', commodity: 'copper', countryCode: 'JP', country: 'Japan', lat: 33.93, lng: 133.10, geoPrecision: 'city', stage: 'smelting', operator: 'Sumitomo Metal Mining' },
  { id: 'ent:smelter:gresik', kind: 'smelter', name: 'Gresik Smelter (PT Smelting)', commodity: 'copper', countryCode: 'ID', country: 'Indonesia', lat: -7.16, lng: 112.62, geoPrecision: 'city', stage: 'smelting', operator: 'Mitsubishi Materials / Freeport' },
  { id: 'ent:smelter:manyar', kind: 'smelter', name: 'Manyar Smelter (Freeport Indonesia)', commodity: 'copper', countryCode: 'ID', country: 'Indonesia', lat: -7.13, lng: 112.58, geoPrecision: 'city', stage: 'smelting', operator: 'Freeport Indonesia', notes: 'Commissioned 2024–2025; ramping.' },
  { id: 'ent:smelter:aurubis-hamburg', kind: 'smelter', name: 'Aurubis Hamburg', commodity: 'copper', countryCode: 'DE', country: 'Germany', lat: 53.52, lng: 10.04, geoPrecision: 'city', stage: 'smelting', operator: 'Aurubis' },
  { id: 'ent:smelter:glogow', kind: 'smelter', name: 'Głogów Smelter', commodity: 'copper', countryCode: 'PL', country: 'Poland', lat: 51.67, lng: 16.03, geoPrecision: 'city', stage: 'smelting', operator: 'KGHM' },
  { id: 'ent:smelter:caletones', kind: 'smelter', name: 'Caletones Smelter', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -34.10, lng: -70.45, geoPrecision: 'city', stage: 'smelting', operator: 'Codelco' },
  { id: 'ent:smelter:chuquicamata-smelter', kind: 'smelter', name: 'Chuquicamata Smelter', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -22.30, lng: -68.92, geoPrecision: 'city', stage: 'smelting', operator: 'Codelco' },
  { id: 'ent:smelter:ilo', kind: 'smelter', name: 'Ilo Smelter', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -17.64, lng: -71.34, geoPrecision: 'city', stage: 'smelting', operator: 'Southern Copper' },
];

const refineries: Entity[] = [
  { id: 'ent:refinery:guixi-refinery', kind: 'refinery', name: 'Guixi Refinery', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 28.30, lng: 117.22, geoPrecision: 'city', stage: 'refining', operator: 'Jiangxi Copper' },
  { id: 'ent:refinery:onsan-refinery', kind: 'refinery', name: 'Onsan Refinery', commodity: 'copper', countryCode: 'KR', country: 'South Korea', lat: 35.44, lng: 129.36, geoPrecision: 'city', stage: 'refining', operator: 'LS MnM' },
  { id: 'ent:refinery:chile-sxew', kind: 'refinery', name: 'Chile SX-EW & Electrorefining (aggregate)', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -23.5, lng: -69.5, geoPrecision: 'region', stage: 'refining', notes: 'Aggregate node for Chilean cathode output; facility-level split not represented in phase 1.' },
  { id: 'ent:refinery:kennecott', kind: 'refinery', name: 'Kennecott (Garfield) Smelter-Refinery', commodity: 'copper', countryCode: 'US', country: 'United States', lat: 40.72, lng: -112.20, geoPrecision: 'site', stage: 'refining', operator: 'Rio Tinto' },
  { id: 'ent:refinery:glogow-refinery', kind: 'refinery', name: 'Głogów Refinery', commodity: 'copper', countryCode: 'PL', country: 'Poland', lat: 51.68, lng: 16.04, geoPrecision: 'city', stage: 'refining', operator: 'KGHM' },
  { id: 'ent:refinery:drc-sxew', kind: 'refinery', name: 'DRC SX-EW Cathode (aggregate)', commodity: 'copper', countryCode: 'CD', country: 'DR Congo', lat: -10.7, lng: 25.5, geoPrecision: 'region', stage: 'refining', notes: 'Aggregate node for Katanga SX-EW cathode output.' },
];

const ports: Entity[] = [
  { id: 'ent:port:antofagasta', kind: 'port', name: 'Port of Antofagasta', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -23.65, lng: -70.40, geoPrecision: 'site', stage: 'logistics' },
  { id: 'ent:port:mejillones', kind: 'port', name: 'Port of Mejillones (Angamos)', commodity: 'copper', countryCode: 'CL', country: 'Chile', lat: -23.09, lng: -70.44, geoPrecision: 'site', stage: 'logistics' },
  { id: 'ent:port:callao', kind: 'port', name: 'Port of Callao', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -12.05, lng: -77.15, geoPrecision: 'site', stage: 'logistics' },
  { id: 'ent:port:matarani', kind: 'port', name: 'Port of Matarani', commodity: 'copper', countryCode: 'PE', country: 'Peru', lat: -17.00, lng: -72.11, geoPrecision: 'site', stage: 'logistics' },
  { id: 'ent:port:amamapare', kind: 'port', name: 'Amamapare Port (Grasberg)', commodity: 'copper', countryCode: 'ID', country: 'Indonesia', lat: -4.83, lng: 136.99, geoPrecision: 'site', stage: 'logistics' },
  { id: 'ent:port:dar-es-salaam', kind: 'port', name: 'Port of Dar es Salaam', commodity: 'copper', countryCode: 'TZ', country: 'Tanzania', lat: -6.82, lng: 39.29, geoPrecision: 'site', stage: 'logistics', notes: 'Primary eastern export corridor for Katanga/Copperbelt material.' },
  { id: 'ent:port:durban', kind: 'port', name: 'Port of Durban', commodity: 'copper', countryCode: 'ZA', country: 'South Africa', lat: -29.87, lng: 31.02, geoPrecision: 'site', stage: 'logistics', notes: 'Southern export corridor for Katanga/Copperbelt material.' },
  { id: 'ent:port:shanghai', kind: 'port', name: 'Port of Shanghai (Yangshan)', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 30.63, lng: 122.06, geoPrecision: 'site', stage: 'logistics', notes: 'Stand-in gateway node for Chinese concentrate/cathode imports; the real import flow spreads across several ports.' },
];

const demandRegions: Entity[] = [
  { id: 'ent:region:china-fabrication', kind: 'region', name: 'China fabrication & manufacturing', commodity: 'copper', countryCode: 'CN', country: 'China', lat: 31.5, lng: 117.0, geoPrecision: 'region', stage: 'manufacturing' },
  { id: 'ent:region:eu-manufacturing', kind: 'region', name: 'EU manufacturing', commodity: 'copper', country: 'European Union', lat: 50.0, lng: 9.0, geoPrecision: 'region', stage: 'manufacturing' },
  { id: 'ent:region:us-manufacturing', kind: 'region', name: 'US manufacturing', commodity: 'copper', countryCode: 'US', country: 'United States', lat: 40.0, lng: -85.0, geoPrecision: 'region', stage: 'manufacturing' },
  { id: 'ent:region:japan-korea-manufacturing', kind: 'region', name: 'Japan / Korea manufacturing', commodity: 'copper', lat: 35.5, lng: 132.0, geoPrecision: 'region', stage: 'manufacturing' },
  { id: 'ent:region:india-manufacturing', kind: 'region', name: 'India manufacturing', commodity: 'copper', countryCode: 'IN', country: 'India', lat: 22.0, lng: 78.0, geoPrecision: 'region', stage: 'manufacturing' },
];

const infrastructure: Entity[] = [
  { id: 'ent:infrastructure:lme-warehouses', kind: 'infrastructure', name: 'LME warehouse network', commodity: 'copper', geoPrecision: 'region', stage: 'logistics', notes: 'Global network; no single location. Stock series attached here.' },
  { id: 'ent:infrastructure:panama-canal', kind: 'infrastructure', name: 'Panama Canal', countryCode: 'PA', country: 'Panama', lat: 9.08, lng: -79.68, geoPrecision: 'site', stage: 'logistics' },
];

export const COPPER_ENTITIES: Entity[] = [
  { id: 'ent:commodity:copper', kind: 'commodity', name: 'Copper' },
  ...countries, ...mines, ...smelters, ...refineries, ...ports, ...demandRegions, ...infrastructure,
];

/* ── Observations ── */

/** Country mine production 2024, kt contained Cu (USGS MCS 2025 magnitudes). */
const countryProduction: Array<[string, number, Observation['confidence']]> = [
  ['ent:country:cl', 5300, 'high'],
  ['ent:country:cd', 3300, 'high'],
  ['ent:country:pe', 2600, 'high'],
  ['ent:country:cn', 1800, 'high'],
  ['ent:country:us', 1100, 'high'],
  ['ent:country:id', 1000, 'medium'],
  ['ent:country:ru', 930, 'medium'],
  ['ent:country:au', 800, 'high'],
  ['ent:country:zm', 800, 'medium'],
  ['ent:country:kz', 740, 'medium'],
  ['ent:country:mx', 700, 'high'],
  ['ent:country:pl', 390, 'high'],
  ['ent:country:mn', 300, 'low'],
];

/** Country refined production 2024, kt (ICSG magnitudes). */
const countryRefined: Array<[string, number, Observation['confidence']]> = [
  ['ent:country:cn', 12000, 'high'],
  ['ent:country:cd', 2500, 'medium'],
  ['ent:country:cl', 1900, 'high'],
  ['ent:country:jp', 1500, 'high'],
  ['ent:country:ru', 1000, 'medium'],
  ['ent:country:us', 890, 'high'],
  ['ent:country:kr', 650, 'high'],
  ['ent:country:de', 630, 'high'],
  ['ent:country:pl', 590, 'high'],
  ['ent:country:in', 550, 'medium'],
  ['ent:country:zm', 400, 'medium'],
  ['ent:country:id', 400, 'low'],
];

/** Refined consumption 2024, kt (ICSG magnitudes; region entities). */
const regionConsumption: Array<[string, number, Observation['confidence']]> = [
  ['ent:region:china-fabrication', 15000, 'high'],
  ['ent:region:eu-manufacturing', 3100, 'medium'],
  ['ent:region:us-manufacturing', 1800, 'high'],
  ['ent:region:japan-korea-manufacturing', 1400, 'medium'],
  ['ent:region:india-manufacturing', 800, 'medium'],
];

/** Facility production 2024, kt contained Cu (company disclosures, representative). */
const facilityProduction: Array<[string, number, Observation['confidence']]> = [
  ['ent:mine:escondida', 1050, 'high'],
  ['ent:mine:collahuasi', 560, 'high'],
  ['ent:mine:el-teniente', 420, 'high'],
  ['ent:mine:chuquicamata', 350, 'high'],
  ['ent:mine:cerro-verde', 430, 'high'],
  ['ent:mine:antamina', 430, 'high'],
  ['ent:mine:las-bambas', 320, 'high'],
  ['ent:mine:grasberg', 800, 'high'],
  ['ent:mine:kamoa-kakula', 440, 'high'],
  ['ent:mine:tenke-fungurume', 280, 'medium'],
  ['ent:mine:morenci', 450, 'high'],
  ['ent:mine:buenavista', 430, 'medium'],
  ['ent:mine:oyu-tolgoi', 220, 'medium'],
  ['ent:mine:kansanshi', 200, 'medium'],
  ['ent:mine:cobre-panama', 0, 'high'],
];

/**
 * Representative monthly exchange-stock series (kt), Aug 2025 → Jul 2026.
 * Shaped like the real LME series (drawdown into 2026) — representative,
 * not a live feed. This is the anomaly-detection substrate for phase 1.
 */
const lmeStocks: Array<[string, number]> = [
  ['2025-08', 182], ['2025-09', 175], ['2025-10', 171], ['2025-11', 168],
  ['2025-12', 165], ['2026-01', 170], ['2026-02', 161], ['2026-03', 150],
  ['2026-04', 139], ['2026-05', 127], ['2026-06', 104], ['2026-07', 88],
];

function monthPeriod(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, '0')}` };
}

export const COPPER_OBSERVATIONS: Observation[] = [
  ...countryProduction.map(([entityId, value, confidence]): Observation => ({
    id: `obs:prod-2024:${entityId.split(':')[2]}`,
    entityId, metric: 'production', value, unit: 'kt/y', period: Y2024,
    valueKind: 'representative', confidence,
    provenance: usgs('Mine production, 2024 est.', 'Contained copper.'),
  })),
  ...countryRefined.map(([entityId, value, confidence]): Observation => ({
    id: `obs:refined-2024:${entityId.split(':')[2]}`,
    entityId, metric: 'refined_production', value, unit: 'kt/y', period: Y2024,
    valueKind: 'representative', confidence,
    provenance: icsg('Refined production by country, 2024', 'Includes SX-EW cathode.'),
  })),
  ...regionConsumption.map(([entityId, value, confidence]): Observation => ({
    id: `obs:cons-2024:${entityId.split(':')[2]}`,
    entityId, metric: 'consumption', value, unit: 'kt/y', period: Y2024,
    valueKind: 'representative', confidence,
    provenance: icsg('Refined usage by region, 2024'),
  })),
  ...facilityProduction.map(([entityId, value, confidence]): Observation => ({
    id: `obs:prod-2024:${entityId.split(':')[2]}`,
    entityId, metric: 'production', value, unit: 'kt/y', period: Y2024,
    valueKind: 'representative', confidence,
    provenance: curated('Facility output, contained Cu, assembled from company reporting.'),
  })),
  ...lmeStocks.map(([ym, value]): Observation => ({
    id: `obs:lme-stocks:${ym}`,
    entityId: 'ent:infrastructure:lme-warehouses',
    metric: 'inventory', value, unit: 'kt', period: monthPeriod(ym),
    valueKind: 'representative', confidence: 'medium',
    provenance: lme('Month-end total copper stocks, representative series.'),
  })),
];

/* ── Capacities (kt/y, contained Cu throughput) ── */

const capacityRows: Array<[string, string, Capacity['stage'], number, Capacity['confidence']]> = [
  ['cap:guixi', 'ent:smelter:guixi', 'smelting', 1100, 'medium'],
  ['cap:daye', 'ent:smelter:daye', 'smelting', 600, 'medium'],
  ['cap:yunnan', 'ent:smelter:yunnan-kunming', 'smelting', 500, 'low'],
  ['cap:onsan', 'ent:smelter:onsan', 'smelting', 640, 'medium'],
  ['cap:saganoseki', 'ent:smelter:saganoseki', 'smelting', 450, 'medium'],
  ['cap:toyo', 'ent:smelter:toyo', 'smelting', 450, 'medium'],
  ['cap:gresik', 'ent:smelter:gresik', 'smelting', 300, 'medium'],
  ['cap:manyar', 'ent:smelter:manyar', 'smelting', 480, 'medium'],
  ['cap:aurubis-hamburg', 'ent:smelter:aurubis-hamburg', 'smelting', 450, 'medium'],
  ['cap:glogow', 'ent:smelter:glogow', 'smelting', 440, 'medium'],
  ['cap:caletones', 'ent:smelter:caletones', 'smelting', 400, 'medium'],
  ['cap:chuquicamata-smelter', 'ent:smelter:chuquicamata-smelter', 'smelting', 350, 'medium'],
  ['cap:ilo', 'ent:smelter:ilo', 'smelting', 360, 'medium'],
  ['cap:guixi-refinery', 'ent:refinery:guixi-refinery', 'refining', 1200, 'medium'],
  ['cap:onsan-refinery', 'ent:refinery:onsan-refinery', 'refining', 680, 'medium'],
  ['cap:chile-sxew', 'ent:refinery:chile-sxew', 'refining', 2100, 'low'],
  ['cap:kennecott', 'ent:refinery:kennecott', 'refining', 300, 'medium'],
  ['cap:glogow-refinery', 'ent:refinery:glogow-refinery', 'refining', 600, 'medium'],
  ['cap:drc-sxew', 'ent:refinery:drc-sxew', 'refining', 2600, 'low'],
  ['cap:cobre-panama', 'ent:mine:cobre-panama', 'production', 350, 'high'],
];

export const COPPER_CAPACITIES: Capacity[] = capacityRows.map(([id, entityId, stage, value, confidence]) => ({
  id, entityId, stage, value, unit: 'kt/y', period: Y2024,
  valueKind: 'representative', confidence,
  provenance: curated('Nameplate/annualized throughput, contained Cu.'),
}));

/* ── Flows (2024 annual, kt contained Cu) ── */

type FlowRow = [id: string, from: string, to: string, form: Flow['form'], qty: number, mode: Flow['mode'], conf: Flow['confidence'], note?: string];

const flowRows: FlowRow[] = [
  // Chilean mines → export ports (concentrate)
  ['flow:escondida-antofagasta', 'ent:mine:escondida', 'ent:port:antofagasta', 'concentrate', 750, 'rail', 'medium', 'Escondida concentrate railed to coast; SX-EW cathode excluded.'],
  ['flow:collahuasi-antofagasta', 'ent:mine:collahuasi', 'ent:port:antofagasta', 'concentrate', 540, 'road', 'low', 'Collahuasi actually ships via Punta Patache; folded into Antofagasta node in phase 1.'],
  ['flow:chuqui-mine-smelter', 'ent:mine:chuquicamata', 'ent:smelter:chuquicamata-smelter', 'concentrate', 320, 'internal', 'medium'],
  ['flow:teniente-caletones', 'ent:mine:el-teniente', 'ent:smelter:caletones', 'concentrate', 380, 'internal', 'medium'],
  // Peruvian mines → ports
  ['flow:cerro-verde-matarani', 'ent:mine:cerro-verde', 'ent:port:matarani', 'concentrate', 400, 'rail', 'medium'],
  ['flow:las-bambas-matarani', 'ent:mine:las-bambas', 'ent:port:matarani', 'concentrate', 310, 'road', 'medium'],
  ['flow:antamina-callao', 'ent:mine:antamina', 'ent:port:callao', 'concentrate', 420, 'pipeline', 'low', 'Antamina ships via Punta Lobitos; folded into Callao node in phase 1.'],
  // Concentrate sea flows → East Asia
  ['flow:antofagasta-shanghai', 'ent:port:antofagasta', 'ent:port:shanghai', 'concentrate', 900, 'sea', 'medium'],
  ['flow:antofagasta-japan', 'ent:port:antofagasta', 'ent:smelter:saganoseki', 'concentrate', 200, 'sea', 'low'],
  ['flow:matarani-shanghai', 'ent:port:matarani', 'ent:port:shanghai', 'concentrate', 550, 'sea', 'medium'],
  ['flow:callao-shanghai', 'ent:port:callao', 'ent:port:shanghai', 'concentrate', 300, 'sea', 'medium'],
  ['flow:callao-onsan', 'ent:port:callao', 'ent:smelter:onsan', 'concentrate', 120, 'sea', 'low'],
  ['flow:matarani-toyo', 'ent:port:matarani', 'ent:smelter:toyo', 'concentrate', 130, 'sea', 'low'],
  // Chinese gateway → smelters
  ['flow:shanghai-guixi', 'ent:port:shanghai', 'ent:smelter:guixi', 'concentrate', 950, 'mixed', 'low', 'Gateway allocation is representative; Chinese import split by smelter is not public at this granularity.'],
  ['flow:shanghai-daye', 'ent:port:shanghai', 'ent:smelter:daye', 'concentrate', 450, 'mixed', 'low'],
  ['flow:shanghai-yunnan', 'ent:port:shanghai', 'ent:smelter:yunnan-kunming', 'concentrate', 350, 'mixed', 'low'],
  // Indonesia
  ['flow:grasberg-amamapare', 'ent:mine:grasberg', 'ent:port:amamapare', 'concentrate', 800, 'pipeline', 'medium', 'Concentrate slurry pipeline to port.'],
  ['flow:amamapare-gresik', 'ent:port:amamapare', 'ent:smelter:gresik', 'concentrate', 300, 'sea', 'medium'],
  ['flow:amamapare-manyar', 'ent:port:amamapare', 'ent:smelter:manyar', 'concentrate', 400, 'sea', 'medium', 'Ramping toward full domestic processing after export-permit wind-down.'],
  // DRC / Zambia corridors
  ['flow:kamoa-dar', 'ent:mine:kamoa-kakula', 'ent:port:dar-es-salaam', 'blister', 260, 'road', 'medium', 'Anode/blister from on-site smelter plus concentrate, expressed as Cu content.'],
  ['flow:kamoa-durban', 'ent:mine:kamoa-kakula', 'ent:port:durban', 'blister', 150, 'road', 'low'],
  ['flow:tenke-dar', 'ent:mine:tenke-fungurume', 'ent:port:dar-es-salaam', 'cathode', 180, 'road', 'medium', 'SX-EW cathode trucked east.'],
  ['flow:dar-shanghai', 'ent:port:dar-es-salaam', 'ent:port:shanghai', 'blister', 420, 'sea', 'medium'],
  ['flow:durban-shanghai', 'ent:port:durban', 'ent:port:shanghai', 'blister', 140, 'sea', 'low'],
  // Smelter → refinery → fabrication (China)
  ['flow:guixi-smelter-refinery', 'ent:smelter:guixi', 'ent:refinery:guixi-refinery', 'anode', 1050, 'internal', 'medium'],
  ['flow:guixi-refinery-fab', 'ent:refinery:guixi-refinery', 'ent:region:china-fabrication', 'cathode', 1150, 'mixed', 'medium'],
  ['flow:daye-fab', 'ent:smelter:daye', 'ent:region:china-fabrication', 'cathode', 550, 'mixed', 'low'],
  ['flow:yunnan-fab', 'ent:smelter:yunnan-kunming', 'ent:region:china-fabrication', 'cathode', 450, 'mixed', 'low'],
  // Other refined flows to demand regions
  ['flow:onsan-refinery-korea', 'ent:smelter:onsan', 'ent:refinery:onsan-refinery', 'anode', 620, 'internal', 'medium'],
  ['flow:onsan-fab', 'ent:refinery:onsan-refinery', 'ent:region:japan-korea-manufacturing', 'cathode', 640, 'mixed', 'medium'],
  ['flow:saganoseki-fab', 'ent:smelter:saganoseki', 'ent:region:japan-korea-manufacturing', 'cathode', 430, 'mixed', 'medium'],
  ['flow:toyo-fab', 'ent:smelter:toyo', 'ent:region:japan-korea-manufacturing', 'cathode', 420, 'mixed', 'medium'],
  ['flow:chile-sxew-us', 'ent:refinery:chile-sxew', 'ent:region:us-manufacturing', 'cathode', 600, 'sea', 'medium'],
  ['flow:chile-sxew-china', 'ent:refinery:chile-sxew', 'ent:region:china-fabrication', 'cathode', 900, 'sea', 'medium'],
  ['flow:drc-sxew-china', 'ent:refinery:drc-sxew', 'ent:region:china-fabrication', 'cathode', 1500, 'mixed', 'medium', 'Katanga cathode to China via multiple corridors; corridor split shown separately at port level for the blister/anode share.'],
  ['flow:kennecott-us', 'ent:refinery:kennecott', 'ent:region:us-manufacturing', 'cathode', 220, 'rail', 'medium'],
  ['flow:aurubis-eu', 'ent:smelter:aurubis-hamburg', 'ent:region:eu-manufacturing', 'cathode', 430, 'mixed', 'medium'],
  ['flow:glogow-refinery-eu', 'ent:refinery:glogow-refinery', 'ent:region:eu-manufacturing', 'cathode', 560, 'mixed', 'medium'],
  ['flow:glogow-smelter-refinery', 'ent:smelter:glogow', 'ent:refinery:glogow-refinery', 'anode', 420, 'internal', 'medium'],
];

export const COPPER_FLOWS: Flow[] = flowRows.map(([id, fromEntityId, toEntityId, form, quantity, mode, confidence, note]) => ({
  id, fromEntityId, toEntityId, commodity: 'copper', form, quantity, unit: 'kt/y',
  period: Y2024, mode, valueKind: 'representative', confidence,
  provenance: curated(note ?? 'Trade-flow magnitude assembled from public trade statistics and company reporting; expressed as contained Cu.'),
}));

/* ── Explicit dependencies (structural facts not derivable from single flows) ── */

export const COPPER_DEPENDENCIES: Dependency[] = [
  { id: 'dep:kamoa-dar-corridor', fromEntityId: 'ent:mine:kamoa-kakula', type: 'depends_on', toEntityId: 'ent:port:dar-es-salaam', strength: 0.6, basis: 'Primary export corridor; alternative (Durban/Lobito) has lower throughput.', provenance: curated() },
  { id: 'dep:gresik-grasberg', fromEntityId: 'ent:smelter:gresik', type: 'depends_on', toEntityId: 'ent:mine:grasberg', strength: 0.9, basis: 'Near-sole concentrate source.', provenance: curated() },
  { id: 'dep:manyar-grasberg', fromEntityId: 'ent:smelter:manyar', type: 'depends_on', toEntityId: 'ent:mine:grasberg', strength: 0.95, basis: 'Built to process Grasberg concentrate.', provenance: curated() },
  { id: 'dep:caletones-teniente', fromEntityId: 'ent:smelter:caletones', type: 'depends_on', toEntityId: 'ent:mine:el-teniente', strength: 0.9, basis: 'Captive smelter.', provenance: curated() },
  { id: 'dep:chuqui-smelter-mine', fromEntityId: 'ent:smelter:chuquicamata-smelter', type: 'depends_on', toEntityId: 'ent:mine:chuquicamata', strength: 0.8, basis: 'Captive smelter.', provenance: curated() },
  { id: 'dep:china-fab-drc', fromEntityId: 'ent:region:china-fabrication', type: 'depends_on', toEntityId: 'ent:refinery:drc-sxew', strength: 0.1, basis: 'Roughly a tenth of Chinese cathode supply arrives as DRC cathode.', provenance: icsg() },
];

/* ── Events ── */

export const COPPER_EVENTS: EconEvent[] = [
  {
    id: 'evt:cobre-panama-closure', entityId: 'ent:mine:cobre-panama', type: 'closure',
    title: 'Cobre Panamá ordered closed', start: '2023-11-28', severity: 'high',
    description: 'Supreme Court ruling voided the mining contract; ~350 kt/y of mine supply (≈1.5% of world output) removed from the market. Site in preservation pending arbitration/negotiation.',
    provenance: news('Widely reported; First Quantum disclosures.'),
  },
  {
    id: 'evt:kakula-seismic-2025', entityId: 'ent:mine:kamoa-kakula', type: 'disruption',
    title: 'Kakula underground seismic event and flooding', start: '2025-05-18', end: '2025-09-30', severity: 'high',
    description: 'Seismic activity forced suspension of underground operations at Kakula; guidance cut while dewatering and restart proceeded.',
    provenance: news('Ivanhoe Mines disclosures, May–Sep 2025.'),
  },
  {
    id: 'evt:grasberg-mud-rush-2025', entityId: 'ent:mine:grasberg', type: 'disruption',
    title: 'Grasberg Block Cave mud rush / force majeure', start: '2025-09-08', severity: 'high',
    description: 'Fatal mud rush halted Grasberg Block Cave operations; Freeport declared force majeure and cut 2025–2026 sales guidance. Major upstream shock to the concentrate market.',
    provenance: news('Freeport-McMoRan disclosures, Sep–Oct 2025.'),
  },
  {
    id: 'evt:panama-canal-drought', entityId: 'ent:infrastructure:panama-canal', type: 'weather',
    title: 'Panama Canal drought transit restrictions', start: '2023-06-01', end: '2024-09-30', severity: 'medium',
    description: 'Low Gatún Lake levels cut daily transits, lengthening some South America → Asia/Atlantic routings, including metal cargoes.',
    provenance: news('Panama Canal Authority advisories.'),
  },
  {
    id: 'evt:lme-stock-drawdown', entityId: 'ent:infrastructure:lme-warehouses', type: 'demand_surge',
    title: 'Sustained exchange stock drawdown', start: '2026-02-01', severity: 'medium',
    description: 'Representative series shows accelerating decline in exchange inventories through H1 2026 — the anomaly-detection layer flags the rate of change.',
    provenance: lme(),
  },
];

export const COPPER_SOURCES = SOURCES;
