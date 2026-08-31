/**
 * Payload — Canonical Physical-Economy State
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
  /** When Payload Terminal acquired the value (ISO 8601). */
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
  | 'infrastructure'
  /** Operating/owning company. A commodity can be geographically diversified
   *  and operationally concentrated at once — companies as entities (with
   *  operated_by edges) are what makes the second dimension computable. */
  | 'company';

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
  /** Output of the chain's FIRST transformation stage (alumina from bauxite
   *  refining; copper's blister/anode analog). Named by chain position, not
   *  equipment: the aluminium chain inverts copper's device names (its
   *  refineries make the intermediate, its smelters make the final metal),
   *  so equipment-named metrics do not generalize. `smelter_production`
   *  below is copper-shaped legacy naming for copper's intermediate —
   *  recorded in the ledger, not silently renamed. */
  | 'intermediate_production'
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
  /**
   * When this value became knowable to us (ISO date): the publication date
   * of the source edition, the release date of the report, or — as the
   * conservative upper bound when publication timing is untracked — the
   * retrieval time. `period` says what the value DESCRIBES; `knownAt` says
   * when it EXISTED. The distinction is what makes backtesting honest:
   * as-known-then playback must never show June 2019 a figure published in
   * January 2026. Absent, provenance.retrievedAt is the fallback bound.
   */
  knownAt?: string;
  /** Observation this value revises (e.g. a later MCS vintage superseding
   *  the previous edition's estimate for the same period). */
  supersedes?: string;
  /**
   * Bilateral scope: set when the observation measures a flow with respect
   * to a specific counterparty (e.g. China's concentrate imports FROM Peru,
   * as opposed to from the world). Partner-scoped observations are mirror
   * evidence — they never enter aggregate analytics (concentration, series,
   * anomalies), only divergence analysis.
   */
  partnerEntityId?: string;
  /** Mass basis of the value (physical metrics). Absent = 'unspecified'. */
  basis?: QuantityBasis;
  valueKind: ValueKind;
  confidence: Confidence;
  provenance: Provenance;
}

/* ── Quantity basis ── */

/**
 * What a physical mass number actually weighs. A kt without a basis is
 * underspecified everywhere it appears: contained metal and gross shipped
 * weight differ by the ore grade (~4x for copper concentrate), the numbers
 * are arithmetically combinable and semantically incompatible, and nothing
 * throws when they mix. Trade schemas nominally fix the basis (Comtrade
 * netWgt is gross) but reporters deviate — Chile appears to declare metal
 * content under HS 2603 — so declared basis is a claim, and the divergence
 * system's grade-band gate is the check.
 */
export type QuantityBasis = 'metal_content' | 'gross_weight' | 'unspecified';

/* ── Measurement classes ── */

/**
 * What kind of thing a metric measures. The invariant this encodes: only
 * physical measurements may feed physical analytics (concentration,
 * centrality, bottlenecks, propagation). Prices and positioning are context
 * layers — reflexive signals that respond to expectations about the very
 * disruptions the physical layer detects — and reserves are stocks compiled
 * under differing standards, never comparable as throughput.
 */
export type MeasurementClass = 'physical_flow' | 'physical_stock' | 'market_price' | 'financial_positioning';

export function measurementClassOf(metric: Metric): MeasurementClass {
  switch (metric) {
    case 'inventory':
    case 'reserves':
      return 'physical_stock';
    case 'price':
      return 'market_price';
    case 'net_positioning':
      return 'financial_positioning';
    default:
      return 'physical_flow';
  }
}

/* ── Flow ── */

