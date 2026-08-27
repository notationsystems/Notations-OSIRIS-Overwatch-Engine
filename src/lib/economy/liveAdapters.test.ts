import { describe, it, expect, afterEach } from 'vitest';
import type { Provenance } from './types';
import { validateState } from './types';
import {
  parseMcsWorldCsv, parseMcsWorldCsvAccounted, parseComtradeResponse, parseComtradeBilateral, parseYahooChart, parseCftcRows,
  parseWestmetallTable, westmetallObs, checkWestmetallPlausibility, accountComtradeResponses,
  usgsMcsAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter,
  writeVintageWithoutOverwrite, comparableVintage,
  MCS2025_SPEC, MCS_COPPER_CSPEC, MCS_ALUMINIUM_CSPEC,
} from './liveAdapters';
import westmetallSnapshot from '@/data/economy/snapshots/westmetall-lme-stocks.json';
import { MCS_SNAPSHOT_CSV } from '@/data/economy/snapshots/mcs2025-world-copper';
import { MCS_AL_SNAPSHOT_CSV } from '@/data/economy/snapshots/mcs2025-world-aluminium';
import comtradeSnapshot from '@/data/economy/snapshots/comtrade-copper.json';
import yahooSnapshot from '@/data/economy/snapshots/yahoo-hg-10y.json';
import cftcSnapshot from '@/data/economy/snapshots/cftc-copper-1yr.json';
import { getEconomyState } from './store';
import { observationsAt, concentration } from './analytics';

const prov = (ref: string, note?: string): Provenance =>
  ({ sourceId: 'test', sourceName: 'test', retrievedAt: '2026-08-26T00:00:00Z', sourceRef: ref, note });

describe('row accounting: filtering is never free (round 26)', () => {
  it('the commodity filter now counts what it excludes — the twenty-round counterfactual, printed', () => {
    // Parse the aluminium snapshot (multi-commodity rows) with the COPPER
    // spec: exactly what the live world-file parse did for twenty rounds.
    // Had this accounting existed, every copper ingest would have printed
    // this line, and someone would have asked on day two.
    const { observations, accounting } = parseMcsWorldCsvAccounted(
      MCS_AL_SNAPSHOT_CSV, prov, MCS2025_SPEC, { ...MCS_COPPER_CSPEC, countryMap: {} },
    );
    expect(observations).toEqual([]);
    const commodityFilter = accounting.filtered.find(f => f.predicate.includes('COMMODITY not in [Copper]'))!;
    expect(commodityFilter.count).toBe(56); // every aluminium/bauxite row, named and counted
    expect(accounting.fetchedRows).toBe(56);
    expect(accounting.accepted).toBe(0);
  });

  it('unmapped reporters are counted with names — the resolution gap made visible', () => {
    const { accounting } = parseMcsWorldCsvAccounted(MCS_AL_SNAPSHOT_CSV, prov, MCS2025_SPEC, MCS_ALUMINIUM_CSPEC);
    const unmapped = accounting.filtered.find(f => f.predicate.includes('COUNTRY not in'))!;
    expect(unmapped.count).toBeGreaterThan(0);
    // Germany/Ireland/Spain report alumina but are outside the aluminium
    // country map — dropped rows, now dropped WITH NAMES.
    expect(unmapped.examples!.join(' ')).toMatch(/Germany|Ireland|Spain|Other Countries|World total/);
    expect(accounting.accepted).toBeGreaterThan(30);
    expect(accounting.fetchedRows).toBe(accounting.accepted
      + accounting.filtered.reduce((s, f) => s + f.count, 0)
      + accounting.rejected.reduce((s, r) => s + r.count, 0)); // every row accounted for
  });

  it('Comtrade accounting names the unmapped-M49 and noise-floor drops', () => {
    const responses = (comtradeSnapshot as { responses: Parameters<typeof accountComtradeResponses>[0] }).responses;
    const acct = accountComtradeResponses(responses);
    expect(acct.fetchedRows).toBeGreaterThan(0);
    expect(acct.accepted).toBeGreaterThan(0);
    // The bilateral partner rows outside M49_TO_ENTITY were silently dropped
    // since round 1 — now counted with the codes named.
    const partnerDrop = acct.filtered.find(f => f.predicate.includes('partner M49'));
    expect(partnerDrop).toBeDefined();
    expect(partnerDrop!.count).toBeGreaterThan(0);
    expect(partnerDrop!.examples!.length).toBeGreaterThan(0);
    // Conservation: every fetched row lands in exactly one bucket.
    expect(acct.fetchedRows).toBe(acct.accepted
      + acct.filtered.reduce((s, f) => s + f.count, 0)
      + acct.rejected.reduce((s, r) => s + r.count, 0));
  });
});

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

