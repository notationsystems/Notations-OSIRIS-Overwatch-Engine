/**
 * OSIRIS — Canonical Physical-Economy State
 *
 * Identity discipline (do not blur these):
 *  - Entity       persistent real-world object (mine, smelter, port, country…)
 *  - Observation  a sourced measurement about an entity (production, inventory…)
 *  - Flow         a directed material movement between two entities
 *  - Capacity     a constraint on possible throughput of an entity
 *  - Dependency   a typed relationship (A depends_on B, A located_in G…)
 *  - EconEvent    a temporally bounded change (outage, strike, expansion…)
 *
 * Raw evidence and derived inference must never share an identity: every
 * Observation/Flow/Capacity carries `valueKind` and `provenance`; analytical
 * outputs are wrapped in AnalyticalResult and reference their input ids
 * instead of masquerading as observations.
 */

/* ── Provenance ── */

export interface Provenance {
  /** Stable id of the source, e.g. "usgs-mcs-2025". */
  sourceId: string;
  sourceName: string;
  sourceUrl?: string;
  /** When OSIRIS acquired the value (ISO 8601). */
  retrievedAt: string;
  /** Locator within the source: table, page, series id. */
  sourceRef?: string;
  /** Identity of the raw artifact (file hash, snapshot id) where practical. */
  artifactId?: string;
  note?: string;
}

export type Confidence = 'high' | 'medium' | 'low';

/**
 * How the number came to be. `representative` marks curated public-domain
 * magnitudes (real-world derived, order-of-magnitude faithful) used to prove
 * the pipeline — never presented as fresh reported data.
 */
export type ValueKind = 'reported' | 'estimated' | 'derived' | 'representative';

/** Coarseness of a geographic position. Do not fabricate precision. */
export type GeoPrecision = 'exact' | 'site' | 'city' | 'region' | 'country';

export interface Period {
  /** ISO 8601 date (inclusive). */
  start: string;
  /** ISO 8601 date (inclusive). */
  end: string;
}

/* ── Entity ── */

export type EntityKind =
  | 'mine'
  | 'smelter'
  | 'refinery'
  | 'port'
  | 'manufacturer'
  | 'region'
  | 'country'
  | 'commodity'
  | 'infrastructure';

/** Where the entity sits in the material chain. */
export type SupplyStage =
  | 'production'
  | 'concentrate'
  | 'smelting'
  | 'refining'
  | 'manufacturing'
  | 'demand'
  | 'logistics';

export interface Entity {
  /** "ent:<kind>:<slug>" — persistent, human-auditable. */
  id: string;
  kind: EntityKind;
  name: string;
  /** Commodity slug this entity chiefly concerns, e.g. "copper". */
  commodity?: string;
  /** ISO 3166 alpha-2 where meaningful. */
  countryCode?: string;
  country?: string;
  region?: string;
  lat?: number;
  lng?: number;
  geoPrecision?: GeoPrecision;
  stage?: SupplyStage;
  /** Operator / owner, free text. */
  operator?: string;
  tags?: string[];
  notes?: string;
}

/* ── Observation ── */

export type Metric =
  | 'production'
  | 'refined_production'
  | 'smelter_production'
  | 'inventory'
  | 'utilization'
  | 'shipment'
  | 'consumption'
  | 'exports'
  | 'imports'
  /* Trade metrics are split by material form so a gross-weight concentrate
   * figure can never be collapsed with a refined-cathode figure. */
  | 'concentrate_exports'
  | 'refined_exports'
  | 'concentrate_imports'
  | 'refined_imports'
  | 'reserves'
  /** Exchange price of the commodity itself (context, not physical flow). */
  | 'price'
  /** Futures positioning (e.g. managed-money net contracts). */
  | 'net_positioning'
  | 'throughput';

export interface Observation {
  /** "obs:<slug>" */
  id: string;
  entityId: string;
  metric: Metric;
  value: number;
  /** e.g. "kt/y", "Mt/y", "kt", "%", "t/d" */
  unit: string;
  period: Period;
  valueKind: ValueKind;
  confidence: Confidence;
  provenance: Provenance;
}

/* ── Flow ── */

/** Physical form the commodity takes while moving. */
export type MaterialForm =
  | 'ore'
  | 'concentrate'
  | 'blister'
  | 'anode'
  | 'cathode'
  | 'refined'
  | 'scrap'
  | 'semis'
  | 'product';

export type TransportMode = 'sea' | 'rail' | 'road' | 'pipeline' | 'internal' | 'mixed' | 'unknown';

export interface Flow {
  /** "flow:<slug>" */
  id: string;
  fromEntityId: string;
  toEntityId: string;
  commodity: string;
  form: MaterialForm;
  quantity: number;
  unit: string;
  period: Period;
  mode: TransportMode;
  valueKind: ValueKind;
  confidence: Confidence;
  provenance: Provenance;
}

/* ── Capacity ── */

export interface Capacity {
  /** "cap:<slug>" */
  id: string;
  entityId: string;
  /** What the capacity constrains, e.g. smelting throughput. */
  stage: SupplyStage;
  value: number;
  unit: string;
  period?: Period;
  valueKind: ValueKind;
  confidence: Confidence;
  provenance: Provenance;
}

/* ── Dependency ── */

export type DependencyType = 'depends_on' | 'feeds' | 'located_in' | 'produces' | 'processes' | 'consumes';

export interface Dependency {
  /** "dep:<slug>" */
  id: string;
  fromEntityId: string;
  type: DependencyType;
  toEntityId: string;
  /** Share of the from-entity's requirement met by the to-entity (0..1), when known. */
  strength?: number;
  basis?: string;
  provenance: Provenance;
}

