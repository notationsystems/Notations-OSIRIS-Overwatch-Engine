/**
 * Payload — Live acquisition adapters for the physical economy.
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
 * with PAYLOAD_DISABLE_LIVE=1, in which case the snapshot rung serves.
 * (OSIRIS_DISABLE_LIVE is honoured for one release and warns.)
 */

import type { Observation, Provenance, UnresolvedIdentifier } from './types';
import type { AdapterPayload, EconomyAdapter, RowAccounting } from './adapters';
import { buildUnresolvedRecords } from './resolution';
import { cachedSource } from '@/lib/sourceCache';
import { MCS_SNAPSHOT_CSV, MCS_SNAPSHOT_CAPTURED_AT } from '@/data/economy/snapshots/mcs2025-world-copper';
import { MCS2024_SNAPSHOT_CSV, MCS2024_SNAPSHOT_CAPTURED_AT, MCS2024_PUBLISHED_AT } from '@/data/economy/snapshots/mcs2024-world-copper';
import { MCS_AL_SNAPSHOT_CSV, MCS_AL_SNAPSHOT_CAPTURED_AT } from '@/data/economy/snapshots/mcs2025-world-aluminium';
import comtradeSnapshot from '@/data/economy/snapshots/comtrade-copper.json';
import yahooSnapshot from '@/data/economy/snapshots/yahoo-hg-10y.json';
import cftcSnapshot from '@/data/economy/snapshots/cftc-copper-1yr.json';
import westmetallSnapshot from '@/data/economy/snapshots/westmetall-lme-stocks.json';
import comtradeDa from '@/data/economy/snapshots/comtrade-da.json';
import { withHostRateLimit } from './outboundRate';
import { processSingleton } from './processSingleton';
import { readEnvWithLegacy } from './envCompat';

const UA = 'Payload Terminal-Overwatch/0.1 (internal research instrument)';

function liveDisabled(): boolean {
  // VITEST is set by the vitest runner regardless of NODE_ENV; NODE_ENV alone
  // is not enough (vitest only defaults it when unset, so a CI shell that
  // pre-exports NODE_ENV=production would silently un-gate live fetches).
  const underTest = process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';
  return readEnvWithLegacy('PAYLOAD_DISABLE_LIVE').value === '1'
    || (underTest && process.env.RUN_LIVE_TESTS !== '1');
}

// EVERY outbound request goes through the process-wide per-host limiter
// (D-10): the in-loop sleep below is a one-shot-script discipline and says
// nothing about two assemblies overlapping, which boot warming now makes
// routine. Concurrent callers cannot compound because they cannot run
// concurrently against one host.
async function fetchJson<T>(url: string, timeoutMs = 15000, headers: Record<string, string> = {}): Promise<T> {
  return withHostRateLimit(url, async () => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  });
}

async function fetchText(url: string, timeoutMs = 20000, headers: Record<string, string> = {}): Promise<string> {
  return withHostRateLimit(url, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.text();
  });
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

/** MCS COUNTRY column → Payload Terminal country entity. Names carry stray spaces. */
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

/**
 * Column layout of one MCS edition ("vintage"). Each edition is a dated
 * snapshot of a revised series: MCS Y carries reported Y-2 figures and
 * estimated Y-1 figures, published in January of year Y — which is the
 * knownAt bound for everything it contains.
 */
export interface McsVintageSpec {
  idPrefix: string;
  /** Publication date of the edition — the knowability bound. */
  publishedAt: string;
  /** null → the file is commodity-specific (no COMMODITY column). */
  commodityCol: string | null;
  countryCol: string;
  typeCol: string;
  reportedCol: string;
  reportedYear: number;
  estimatedCol: string;
  estimatedYear: number;
  reservesCol: string | null;
  reservesYear: number;
  notesCol: string | null;
}

export const MCS2025_SPEC: McsVintageSpec = {
  idPrefix: 'usgs-mcs2025', publishedAt: '2025-01-30',
  commodityCol: 'COMMODITY', countryCol: 'COUNTRY', typeCol: 'TYPE',
  reportedCol: 'PROD_2023', reportedYear: 2023,
  estimatedCol: 'PROD_EST_ 2024', estimatedYear: 2024,
  reservesCol: 'RESERVES_2024', reservesYear: 2024,
  notesCol: 'PROD_NOTES',
};

export const MCS2024_SPEC: McsVintageSpec = {
  idPrefix: 'usgs-mcs2024', publishedAt: MCS2024_PUBLISHED_AT,
  commodityCol: null, countryCol: 'Country', typeCol: 'Type',
  reportedCol: 'Prod_kt_2022', reportedYear: 2022,
  estimatedCol: 'Prod_kt_est_2023', estimatedYear: 2023,
  reservesCol: 'Reserves_kt', reservesYear: 2023,
  notesCol: 'Prod_notes',
};

/**
 * Which rows of the ALL-COMMODITY world file a state ingests, and what each
 * row type means in canonical vocabulary. The world CSV carries every MCS
 * chapter; until round 25 the parser hardcoded `!== 'Copper'` — the
 * commodity spec is the generalization the aluminium experiment forced.
 * Note the basis differences the spec makes explicit: copper's MCS figures
 * are contained metal; bauxite and alumina figures are GROSS mass (dry
 * tons / calcined weight) — same metric slot, different basis, carried on
 * the observation.
 */
export interface McsCommoditySpec {
  /** COMMODITY column values to admit. */
  commodities: string[];
  /** Row TYPE → canonical metric + basis; null skips the row. */
  metricFor: (type: string) => { metric: 'production' | 'refined_production' | 'intermediate_production'; basis: 'metal_content' | 'gross_weight' } | null;
  countryMap: Record<string, string>;
}

export const MCS_COPPER_CSPEC: McsCommoditySpec = {
  commodities: ['Copper'],
  metricFor: (type) => type.startsWith('Mine production') ? { metric: 'production', basis: 'metal_content' }
    : type.startsWith('Refinery production') ? { metric: 'refined_production', basis: 'metal_content' }
      : null,
  countryMap: {}, // filled below (MCS_COUNTRY_MAP is declared earlier in the file)
};

