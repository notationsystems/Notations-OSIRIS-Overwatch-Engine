import { describe, it, expect } from 'vitest';
import type { Provenance } from './types';
import { validateState } from './types';
import {
  parseMcsWorldCsv, parseComtradeResponse, parseYahooChart, parseCftcRows,
  usgsMcsAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter,
} from './liveAdapters';
import { MCS_SNAPSHOT_CSV } from '@/data/economy/snapshots/mcs2025-world-copper';
import comtradeSnapshot from '@/data/economy/snapshots/comtrade-copper.json';
import yahooSnapshot from '@/data/economy/snapshots/yahoo-hg-10y.json';
import cftcSnapshot from '@/data/economy/snapshots/cftc-copper-1yr.json';
import { getEconomyState } from './store';
import { observationsAt, concentration } from './analytics';

const prov = (ref: string, note?: string): Provenance =>
  ({ sourceId: 'test', sourceName: 'test', retrievedAt: '2026-08-26T00:00:00Z', sourceRef: ref, note });

describe('parseMcsWorldCsv (against the committed real capture)', () => {
  const obs = parseMcsWorldCsv(MCS_SNAPSHOT_CSV, prov);

  it('extracts reported 2023 and estimated 2024 mine production', () => {
    const cl23 = obs.find(o => o.id === 'obs:usgs-mcs2025:production:cl:2023');
    expect(cl23).toMatchObject({ value: 5250, unit: 'kt/y', valueKind: 'reported' });
    const cd24 = obs.find(o => o.id === 'obs:usgs-mcs2025:production:cd:2024');
    expect(cd24).toMatchObject({ value: 3300, valueKind: 'estimated' });
  });

  it('extracts refinery production and reserves', () => {
    const cn = obs.find(o => o.id === 'obs:usgs-mcs2025:refined_production:cn:2023');
    expect(cn?.value).toBe(12000);
    const clReserves = obs.find(o => o.id === 'obs:usgs-mcs2025:reserves:cl:2024');
    expect(clReserves).toMatchObject({ value: 190000, unit: 'kt', valueKind: 'estimated' });
  });

  it('skips aggregate rows and unmapped countries', () => {
    expect(obs.some(o => o.id.includes('other') || o.id.includes('world'))).toBe(false);
    // Germany reports no mine production (blank cell) — no zero fabricated.
    expect(obs.some(o => o.id === 'obs:usgs-mcs2025:production:de:2023')).toBe(false);
    // But Germany's refinery production exists.
    expect(obs.find(o => o.id === 'obs:usgs-mcs2025:refined_production:de:2023')?.value).toBe(609);
  });

  it('quoted TYPE fields with commas parse intact', () => {
    // "Mine production, recoverable copper content" contains a comma.
    expect(obs.filter(o => o.metric === 'production').length).toBeGreaterThan(10);
  });
});

describe('parseComtradeResponse (against the committed real capture)', () => {
  const responses = (comtradeSnapshot as { responses: Record<string, { data: Array<{ partnerCode?: number; netWgt?: number | null }> }> }).responses;

  it('reads world-aggregate gross weight for Chile concentrate exports', () => {
    const o = parseComtradeResponse('152-2603-X-2023', responses['152-2603-X-2023'], prov)!;
    expect(o.entityId).toBe('ent:country:cl');
    expect(o.metric).toBe('concentrate_exports');
    expect(o.unit).toBe('kt gross/y');
    expect(o.value).toBe(2959); // 2.959 Gt kg → kt gross
    expect(o.valueKind).toBe('reported');
    expect(o.provenance.note).toContain('GROSS');
  });

  it('sums bilateral partner rows when the world aggregate weight is null (Peru)', () => {
    const o = parseComtradeResponse('604-2603-X-2023', responses['604-2603-X-2023'], prov)!;
    expect(o.entityId).toBe('ent:country:pe');
    expect(o.value).toBe(9964); // kt gross concentrate, summed over 20 partners
    expect(o.provenance.note).toContain('summed from bilateral partner rows');
  });

  it('maps refined trade to the refined metrics with copper-content units', () => {
    const o = parseComtradeResponse('180-7403-X-2023', responses['180-7403-X-2023'], prov)!;
    expect(o.metric).toBe('refined_exports');
    expect(o.unit).toBe('kt/y');
    expect(o.value).toBe(2020); // DRC refined exports 2023
    const m = parseComtradeResponse('156-2603-M-2023', responses['156-2603-M-2023'], prov)!;
    expect(m.metric).toBe('concentrate_imports');
    expect(m.value).toBe(27534); // China gross concentrate imports
  });

  it('returns null for unmapped reporters', () => {
    expect(parseComtradeResponse('999-2603-X-2023', { data: [{ partnerCode: 0, netWgt: 5 }] }, prov)).toBeNull();
  });
});

