/**
 * OSIRIS — Live acquisition adapters for the physical economy.
 *
 * Four providers, each behind the same degradation ladder:
 *
 *   live fetch → TTL cache + in-flight dedup (sourceCache) →
 *   last-good in memory → bundled snapshot (committed raw capture)
 *
 * so the engine keeps a coherent state whether or not the network
 * cooperates, and every observation says which rung it came from.
 *
 *   usgs-mcs-live      USGS Mineral Commodity Summaries World Data CSV via
 *                      ScienceBase — REPORTED 2023 + ESTIMATED 2024 mine and
 *                      refinery production + reserves, by country.
 *   comtrade-trade     UN Comtrade preview — reported physical trade weight
 *                      (HS 2603 concentrates gross weight, HS 7403 refined).
 *   yahoo-copper-price COMEX HG=F monthly closes (USD/lb), 10y.
 *   cftc-positioning   CFTC COT managed-money net positioning, weekly.
 *
 * Parse functions are exported and tested against the committed snapshots,
 * which are verbatim captures of the real endpoints — the parser cannot
 * drift from reality without a test noticing.
 *
 * Live fetches are disabled under vitest (RUN_LIVE_TESTS=1 re-enables) and
 * with OSIRIS_DISABLE_LIVE=1, in which case the snapshot rung serves.
 */

import type { Observation, Provenance } from './types';
import type { AdapterPayload, EconomyAdapter } from './adapters';
import { cachedSource } from '@/lib/sourceCache';
import { MCS_SNAPSHOT_CSV, MCS_SNAPSHOT_CAPTURED_AT } from '@/data/economy/snapshots/mcs2025-world-copper';
import comtradeSnapshot from '@/data/economy/snapshots/comtrade-copper.json';
import yahooSnapshot from '@/data/economy/snapshots/yahoo-hg-10y.json';
import cftcSnapshot from '@/data/economy/snapshots/cftc-copper-1yr.json';

const UA = 'OSIRIS-Overwatch/0.1 (internal research instrument)';

function liveDisabled(): boolean {
  return process.env.OSIRIS_DISABLE_LIVE === '1'
    || (process.env.NODE_ENV === 'test' && process.env.RUN_LIVE_TESTS !== '1');
}