describe('Comtrade publication dates (data-availability snapshot)', () => {
  it('stamps knownAt from the getDA release dates — the held version\'s, not the first', () => {
    const responses = (comtradeSnapshot as { responses: Record<string, Parameters<typeof parseComtradeResponse>[1]> }).responses;
    // Chile 2024: first released 2025-04-24, then REVISED IN PLACE — the
    // version we hold was released 2026-04-29 and is stamped with that date.
    // as_known_then before it is honestly blind: the original vintage no
    // longer exists anywhere (Comtrade keeps one version).
    const cl2024 = parseComtradeResponse('152-2603-X-2024', responses['152-2603-X-2024'], prov)!;
    expect(cl2024.knownAt).toBe('2026-04-29');
    expect(cl2024.provenance.note).toContain('revised in place');
    // China 2023: released once — knownAt is its (only) release date.
    const cn2023 = parseComtradeResponse('156-2603-M-2023', responses['156-2603-M-2023'], prov)!;
    expect(cn2023.knownAt).toBe('2024-04-07');
    // Bilateral rows inherit the reporter's release date.
    const bilateral = parseComtradeBilateral('156-2603-M-2023', responses['156-2603-M-2023'], prov);
    expect(bilateral.length).toBeGreaterThan(0);
    for (const o of bilateral) expect(o.knownAt).toBe('2024-04-07');
  });
});

describe('parseWestmetallTable / westmetallObs (against the committed real capture)', () => {
  it('parses the daily table markup', () => {
    const html = '<tr><td >25. August 2026</td>\n<td >14,425.00</td>\n<td >14,298.00</td>\n<td class="last">238,725</td></tr>'
      + '<tr><td >02. January 2026</td>\n<td >12,000.00</td>\n<td >12,100.00</td>\n<td class="last">99,150</td></tr>';
    const rows = parseWestmetallTable(html);
    expect(rows).toEqual([
      { date: '2026-01-02', stockTonnes: 99150 },
      { date: '2026-08-25', stockTonnes: 238725 },
    ]);
  });

  it('plausibility gate: accepts the real capture, rejects fresh-but-wrong data', () => {
    const rows = (westmetallSnapshot as { rows: Array<{ date: string; stockTonnes: number }> }).rows;
    // The real series passes.
    expect(checkWestmetallPlausibility(rows)).toBeNull();
    // A wrong-column latch (price ~14,425 USD/t parsed as stock) is caught by
    // the sanity range: freshness would be nominal, content nonsense.
    expect(checkWestmetallPlausibility([{ date: '2026-08-25', stockTonnes: 14425 }]))
      .toContain('wrong-column latch');
    // A discontinuous jump is caught even inside the sanity range.
    expect(checkWestmetallPlausibility([
      { date: '2026-08-24', stockTonnes: 240000 },
      { date: '2026-08-25', stockTonnes: 100000 },
    ])).toContain('day-over-day change');
    // Broken ordering is caught.
    expect(checkWestmetallPlausibility([
      { date: '2026-08-25', stockTonnes: 240000 },
      { date: '2026-08-24', stockTonnes: 239000 },
    ])).toContain('not strictly increasing');
  });

  it('converts the snapshot to daily kt observations with day-after knowability', () => {
    const rows = (westmetallSnapshot as { rows: Array<{ date: string; stockTonnes: number }> }).rows;
    expect(rows.length).toBe(164);
    const obs = westmetallObs(rows, prov);
    const latest = obs[obs.length - 1];
    expect(latest.id).toBe('obs:lme-stock-daily:2026-08-25');
    expect(latest.value).toBeCloseTo(238.725, 3); // tonnes → kt
    expect(latest.unit).toBe('kt');
    expect(latest.basis).toBe('metal_content');
    expect(latest.period).toEqual({ start: '2026-08-25', end: '2026-08-25' });
    // Previous session's closing stock publishes the next morning.
    expect(latest.knownAt).toBe('2026-08-26');
    expect(latest.valueKind).toBe('reported');
  });
});

