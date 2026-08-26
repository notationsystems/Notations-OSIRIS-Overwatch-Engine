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

const ADAPTERS: EconomyAdapter[] = [curatedCopperAdapter, ...LIVE_ADAPTERS];

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