describe('parseYahooChart (against the committed real capture)', () => {
  const obs = parseYahooChart((yahooSnapshot as { raw: Parameters<typeof parseYahooChart>[0] }).raw, prov);

  it('produces a monthly USD/lb price series on the commodity entity', () => {
    expect(obs.length).toBeGreaterThan(90);
    for (const o of obs) {
      expect(o.entityId).toBe('ent:commodity:copper');
      expect(o.metric).toBe('price');
      expect(o.unit).toBe('USD/lb');
      expect(o.value).toBeGreaterThan(1);
      expect(o.value).toBeLessThan(10);
    }
    // Chronological, unique months.
    const months = obs.map(o => o.id);
    expect(new Set(months).size).toBe(months.length);
    expect([...months].sort()).toEqual(months);
  });

  it('marks the in-progress month as partial with reduced confidence', () => {
    const last = obs[obs.length - 1];
    expect(last.confidence).toBe('medium');
    expect(last.provenance.note).toContain('month-to-date');
    expect(obs[obs.length - 2].confidence).toBe('high');
  });
});

describe('parseCftcRows (against the committed real capture)', () => {
  const obs = parseCftcRows((cftcSnapshot as { rows: Parameters<typeof parseCftcRows>[0] }).rows, prov);

  it('computes managed-money net positioning per report week', () => {
    expect(obs.length).toBe(60);
    const latest = obs[obs.length - 1];
    expect(latest.id).toBe('obs:cftc-mm-net:2026-08-18');
    expect(latest.value).toBe(92097 - 13449);
    expect(latest.unit).toBe('contracts');
    // Sorted ascending by date.
    expect(obs[0].period.start < latest.period.start).toBe(true);
  });
});

describe('live adapters in the assembled state (snapshot rung, network off)', () => {
  it('all four adapters serve snapshot observations under test env', async () => {
    for (const adapter of [usgsMcsAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter]) {
      const payload = await adapter.load('copper');
      expect(payload.observations.length, adapter.providerId).toBeGreaterThan(0);
      for (const o of payload.observations) {
        expect(o.provenance.note, `${adapter.providerId} ${o.id}`).toContain('bundled snapshot');
      }
    }
  });

  it('assembled copper state includes live-adapter observations and stays valid', async () => {
    const { state, providers } = await getEconomyState('copper', { fresh: true });
    expect(providers).toEqual(expect.arrayContaining(['curated-copper-v1', 'usgs-mcs-live', 'comtrade-trade', 'yahoo-copper-price', 'cftc-positioning']));
    expect(validateState(state).filter(i => i.severity === 'error')).toEqual([]);
    expect(state.observations.some(o => o.metric === 'price')).toBe(true);
    expect(state.observations.some(o => o.metric === 'concentrate_exports')).toBe(true);
    expect(state.observations.some(o => o.metric === 'net_positioning')).toBe(true);
    expect(state.sources.some(s => s.sourceId === 'un-comtrade-preview')).toBe(true);
  });

  it('reported USGS figures outrank curated representative ones at the same period', async () => {
    const { state } = await getEconomyState('copper', { fresh: true });
    // 2023: curated series says CL 5250 (representative), USGS says 5250
    // (reported) — selection must pick the reported record.
    const picked = observationsAt(state, 'production', 'country', '2023-12-31')
      .find(o => o.entityId === 'ent:country:cl')!;
    expect(picked.valueKind).toBe('reported');
    expect(picked.id).toBe('obs:usgs-mcs2025:production:cl:2023');
    // 2024: USGS estimate (5300) outranks curated representative (5300).
    const latest = observationsAt(state, 'production', 'country')
      .find(o => o.entityId === 'ent:country:cl')!;
    expect(latest.valueKind).toBe('estimated');
    // Concentration therefore runs on the hardest available evidence.
    const conc = concentration(state, 'production', 'country');
    expect(conc.inputs.observationIds).toContain('obs:usgs-mcs2025:production:cl:2024');
  });
});