describe('comtrade degradation ladder (stubbed fetch)', () => {
  // NOTE: order matters — the all-empty case must run before the partial
  // case, because a successful partial pass caches under econ:comtrade for
  // its full TTL while a failed pass is never served from cache.
  const realFetch = globalThis.fetch;
  const savedEnv = process.env.RUN_LIVE_TESTS;
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (savedEnv === undefined) delete process.env.RUN_LIVE_TESTS;
    else process.env.RUN_LIVE_TESTS = savedEnv;
  });

  it('treats an all-200-but-empty live pass as failure: snapshot serves, nothing cached as fresh', async () => {
    process.env.RUN_LIVE_TESTS = '1';
    globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) })) as unknown as typeof fetch;
    const payload = await comtradeAdapter.load('copper');
    expect(payload.observations.length).toBeGreaterThan(0);
    for (const o of payload.observations) {
      expect(o.provenance.note, o.id).toContain('bundled snapshot');
    }
  });

  it('degrades per request: one live success + 429s yields mixed live/snapshot provenance', async () => {
    process.env.RUN_LIVE_TESTS = '1';
    const firstResponse = (comtradeSnapshot as { responses: Record<string, unknown> }).responses['152-2603-X-2023'];
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, json: async () => firstResponse };
      return { ok: false, status: 429, json: async () => ({}) };
    }) as unknown as typeof fetch;
    const payload = await comtradeAdapter.load('copper');
    const world = payload.observations.filter(o => !o.partnerEntityId);
    const bilateral = payload.observations.filter(o => o.partnerEntityId);
    expect(world).toHaveLength(6);
    expect(bilateral.length).toBeGreaterThan(5); // mirror evidence rides along
    const liveWorld = world.filter(o => !(o.provenance.note ?? '').includes('bundled snapshot'));
    const snapWorld = world.filter(o => (o.provenance.note ?? '').includes('rate limited'));
    expect(liveWorld).toHaveLength(1);
    expect(liveWorld[0].id).toBe('obs:comtrade:cl:2603:X:2023');
    expect(snapWorld).toHaveLength(5);
    // The 429 circuit breaker stopped further live attempts after request 2.
    expect(calls).toBe(2);
  });
});