async function fetchJson<T>(url: string, timeoutMs = 15000, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json() as Promise<T>;
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

/** Live → cache → snapshot: the shared ladder. */
function withSnapshotFallback(
  cacheKey: string,
  ttlMs: number,
  liveFetch: () => Promise<Observation[]>,
  snapshot: (note: string) => Observation[],
): () => Promise<Observation[]> {
  const cached = cachedSource<Observation>(cacheKey, liveFetch, ttlMs);
  return async () => {
    if (liveDisabled()) return snapshot('live fetch disabled in this environment');
    try {
      const live = await cached();
      if (live.length > 0) return live;
      return snapshot('live fetch returned no records');
    } catch (e) {
      return snapshot(`live fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/* ══════════════ USGS MCS World Data ══════════════ */

const MCS_ITEM_ID = '6798fd34d34ea8c18376e8ee';
const MCS_ITEM_URL = `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}?format=json&fields=files`;

/** MCS COUNTRY column → OSIRIS country entity. Names carry stray spaces. */
const MCS_COUNTRY_MAP: Record<string, string> = {
  'United States': 'ent:country:us',
  'Australia': 'ent:country:au',
  'Canada': 'ent:country:ca',
  'Chile': 'ent:country:cl',
  'China': 'ent:country:cn',
  'Congo (Kinshasa)': 'ent:country:cd',
  'Germany': 'ent:country:de',
  'India': 'ent:country:in',
  'Indonesia': 'ent:country:id',
  'Japan': 'ent:country:jp',
  'Kazakhstan': 'ent:country:kz',
  'Korea, Republic of': 'ent:country:kr',
  'Mexico': 'ent:country:mx',
  'Peru': 'ent:country:pe',
  'Poland': 'ent:country:pl',
  'Russia': 'ent:country:ru',
  'Zambia': 'ent:country:zm',
};

/** Minimal CSV row splitter that honors double-quoted fields. */
function splitCsvRow(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

export function parseMcsWorldCsv(csvText: string, prov: (ref: string, note?: string) => Provenance): Observation[] {
  const lines = csvText.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = splitCsvRow(lines[0]).map(h => h.trim());
  const col = (name: string) => header.findIndex(h => h.replace(/\s+/g, ' ') === name);
  const iCommodity = col('COMMODITY');
  const iCountry = col('COUNTRY');
  const iType = col('TYPE');
  const iProd23 = col('PROD_2023');
  const iProd24 = col('PROD_EST_ 2024') >= 0 ? col('PROD_EST_ 2024') : col('PROD_EST_2024');
  const iReserves = col('RESERVES_2024');
  if (iCommodity < 0 || iCountry < 0 || iType < 0) throw new Error('MCS CSV header not recognized');

  const num = (raw: string | undefined): number | null => {
    const cleaned = (raw ?? '').replace(/[",\s]/g, '');
    if (!cleaned) return null;
    const v = Number(cleaned);
    return Number.isFinite(v) ? v : null;
  };

  const obs: Observation[] = [];
  for (const line of lines.slice(1)) {
    const row = splitCsvRow(line);
    if ((row[iCommodity] ?? '').trim() !== 'Copper') continue;
    const entityId = MCS_COUNTRY_MAP[(row[iCountry] ?? '').trim()];
    if (!entityId) continue; // "Other Countries", "World total", unmapped
    const type = (row[iType] ?? '').trim();
    const metric = type.startsWith('Mine production') ? 'production' as const
      : type.startsWith('Refinery production') ? 'refined_production' as const
        : null;
    const slug = entityId.split(':')[2];
    if (metric) {
      const v23 = num(row[iProd23]);
      if (v23 !== null) {
        obs.push({
          id: `obs:usgs-mcs2025:${metric}:${slug}:2023`,
          entityId, metric, value: v23, unit: 'kt/y',
          period: { start: '2023-01-01', end: '2023-12-31' },
          valueKind: 'reported', confidence: 'high',
          provenance: prov(`${type}, 2023`),
        });
      }
      const v24 = num(row[iProd24]);
      if (v24 !== null) {
        obs.push({
          id: `obs:usgs-mcs2025:${metric}:${slug}:2024`,
          entityId, metric, value: v24, unit: 'kt/y',
          period: { start: '2024-01-01', end: '2024-12-31' },
          valueKind: 'estimated', confidence: 'high',
          provenance: prov(`${type}, 2024 est.`),
        });
      }
      if (metric === 'production') {
        const res24 = num(row[iReserves]);
        if (res24 !== null) {
          obs.push({
            id: `obs:usgs-mcs2025:reserves:${slug}:2024`,
            entityId, metric: 'reserves', value: res24, unit: 'kt',
            period: { start: '2024-01-01', end: '2024-12-31' },
            valueKind: 'estimated', confidence: 'medium',
            provenance: prov('Reserves, 2024', 'USGS reserves are estimates by definition.'),
          });
        }
      }
    }
  }
  return obs;
}

interface ScienceBaseItem { files?: Array<{ name?: string; url?: string }> }

async function fetchMcsLive(): Promise<Observation[]> {
  const item = await fetchJson<ScienceBaseItem>(MCS_ITEM_URL);
  const file = item.files?.find(f => /World_Data.*\.csv$/i.test(f.name ?? ''));
  if (!file?.url) throw new Error('MCS World Data CSV not found on ScienceBase item');
  const csv = await fetchText(file.url);
  const retrievedAt = new Date().toISOString();
  return parseMcsWorldCsv(csv, (ref, note) => ({
    sourceId: 'usgs-mcs2025-live',
    sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
    sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    retrievedAt, sourceRef: ref, note,
  }));
}

function mcsSnapshot(reason: string): Observation[] {
  return parseMcsWorldCsv(MCS_SNAPSHOT_CSV, (ref, note) => ({
    sourceId: 'usgs-mcs2025-live',
    sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
    sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    retrievedAt: `${MCS_SNAPSHOT_CAPTURED_AT}T00:00:00Z`,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  }));
}

/* ══════════════ UN Comtrade preview ══════════════ */

/** (reporter M49, HS code, flow, year) requests the adapter makes. */
const COMTRADE_REQUESTS: Array<[m49: number, hs: '2603' | '7403', flow: 'X' | 'M', year: number]> = [
  [152, '2603', 'X', 2023], [152, '2603', 'X', 2024],
  [604, '2603', 'X', 2023],
  [180, '7403', 'X', 2023],
  [156, '2603', 'M', 2023],
  [156, '7403', 'M', 2023],
];

const M49_TO_ENTITY: Record<number, string> = {
  152: 'ent:country:cl', 604: 'ent:country:pe', 180: 'ent:country:cd', 156: 'ent:country:cn',
  842: 'ent:country:us', 360: 'ent:country:id', 36: 'ent:country:au', 894: 'ent:country:zm',
  484: 'ent:country:mx', 398: 'ent:country:kz', 643: 'ent:country:ru', 496: 'ent:country:mn',
  616: 'ent:country:pl', 392: 'ent:country:jp', 410: 'ent:country:kr', 276: 'ent:country:de',
  356: 'ent:country:in', 591: 'ent:country:pa', 124: 'ent:country:ca',
};

interface ComtradeRow {
  partnerCode?: number;
  netWgt?: number | null;
  isNetWgtEstimated?: boolean;
}
interface ComtradeResponse { data?: ComtradeRow[] }

export function parseComtradeResponse(
  key: string,
  raw: ComtradeResponse,
  prov: (ref: string, note?: string) => Provenance,
): Observation | null {
  const [m49Str, hs, flow, yearStr] = key.split('-');
  const entityId = M49_TO_ENTITY[Number(m49Str)];
  if (!entityId) return null;
  const rows = raw.data ?? [];
  const world = rows.find(r => r.partnerCode === 0);
  let kg: number | null = null;
  let estimated = false;
  let derivedFromPartners = false;
  if (world && world.netWgt !== null && world.netWgt !== undefined) {
    kg = world.netWgt;
    estimated = world.isNetWgtEstimated === true;
  } else {
    // Some reporters leave the world aggregate's weight null (Peru 2603/2023)
    // — sum the bilateral rows instead and say so.
    const partners = rows.filter(r => r.partnerCode !== 0 && r.netWgt !== null && r.netWgt !== undefined);
    if (partners.length === 0) return null;
    kg = partners.reduce((s, r) => s + (r.netWgt ?? 0), 0);
    estimated = partners.some(r => r.isNetWgtEstimated === true);
    derivedFromPartners = true;
  }
  const metric = hs === '2603'
    ? (flow === 'X' ? 'concentrate_exports' as const : 'concentrate_imports' as const)
    : (flow === 'X' ? 'refined_exports' as const : 'refined_imports' as const);
  const formNote = hs === '2603'
    ? 'HS 2603 copper ores & concentrates — GROSS shipped weight, not contained copper (typical concentrate grades run ~20–30% Cu).'
    : 'HS 7403 refined copper — gross weight ≈ copper content.';
  const slug = entityId.split(':')[2];
  return {
    id: `obs:comtrade:${slug}:${hs}:${flow}:${yearStr}`,
    entityId, metric,
    value: Math.round(kg / 1e6),
    unit: hs === '2603' ? 'kt gross/y' : 'kt/y',
    period: { start: `${yearStr}-01-01`, end: `${yearStr}-12-31` },
    valueKind: 'reported',
    confidence: estimated ? 'medium' : 'high',
    provenance: prov(
      `HS ${hs} flow ${flow} reporter ${m49Str} period ${yearStr}`,
      [formNote, derivedFromPartners ? 'World total summed from bilateral partner rows (reporter aggregate weight was null).' : null].filter(Boolean).join(' '),
    ),
  };
}

async function fetchComtradeLive(): Promise<Observation[]> {
  const retrievedAt = new Date().toISOString();
  const prov = (ref: string, note?: string): Provenance => ({
    sourceId: 'un-comtrade-preview',
    sourceName: 'UN Comtrade (public preview API)',
    sourceUrl: 'https://comtradeplus.un.org/',
    retrievedAt, sourceRef: ref, note,
  });
  const snapshotResponses = (comtradeSnapshot as { capturedAt: string; responses: Record<string, ComtradeResponse> });
  const obs: Observation[] = [];
  let anyLive = false;
  let rateLimited = false;
  for (const [m49, hs, flow, year] of COMTRADE_REQUESTS) {
    const key = `${m49}-${hs}-${flow}-${year}`;
    let one: Observation | null = null;
    // The preview endpoint rate-limits per IP aggressively; once it starts
    // 429ing, stop hitting it and serve the remaining keys from snapshot.
    if (!rateLimited) {
      try {
        const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${m49}&period=${year}&cmdCode=${hs}&flowCode=${flow}`;
        const raw = await fetchJson<ComtradeResponse>(url, 20000);
        one = parseComtradeResponse(key, raw, prov);
        anyLive = true;
        await new Promise(r => setTimeout(r, 1100)); // stay polite
      } catch (e) {
        if (e instanceof Error && e.message.includes('429')) rateLimited = true;
        one = null;
      }
    }
    if (!one) {
      // Per-request degradation: this key alone falls back to its snapshot slice.
      const snap = snapshotResponses.responses[key];
      if (snap) {
        one = parseComtradeResponse(key, snap, (ref, note) => ({
          ...prov(ref, note),
          retrievedAt: `${snapshotResponses.capturedAt}T00:00:00Z`,
          note: [`bundled snapshot (live request unavailable${rateLimited ? ': rate limited' : ''})`, note].filter(Boolean).join(' — '),
        }));
      }
    }
    if (one) obs.push(one);
  }
  // If nothing came back live, report failure so the ladder's snapshot rung
  // serves — an all-snapshot result must not be cached as a fresh success.
  if (!anyLive) throw new Error('no live Comtrade responses (rate limited or unreachable)');
  return obs;
}