const AL_COUNTRY_MAP: Record<string, string> = {
  'United States': 'ent:country:us', 'Australia': 'ent:country:au', 'Bahrain': 'ent:country:bh',
  'Brazil': 'ent:country:br', 'Canada': 'ent:country:ca', 'China': 'ent:country:cn',
  'Iceland': 'ent:country:is', 'India': 'ent:country:in', 'Malaysia': 'ent:country:my',
  'Norway': 'ent:country:no', 'Russia': 'ent:country:ru', 'United Arab Emirates': 'ent:country:ae',
  'Guinea': 'ent:country:gn', 'Indonesia': 'ent:country:id', 'Jamaica': 'ent:country:jm',
  'Kazakhstan': 'ent:country:kz', 'Saudi Arabia': 'ent:country:sa', 'Vietnam': 'ent:country:vn',
  'Greece': 'ent:country:gr', 'Turkey': 'ent:country:tr',
  // Germany/Ireland/Spain alumina rows stay unmapped until the register
  // carries those countries — an unmapped reporter is a dropped row, which
  // is the resolution gap the round-25 assessment names; kept small here.
};

export const MCS_ALUMINIUM_CSPEC: McsCommoditySpec = {
  commodities: ['Aluminum', 'Bauxite'],
  metricFor: (type) =>
    // USGS's own vocabulary confirms the chain inversion: aluminium
    // SMELTERS produce the final metal, its REFINERIES the intermediate.
    type.startsWith('Smelter production, aluminum') ? { metric: 'refined_production', basis: 'metal_content' }
      : type.startsWith('Mine production, bauxite') ? { metric: 'production', basis: 'gross_weight' }
        : type.startsWith('Refinery production, alumina') ? { metric: 'intermediate_production', basis: 'gross_weight' }
          : null,
  countryMap: AL_COUNTRY_MAP,
};

/** Back-compat wrapper: observations only. Adapters use the accounted form —
 *  filtering is never free (see RowAccounting). */
export function parseMcsWorldCsv(
  csvText: string,
  prov: (ref: string, note?: string) => Provenance,
  spec: McsVintageSpec = MCS2025_SPEC,
  cspec?: McsCommoditySpec,
): Observation[] {
  return parseMcsWorldCsvAccounted(csvText, prov, spec, cspec).observations;
}

/**
 * The accounted parse: every CSV row is accepted, filtered with its
 * predicate named, or rejected. The commodity filter that silently
 * discarded aluminium for twenty rounds now counts what it excludes.
 */