describe('live adapters in the assembled state (snapshot rung, network off)', () => {
  it('all four adapters serve snapshot observations under test env', async () => {
    for (const adapter of [usgsMcsAdapter, comtradeAdapter, yahooPriceAdapter, cftcPositioningAdapter]) {
      const payload = await adapter.load('copper');
      expect(payload.observations.length, adapter.providerId).toBeGreaterThan(0);
      for (const o of payload.observations) {
        // MCS2024 vintage records are permanent history, not a fallback rung —
        // they carry their own vintage source id instead of a snapshot note.
        if (o.provenance.sourceId === 'usgs-mcs2024-vintage') continue;
        expect(o.provenance.note, `${adapter.providerId} ${o.id}`).toContain('bundled snapshot');
      }
    }
    // The vintage rode along with the USGS payload.
    const usgs = await usgsMcsAdapter.load('copper');
    expect(usgs.observations.some(o => o.provenance.sourceId === 'usgs-mcs2024-vintage')).toBe(true);
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

describe('the archive never overwrites a capture (final order finding)', () => {
  /** In-memory stand-in for node:fs/promises with the two methods used. */
  function memFs(seed: Record<string, string> = {}) {
    const files = { ...seed };
    return {
      files,
      async readFile(p: string) {
        if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return files[p];
      },
      async writeFile(p: string, data: string) { files[p] = data; },
    };
  }

  it('a differing same-day re-capture lands beside the first, never on top of it', async () => {
    // The real sequence, reproduced: a 4-row capture, then an 18-row
    // superset for the identical query on the same date.
    const first = JSON.stringify({ count: 4, data: [1, 2, 3, 4] });
    const second = JSON.stringify({ count: 18, data: Array.from({ length: 18 }, (_, i) => i) });
    const fs = memFs();
    const a = await writeVintageWithoutOverwrite(fs, '/arch/2026-08-27', '152-2603-X-2023', first);
    const b = await writeVintageWithoutOverwrite(fs, '/arch/2026-08-27', '152-2603-X-2023', second);
    expect(a).toBe('/arch/2026-08-27/152-2603-X-2023.json');
    expect(b).toBe('/arch/2026-08-27/152-2603-X-2023-2.json');
    // BOTH knowledge states survive — the first is not a casualty of the second.
    expect(fs.files['/arch/2026-08-27/152-2603-X-2023.json']).toBe(first);
    expect(fs.files['/arch/2026-08-27/152-2603-X-2023-2.json']).toBe(second);
    // A third, differing again, keeps sequencing.
    const third = JSON.stringify({ count: 19, data: [] });
    expect(await writeVintageWithoutOverwrite(fs, '/arch/2026-08-27', '152-2603-X-2023', third))
      .toBe('/arch/2026-08-27/152-2603-X-2023-3.json');
  });

  it('a re-fetch that differs ONLY in the server\'s own timing is a no-op', async () => {
    // Found by watching the archive during live runs, immediately after
    // the no-overwrite fix shipped: Comtrade stamps each response with
    // its own elapsedTime, so byte-identical NEVER matched and every
    // re-fetch of unchanged data wrote another sibling — seven copies of
    // one knowledge state accumulated in an afternoon. An archive that
    // grows without bound on unchanged data loses the real revision in
    // copies of itself.
    const a = JSON.stringify({ elapsedTime: '0.64 secs', count: 18, data: [1, 2, 3] });
    const b = JSON.stringify({ elapsedTime: '0.11 secs', count: 18, data: [1, 2, 3] });
    expect(comparableVintage(a)).toBe(comparableVintage(b));
    const fs = memFs();
    expect(await writeVintageWithoutOverwrite(fs, '/arch/d', 'k', a)).toBe('/arch/d/k.json');
    expect(await writeVintageWithoutOverwrite(fs, '/arch/d', 'k', b)).toBeNull();
    expect(Object.keys(fs.files)).toEqual(['/arch/d/k.json']);
    // The STORED file keeps the full response, timing included — we never
    // edit an archived capture, only compare it with a better question.
    expect(fs.files['/arch/d/k.json']).toBe(a);
    expect(JSON.parse(fs.files['/arch/d/k.json']).elapsedTime).toBe('0.64 secs');

    // Discriminating: a genuinely different payload still lands beside it,
    // even when its timing happens to match.
    const c = JSON.stringify({ elapsedTime: '0.64 secs', count: 4, data: [1] });
    expect(await writeVintageWithoutOverwrite(fs, '/arch/d', 'k', c)).toBe('/arch/d/k-2.json');
  });

  it('a byte-identical re-fetch is a no-op — re-running the instrument does not litter the archive', async () => {
    const bytes = JSON.stringify({ count: 4, data: [1] });
    const fs = memFs({ '/arch/2026-08-27/k.json': bytes });
    expect(await writeVintageWithoutOverwrite(fs, '/arch/2026-08-27', 'k', bytes)).toBeNull();
    expect(Object.keys(fs.files)).toEqual(['/arch/2026-08-27/k.json']);
  });

  it('the discriminating case: the OLD unconditional write would have destroyed the first capture', async () => {
    // Vacuity guard — the property above is only meaningful because the
    // naive implementation fails it. This is that implementation.
    const fs = memFs();
    const naiveWrite = async (key: string, bytes: string) => { await fs.writeFile(`/arch/${key}.json`, bytes); };
    await naiveWrite('k', 'FIRST');
    await naiveWrite('k', 'SECOND');
    expect(fs.files['/arch/k.json']).toBe('SECOND');
    expect(Object.values(fs.files)).not.toContain('FIRST'); // gone, unrecoverably
  });
});