/* ── Event ── */

export type EconEventType =
  | 'outage'
  | 'strike'
  | 'closure'
  | 'expansion'
  | 'disruption'
  | 'weather'
  | 'policy'
  | 'demand_surge';

export interface EconEvent {
  /** "evt:<slug>" */
  id: string;
  entityId?: string;
  type: EconEventType;
  title: string;
  start: string;
  end?: string;
  severity: 'low' | 'medium' | 'high';
  description?: string;
  provenance: Provenance;
}

/* ── Canonical state ── */

export interface EconomyState {
  commodity: string;
  /** Human label, e.g. "Copper". */
  commodityName: string;
  entities: Entity[];
  observations: Observation[];
  flows: Flow[];
  capacities: Capacity[];
  dependencies: Dependency[];
  events: EconEvent[];
  /** Sources referenced across the state, for the evidence panel. */
  sources: Array<{ sourceId: string; sourceName: string; sourceUrl?: string }>;
}

/* ── Evidence / Operation / Execution separation for analytics ── */

export interface AnalyticalResult<T> {
  /** Operation identity: what was requested. */
  operation: { name: string; params: Record<string, string | number | undefined> };
  /** Execution identity: which run produced it. */
  execution: { executedAt: string; engine: string };
  /** Evidence identity: exact inputs the result was computed from. */
  inputs: { observationIds?: string[]; flowIds?: string[]; capacityIds?: string[]; entityIds?: string[] };
  result: T;
}

/* ── Validation ── */

export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
}

const ID_PREFIX: Record<string, RegExp> = {
  entity: /^ent:/,
  observation: /^obs:/,
  flow: /^flow:/,
  capacity: /^cap:/,
  dependency: /^dep:/,
  event: /^evt:/,
};

/**
 * Referential-integrity + schema sanity check over a canonical state.
 * Returns issues instead of throwing so callers can decide severity policy.
 */
export function validateState(state: EconomyState): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entityIds = new Set<string>();

  for (const e of state.entities) {
    if (!ID_PREFIX.entity.test(e.id)) issues.push({ severity: 'error', message: `Entity id missing ent: prefix: ${e.id}` });
    if (entityIds.has(e.id)) issues.push({ severity: 'error', message: `Duplicate entity id: ${e.id}` });
    entityIds.add(e.id);
    if ((e.lat !== undefined) !== (e.lng !== undefined)) issues.push({ severity: 'error', message: `Entity ${e.id} has only one of lat/lng` });
    if (e.lat !== undefined && (e.lat < -90 || e.lat > 90)) issues.push({ severity: 'error', message: `Entity ${e.id} lat out of range` });
    if (e.lng !== undefined && (e.lng < -180 || e.lng > 180)) issues.push({ severity: 'error', message: `Entity ${e.id} lng out of range` });
    if (e.lat !== undefined && !e.geoPrecision) issues.push({ severity: 'warning', message: `Entity ${e.id} has coordinates but no geoPrecision` });
  }

  const seen = new Set<string>();
  const checkRecord = (
    id: string, kind: keyof typeof ID_PREFIX, refs: string[], value?: number,
  ) => {
    if (!ID_PREFIX[kind].test(id)) issues.push({ severity: 'error', message: `${kind} id missing prefix: ${id}` });
    if (seen.has(id)) issues.push({ severity: 'error', message: `Duplicate id: ${id}` });
    seen.add(id);
    for (const r of refs) {
      if (!entityIds.has(r)) issues.push({ severity: 'error', message: `${kind} ${id} references unknown entity ${r}` });
    }
    if (value !== undefined && !Number.isFinite(value)) issues.push({ severity: 'error', message: `${kind} ${id} has non-finite value` });
  };

  for (const o of state.observations) checkRecord(o.id, 'observation', [o.entityId], o.value);
  for (const f of state.flows) {
    checkRecord(f.id, 'flow', [f.fromEntityId, f.toEntityId], f.quantity);
    if (f.fromEntityId === f.toEntityId) issues.push({ severity: 'error', message: `Flow ${f.id} is a self-loop` });
    if (f.quantity < 0) issues.push({ severity: 'error', message: `Flow ${f.id} has negative quantity` });
  }
  for (const c of state.capacities) checkRecord(c.id, 'capacity', [c.entityId], c.value);
  for (const d of state.dependencies) checkRecord(d.id, 'dependency', [d.fromEntityId, d.toEntityId]);
  for (const ev of state.events) checkRecord(ev.id, 'event', ev.entityId ? [ev.entityId] : []);

  const withProvenance: Array<{ id: string; provenance?: Provenance }> = [
    ...state.observations, ...state.flows, ...state.capacities, ...state.dependencies, ...state.events,
  ];
  for (const rec of withProvenance) {
    if (!rec.provenance?.sourceId || !rec.provenance?.retrievedAt) {
      issues.push({ severity: 'error', message: `Record ${rec.id} lacks provenance (sourceId/retrievedAt)` });
    }
  }

  return issues;
}

/* ── Unit normalization ── */

/**
 * Convert a mass-per-year quantity to kt/y. Only the units the copper slice
 * actually uses — extend deliberately, do not guess conversions.
 */
export function toKtPerYear(value: number, unit: string): number | null {
  switch (unit) {
    case 'kt/y': return value;
    case 'Mt/y': return value * 1000;
    case 't/y': return value / 1000;
    default: return null;
  }
}
