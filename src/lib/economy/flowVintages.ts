/**
 * Sea Dog Terminal — country-level flow vintages (work order 3.2).
 *
 * Restores propagation across the historical timeline at COUNTRY
 * granularity: reporter-declared Comtrade bilateral concentrate exports
 * become country→country Flow records, one vintage per (reporter, year),
 * captured live 2026-08-27 and archived (data-archive/comtrade/2026-08-27)
 * under the now-or-never rule.
 *
 * Pre-registered hazards, handled as registered:
 *   BASIS    netWgt is gross by schema, but Chile declares CONTAINED METAL
 *            under HS 2603 — the round-4/5 mirror finding (CL→CN ratio
 *            3.97 ≈ 1/0.25). Chilean vintage rows carry metal_content with
 *            the finding cited; every other reporter carries gross_weight,
 *            and the graph's basis firewall applies unchanged: gross flows
 *            convert only via a mirror-implied corridor grade, otherwise
 *            their tonnage refuses visibly.
 *   MIRROR   Reporter-declared exports are the topology source (stated on
 *            every record); partner declarations remain the divergence
 *            system's material and are never re-emitted here.
 *   GRANULARITY  These are COUNTRY flows. They enter the graph only when
 *            the evaluation date predates the facility topology (see
 *            selectTopology in graph.ts), so the two granularities never
 *            mix in one graph and a country-granularity result is labeled
 *            as such end to end.
 *
 * Scope discipline: country-level ONLY. The facility allocation model stays
 * deferred; facility events at country-granularity dates refuse with the
 *  allocation model named (propagation.ts).
 */

import type { Flow } from './types';
import type { AdapterPayload, EconomyAdapter, RowAccounting } from './adapters';
import { M49_TO_ENTITY } from './liveAdapters';
import vintageSnapshot from '@/data/economy/snapshots/comtrade-flow-vintages.json';

interface VintageRow { partnerCode?: number; netWgt?: number | null; period?: number | string }
interface VintageResponse { data?: VintageRow[] }

/** Reporters whose HS-2603 netWgt is established (by the mirror system) to
 *  be contained metal rather than gross weight. Chile is the round-4/5
 *  finding; extend only on divergence evidence, never on convenience. */
const METAL_CONTENT_REPORTERS = new Set([152]);

/** Corridors below this gross floor stay out of the vintage topology —
 *  the same noise bound the bilateral observations use (predicate named in
 *  the accounting). */
const MIN_KG = 5e7; // 50 kt

const entitySlugV = (id: string) => id.split(':')[2];

export function buildCountryFlowVintages(
  responses: Record<string, VintageResponse>,
  retrievedAt: string,
): { flows: Flow[]; accounting: RowAccounting } {
  const flows: Flow[] = [];
  let fetched = 0, accepted = 0, world = 0, unmappedPartner = 0, belowFloor = 0, missingWgt = 0;
  const unmappedCodes = new Set<string>();
  for (const [key, raw] of Object.entries(responses)) {
    const [m49Str, hs, flowCode, yearStr] = key.split('-');
    if (flowCode !== 'X') continue; // reporter-declared exports only (mirror choice)
    const reporterId = M49_TO_ENTITY[Number(m49Str)];
    if (!reporterId) continue;
    const basis = METAL_CONTENT_REPORTERS.has(Number(m49Str)) ? 'metal_content' as const : 'gross_weight' as const;
    for (const row of raw.data ?? []) {
      fetched += 1;
      if (row.netWgt === null || row.netWgt === undefined) { missingWgt += 1; continue; }
      if (!row.partnerCode || row.partnerCode === 0) { world += 1; continue; } // world aggregate — not a corridor
      const partnerId = M49_TO_ENTITY[row.partnerCode];
      if (!partnerId) { unmappedPartner += 1; unmappedCodes.add(String(row.partnerCode)); continue; }
      if (row.netWgt < MIN_KG) { belowFloor += 1; continue; }
      accepted += 1;
      flows.push({
        id: `flow:vintage:${hs}:${entitySlugV(reporterId)}:${entitySlugV(partnerId)}:${yearStr}`,
        fromEntityId: reporterId, toEntityId: partnerId, commodity: 'copper',
        form: hs === '2603' ? 'concentrate' : 'refined',
        quantity: Math.round(row.netWgt / 1e6), unit: basis === 'metal_content' ? 'kt/y' : 'kt gross/y',
        basis,
        period: { start: `${yearStr}-01-01`, end: `${yearStr}-12-31` },
        mode: 'sea', valueKind: 'reported', confidence: 'high',
        provenance: {
          sourceId: 'un-comtrade-preview',
          sourceName: 'UN Comtrade (public preview API) — country flow vintage',
          sourceUrl: 'https://comtradeplus.un.org/',
          retrievedAt,
          sourceRef: `HS ${hs} X reporter ${m49Str} partner ${row.partnerCode} period ${yearStr}`,
          note: basis === 'metal_content'
            ? 'Reporter-declared export (topology source; partner declarations stay with the divergence system). Chile declares CONTAINED METAL under HS 2603 — the mirror-established deviation (CL→CN 3.97×, round 4/5).'
            : 'Reporter-declared export (topology source; partner declarations stay with the divergence system). Gross weight per schema; converts to metal only via a mirror-implied corridor grade, otherwise tonnage refuses visibly.',
        },
      });
    }
  }
  return {
    flows,
    accounting: {
      sourceId: 'un-comtrade-preview',
      scope: `country flow vintages (${Object.keys(responses).length} reporter-year request(s))`,
      fetchedRows: fetched,
      accepted,
      filtered: [
        ...(world > 0 ? [{ predicate: 'world (partner 0) aggregate row — not a corridor', count: world }] : []),
        ...(unmappedPartner > 0 ? [{ predicate: 'partner M49 not in M49_TO_ENTITY', count: unmappedPartner, examples: [...unmappedCodes].slice(0, 8) }] : []),
        ...(belowFloor > 0 ? [{ predicate: 'netWgt below noise floor (50 kt)', count: belowFloor }] : []),
      ],
      rejected: missingWgt > 0 ? [{ reason: 'netWgt missing on row', count: missingWgt }] : [],
    },
  };
}

const SNAP = vintageSnapshot as { capturedAt: string; responses: Record<string, VintageResponse> };

/** Vintage flows are served from the committed capture — Comtrade revises in
 *  place, so the capture IS the vintage; a live refetch would be a different
 *  vintage, not a fresher copy of this one. */
export const comtradeFlowVintagesAdapter: EconomyAdapter = {
  providerId: 'comtrade-flow-vintages',
  providerName: 'UN Comtrade country flow vintages (2017–2022, captured 2026-08-27)',
  commodities: ['copper'],
  async load(): Promise<AdapterPayload> {
    const { flows, accounting } = buildCountryFlowVintages(SNAP.responses, `${SNAP.capturedAt}T00:00:00Z`);
    return {
      commodity: 'copper', commodityName: 'Copper',
      entities: [], observations: [], capacities: [], dependencies: [], events: [],
      flows,
      sources: [{
        sourceId: 'un-comtrade-preview',
        sourceName: 'UN Comtrade (public preview API)',
        sourceUrl: 'https://comtradeplus.un.org/',
      }],
      accounting: [accounting],
    };
  },
};