function comtradeSnapshotObs(reason: string): Observation[] {
  const captured = (comtradeSnapshot as { capturedAt: string }).capturedAt;
  const prov = (ref: string, note?: string): Provenance => ({
    sourceId: 'un-comtrade-preview',
    sourceName: 'UN Comtrade (public preview API)',
    sourceUrl: 'https://comtradeplus.un.org/',
    retrievedAt: `${captured}T00:00:00Z`,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  });
  const responses = (comtradeSnapshot as { responses: Record<string, ComtradeResponse> }).responses;
  const obs: Observation[] = [];
  for (const [key, raw] of Object.entries(responses)) {
    const one = parseComtradeResponse(key, raw, prov);
    if (one) obs.push(one);
  }
  return obs;
}

/* ══════════════ Yahoo Finance HG=F monthly price ══════════════ */

interface YahooChart {
  chart?: {
    result?: Array<{
      meta?: { currency?: string; symbol?: string };
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
    error?: unknown;
  };
}

export function parseYahooChart(raw: YahooChart, prov: (ref: string, note?: string) => Provenance): Observation[] {
  const result = raw.chart?.result?.[0];
  if (!result?.timestamp || !result.indicators?.quote?.[0]?.close) return [];
  const { timestamp } = result;
  const close = result.indicators.quote[0].close;
  // Key by month, keep the latest point per month — Yahoo appends the
  // in-progress session as an extra same-month timestamp.
  const byMonth = new Map<string, number>();
  for (let i = 0; i < timestamp.length; i++) {
    const c = close[i];
    if (c === null || c === undefined || !Number.isFinite(c)) continue;
    const month = new Date(timestamp[i] * 1000).toISOString().slice(0, 7);
    byMonth.set(month, c);
  }
  const months = [...byMonth.keys()].sort();
  const lastMonth = months[months.length - 1];
  return months.map(month => {
    const [y, m] = month.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const partial = month === lastMonth;
    return {
      id: `obs:hg-price:${month}`,
      entityId: 'ent:commodity:copper',
      metric: 'price' as const,
      value: Number(byMonth.get(month)!.toFixed(4)),
      unit: 'USD/lb',
      period: { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` },
      valueKind: 'reported' as const,
      confidence: partial ? 'medium' as const : 'high' as const,
      provenance: prov(`HG=F monthly close, ${month}`, partial ? 'Month in progress — month-to-date close.' : undefined),
    };
  });
}

async function fetchYahooLive(): Promise<Observation[]> {
  const raw = await fetchJson<YahooChart>(
    'https://query1.finance.yahoo.com/v8/finance/chart/HG=F?range=10y&interval=1mo',
    12000,
    { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
  );
  const retrievedAt = new Date().toISOString();
  return parseYahooChart(raw, (ref, note) => ({
    sourceId: 'yahoo-hg-chart',
    sourceName: 'COMEX copper front-month (HG=F) via Yahoo Finance chart API',
    sourceUrl: 'https://finance.yahoo.com/quote/HG=F',
    retrievedAt, sourceRef: ref, note,
  }));
}

function yahooSnapshotObs(reason: string): Observation[] {
  const captured = (yahooSnapshot as { capturedAt: string }).capturedAt;
  return parseYahooChart((yahooSnapshot as { raw: YahooChart }).raw, (ref, note) => ({
    sourceId: 'yahoo-hg-chart',
    sourceName: 'COMEX copper front-month (HG=F) via Yahoo Finance chart API',
    sourceUrl: 'https://finance.yahoo.com/quote/HG=F',
    retrievedAt: `${captured}T00:00:00Z`,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  }));
}

/* ══════════════ CFTC COT positioning ══════════════ */

interface CftcRow {
  report_date_as_yyyy_mm_dd?: string;
  m_money_positions_long_all?: string;
  m_money_positions_short_all?: string;
  open_interest_all?: string;
}

export function parseCftcRows(rows: CftcRow[], prov: (ref: string, note?: string) => Provenance): Observation[] {
  const obs: Observation[] = [];
  for (const row of rows) {
    const date = row.report_date_as_yyyy_mm_dd?.slice(0, 10);
    const long = Number(row.m_money_positions_long_all);
    const short = Number(row.m_money_positions_short_all);
    if (!date || !Number.isFinite(long) || !Number.isFinite(short)) continue;
    obs.push({
      id: `obs:cftc-mm-net:${date}`,
      entityId: 'ent:commodity:copper',
      metric: 'net_positioning',
      value: long - short,
      unit: 'contracts',
      period: { start: date, end: date },
      valueKind: 'reported',
      confidence: 'high',
      provenance: prov(
        `COT disaggregated, COMEX copper (085692), ${date}`,
        `Managed-money net = long ${long} − short ${short}; open interest ${row.open_interest_all ?? 'n/a'}.`,
      ),
    });
  }
  return obs.sort((a, b) => a.period.start.localeCompare(b.period.start));
}

async function fetchCftcLive(): Promise<Observation[]> {
  const url = 'https://publicreporting.cftc.gov/resource/72hh-3qpy.json'
    + '?$limit=60&commodity_name=COPPER&cftc_contract_market_code=085692'
    + '&$order=report_date_as_yyyy_mm_dd%20DESC'
    + '&$select=report_date_as_yyyy_mm_dd,open_interest_all,m_money_positions_long_all,m_money_positions_short_all';
  const rows = await fetchJson<CftcRow[]>(url);
  const retrievedAt = new Date().toISOString();
  return parseCftcRows(rows, (ref, note) => ({
    sourceId: 'cftc-cot',
    sourceName: 'CFTC Commitments of Traders (disaggregated, Socrata)',
    sourceUrl: 'https://publicreporting.cftc.gov/',
    retrievedAt, sourceRef: ref, note,
  }));
}

function cftcSnapshotObs(reason: string): Observation[] {
  const captured = (cftcSnapshot as { capturedAt: string }).capturedAt;
  return parseCftcRows((cftcSnapshot as { rows: CftcRow[] }).rows, (ref, note) => ({
    sourceId: 'cftc-cot',
    sourceName: 'CFTC Commitments of Traders (disaggregated, Socrata)',
    sourceUrl: 'https://publicreporting.cftc.gov/',
    retrievedAt: `${captured}T00:00:00Z`,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  }));
}

/* ══════════════ Adapter assembly ══════════════ */

function observationOnlyPayload(observations: Observation[], source: AdapterPayload['sources'][number]): AdapterPayload {
  return {
    commodity: 'copper',
    commodityName: 'Copper',
    entities: [], flows: [], capacities: [], dependencies: [], events: [],
    observations,
    sources: [source],
  };
}

const DAY = 24 * 60 * 60 * 1000;

const loaders = {
  usgs: withSnapshotFallback('econ:usgs-mcs', 30 * DAY, fetchMcsLive, mcsSnapshot),
  comtrade: withSnapshotFallback('econ:comtrade', 30 * DAY, fetchComtradeLive, comtradeSnapshotObs),
  yahoo: withSnapshotFallback('econ:yahoo-hg', 12 * 60 * 60 * 1000, fetchYahooLive, yahooSnapshotObs),
  cftc: withSnapshotFallback('econ:cftc-cot', 12 * 60 * 60 * 1000, fetchCftcLive, cftcSnapshotObs),
};

export const usgsMcsAdapter: EconomyAdapter = {
  providerId: 'usgs-mcs-live',
  providerName: 'USGS Mineral Commodity Summaries World Data (live, ScienceBase)',
  commodities: ['copper'],
  async load() {
    return observationOnlyPayload(await loaders.usgs(), {
      sourceId: 'usgs-mcs2025-live',
      sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
      sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    });
  },
};

export const comtradeAdapter: EconomyAdapter = {
  providerId: 'comtrade-trade',
  providerName: 'UN Comtrade public preview — copper trade weights',
  commodities: ['copper'],
  async load() {
    return observationOnlyPayload(await loaders.comtrade(), {
      sourceId: 'un-comtrade-preview',
      sourceName: 'UN Comtrade (public preview API)',
      sourceUrl: 'https://comtradeplus.un.org/',
    });
  },
};

export const yahooPriceAdapter: EconomyAdapter = {
  providerId: 'yahoo-copper-price',
  providerName: 'COMEX HG=F monthly price via Yahoo Finance',
  commodities: ['copper'],
  async load() {
    return observationOnlyPayload(await loaders.yahoo(), {
      sourceId: 'yahoo-hg-chart',
      sourceName: 'COMEX copper front-month (HG=F) via Yahoo Finance chart API',
      sourceUrl: 'https://finance.yahoo.com/quote/HG=F',
    });
  },
};

export const cftcPositioningAdapter: EconomyAdapter = {
  providerId: 'cftc-positioning',
  providerName: 'CFTC COT managed-money copper positioning',
  commodities: ['copper'],
  async load() {
    return observationOnlyPayload(await loaders.cftc(), {
      sourceId: 'cftc-cot',
      sourceName: 'CFTC Commitments of Traders (disaggregated, Socrata)',
      sourceUrl: 'https://publicreporting.cftc.gov/',
    });
  },
};

export const LIVE_ADAPTERS: EconomyAdapter[] = [
  usgsMcsAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter,
];