/** Physical form the commodity takes while moving. */
export type MaterialForm =
  | 'ore'
  /** Calcined alumina (Al2O3) — the aluminium chain's intermediate; a
   *  chemical product, not a concentrate, so it gets its own name. Bauxite
   *  moves as 'ore'; primary aluminium as 'refined'. */
  | 'alumina'
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
  /** Mass basis. Gross-weight flows enter graph throughput only after
   *  conversion via a mirror-implied corridor grade (basis.ts) — at face
   *  value an edge would carry ~4x its true weight in inbound shares, and
   *  discarded as zero it would claim the flow carries nothing. Where no
   *  grade exists, throughput consumers refuse shares visibly. */
  basis?: QuantityBasis;
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

/**
 * `operated_by` links a facility to the company that operates/owns it, with
 * `strength` = attribution share (JV shares from public disclosures). It is
 * OPERATIONAL structure, so unlike located_in it stays in the traversal
 * graph: a company's labour dispute or financial distress reaches every
 * asset it operates, across borders — correlated risk that geographic
 * grouping scores as diversified.
 */
export type DependencyType = 'depends_on' | 'feeds' | 'located_in' | 'produces' | 'processes' | 'consumes' | 'operated_by';

export interface Dependency {
  /** "dep:<slug>" */
  id: string;
  fromEntityId: string;
  type: DependencyType;
  toEntityId: string;
  /** Share of the from-entity's requirement met by the to-entity (0..1), when known. */
  strength?: number;
  basis?: string;
  /**
   * operated_by edges only: what the relationship IS. 'operator' = the
   * company of record with operational control — the lever a strike or
   * distress pulls, so the edge propagation traverses and the CONTROL
   * attribution basis uses (100% of the asset). 'shareholder' = economic
   * interest — a claim on output, not a lever over operations: it feeds the
   * ECONOMIC attribution basis and never enters the traversal graph.
   * Escondida stops when BHP's workforce strikes, not 57.5% of Escondida.
   */
  role?: 'operator' | 'shareholder';
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
  | 'demand_surge'
  /** Financial/legal events attach to OWNERS, not managers — they traverse
   *  shareholder edges as well as operator edges (see propagation). */
  | 'sanction'
  | 'insolvency';

export interface EconEvent {
  /** "evt:<slug>" */
  id: string;
  entityId?: string;
  type: EconEventType;
  title: string;
  /** When the event OCCURRED (start of its physical window). */
  start: string;
  end?: string;
  /**
   * When the event became publicly knowable (first credible report or
   * disclosure). Detection latency — firstReportedAt minus start — is the
   * number that says how much warning a detector could actually have given.
   * Absent, `start` is assumed (reported immediately), which overstates
   * knowability; curated events should set it explicitly.
   */
  firstReportedAt?: string;
  /**
   * When the event was ANNOUNCED, where announcement structurally precedes
   * occurrence: a strike notice before the stoppage, a policy order before
   * implementation, a licence challenge before the halt. Anticipatory
   * behaviour (forward-buying, inventory draws) between announcedAt and
   * start is a real mechanism with an observable duration — so attribution
   * windows are DERIVED from this field, never chosen: an event without an
   * announcement has no anticipation story and gets no window.
   */
  announcedAt?: string;
  /**
   * Regulatory events attach to TERRITORY, not to an attribution edge: a
   * licence lapse, export ban or state decree reaches the entities inside a
   * jurisdiction, scoped by what the regulation actually governs. An export
   * halt is the sharp shape: it stops CROSSING flows without stopping
   * production — foreign receivers lose supply while domestic ones keep it.
   * A regulatory event without a scope propagates nowhere and says so
   * (refused, not guessed).
   */
  regulatoryScope?: {
    /** ISO 3166 alpha-2 of the governing jurisdiction. */
    jurisdictionCountryCode: string;
    commodity?: string;
    /** Which stages the regulation governs; absent = all. */
    stages?: SupplyStage[];
    /** What it stops: exports (crossing flows only), or all activity. */
    direction?: 'export' | 'all';
  };
  severity: 'low' | 'medium' | 'high';
  /** Estimated physical magnitude of the impact, when curatable — the
   *  number a backtest match can be sized against. Estimates say so in
   *  `note`; absence means "not curated", never zero. */
  magnitude?: { value: number; unit: string; basis?: QuantityBasis; note?: string };
  /**
   * How this event entered the record — the split that decides whether it
   * may score a detector. 'independent': curated from the external public
   * record without reference to detector output. 'post_hoc': curated after
   * observing detector firings, or written around a series the detector
   * runs on. A truth set assembled by looking at what the detector fired on
   * cannot be used to score that detector, so post-hoc events are excluded
   * from the headline precision. Absent = treated as post_hoc (independence
   * must be claimed, never presumed).
   */
  curation?: 'independent' | 'post_hoc';
  /**
   * A TYPED acknowledgment that this event is modeled AROUND a schema gap
   * rather than within the schema (round 26). The acknowledgment lives on
   * the record, not in prose, so the ledger guard can count acknowledged
   * counterexamples and force the re-take when a new one arrives:
   *   facility_scoped_regulation — a regulatory act scoped to one facility
   *     (the Alunorte court embargo), inexpressible in the
   *     jurisdiction-shaped RegulatoryScope and modeled as an operational
   *     disruption instead.
   */
  schemaLimitation?: 'facility_scoped_regulation';
  description?: string;
  provenance: Provenance;
}

/* ── Entity resolution gate (work order 3.3) ── */

/**
 * A typed record of an identifier a source proposed and the register could
 * not resolve. Row accounting (round 26) made these drops COUNTABLE; this
 * makes them RECORDS — searchable (`refused:resolution`), each carrying the
 * raw identifier verbatim, its source, how many rows rode on it, and the
 * remedy that would resolve it. Near matches in the register surface as
 * `candidates` and are NEVER merged: name similarity alone is never
 * sufficient, and a proposal below certainty is unresolved, not assigned.
 */
export interface UnresolvedIdentifier {
  /** The identifier vocabulary, e.g. 'comtrade-m49-partner', 'mcs-country-name'. */
  scheme: string;
  /** The raw identifier, verbatim as the source sent it. */
  identifier: string;
  sourceId: string;
  /** Rows that carried this identifier and were dropped for it. */
  occurrences: number;
  /** Where it appeared, e.g. a reporter-year request key. */
  context?: string;
  /** Register entities whose NAME is similar — informational only; the gate
   *  never merges on similarity, it names the collision for a curator. */
  candidates?: Array<{ entityId: string; name: string; note: string }>;
  remedy: string;
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
  /** The resolution gate's residue: identifiers sources proposed that the
   *  register could not resolve — typed records, not counts (work order
   *  3.3). Deterministically ordered; reconciles against row accounting's
   *  resolution-layer filtered counts. */
  unresolved?: UnresolvedIdentifier[];
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
  /**
   * Why the result is EMPTY — set only when it is, and never as a caveat on
   * a populated one (a note on every result is a note on none).
   *
   * An analytical operation that returns nothing has said one of several
   * different things: nothing qualified, the inputs it needs are absent at
   * this evaluation date, or the population it ranks over is excluded by
   * construction here. A bare empty array says none of them, and the reader
   * supplies the wrong one — usually "the instrument is broken" or "there
   * are no bottlenecks", when the truth was "no facility structure exists
   * at this date to rank".
   */
  emptyBecause?: string;
}

/* ── Divergence ── */

/**
 * A derived record of observer disagreement. An anomaly says the world
 * moved; a divergence says the observers disagree about whether it moved —
 * conflating the two is how fabricated sigma is born. Emitted whenever
 * resolution discards a claim, and for Comtrade mirror pairs (exporter- vs
 * importer-declared measurements of the same physical flow), where
 * persistent directional gaps are the standard route to transshipment and
 * misreporting findings.
 */
export interface DivergenceClaim {
  observationId: string;
  sourceId: string;
  value: number;
  unit: string;
  valueKind: ValueKind;
  confidence: Confidence;
  /** Mirror pairs: who is speaking. */
  perspective?: 'reporter' | 'partner';
}

export interface Divergence {
  /** "div:<slug>" */
  id: string;
  kind: 'multi-provider' | 'mirror';
  entityId: string;
  /** Mirror pairs: the counterparty. */
  partnerEntityId?: string;
  metric: Metric;
  period: Period;
  claims: DivergenceClaim[];
  /** The observation the resolved series actually used ('' when neither
   *  side feeds aggregate analytics — bilateral mirror evidence). */
  resolvedTo: string;
  spread: number;
  /** spread / max(|claims|), 0..∞ */
  relativeSpread: number;
  direction: 'resolved_higher' | 'resolved_lower' | 'reporter_higher' | 'partner_higher' | 'unsigned';
  /** Consecutive periods this (entity, metric[, partner]) divergence has
   *  held with consistent direction. */
  persistence: number;
  class: 'revision_lag' | 'coverage' | 'definitional' | 'unexplained';
  /**
   * Present when the pair was normalized at the reference concentrate grade.
   * A definitional class without this is a dismissal; with it, the residual
   * is a STATEMENT ("the basis explains the entire gap") and a BASELINE —
   * ranking uses the residual, not the raw spread, so a definitional pair
   * whose residual drifts climbs back into view instead of staying
   * permanently classed and unwatched.
   */
  basisNormalization?: {
    referenceGrade: number;
    impliedGrade: number;
    /**
     * (content-declared − gross×reference) ÷ (gross×reference). The LEVEL is
     * confounded by the corridor's unknown true grade (a genuine 30%-grade
     * corridor with honest declarations shows +20% at the 25% reference), so
     * it is display and baseline — never a trigger.
     */
    residual: number;
    /** Residual across the 20–33% grade uncertainty band. */
    residualBand: [number, number];
    /**
     * Residual minus the median of this corridor's PRIOR residuals. Grade is
     * a slowly-moving physical property — an approximately constant offset
     * per corridor — so first-differencing removes it, and drift is what
     * reclassification keys on. Absent for a corridor's first period.
     */
    residualDrift?: number;
  };
  explanation: string;
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