export function parseMcsWorldCsvAccounted(
  csvText: string,
  prov: (ref: string, note?: string) => Provenance,
  spec: McsVintageSpec = MCS2025_SPEC,
  cspec?: McsCommoditySpec,
): { observations: Observation[]; accounting: RowAccounting; unresolved: UnresolvedIdentifier[] } {
  const lines = csvText.replace(/^\ufeff/, '').split(/\r?\n/).filter(l => l.trim().length > 0);
  const header = splitCsvRow(lines[0]).map(h => h.trim());
  const col = (name: string | null) => (name === null ? -1 : header.findIndex(h => h.replace(/\s+/g, ' ') === name.replace(/\s+/g, ' ')));
  const iCommodity = col(spec.commodityCol);
  const iCountry = col(spec.countryCol);
  const iType = col(spec.typeCol);
  const iReported = col(spec.reportedCol);
  const iEstimated = col(spec.estimatedCol);
  const iReserves = col(spec.reservesCol);
  const iNotes = col(spec.notesCol);
  if (iCountry < 0 || iType < 0) throw new Error(`MCS CSV header not recognized for ${spec.idPrefix}`);

  const num = (raw: string | undefined): number | null => {
    const cleaned = (raw ?? '').replace(/[",\s]/g, '');
    if (!cleaned) return null;
    const v = Number(cleaned);
    return Number.isFinite(v) ? v : null;
  };

  const cs: McsCommoditySpec = cspec ?? { ...MCS_COPPER_CSPEC, countryMap: MCS_COUNTRY_MAP };
  const obs: Observation[] = [];
  let acceptedRows = 0;
  const filteredCommodity = { count: 0 };
  const filteredCountry = new Map<string, number>();
  const filteredType = new Map<string, number>();
  for (const line of lines.slice(1)) {
    const row = splitCsvRow(line);
    if (iCommodity >= 0 && !cs.commodities.includes((row[iCommodity] ?? '').trim())) {
      filteredCommodity.count += 1;
      continue;
    }
    const countryName = (row[iCountry] ?? '').trim();
    const entityId = cs.countryMap[countryName];
    if (!entityId) {
      // "Other Countries", "World total", and genuinely unmapped reporters —
      // the resolution gap, now counted with names instead of vanished.
      filteredCountry.set(countryName, (filteredCountry.get(countryName) ?? 0) + 1);
      continue;
    }
    const type = (row[iType] ?? '').trim();
    const mapped = cs.metricFor(type);
    const metric = mapped?.metric ?? null;
    const basis = mapped?.basis ?? 'metal_content';
    const slug = entityId.split(':')[2];
    if (!metric) {
      filteredType.set(type, (filteredType.get(type) ?? 0) + 1);
      continue;
    }
    acceptedRows += 1;
    if (metric) {
      // USGS flags some "reported" figures as its own estimates in the notes
      // column (e.g. "estimated 2023") — those must not carry 'reported'.
      const notes = iNotes >= 0 ? (row[iNotes] ?? '').trim() : '';
      const noteEstimated = /estimat/i.test(notes);
      const vReported = num(row[iReported]);
      if (vReported !== null) {
        obs.push({
          id: `obs:${spec.idPrefix}:${metric}:${slug}:${spec.reportedYear}`,
          entityId, metric, value: vReported, unit: 'kt/y', basis,
          period: { start: `${spec.reportedYear}-01-01`, end: `${spec.reportedYear}-12-31` },
          knownAt: spec.publishedAt,
          valueKind: noteEstimated ? 'estimated' : 'reported', confidence: 'high',
          provenance: prov(`${type}, ${spec.reportedYear}`, noteEstimated ? `USGS note: ${notes}` : undefined),
        });
      }
      const vEstimated = num(row[iEstimated]);
      if (vEstimated !== null) {
        obs.push({
          id: `obs:${spec.idPrefix}:${metric}:${slug}:${spec.estimatedYear}`,
          entityId, metric, value: vEstimated, unit: 'kt/y', basis,
          period: { start: `${spec.estimatedYear}-01-01`, end: `${spec.estimatedYear}-12-31` },
          knownAt: spec.publishedAt,
          valueKind: 'estimated', confidence: 'high',
          provenance: prov(`${type}, ${spec.estimatedYear} est.`),
        });
      }
      if (metric === 'production' && iReserves >= 0) {
        const vReserves = num(row[iReserves]);
        if (vReserves !== null) {
          obs.push({
            id: `obs:${spec.idPrefix}:reserves:${slug}:${spec.reservesYear}`,
            entityId, metric: 'reserves', value: vReserves, unit: 'kt',
            period: { start: `${spec.reservesYear}-01-01`, end: `${spec.reservesYear}-12-31` },
            knownAt: spec.publishedAt,
            valueKind: 'estimated', confidence: 'medium',
            provenance: prov(`Reserves, ${spec.reservesYear}`, 'USGS reserves are estimates by definition, compiled under differing national standards — a stock figure, never comparable as throughput.'),
          });
        }
      }
    }
  }
  const accounting: RowAccounting = {
    sourceId: `${spec.idPrefix}-live`.replace('usgs-mcs2024-live', 'usgs-mcs2024-vintage'),
    scope: `${spec.idPrefix} world CSV (commodities: ${cs.commodities.join(', ')})`,
    fetchedRows: lines.length - 1,
    accepted: acceptedRows,
    filtered: [
      ...(iCommodity >= 0 ? [{ predicate: `COMMODITY not in [${cs.commodities.join(', ')}]`, count: filteredCommodity.count }] : []),
      ...(filteredCountry.size > 0 ? [{
        predicate: 'COUNTRY not in commodity country map (aggregates + unmapped reporters)',
        count: [...filteredCountry.values()].reduce((s, n) => s + n, 0),
        examples: [...filteredCountry.keys()].slice(0, 8),
      }] : []),
      ...(filteredType.size > 0 ? [{
        predicate: 'TYPE not recognized by metricFor',
        count: [...filteredType.values()].reduce((s, n) => s + n, 0),
        examples: [...filteredType.keys()].slice(0, 4),
      }] : []),
    ],
    rejected: [],
  };
  // The resolution gate's typed records (work order 3.3): the COUNTRY drops
  // above, as records rather than a count — built from the SAME map, so
  // reconciliation with the accounting is structural. Candidates against
  // the register are enriched at assembly (the parser has no register).
  const unresolved = buildUnresolvedRecords(
    'mcs-country-name', accounting.sourceId,
    new Map([...filteredCountry].map(([name, count]) => [name, { occurrences: count, context: `${spec.idPrefix} world CSV` }])),
    [],
    'Add the country name to the commodity countryMap (register the entity first if absent), or record it as an aggregate out of scope (World total / Other countries).',
  );
  return { observations: obs, accounting, unresolved };
}

interface ScienceBaseItem { files?: Array<{ name?: string; url?: string }> }

/** Accounting from the most recent parse on each MCS path. Cached loader
 *  hits reuse the last accounting (same data, same drops); the holder makes
 *  filtering visible without threading a tuple through the ladder. */
const mcsAccounting: { copper?: RowAccounting; copperVintage?: RowAccounting; aluminium?: RowAccounting } = {};
/** Resolution-gate residue from the most recent parse on each MCS path —
 *  same holder pattern as the accounting, same reconciliation. */
const mcsUnresolved: { copper?: UnresolvedIdentifier[]; copperVintage?: UnresolvedIdentifier[]; aluminium?: UnresolvedIdentifier[] } = {};

async function fetchMcsLive(): Promise<Observation[]> {
  const item = await fetchJson<ScienceBaseItem>(MCS_ITEM_URL);
  const file = item.files?.find(f => /World_Data.*\.csv$/i.test(f.name ?? ''));
  if (!file?.url) throw new Error('MCS World Data CSV not found on ScienceBase item');
  const csv = await fetchText(file.url);
  const retrievedAt = new Date().toISOString();
  const { observations, accounting, unresolved } = parseMcsWorldCsvAccounted(csv, (ref, note) => ({
    sourceId: 'usgs-mcs2025-live',
    sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
    sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    retrievedAt, sourceRef: ref, note,
  }), MCS2025_SPEC);
  mcsAccounting.copper = accounting;
  mcsUnresolved.copper = unresolved;
  return observations;
}

/** The MCS2024 edition — static history, always served from the committed
 *  capture. Its estimates are what was knowable before MCS2025 published. */
function mcs2024VintageObs(): Observation[] {
  const { observations, accounting, unresolved } = parseMcsWorldCsvAccounted(MCS2024_SNAPSHOT_CSV, (ref, note) => ({
    sourceId: 'usgs-mcs2024-vintage',
    sourceName: 'USGS Mineral Commodity Summaries 2024 — Copper (ScienceBase vintage)',
    sourceUrl: 'https://www.sciencebase.gov/catalog/item/65b7d77ed34e36a39045b4b2',
    retrievedAt: `${MCS2024_SNAPSHOT_CAPTURED_AT}T00:00:00Z`,
    sourceRef: ref, note,
  }), MCS2024_SPEC);
  mcsAccounting.copperVintage = { ...accounting, sourceId: 'usgs-mcs2024-vintage' };
  mcsUnresolved.copperVintage = unresolved.map(u => ({ ...u, sourceId: 'usgs-mcs2024-vintage' }));
  return observations;
}

/** Chain revisions: an MCS2025 figure supersedes the MCS2024 figure for the
 *  same (entity, metric, period). */
function linkSupersedes(current: Observation[], vintage: Observation[]): Observation[] {
  const vintageByKey = new Map(vintage.map(o => [`${o.entityId}|${o.metric}|${o.period.start}`, o.id]));
  return current.map(o => {
    const prior = vintageByKey.get(`${o.entityId}|${o.metric}|${o.period.start}`);
    return prior ? { ...o, supersedes: prior } : o;
  });
}

function mcsSnapshot(reason: string): Observation[] {
  const { observations, accounting, unresolved } = parseMcsWorldCsvAccounted(MCS_SNAPSHOT_CSV, (ref, note) => ({
    sourceId: 'usgs-mcs2025-live',
    sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
    sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    retrievedAt: `${MCS_SNAPSHOT_CAPTURED_AT}T00:00:00Z`,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  }), MCS2025_SPEC);
  mcsAccounting.copper = { ...accounting, scope: `${accounting.scope} [snapshot rung]` };
  mcsUnresolved.copper = unresolved;
  return observations;
}

/* ── Aluminium from the same world file ── */

function mcsAlProv(retrievedAt: string, note?: string) {
  return (ref: string, extra?: string): Provenance => ({
    sourceId: 'usgs-mcs2025-live',
    sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
    sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    retrievedAt, sourceRef: ref, note: [note, extra].filter(Boolean).join(' — ') || undefined,
  });
}

async function fetchMcsAluminiumLive(): Promise<Observation[]> {
  const item = await fetchJson<ScienceBaseItem>(MCS_ITEM_URL);
  const file = item.files?.find(f => /World_Data.*\.csv$/i.test(f.name ?? ''));
  if (!file?.url) throw new Error('MCS World Data CSV not found on ScienceBase item');
  const csv = await fetchText(file.url);
  const { observations, accounting, unresolved } = parseMcsWorldCsvAccounted(csv, mcsAlProv(new Date().toISOString()), MCS2025_SPEC, MCS_ALUMINIUM_CSPEC);
  mcsAccounting.aluminium = accounting;
  mcsUnresolved.aluminium = unresolved;
  return observations;
}

function mcsAluminiumSnapshot(reason: string): Observation[] {
  const { observations, accounting, unresolved } = parseMcsWorldCsvAccounted(
    MCS_AL_SNAPSHOT_CSV,
    mcsAlProv(`${MCS_AL_SNAPSHOT_CAPTURED_AT}T00:00:00Z`, `bundled snapshot (${reason})`),
    MCS2025_SPEC, MCS_ALUMINIUM_CSPEC,
  );
  mcsAccounting.aluminium = { ...accounting, scope: `${accounting.scope} [snapshot rung]` };
  mcsUnresolved.aluminium = unresolved;
  return observations;
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

export const M49_TO_ENTITY: Record<number, string> = {
  152: 'ent:country:cl', 604: 'ent:country:pe', 180: 'ent:country:cd', 156: 'ent:country:cn',
  842: 'ent:country:us', 360: 'ent:country:id', 36: 'ent:country:au', 894: 'ent:country:zm',
  484: 'ent:country:mx', 398: 'ent:country:kz', 643: 'ent:country:ru', 496: 'ent:country:mn',
  616: 'ent:country:pl', 392: 'ent:country:jp', 410: 'ent:country:kr', 276: 'ent:country:de',
  356: 'ent:country:in', 591: 'ent:country:pa', 124: 'ent:country:ca',
  // Comtrade uses its own historic code for India as a PARTNER (699, vs the
  // ISO M49 356 it uses as a reporter) — found by the flow-vintage ingest
  // when Indonesia's third-largest 2017 receiver dropped as unmapped. The
  // resolution gate (work order 3.3) is what makes this class of gap
  // visible instead of silent.
  699: 'ent:country:in',
};

interface ComtradeRow {
  partnerCode?: number;
  netWgt?: number | null;
  isNetWgtEstimated?: boolean;
}
interface ComtradeResponse { data?: ComtradeRow[] }

/*
 * Publication dates from the UN Comtrade data-availability API (getDA),
 * captured as a committed snapshot. Two properties shape everything here:
 *
 *   1. knownAt is real, not a retrieval-time fallback: each (reporter,
 *      period) dataset carries firstReleased and lastReleased.
 *   2. Comtrade keeps ONE version of a dataset — revisions overwrite in
 *      place with no archive of prior versions. The figure Payload Terminal holds is
 *      therefore the lastReleased version, and is stamped with THAT date:
 *      as_known_then earlier than lastReleased is honestly blind for this
 *      value, because the vintage that WAS knowable then no longer exists
 *      anywhere (both Chile years have already been revised in place).
 *      This is also why the archival rung below exists: Payload Terminal's own
 *      snapshots are the only Comtrade vintage archive there will ever be.
 */
interface ComtradeDaRow { reporterCode: number; period: number; firstReleased: string; lastReleased: string }
// On globalThis: a severed copy means boot and request contexts each
// re-fetch the publication-date index, which is both wasted outbound
// load against a courtesy-limited source and a knownAt that could differ
// between contexts for the same record. See processSingleton.ts.
const COMTRADE_DA = processSingleton('comtrade-da', () => new Map<string, ComtradeDaRow>());
for (const r of (comtradeDa as { rows: ComtradeDaRow[] }).rows) {
  const key = `${r.reporterCode}-${r.period}`;
  const prev = COMTRADE_DA.get(key);
  if (!prev || r.lastReleased > prev.lastReleased) COMTRADE_DA.set(key, r);
}

function comtradeKnownAt(m49: string | number, year: string | number): { knownAt?: string; daNote?: string } {
  const row = COMTRADE_DA.get(`${m49}-${year}`);
  if (!row) return {};
  const first = row.firstReleased.slice(0, 10);
  const held = row.lastReleased.slice(0, 10);
  return {
    knownAt: held,
    daNote: held === first
      ? `Released ${first} (Comtrade getDA).`
      : `First released ${first}; held version released ${held} — revised in place, the original vintage is unrecoverable unless archived.`,
  };
}

/**
 * Best-effort vintage archival. Comtrade revises datasets in place and keeps
 * no prior versions, so every successful retrieval is written to
 * data-archive/comtrade/<date>/ — the only vintage archive of Comtrade that
 * will ever exist. Failure (read-only filesystem) must never break
 * acquisition.
 */
async function archiveComtradeVintage(key: string, raw: unknown): Promise<void> {
  // NEVER under test: the degradation-ladder tests exercise this path with
  // STUBBED responses, and an unguarded write here put stub-served bytes
  // into the real unreconstructable archive during every suite run — found
  // by the S-2 manifest verifier the first time the two cohabited a suite
  // (a fabricated byte in the vintage store is the exact loss class the
  // archive exists to prevent, arriving through the instrument's own
  // tests). Live-run archival is unaffected: VITEST is unset there.
  if (process.env.VITEST) return;
  try {
    const fs = await import('node:fs/promises');
    const day = new Date().toISOString().slice(0, 10);
    const dir = `${process.cwd()}/data-archive/comtrade/${day}`;
    await fs.mkdir(dir, { recursive: true });
    await writeVintageWithoutOverwrite(fs, dir, key, JSON.stringify(raw));
  } catch { /* best-effort by design */ }
}

/**
 * NEVER OVERWRITE A CAPTURE (final order finding, verified in the running
 * configuration). The archive path is keyed by DAY, and the write was
 * unconditional — so a second live run on the same date silently replaced
 * the first capture of an UNRECONSTRUCTABLE vintage. It happened: the
 * 01:06 capture of 152-2603-X-2023 (4 partner rows) was overwritten at
 * 18:17 by a superset (18 rows) for the identical query; only git history
 * held the earlier bytes. Comtrade revises in place and keeps no prior
 * version, so an overwritten capture is a knowledge state gone — the exact
 * loss class the archive exists to prevent, this time arriving through the
 * archive's own writer.
 *
 * Identical bytes are a no-op (a re-fetch that changed nothing adds no
 * file). DIFFERING bytes get the next free sequenced sibling, so both
 * captures survive and the intra-day revision is itself visible evidence.
 */
export async function writeVintageWithoutOverwrite(
  fs: { readFile(p: string, enc: 'utf8'): Promise<string>; writeFile(p: string, data: string): Promise<void> },
  dir: string,
  key: string,
  bytes: string,
): Promise<string | null> {
  const mine = comparableVintage(bytes);
  for (let n = 1; n < 100; n++) {
    const path = `${dir}/${key}${n === 1 ? '' : `-${n}`}.json`;
    let existing: string | null = null;
    try {
      existing = await fs.readFile(path, 'utf8');
    } catch {
      await fs.writeFile(path, bytes); // free slot: FULL bytes, unmodified
      return path;
    }
    if (comparableVintage(existing) === mine) return null; // same knowledge state
  }
  return null; // 99 differing same-day captures: something else is wrong
}

/**
 * The comparable form of a capture: the payload WITHOUT the response's
 * volatile metadata.
 *
 * Found immediately after the no-overwrite fix shipped, by watching the
 * archive during live runs: Comtrade stamps every response with its own
 * server-side timing (`elapsedTime: "0.64 secs"`), which differs on every
 * call. A byte-identical comparison therefore NEVER matched, so each
 * re-fetch of unchanged data wrote another sibling — seven near-identical
 * copies of one knowledge state accumulated in a single afternoon
 * (verified: `-2` through `-8` had identical payloads and seven different
 * timings). An archive that grows without bound on unchanged data is a
 * different way to lose a vintage: the real revision becomes a needle in
 * copies of itself.
 *
 * The comparison ignores the timing; the STORED FILE is always the full
 * unmodified response. We never edit an archived capture — we only decide
 * with a better question whether it is new.
 */
export function comparableVintage(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // `elapsedTime` is dropped deliberately: it is the provider's own timing,
    // not a fact about the world, and carrying it would put a number with no
    // subject into a record that is otherwise all measurements.
    const { elapsedTime: _dropped, ...rest } = parsed;
    void _dropped;
    return JSON.stringify(rest);
  } catch {
    return raw; // not JSON: compare verbatim rather than guess
  }
}

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
  const { knownAt, daNote } = comtradeKnownAt(m49Str, yearStr);
  return {
    id: `obs:comtrade:${slug}:${hs}:${flow}:${yearStr}`,
    entityId, metric,
    value: Math.round(kg / 1e6),
    unit: hs === '2603' ? 'kt gross/y' : 'kt/y',
    // Schema basis: Comtrade netWgt is nominally gross shipped weight. This
    // is a CLAIM about the reporter's declaration, not verified fact — the
    // divergence grade-band gate detects reporters who deviate (e.g. Chile
    // appears to declare contained metal under HS 2603).
    basis: hs === '2603' ? 'gross_weight' : 'metal_content',
    period: { start: `${yearStr}-01-01`, end: `${yearStr}-12-31` },
    ...(knownAt ? { knownAt } : {}),
    // A world total Payload Terminal computed by summing partner rows is inference,
    // not the reporter's own aggregate — the identity charter says so.
    valueKind: derivedFromPartners ? 'derived' : 'reported',
    confidence: estimated ? 'medium' : 'high',
    provenance: prov(
      `HS ${hs} flow ${flow} reporter ${m49Str} period ${yearStr}`,
      [formNote, derivedFromPartners ? 'World total summed from bilateral partner rows (reporter aggregate weight was null).' : null, daNote].filter(Boolean).join(' '),
    ),
  };
}

/** Slug of an entity id. */
function entitySlug(entityId: string): string {
  return entityId.split(':')[2];
}

/**
 * Bilateral (partner-scoped) observations from a Comtrade response's partner
 * rows. These are mirror evidence — reporter-declared flows to/from a named
 * counterparty. They never enter aggregate analytics; the divergence system
 * matches them against the counterparty's own declaration of the same flow.
 */
export function parseComtradeBilateral(
  key: string,
  raw: ComtradeResponse,
  prov: (ref: string, note?: string) => Provenance,
): Observation[] {
  const [m49Str, hs, flow, yearStr] = key.split('-');
  const entityId = M49_TO_ENTITY[Number(m49Str)];
  if (!entityId) return [];
  const metric = hs === '2603'
    ? (flow === 'X' ? 'concentrate_exports' as const : 'concentrate_imports' as const)
    : (flow === 'X' ? 'refined_exports' as const : 'refined_imports' as const);
  const minKg = hs === '2603' ? 1e8 : 5e7; // 100 kt gross / 50 kt — bound the noise
  const obs: Observation[] = [];
  for (const row of (raw.data ?? []) as Array<ComtradeRow & { partnerCode?: number }>) {
    if (!row.partnerCode || row.partnerCode === 0) continue;
    const partnerEntityId = M49_TO_ENTITY[row.partnerCode];
    if (!partnerEntityId || row.netWgt === null || row.netWgt === undefined || row.netWgt < minKg) continue;
    const { knownAt, daNote } = comtradeKnownAt(m49Str, yearStr);
    obs.push({
      id: `obs:comtrade:${entitySlug(entityId)}:${hs}:${flow}:${yearStr}:${entitySlug(partnerEntityId)}`,
      entityId, partnerEntityId, metric,
      value: Math.round(row.netWgt / 1e6),
      unit: hs === '2603' ? 'kt gross/y' : 'kt/y',
      basis: hs === '2603' ? 'gross_weight' : 'metal_content',
      period: { start: `${yearStr}-01-01`, end: `${yearStr}-12-31` },
      ...(knownAt ? { knownAt } : {}),
      valueKind: 'reported',
      confidence: row.isNetWgtEstimated === true ? 'medium' : 'high',
      provenance: prov(
        `HS ${hs} flow ${flow} reporter ${m49Str} partner ${row.partnerCode} period ${yearStr}`,
        ['Bilateral declaration (mirror evidence) — excluded from aggregate analytics; compared against the counterparty\'s declaration by the divergence system.', daNote].filter(Boolean).join(' '),
      ),
    });
  }
  return obs;
}

/**
 * Pure row accounting over Comtrade responses: recomputes the parse
 * predicates' drops (unmapped reporter/partner M49 — the round-25
 * resolution gap — the netWgt floor, missing world rows) so every fetched
 * row is accepted, filtered with the predicate named, or rejected. Kept in
 * lockstep with parseComtradeResponse/parseComtradeBilateral; the snapshot
 * tests hold the two together.
 */
export function accountComtradeResponsesFull(responses: Record<string, ComtradeResponse>): { accounting: RowAccounting; unresolved: UnresolvedIdentifier[] } {
  let fetched = 0, accepted = 0, unmappedReporter = 0, unmappedPartner = 0, belowFloor = 0, missingWgt = 0;
  const reporterTally = new Map<string, { occurrences: number; context?: string }>();
  const partnerTally = new Map<string, { occurrences: number; context?: string }>();
  for (const [key, raw] of Object.entries(responses)) {
    const [m49Str, hs] = key.split('-');
    const minKg = hs === '2603' ? 1e8 : 5e7;
    const rows = (raw.data ?? []) as Array<ComtradeRow & { partnerCode?: number }>;
    fetched += rows.length;
    if (!M49_TO_ENTITY[Number(m49Str)]) {
      unmappedReporter += rows.length;
      const prev = reporterTally.get(m49Str);
      reporterTally.set(m49Str, { occurrences: (prev?.occurrences ?? 0) + rows.length, context: prev?.context ?? `request ${key}` });
      continue;
    }
    for (const row of rows) {
      if (row.netWgt === null || row.netWgt === undefined) { missingWgt += 1; continue; }
      if (!row.partnerCode || row.partnerCode === 0) { accepted += 1; continue; } // world row → aggregate obs
      if (!M49_TO_ENTITY[row.partnerCode]) {
        unmappedPartner += 1;
        const code = String(row.partnerCode);
        const prev = partnerTally.get(code);
        partnerTally.set(code, { occurrences: (prev?.occurrences ?? 0) + 1, context: prev?.context ?? `request ${key}` });
        continue;
      }
      if (row.netWgt < minKg) { belowFloor += 1; continue; }
      accepted += 1;
    }
  }
  const accounting: RowAccounting = {
    sourceId: 'un-comtrade-preview',
    scope: `Comtrade preview responses (${Object.keys(responses).length} request(s))`,
    fetchedRows: fetched,
    accepted,
    filtered: [
      ...(unmappedReporter > 0 ? [{ predicate: 'reporter M49 not in M49_TO_ENTITY', count: unmappedReporter, examples: [...reporterTally.keys()].slice(0, 6) }] : []),
      ...(unmappedPartner > 0 ? [{ predicate: 'partner M49 not in M49_TO_ENTITY', count: unmappedPartner, examples: [...partnerTally.keys()].slice(0, 8) }] : []),
      ...(belowFloor > 0 ? [{ predicate: 'netWgt below noise floor (100 kt gross / 50 kt)', count: belowFloor }] : []),
    ],
    rejected: missingWgt > 0 ? [{ reason: 'netWgt missing on row', count: missingWgt }] : [],
  };
  const M49_REMEDY = 'Add the M49 code to M49_TO_ENTITY (register the country entity first if absent), or record the code as out of scope (aggregate/special area codes).';
  return {
    accounting,
    unresolved: [
      ...buildUnresolvedRecords('comtrade-m49-reporter', 'un-comtrade-preview', reporterTally, [], M49_REMEDY),
      ...buildUnresolvedRecords('comtrade-m49-partner', 'un-comtrade-preview', partnerTally, [], M49_REMEDY),
    ],
  };
}

/** Back-compat accounting-only form — the accounted parse contract tests use
 *  it; adapters use the full form so the resolution gate gets its records. */
export function accountComtradeResponses(responses: Record<string, ComtradeResponse>): RowAccounting {
  return accountComtradeResponsesFull(responses).accounting;
}

const comtradeAccounting: { current?: RowAccounting } = {};
const comtradeUnresolved: { current?: UnresolvedIdentifier[] } = {};

async function fetchComtradeLive(): Promise<Observation[]> {
  const retrievedAt = new Date().toISOString();
  const prov = (ref: string, note?: string): Provenance => ({
    sourceId: 'un-comtrade-preview',
    sourceName: 'UN Comtrade (public preview API)',
    sourceUrl: 'https://comtradeplus.un.org/',
    retrievedAt, sourceRef: ref, note,
  });
  const snapshotResponses = (comtradeSnapshot as { capturedAt: string; responses: Record<string, ComtradeResponse> });
  const rawByKey = new Map<string, ComtradeResponse>();
  const usedResponses: Record<string, ComtradeResponse> = {};
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
        rawByKey.set(key, raw);
        // Archive the vintage NOW: Comtrade revises in place with no prior-
        // version archive, so this write is the only copy that will survive
        // the next revision.
        await archiveComtradeVintage(key, raw);
        one = parseComtradeResponse(key, raw, prov);
        // A 200 with an empty data array is NOT live coverage — counting it
        // would let an all-snapshot result be cached as a fresh success.
        if (one) anyLive = true;
        await new Promise(r => setTimeout(r, 1100)); // stay polite
      } catch (e) {
        if (e instanceof Error && e.message.includes('429')) rateLimited = true;
        one = null;
      }
    }
    let bilateral: Observation[] = [];
    if (one) {
      // Live parse succeeded — bilateral rows come from the same response at
      // zero extra request cost. (rawByKey holds the last successful raw.)
      usedResponses[key] = rawByKey.get(key)!;
      bilateral = parseComtradeBilateral(key, rawByKey.get(key)!, prov);
    } else {
      // Per-request degradation: this key alone falls back to its snapshot slice.
      const snap = snapshotResponses.responses[key];
      if (snap) {
        const snapProv = (ref: string, note?: string): Provenance => ({
          ...prov(ref, note),
          retrievedAt: `${snapshotResponses.capturedAt}T00:00:00Z`,
          note: [`bundled snapshot (live request unavailable${rateLimited ? ': rate limited' : ''})`, note].filter(Boolean).join(' — '),
        });
        usedResponses[key] = snap;
        one = parseComtradeResponse(key, snap, snapProv);
        bilateral = parseComtradeBilateral(key, snap, snapProv);
      }
    }
    if (one) obs.push(one);
    obs.push(...bilateral);
  }
  // If nothing came back live, report failure so the ladder's snapshot rung
  // serves — an all-snapshot result must not be cached as a fresh success.
  if (!anyLive) throw new Error('no live Comtrade responses (rate limited or unreachable)');
  const full = accountComtradeResponsesFull(usedResponses);
  comtradeAccounting.current = full.accounting;
  comtradeUnresolved.current = full.unresolved;
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
    obs.push(...parseComtradeBilateral(key, raw, prov));
  }
  const full = accountComtradeResponsesFull(responses);
  comtradeAccounting.current = { ...full.accounting, scope: 'Comtrade snapshot rung' };
  comtradeUnresolved.current = full.unresolved;
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
    // A completed month's close is knowable the following day; the partial
    // month falls back to retrieval time via knownAtOf.
    const dayAfter = new Date(Date.UTC(y, m - 1, lastDay) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      id: `obs:hg-price:${month}`,
      entityId: 'ent:commodity:copper',
      metric: 'price' as const,
      value: Number(byMonth.get(month)!.toFixed(4)),
      unit: 'USD/lb',
      period: { start: `${month}-01`, end: `${month}-${String(lastDay).padStart(2, '0')}` },
      ...(partial ? {} : { knownAt: dayAfter }),
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
    const release = new Date(Date.parse(`${date}T00:00:00Z`) + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    obs.push({
      id: `obs:cftc-mm-net:${date}`,
      entityId: 'ent:commodity:copper',
      metric: 'net_positioning',
      value: long - short,
      unit: 'contracts',
      period: { start: date, end: date },
      knownAt: release, // COT releases Friday, three days after the Tuesday as-of
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

/* ══════════════ Westmetall daily LME copper stocks ══════════════ */

/*
 * Recon verdict (2026-08): the LME's own market-data pages and the CME
 * delivery reports both sit behind bot protection (403), and LME data is
 * commercially licensed at the feed level. Westmetall (a German metal
 * trader) republishes the LME daily headline figures — cash settlement,
 * 3-month, and closing stock — as a public HTML table, reachable without a
 * key, year-to-date depth. This is the one daily-cadence PHYSICAL series
 * the horizon table found capable of a non-negative lead. Licensing
 * posture: headline daily totals republished by a third party, used here
 * for internal research; a production deployment wants a licensed LME feed
 * — that is the first line of the acquisition shopping list.
 */

const WM_URL = 'https://www.westmetall.com/en/markdaten.php?action=table&field=LME_Cu_cash';
const WM_MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

export interface WestmetallRow { date: string; stockTonnes: number }

/** Parse the Westmetall market-data table: date, cash, 3-month, stock. */
export function parseWestmetallTable(html: string): WestmetallRow[] {
  const rowRe = /<td >(\d{2})\. (\w+) (\d{4})<\/td>\s*<td >([\d,.]+)<\/td>\s*<td >([\d,.]+)<\/td>\s*<td class="last">([\d,]+)<\/td>/g;
  const rows: WestmetallRow[] = [];
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const [, d, mon, y, , , stock] = m;
    const month = WM_MONTHS[mon];
    if (!month) continue;
    rows.push({
      date: `${y}-${String(month).padStart(2, '0')}-${d}`,
      stockTonnes: Number(stock.replace(/,/g, '')),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export function westmetallObs(rows: WestmetallRow[], prov: (ref: string, note?: string) => Provenance): Observation[] {
  return rows.map(r => {
    // The LME publishes the previous session's closing stock the next
    // morning — day+1 is the conservative knowability bound.
    const dayAfter = new Date(Date.parse(`${r.date}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return {
      id: `obs:lme-stock-daily:${r.date}`,
      entityId: 'ent:infrastructure:lme-warehouses',
      metric: 'inventory' as const,
      value: Number((r.stockTonnes / 1000).toFixed(3)),
      unit: 'kt',
      basis: 'metal_content' as const, // refined cathode: contained ≈ gross
      period: { start: r.date, end: r.date },
      knownAt: dayAfter,
      valueKind: 'reported' as const,
      confidence: 'medium' as const, // real published figure via a republisher
      provenance: prov(`LME closing stock, ${r.date}`, `${r.stockTonnes.toLocaleString()} t; LME headline figure republished by Westmetall.`),
    };
  });
}

/*
 * Plausibility gate — SAFETY, where the degradation ladder is only
 * LIVENESS. The failure mode a scrape is most likely to produce is fresh
 * but wrong: if the markup shifts and the parser latches onto the adjacent
 * column (a ~14,000 USD/t price parsed as ~14 kt of stock), the fetch
 * succeeds, knownAt is current, cadence is nominal — and corpus health is
 * correctly silent while the series is nonsense. A violated gate REJECTS
 * the fetch, which degrades the ladder deliberately and turns the invisible
 * failure into a 'source_suspect' the health system already reports.
 */
export const WESTMETALL_GATE = {
  /** Absolute sanity bounds, kt. LME copper stocks have ranged ~30–900 kt
   *  historically; a price-column latch lands near 14 kt, far outside. */
  valueRangeKt: [20, 1500] as [number, number],
  /** Exchange stocks rarely move >25% day-over-day even on mass warrant
   *  cancellations; a column latch jumps discontinuously. */
  maxDailyChangeRatio: 0.25,
  /** Year-to-date table: 1 row on Jan 2, ~260 by late December. */
  expectedRowCountRange: [1, 400] as [number, number],
};

export function checkWestmetallPlausibility(rows: WestmetallRow[]): string | null {
  const [minRows, maxRows] = WESTMETALL_GATE.expectedRowCountRange;
  if (rows.length < minRows || rows.length > maxRows) {
    return `row count ${rows.length} outside expected [${minRows}, ${maxRows}]`;
  }
  const [lo, hi] = WESTMETALL_GATE.valueRangeKt;
  for (let i = 0; i < rows.length; i++) {
    const kt = rows[i].stockTonnes / 1000;
    if (kt < lo || kt > hi) {
      return `value ${kt.toFixed(1)} kt on ${rows[i].date} outside sanity range [${lo}, ${hi}] kt — possible wrong-column latch`;
    }
    if (i > 0) {
      if (rows[i].date <= rows[i - 1].date) return `dates not strictly increasing at ${rows[i].date}`;
      const prev = rows[i - 1].stockTonnes;
      const change = prev > 0 ? Math.abs(rows[i].stockTonnes - prev) / prev : 0;
      if (change > WESTMETALL_GATE.maxDailyChangeRatio) {
        return `day-over-day change ${(change * 100).toFixed(0)}% on ${rows[i].date} exceeds ${(WESTMETALL_GATE.maxDailyChangeRatio * 100).toFixed(0)}%`;
      }
    }
  }
  return null;
}

async function fetchWestmetallLive(): Promise<Observation[]> {
  const html = await fetchText(WM_URL, 20000, {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });
  const rows = parseWestmetallTable(html);
  const violation = checkWestmetallPlausibility(rows);
  if (violation) throw new Error(`plausibility violation: ${violation}`);
  const retrievedAt = new Date().toISOString();
  return westmetallObs(rows, (ref, note) => ({
    sourceId: 'westmetall-lme-stocks',
    sourceName: 'LME daily copper stocks (via Westmetall market data)',
    sourceUrl: WM_URL,
    retrievedAt, sourceRef: ref, note,
  }));
}

function westmetallSnapshotObs(reason: string): Observation[] {
  const snap = westmetallSnapshot as { retrievedAt: string; rows: WestmetallRow[] };
  return westmetallObs(snap.rows, (ref, note) => ({
    sourceId: 'westmetall-lme-stocks',
    sourceName: 'LME daily copper stocks (via Westmetall market data)',
    sourceUrl: WM_URL,
    retrievedAt: snap.retrievedAt,
    sourceRef: ref,
    note: [`bundled snapshot (${reason})`, note].filter(Boolean).join(' — '),
  }));
}

/* ══════════════ Adapter assembly ══════════════ */

function observationOnlyPayload(
  observations: Observation[],
  source: AdapterPayload['sources'][number],
  commodity: [slug: string, name: string] = ['copper', 'Copper'], // was hardcoded 'copper' until round 25
): AdapterPayload {
  return {
    commodity: commodity[0],
    commodityName: commodity[1],
    entities: [], flows: [], capacities: [], dependencies: [], events: [],
    observations,
    sources: [source],
  };
}

const DAY = 24 * 60 * 60 * 1000;

const loaders = {
  usgs: withSnapshotFallback('econ:usgs-mcs', 30 * DAY, fetchMcsLive, mcsSnapshot),
  usgsAluminium: withSnapshotFallback('econ:usgs-mcs-al', 30 * DAY, fetchMcsAluminiumLive, mcsAluminiumSnapshot),
  comtrade: withSnapshotFallback('econ:comtrade', 30 * DAY, fetchComtradeLive, comtradeSnapshotObs),
  yahoo: withSnapshotFallback('econ:yahoo-hg', 12 * 60 * 60 * 1000, fetchYahooLive, yahooSnapshotObs),
  cftc: withSnapshotFallback('econ:cftc-cot', 12 * 60 * 60 * 1000, fetchCftcLive, cftcSnapshotObs),
  westmetall: withSnapshotFallback('econ:westmetall-lme', 6 * 60 * 60 * 1000, fetchWestmetallLive, westmetallSnapshotObs),
};

export const usgsMcsAdapter: EconomyAdapter = {
  providerId: 'usgs-mcs-live',
  providerName: 'USGS Mineral Commodity Summaries World Data (live, ScienceBase)',
  commodities: ['copper'],
  async load() {
    const vintage = mcs2024VintageObs();
    const current = linkSupersedes(await loaders.usgs(), vintage);
    const payload = observationOnlyPayload([...current, ...vintage], {
      sourceId: 'usgs-mcs2025-live',
      sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
      sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    });
    payload.sources.push({
      sourceId: 'usgs-mcs2024-vintage',
      sourceName: 'USGS Mineral Commodity Summaries 2024 — Copper (ScienceBase vintage)',
      sourceUrl: 'https://www.sciencebase.gov/catalog/item/65b7d77ed34e36a39045b4b2',
    });
    payload.accounting = [mcsAccounting.copper, mcsAccounting.copperVintage].filter((a): a is RowAccounting => !!a);
    payload.unresolved = [...(mcsUnresolved.copper ?? []), ...(mcsUnresolved.copperVintage ?? [])];
    return payload;
  },
};

export const usgsMcsAluminiumAdapter: EconomyAdapter = {
  providerId: 'usgs-mcs-aluminium-live',
  providerName: 'USGS Mineral Commodity Summaries World Data — aluminium chain (live, ScienceBase)',
  commodities: ['aluminium'],
  async load() {
    // Same world file, same ladder, different commodity spec: bauxite mine
    // production (gross dry tons), alumina refinery production (gross
    // calcined weight, intermediate_production) and primary aluminium
    // smelter production (metal content, refined_production).
    const payload = observationOnlyPayload(await loaders.usgsAluminium(), {
      sourceId: 'usgs-mcs2025-live',
      sourceName: 'USGS Mineral Commodity Summaries 2025 — World Data (ScienceBase)',
      sourceUrl: `https://www.sciencebase.gov/catalog/item/${MCS_ITEM_ID}`,
    }, ['aluminium', 'Aluminium']);
    payload.accounting = mcsAccounting.aluminium ? [mcsAccounting.aluminium] : [];
    payload.unresolved = mcsUnresolved.aluminium ?? [];
    return payload;
  },
};

export const comtradeAdapter: EconomyAdapter = {
  providerId: 'comtrade-trade',
  providerName: 'UN Comtrade public preview — copper trade weights',
  commodities: ['copper'],
  async load() {
    const payload = observationOnlyPayload(await loaders.comtrade(), {
      sourceId: 'un-comtrade-preview',
      sourceName: 'UN Comtrade (public preview API)',
      sourceUrl: 'https://comtradeplus.un.org/',
    });
    payload.accounting = comtradeAccounting.current ? [comtradeAccounting.current] : [];
    payload.unresolved = comtradeUnresolved.current ?? [];
    return payload;
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

export const westmetallStocksAdapter: EconomyAdapter = {
  providerId: 'westmetall-lme-stocks',
  providerName: 'LME daily copper stocks via Westmetall',
  commodities: ['copper'],
  async load() {
    return observationOnlyPayload(await loaders.westmetall(), {
      sourceId: 'westmetall-lme-stocks',
      sourceName: 'LME daily copper stocks (via Westmetall market data)',
      sourceUrl: WM_URL,
    });
  },
};

export const LIVE_ADAPTERS: EconomyAdapter[] = [
  usgsMcsAdapter, usgsMcsAluminiumAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter, westmetallStocksAdapter,
];

/* The country flow-vintage adapter lives in flowVintages.ts and is
 * registered by adapters.ts alongside these — kept separate because it
 * serves committed captures (Comtrade revises in place; the capture IS the
 * vintage), not the live ladder. */
