/**
 * OSIRIS — Acquisition layer for the physical economy.
 *
 *   Provider → Adapter → Normalized records → Canonical EconomyState
 *
 * An adapter owns one provider. It returns canonical-shape records plus the
 * source registry entries it used; assembly, derived relationships, and
 * validation happen in the store, not in adapters. No provider is hard-coded
 * anywhere downstream of the registry.
 */

import type {
  EconomyState, Entity, Observation, Flow, Capacity, Dependency, EconEvent,
} from './types';
import {
  COPPER_ENTITIES, COPPER_OBSERVATIONS, COPPER_FLOWS, COPPER_CAPACITIES,
  COPPER_DEPENDENCIES, COPPER_EVENTS, COPPER_SOURCES,
} from '@/data/economy/copper';
import { COPPER_SERIES_OBSERVATIONS, COPPER_SERIES_SOURCES } from '@/data/economy/copper-series';
// Runtime-safe despite the apparent cycle: liveAdapters imports only TYPES
// from this module, so nothing evaluates back into it at load time.
import { LIVE_ADAPTERS } from './liveAdapters';
import { curatedAluminiumAdapter } from '@/data/economy/aluminium';

/**
 * Row accounting: every row an adapter fetched is accepted, rejected with a
 * reason, or FILTERED with the predicate named and counted. Silent filtering
 * is a defect class, not an incident (round 26): rejection was always
 * reported (IngestReport, validation issues) but a filtered row never became
 * a candidate record, so it was invisible — `!== 'Copper'` discarded
 * aluminium's world data for twenty rounds, and unmapped M49/MCS identifiers
 * vanished at resolution. Every refusal discipline in the system sits
 * downstream of ingest; this is the same doctrine — a drop is a claim that
 * the data doesn't matter, and claims get stated — applied at the one
 * boundary it never reached.
 */
export interface RowAccounting {
  sourceId: string;
  /** What the accounting covers, e.g. 'MCS2025 world CSV' or 'Comtrade requests'. */
  scope: string;
  fetchedRows: number;
  accepted: number;
  filtered: Array<{ predicate: string; count: number; examples?: string[] }>;
  rejected: Array<{ reason: string; count: number }>;
}

export interface AdapterPayload {
  commodity: string;
  commodityName: string;
  entities: Entity[];
  observations: Observation[];
  flows: Flow[];
  capacities: Capacity[];
  dependencies: Dependency[];
  events: EconEvent[];
  sources: EconomyState['sources'];
  /** Row accounting per fetch scope — absent only for curated datasets,
   *  which fetch nothing. */
  accounting?: RowAccounting[];
}

export interface EconomyAdapter {
  providerId: string;
  providerName: string;
  /** Commodities this adapter can serve. */
  commodities: string[];
  /**
   * Fetch + normalize. Async so live-provider adapters (HTTP, files) slot in
   * without an interface change; the curated adapter resolves immediately.
   */
  load(commodity: string): Promise<AdapterPayload>;
}

/* ── Curated dataset adapter (phase 1) ── */

export const curatedCopperAdapter: EconomyAdapter = {
  providerId: 'curated-copper-v1',
  providerName: 'OSIRIS curated copper dataset (USGS/ICSG-derived representative data)',
  commodities: ['copper'],
  async load(commodity: string): Promise<AdapterPayload> {
    if (commodity !== 'copper') throw new Error(`curated-copper-v1 cannot serve commodity "${commodity}"`);
    return {
      commodity: 'copper',
      commodityName: 'Copper',
      entities: COPPER_ENTITIES,
      observations: [...COPPER_OBSERVATIONS, ...COPPER_SERIES_OBSERVATIONS],
      flows: COPPER_FLOWS,
      capacities: COPPER_CAPACITIES,
      dependencies: COPPER_DEPENDENCIES,
      events: COPPER_EVENTS,
      sources: [...COPPER_SOURCES, ...COPPER_SERIES_SOURCES],
    };
  },
};

/* ── Registry ── */

const ADAPTERS: EconomyAdapter[] = [curatedCopperAdapter, curatedAluminiumAdapter, ...LIVE_ADAPTERS];

export function listAdapters(): EconomyAdapter[] {
  return [...ADAPTERS];
}

export function adaptersFor(commodity: string): EconomyAdapter[] {
  return ADAPTERS.filter(a => a.commodities.includes(commodity));
}

export function registerAdapter(adapter: EconomyAdapter): void {
  // Re-registering the same providerId replaces it — lets tests inject fakes.
  const i = ADAPTERS.findIndex(a => a.providerId === adapter.providerId);
  if (i >= 0) ADAPTERS[i] = adapter;
  else ADAPTERS.push(adapter);
}

export function unregisterAdapter(providerId: string): void {
  const i = ADAPTERS.findIndex(a => a.providerId === providerId);
  if (i >= 0) ADAPTERS.splice(i, 1);
}
