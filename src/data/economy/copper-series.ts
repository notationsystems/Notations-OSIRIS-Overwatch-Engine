/**
 * OSIRIS — Copper time-series extension (temporal state substrate).
 *
 * Multi-year observation series that give the engine a time axis: annual mine
 * production by country 2015–2023 (2024 lives in copper.ts as the current
 * snapshot — no duplicate periods), annual Chinese refined production, the
 * Cobre Panamá lifecycle, and a two-year monthly exchange-stock series.
 *
 * Magnitudes follow USGS Mineral Commodity Summaries / ICSG historical
 * series; like the rest of the curated dataset they are REPRESENTATIVE
 * (order-of-magnitude faithful, not fresh reported figures) and say so.
 * Real structural stories these series carry, which the analytics layer
 * should rediscover on its own:
 *   - the DRC ramp (≈1.0 → 3.3 Mt/y over the decade)
 *   - Indonesia's 2019 dip (Grasberg open-pit → underground transition)
 *   - Panama appearing in 2019 and going to zero after the Nov 2023 closure
 *   - concentration of mine production FALLING as DRC/central Africa grew
 */

import type { Observation, Provenance } from '@/lib/economy/types';

const RETRIEVED = '2026-08-26T00:00:00Z';

const usgsHist = (year: string): Provenance => ({
  sourceId: 'usgs-mcs-historical',
  sourceName: 'USGS Mineral Commodity Summaries — historical copper series',
  sourceUrl: 'https://www.usgs.gov/centers/national-minerals-information-center/copper-statistics-and-information',
  retrievedAt: RETRIEVED,
  sourceRef: `Mine production, ${year}`,
  note: 'Contained copper; representative of the published series.',
});

const icsgHist = (year: string): Provenance => ({
  sourceId: 'icsg-factbook-2024',
  sourceName: 'ICSG World Copper Factbook 2024',
  sourceUrl: 'https://icsg.org/copper-factbook/',
  retrievedAt: RETRIEVED,
  sourceRef: `Refined production, ${year}`,
});

const lme = (note?: string): Provenance => ({
  sourceId: 'lme-representative',
  sourceName: 'Representative exchange warehouse stock series (LME-shaped)',
  sourceUrl: 'https://www.lme.com/en/market-data',
  retrievedAt: RETRIEVED,
  note,
});

const yearPeriod = (y: number) => ({ start: `${y}-01-01`, end: `${y}-12-31` });

/* ── Annual mine production by country, kt contained Cu, 2015–2023 ──
 * 2024 values live in copper.ts (countryProduction) so each (entity, year)
 * has exactly one observation. */
const MINE_SERIES: Record<string, number[]> = {
  // year:            2015  2016  2017  2018  2019  2020  2021  2022  2023
  'ent:country:cl': [5760, 5550, 5500, 5830, 5790, 5730, 5620, 5330, 5250],
  'ent:country:pe': [1700, 2350, 2450, 2440, 2460, 2150, 2300, 2440, 2760],
  'ent:country:cd': [1020,  850, 1090, 1230, 1290, 1600, 1800, 2360, 2840],
  'ent:country:cn': [1710, 1900, 1710, 1560, 1680, 1720, 1800, 1900, 1700],
  'ent:country:us': [1380, 1430, 1260, 1220, 1260, 1200, 1230, 1220, 1100],
  'ent:country:id': [ 580,  700,  620,  780,  340,  530,  730,  920,  840],
  'ent:country:au': [ 970,  950,  860,  920,  930,  880,  790,  830,  810],
  'ent:country:zm': [ 710,  760,  790,  850,  800,  830,  800,  770,  760],
  'ent:country:ru': [ 730,  700,  700,  750,  750,  850,  910,  960,  930],
  'ent:country:kz': [ 500,  660,  750,  760,  700,  700,  690,  680,  740],
  'ent:country:mx': [ 590,  620,  740,  750,  770,  730,  720,  740,  750],
  'ent:country:mn': [ 360,  350,  330,  310,  310,  310,  290,  250,  260],
  'ent:country:pl': [ 430,  430,  420,  400,  400,  390,  390,  390,  390],
};

/* Panama: producer only 2019–2023; 2024 = 0 after the court-ordered closure.
 * Its 2024 zero lives here (copper.ts has no PA country production row). */
const PANAMA_SERIES: Array<[number, number]> = [
  [2019, 150], [2020, 285], [2021, 330], [2022, 350], [2023, 330], [2024, 0],
];

/* Chinese refined production, kt/y, 2015–2023 (2024 snapshot in copper.ts). */
const CN_REFINED_SERIES: number[] = [7960, 8440, 8890, 9030, 9780, 10250, 10490, 11060, 11500];

/* Monthly exchange stocks, kt — extends the copper.ts series (2025-08 →
 * 2026-07) backward by twelve months. Shaped like the real LME series: the
 * 2024 stock build, then the sharp H1-2025 drawdown as metal was pulled
 * toward the US, a partial rebuild, then the 2026 decline. */
const STOCKS_EXTENSION: Array<[string, number]> = [
  ['2024-08', 292], ['2024-09', 300], ['2024-10', 271], ['2024-11', 265],
  ['2024-12', 271], ['2025-01', 255], ['2025-02', 260], ['2025-03', 220],
  ['2025-04', 205], ['2025-05', 160], ['2025-06', 95], ['2025-07', 130],
];

function monthPeriod(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${ym}-01`, end: `${ym}-${String(lastDay).padStart(2, '0')}` };
}

export const COPPER_SERIES_OBSERVATIONS: Observation[] = [
  ...Object.entries(MINE_SERIES).flatMap(([entityId, values]) =>
    values.map((value, i): Observation => {
      const year = 2015 + i;
      return {
        id: `obs:prod:${entityId.split(':')[2]}:${year}`,
        entityId, metric: 'production', value, unit: 'kt/y', period: yearPeriod(year),
        valueKind: 'representative',
        confidence: year >= 2020 ? 'high' : 'medium',
        provenance: usgsHist(String(year)),
      };
    })),
  ...PANAMA_SERIES.map(([year, value]): Observation => ({
    id: `obs:prod:pa:${year}`,
    entityId: 'ent:country:pa', metric: 'production', value, unit: 'kt/y', period: yearPeriod(year),
    valueKind: 'representative', confidence: 'high',
    provenance: usgsHist(String(year)),
  })),
  ...CN_REFINED_SERIES.map((value, i): Observation => {
    const year = 2015 + i;
    return {
      id: `obs:refined:cn:${year}`,
      entityId: 'ent:country:cn', metric: 'refined_production', value, unit: 'kt/y', period: yearPeriod(year),
      valueKind: 'representative', confidence: 'high',
      provenance: icsgHist(String(year)),
    };
  }),
  ...STOCKS_EXTENSION.map(([ym, value]): Observation => ({
    id: `obs:lme-stocks:${ym}`,
    entityId: 'ent:infrastructure:lme-warehouses',
    metric: 'inventory', value, unit: 'kt', period: monthPeriod(ym),
    valueKind: 'representative', confidence: 'medium',
    provenance: lme('Month-end total copper stocks, representative series.'),
  })),
];

export const COPPER_SERIES_SOURCES = [
  {
    sourceId: 'usgs-mcs-historical',
    sourceName: 'USGS Mineral Commodity Summaries — historical copper series',
    sourceUrl: 'https://www.usgs.gov/centers/national-minerals-information-center/copper-statistics-and-information',
  },
];