  for (const o of state.observations) {
    checkRecord(o.id, 'observation', o.partnerEntityId ? [o.entityId, o.partnerEntityId] : [o.entityId], o.value);
    if (o.knownAt && !/^\d{4}-\d{2}-\d{2}/.test(o.knownAt)) issues.push({ severity: 'error', message: `Observation ${o.id} has malformed knownAt` });
  }
  for (const f of state.flows) {
    checkRecord(f.id, 'flow', [f.fromEntityId, f.toEntityId], f.quantity);
    if (f.fromEntityId === f.toEntityId) issues.push({ severity: 'error', message: `Flow ${f.id} is a self-loop` });
    if (f.quantity < 0) issues.push({ severity: 'error', message: `Flow ${f.id} has negative quantity` });
  }
  for (const c of state.capacities) checkRecord(c.id, 'capacity', [c.entityId], c.value);
  for (const d of state.dependencies) checkRecord(d.id, 'dependency', [d.fromEntityId, d.toEntityId]);
  for (const ev of state.events) {
    checkRecord(ev.id, 'event', ev.entityId ? [ev.entityId] : []);
    if (ev.announcedAt && ev.announcedAt > ev.start) {
      issues.push({ severity: 'error', message: `Event ${ev.id} has announcedAt after start — an announcement cannot postdate the occurrence it announces` });
    }
  }

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
    // Gross-mass kilotonnes: the MAGNITUDE parses identically — what makes
    // it gross is the record's `basis`, which the graph's conversion
    // firewall governs (corridor grade / stage constant / visible refusal).
    // Refusing the unit here would double-encode basis in the unit string
    // and make gross flows unconvertible even when a grade exists.
    case 'kt gross/y': return value;
    case 'Mt/y': return value * 1000;
    case 't/y': return value / 1000;
    default: return null;
  }
}
