// src/lib/economy/freightWorld.ts
//
// A SIMULATED FREIGHT WORLD, generated against the real engine's vocabulary.
//
// This exists because `freightFixture.ts` is nine hand-built loads — enough to
// pin every refusal, too few for any statistic. This is the population version:
// hundreds of loads with signals PLANTED in them, so the analytics have
// something true to find. A fixture of uniform noise proves the code runs; a
// fixture containing a carrier who persistently underquotes proves the
// divergence engine FINDS HIM.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE PROPERTIES THIS FILE ENFORCES, EACH BECAUSE THE ABSENCE WAS MEASURED
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. EVERY TRANSITION IS A REAL TRANSITION. A generator free to invent state
//    names produces chains that walk cleanly and mean nothing. Measured on the
//    predecessor design: 5,570 transitions, reported "zero illegal", of which
//    4,392 (78.9%) named a state absent from `LoadState` and would have been
//    refused by `TRANSITIONS` at the first hop. `booked → assigned` is not a
//    transition this lifecycle has. The generator now emits `LoadState` and
//    asserts `isLegalTransition` on every hop as it builds, so the claim
//    "every chain legal" is about the engine or it does not appear.
//
//    Two consequences of using the real table, both corrections to the model:
//    a QUOTE is not a lifecycle state (there is no load yet), and INVOICING is
//    not one either (`delivered` is terminal — billing is a fact about the
//    load, not a position of it). Both are carried as fields.
//
// 2. AN IDENTITY IS ALLOCATED ONCE, NEVER RENAMED. Measured on the predecessor:
//    the underquoting carrier was created at index 11 (`CX-012`) and then
//    assigned the id `CX-014`, which index 13 already held. 18 carriers, 17
//    distinct ids, `CX-012` issued to nobody. The divergence scan then reported
//    its top offender as `CX-014, n=61, +11.5%` — a MERGED POPULATION of two
//    carriers with biases −0.110 and −0.004, roughly twice any other carrier's
//    load count. The number was plausible, so it shipped and got quoted.
//
// 3. A PLANT BINDS TO A LOAD THAT EXISTS, OR THE WORLD REFUSES TO BE BUILT.
//    Measured on the predecessor: plants named load ids literally (`L-0501`)
//    and fell back to `loads[500]` when absent, clamped to the last index.
//    Across 16 seeds, 3 silently misbound; at seed 8 both the double-brokering
//    plant and the telemetry-gap plant landed on the SAME load, `L-0520`, and
//    a runner checking "is this flag present anywhere" would have reported both
//    found. The fallback was described in a comment as already fixed. It was
//    not fixed; it merely did not fire at the seed that was run.
//
//    Plants now SELECT from the loads that exist, `bindPlant` throws when no
//    candidate qualifies, and each plant records the id it actually landed on
//    so a runner checks `boundTo` rather than a string it was told to expect.
//
// Everything here is stamped `representative`, so `isAdmissible` is false at
// every derivation. That is not caution, it is the product: a system whose
// value is knowing what it knows cannot hold a fixture that reads as real.

import type { Attestation } from './attestation';
import { attestationOf } from './attestation';
import type { LoadState, Transition } from './lifecycle.types';
import { isLegalTransition } from './lifecycle';
import type { Reading } from './notary';
import { toMilli } from './notary.types';

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mulberry32. Same seed, same world, byte for byte.
 *
 * The predecessor's header claimed byte-identical output and its `meta` read
 * `generatedAt: new Date().toISOString()`. Measured: two calls at one seed
 * differed in exactly that field and nowhere else. A generator that reads a
 * clock is not reproducible evidence, and this is the fourth place in this
 * programme where an engine read a clock — so `generatedAt` is a REQUIRED
 * PARAMETER here. There is no default that could hide the omission.
 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const between = (r: () => number, lo: number, hi: number) => lo + r() * (hi - lo);
const intBetween = (r: () => number, lo: number, hi: number) => Math.floor(between(r, lo, hi + 1));
/**
 * Whole seconds, always.
 *
 * `canonicalAt` refuses sub-second precision because the circuit encodes `at`
 * as u64 SECONDS, and a reference that hashes milliseconds produces a root the
 * circuit can never reproduce. Found by running the notary over this world:
 * the generator emitted millisecond instants and every commitment was refused
 * at ingest. Rounding here, at the source, is what the refusal asks for — a TMS
 * does not know the millisecond a truck arrived either.
 */
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;
const iso = (ms: number) => new Date(sec(ms)).toISOString();

const DAY = 86_400_000, HOUR = 3_600_000, MIN = 60_000;

// ─────────────────────────────────────────────────────────────────────────────
// Attestation — one class, applied at the boundary
// ─────────────────────────────────────────────────────────────────────────────

/** Generated, not observed. `isAdmissible` is false for anything downstream. */
export function worldAttestation(note: string): Attestation {
  return attestationOf('representative', 'low', 'unknown', note);
}

// ─────────────────────────────────────────────────────────────────────────────
// Geography — real city coordinates, synthetic facilities
// ─────────────────────────────────────────────────────────────────────────────

export const CITIES = [
  { code: 'TOR', name: 'Toronto', country: 'CA', lon: -79.383, lat: 43.653 },
  { code: 'MIS', name: 'Mississauga', country: 'CA', lon: -79.658, lat: 43.589 },
  { code: 'HAM', name: 'Hamilton', country: 'CA', lon: -79.866, lat: 43.256 },
  { code: 'WIN', name: 'Windsor', country: 'CA', lon: -83.017, lat: 42.317 },
  { code: 'MTL', name: 'Montreal', country: 'CA', lon: -73.568, lat: 45.502 },
  { code: 'DET', name: 'Detroit', country: 'US', lon: -83.046, lat: 42.331 },
  { code: 'CHI', name: 'Chicago', country: 'US', lon: -87.630, lat: 41.878 },
  { code: 'CLE', name: 'Cleveland', country: 'US', lon: -81.694, lat: 41.499 },
  { code: 'BUF', name: 'Buffalo', country: 'US', lon: -78.878, lat: 42.886 },
] as const;

export function haversineKm(a: { lon: number; lat: number }, b: { lon: number; lat: number }): number {
  const R = 6371, rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export const EQUIPMENT = ['van_53', 'reefer_53', 'flatbed_48', 'stepdeck_48'] as const;
export const COMMODITY = ['auto_parts', 'packaged_food', 'pharma', 'building_materials', 'consumer_goods', 'machinery'] as const;
export type Equipment = typeof EQUIPMENT[number];
export type Commodity = typeof COMMODITY[number];

// ─────────────────────────────────────────────────────────────────────────────
// Entities
// ─────────────────────────────────────────────────────────────────────────────

export interface WorldFacility {
  facilityId: string;
  name: string;
  addressRaw: string;
  cityCode: string;
  lon: number; lat: number;
  role: 'shipper' | 'receiver' | 'both';
  /** 0..1. PLANTED low on the slipping receiver. */
  appointmentReliability: number;
  freeTimeMinutes: number;
}

export interface WorldCarrier {
  carrierId: string;
  name: string;
  dot: string; mc: string;
  /** Negative = quotes under market, then invoices back up. PLANTED on one. */
  quoteBiasPct: number;
  onTimePickup: number;
  insuranceExpiresAt: string;
  authorityGrantedAt: string;
  /**
   * Cargo cover limit. `null` on some carriers ON PURPOSE: the cover check has
   * to reach `undetermined` from a real absence, not only from a fixture where
   * every record happens to be missing. Measured on the first run: cover was
   * null for every carrier, so 428 of 520 loads returned `undetermined` on that
   * one check and it never once cleared or refused — a check whose effective
   * range was a single value.
   */
  cargoCoverAmount: { amount: number; currency: 'CAD' } | null;
}

export interface WorldShipper {
  shipperId: string; name: string;
  paymentTermsDays: number;
  creditRating: 'A' | 'B' | 'C';
}

export interface WorldLane {
  laneId: string; origin: string; dest: string;
  distanceKm: number; crossBorder: boolean;
}

export interface WorldLoad {
  loadId: string;
  laneId: string;
  shipperId: string;
  carrierId: string;
  originFacilityId: string;
  destFacilityId: string;
  equipment: Equipment;
  commodity: Commodity;
  declaredValue: { amount: number; currency: 'CAD' } | null;

  // COMMITTED
  quotedToShipper: number;
  quotedBasis: 'all_in' | 'linehaul_plus_fsc';
  carrierRate: number;
  promisedPickupAt: string;
  promisedDeliveryAt: string;
  estimatedTransitHours: number;

  // OBSERVED
  actualPickupAt: string;
  actualDeliveryAt: string;
  invoicedToShipper: number;
  carrierInvoice: number;
  accessorialsBilled: number;
  detentionMinutes: number;
  /** Minutes held at the border. Zero on a domestic lane; part of transit, not dwell. */
  borderWaitMinutes: number;
  /**
   * NOT a lifecycle state. `delivered` is terminal in `TRANSITIONS`; billing is
   * a fact ABOUT the load, not a position OF it. The predecessor emitted
   * `delivered → invoiced` as a transition, which the real table refuses.
   */
  invoicedAt: string;

  transitions: Transition[];

  // Notary material — present only where the contract would require it.
  readings: Reading[] | null;
  commitmentPostedAt: string | null;
  handoffs: Array<{ at: string; fromParty: string; toParty: string; signed: boolean }> | null;

  /** The carrier named on the bill of lading. Differs under the double-brokering plant. */
  bolCarrierId: string;
  flags: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Plants — declared, then BOUND, and the binding is recorded
// ─────────────────────────────────────────────────────────────────────────────

export type PlantId =
  | 'PLANT-1' | 'PLANT-2' | 'PLANT-3' | 'PLANT-4' | 'PLANT-5'
  | 'PLANT-6' | 'PLANT-7' | 'PLANT-8' | 'PLANT-9';

export interface PlantRecord {
  id: PlantId;
  description: string;
  /**
   * WHAT IT LANDED ON, not what it was advertised to land on.
   *
   * A runner must check its detector against this, never against a load id
   * written into a report. The predecessor advertised ids and fell back
   * silently when they were absent; a runner comparing against the advertisement
   * reported plants found that were not there.
   */
  boundTo: string[];
  /** How a detector should expect to see it. */
  expect: string;
}

export const PLANT_NOT_BOUND = 'PLANT_NOT_BOUND';

export class PlantNotBound extends Error {
  readonly code = PLANT_NOT_BOUND;
  constructor(plant: PlantId, criterion: string, poolSize: number) {
    super(
      `${PLANT_NOT_BOUND}: ${plant} found no load matching "${criterion}" among ${poolSize} ` +
      'candidates, so the world it would produce contains a signal the manifest claims is ' +
      'present. Widen the criterion or raise loadCount — a plant that cannot bind must stop ' +
      'the build, because a fixture that silently lacks its own planted signal makes every ' +
      'detector run over it look like a pass.',
    );
    this.name = 'PlantNotBound';
  }
}

/** Deterministic selection: the first load satisfying `where`, or refuse. */
function bindPlant(
  plant: PlantId, loads: readonly WorldLoad[], criterion: string,
  where: (l: WorldLoad) => boolean,
): WorldLoad {
  const hit = loads.find(where);
  if (!hit) throw new PlantNotBound(plant, criterion, loads.length);
  return hit;
}

// ─────────────────────────────────────────────────────────────────────────────
// The world
// ─────────────────────────────────────────────────────────────────────────────

/** The receiver the appointment-slippage plant lives at. Fixed city, so lanes stay coherent. */
export const SLIPPING_RECEIVER_CITY = 'DET';
/**
 * The lane the seasonality plant lives on.
 *
 * IT ENDS AT THE SLIPPING RECEIVER'S CITY ON PURPOSE. A first version put the
 * seasonal plant on a clean lane, and the run showed BOTH the naive
 * calendar-quarter mean and the plant-basis median recovering it — a fixture
 * that cannot separate a sound estimator from an unsound one, and therefore
 * cannot demonstrate the failure it was built to demonstrate. The confound is
 * the point; what the predecessor got wrong was manufacturing it by delivering
 * loads to a facility in the wrong city, not by having it at all.
 */
export const SEASONAL_LANE = 'TOR-DET';
/**
 * Months the seasonality plant fires in, by `promisedPickupAt`. December and
 * January.
 *
 * TWO MONTHS, AND THE COUNT IS STRUCTURAL RATHER THAN TUNED.
 *
 * At four months (Dec-Mar) the demonstration was luck: Q1 held ALL THREE of
 * Jan/Feb/Mar, so it was always far above the summer quarters, and whether the
 * naive calendar-quarter read failed came down to Q4's draw — which held only
 * December. Swept across 16 worlds the headline finding held in **7**. A fixture
 * that demonstrates its own point 44% of the time demonstrates nothing; it is
 * the single-world claim this whole file exists to refuse, made by me.
 *
 * The property that makes the demonstration reliable is not a magic number, it
 * is this: NO CALENDAR QUARTER IS MAJORITY IN-SEASON. December sits in Q4 and
 * January in Q1, so each winter quarter is one month of three, both are diluted
 * the same way, and neither reliably clears a summer quarter. `freightWorld.
 * test.ts` pins that property against the constants directly, so it cannot be
 * lost by editing this array — which is the difference between a structural
 * guarantee and a tuning that happened to work.
 *
 * It is also the more realistic case. A winter peak is weeks, not a third of a
 * year, and the reason a quarterly mean misses it in real freight data is
 * exactly this mismatch of scale.
 */
export const SEASONAL_MONTHS: readonly number[] = [11, 0];

/**
 * REPORTING FLOORS, shared by the generator and the analysis.
 *
 * One number, in one place, because a generator that guarantees 12 loads and an
 * analysis that requires 15 produce a world whose planted signal is present and
 * invisible — and the run reports it as a detector failure.
 */
export const MIN_FACILITY_N = 15;
export const MIN_LANE_N = 60;
export const MIN_SEASON_CELL_N = 12;

/**
 * ONE WINTER IS NOT SEASONALITY.
 *
 * The sharper question, reached by fixing the thin-cell one. With a 12-month
 * window the in-season cell is a SINGLE CONTIGUOUS BLOCK of calendar time, so a
 * one-off — a strike, a construction closure, one bad month at one receiver — is
 * indistinguishable from a seasonal term. Every statistic still computes; the
 * medians separate; the finding reads as recovered. What cannot be established
 * from one winter is the thing the word "seasonal" asserts, which is RECURRENCE.
 *
 * So the world spans two winters and the analysis refuses below this count. It
 * is the same discipline as the posting window in the notary: a fact that a
 * measurement cannot establish is refused before the measurement, not argued
 * about after it.
 */
export const MIN_SEASONS_OBSERVED = 2;

/**
 * The largest share of the seasonal lane the confounding receiver may take.
 *
 * Above this it stops interfering with the seasonal measurement and starts
 * being it. Measured: at 74-80% the out-of-season median rose from 0 to
 * 202-274 minutes and the plant was unrecoverable on any basis.
 */
export const MAX_CONFOUND_SHARE = 0.6;

/**
 * The TARGET share of the slipping receiver's city inbound freight that goes to
 * it. A substantial minority: clearly a confound, clearly not the lane itself.
 */
export const CONFOUND_SHARE = 0.4;

export interface WorldOptions {
  seed?: number;
  loadCount?: number;
  /** REQUIRED. This generator holds no clock. */
  generatedAt: string;
  /** Start of the booking window. */
  windowStart?: string;
  /** Length of the booking window in days. Must span MIN_SEASONS_OBSERVED winters. */
  windowDays?: number;
}

export interface FreightWorld {
  meta: {
    worldId: string;
    seed: number;
    generatedAt: string;
    windowStart: string;
    attestation: Attestation;
    disclaimer: string;
    plants: PlantRecord[];
    /** Loads requested vs produced. A drop is accounted for, never inferred. */
    loadsRequested: number;
    loadsProduced: number;
    loadsDroppedNoFacility: number;
  };
  facilities: WorldFacility[];
  carriers: WorldCarrier[];
  shippers: WorldShipper[];
  lanes: WorldLane[];
  loads: WorldLoad[];
}

/** The underquoting carrier, by the id it is ALLOCATED — never renamed onto another's. */
export const UNDERQUOTE_CARRIER_INDEX = 11;
/** The carrier whose cargo insurance lapses inside the window. */
export const LAPSED_INSURANCE_CARRIER_INDEX = 6;

const CARRIER_NAMES = [
  'Northbridge', 'Lakeshore', 'Pinewood', 'Ironline', 'Cedar Valley', 'Grand River',
  'Bluewater', 'Rockcliff', 'Harborview', 'Silverbirch', 'Trilliumway', 'Meridian',
  'Copperfield', 'Eastgate', 'Foxrun', 'Halton', 'Kingsway', 'Maplecrest',
] as const;

const SHIPPER_NAMES = [
  'Halcyon Foods', 'Verity Auto Systems', 'Cobalt Pharma', 'Ridgeline Building Supply',
  'Northstar Consumer', 'Ardent Machinery', 'Bellwether Retail',
] as const;

/** A lane spine, because a real book concentrates. Uniform lanes leave every lane too thin to read. */
const SPINE = ['TOR-DET', 'TOR-MTL', 'MIS-CHI', 'HAM-BUF', 'WIN-DET', 'TOR-CHI'] as const;

export function makeFreightWorld(opts: WorldOptions): FreightWorld {
  const seed = opts.seed ?? 20260831;
  // 900 over 24 months. The in-season fraction is fixed at 2/12 by the plant, so
  // a longer window alone does NOT thicken the cell — only more loads do. Both
  // are needed and for different reasons: the count for n, the span for
  // recurrence.
  const loadCount = opts.loadCount ?? 900;
  const windowStart = opts.windowStart ?? '2024-09-01T00:00:00.000Z';
  const windowDays = opts.windowDays ?? 720;
  const t0 = Date.parse(windowStart);
  if (!Number.isFinite(t0)) throw new Error(`freightWorld: unparseable windowStart ${windowStart}`);
  if (!Number.isFinite(Date.parse(opts.generatedAt))) {
    throw new Error(`freightWorld: unparseable generatedAt ${opts.generatedAt}`);
  }
  const r = rng(seed);

  // ── facilities ────────────────────────────────────────────────────────────
  const facilities: WorldFacility[] = [];
  const facId = () => `FAC-${String(facilities.length + 1).padStart(3, '0')}`;
  for (const c of CITIES) {
    const n = intBetween(r, 3, 5);
    for (let i = 0; i < n; i++) {
      facilities.push({
        facilityId: facId(),
        name: `${c.name} ${pick(r, ['Distribution', 'Logistics Centre', 'Terminal', 'Warehouse', 'Cross-dock'])} ${i + 1}`,
        addressRaw: `${intBetween(r, 100, 9999)} ${pick(r, ['Industrial', 'Commerce', 'Airport', 'Rail', 'Harbour'])} ${pick(r, ['Dr', 'Drive', 'Rd', 'Road', 'Blvd'])}`,
        cityCode: c.code,
        lon: c.lon + between(r, -0.08, 0.08),
        lat: c.lat + between(r, -0.06, 0.06),
        role: pick(r, ['shipper', 'receiver', 'both'] as const),
        appointmentReliability: between(r, 0.82, 0.97),
        freeTimeMinutes: pick(r, [90, 120, 120, 180]),
      });
    }
  }

  // EVERY CITY CAN BOTH SHIP AND RECEIVE.
  //
  // Roles were drawn independently per facility, so a city could come out with
  // no shipper-capable or no receiver-capable facility and every lane through it
  // would be unservable. Measured at seed 20260101: the seasonal lane carried
  // ZERO loads, and PLANT-8 was advertised in the manifest while absent from the
  // world — the same defect this file was written to close, reached through a
  // door the load-bound `bindPlant` check does not cover.
  //
  // Forcing coverage is not tuning: a city in a real book has both ends. The
  // population assertions below are kept anyway, because "guaranteed by
  // construction" is a claim that rots the moment the construction changes.
  for (const c of CITIES) {
    const here = facilities.filter(f => f.cityCode === c.code);
    if (!here.some(f => f.role !== 'receiver')) here[0].role = 'both';
    if (!here.some(f => f.role !== 'shipper')) here[here.length - 1].role = 'both';
  }

  // PLANT-2 — chronic appointment slippage, at a receiver in ONE city.
  //
  // The predecessor selected the first non-shipper facility anywhere and then
  // routed 16% of ALL loads to it regardless of lane. Measured: 75 of 488 loads
  // delivered to a facility outside their lane's destination city, and the
  // slipping receiver appeared on 29 distinct lanes including Chicago→Cleveland.
  // That is what manufactured the PLANT-2/PLANT-8 confound its report treated as
  // inherent. Here the receiver has a city and only receives what is bound there.
  const slipping = facilities.find(f => f.cityCode === SLIPPING_RECEIVER_CITY && f.role !== 'shipper');
  if (!slipping) throw new PlantNotBound('PLANT-2', `receiver in ${SLIPPING_RECEIVER_CITY}`, facilities.length);
  slipping.appointmentReliability = 0.41;
  slipping.name = 'Brant Distribution';

  // PLANT-3 — one physical yard, two address spellings. Ids allocated, not renamed.
  const dupCity = CITIES[1];
  const dupA = facId();
  facilities.push({
    facilityId: dupA, name: 'Northline Freight Yard', addressRaw: '4820 Industrial Dr',
    cityCode: dupCity.code, lon: dupCity.lon + 0.02, lat: dupCity.lat + 0.01,
    role: 'both', appointmentReliability: 0.9, freeTimeMinutes: 120,
  });
  const dupB = facId();
  facilities.push({
    facilityId: dupB, name: 'Northline Freight Yard Unit 4', addressRaw: '4820 INDUSTRIAL DRIVE UNIT 4',
    cityCode: dupCity.code, lon: dupCity.lon + 0.0201, lat: dupCity.lat + 0.0101,
    role: 'both', appointmentReliability: 0.9, freeTimeMinutes: 120,
  });

  // ── carriers ──────────────────────────────────────────────────────────────
  const carriers: WorldCarrier[] = CARRIER_NAMES.map((n, i) => ({
    carrierId: `CX-${String(i + 1).padStart(3, '0')}`,
    name: `${n} Transport`,
    dot: String(intBetween(r, 1_000_000, 3_999_999)),
    mc: String(intBetween(r, 200_000, 999_999)),
    quoteBiasPct: between(r, -0.02, 0.02),
    onTimePickup: between(r, 0.86, 0.98),
    insuranceExpiresAt: iso(t0 + between(r, 300, 500) * DAY),
    authorityGrantedAt: iso(t0 - between(r, 400, 3000) * DAY),
    // ~1 in 6 carriers has no certificate on file; the rest carry the standard
    // 100k limit, and a few carry only 50k so a high-value load can exceed it.
    cargoCoverAmount: r() < 0.17
      ? null
      : { amount: r() < 0.25 ? 50_000 : 100_000, currency: 'CAD' as const },
  }));
  // The plants take the carriers AT THEIR OWN INDEX and keep the id already
  // allocated there. No rename, so no collision is constructible.
  const underquoter = carriers[UNDERQUOTE_CARRIER_INDEX];
  underquoter.quoteBiasPct = -0.11;
  const lapsed = carriers[LAPSED_INSURANCE_CARRIER_INDEX];
  lapsed.insuranceExpiresAt = iso(t0 + 210 * DAY);
  {
    const ids = carriers.map(c => c.carrierId);
    if (new Set(ids).size !== ids.length) {
      throw new Error(
        'freightWorld: duplicate carrierId. An identity assigned twice merges two populations ' +
        'into one row, and a per-carrier statistic over it is a number about nobody.',
      );
    }
  }

  // ── shippers ──────────────────────────────────────────────────────────────
  const shippers: WorldShipper[] = SHIPPER_NAMES.map((n, i) => ({
    shipperId: `SH-${String(i + 1).padStart(3, '0')}`,
    name: n,
    paymentTermsDays: pick(r, [30, 30, 45, 60]),
    creditRating: pick(r, ['A', 'A', 'B', 'B', 'C'] as const),
  }));

  // ── lanes ─────────────────────────────────────────────────────────────────
  const lanes: WorldLane[] = [];
  for (const a of CITIES) for (const b of CITIES) {
    if (a.code === b.code) continue;
    const km = haversineKm(a, b);
    if (km < 60 || km > 950) continue;
    lanes.push({
      laneId: `${a.code}-${b.code}`, origin: a.code, dest: b.code,
      distanceKm: Math.round(km * 1.18), crossBorder: a.country !== b.country,
    });
  }
  // A lane only exists if both ends can actually be served. Filtering here rather
  // than dropping loads later keeps `loadsProduced` equal to `loadsRequested`
  // instead of leaving a silent shortfall for a reader to notice or not.
  const servable = lanes.filter(l =>
    facilities.some(f => f.cityCode === l.origin && f.role !== 'receiver') &&
    facilities.some(f => f.cityCode === l.dest && f.role !== 'shipper'));
  const spineLanes = servable.filter(l => (SPINE as readonly string[]).includes(l.laneId));
  if (!servable.length) throw new Error('freightWorld: no servable lane — every load would drop');

  // ── loads ─────────────────────────────────────────────────────────────────
  const loads: WorldLoad[] = [];
  let dropped = 0;

  for (let n = 1; n <= loadCount; n++) {
    const loadId = `L-${String(n).padStart(4, '0')}`;
    const lane = (r() < 0.62 && spineLanes.length) ? pick(r, spineLanes) : pick(r, servable);
    const origins = facilities.filter(f => f.cityCode === lane.origin && f.role !== 'receiver');
    const dests = facilities.filter(f => f.cityCode === lane.dest && f.role !== 'shipper');
    if (!origins.length || !dests.length) { dropped++; continue; }

    const originF = pick(r, origins);
    // PLANT-2 lives in ONE city and only takes freight bound there.
    // A CONFOUND INTERFERES WITH A MEASUREMENT; SOMETHING THAT CONSTITUTES IT IS
    // NOT A CONFOUND, IT IS THE SIGNAL.
    //
    // At a 0.55 forcing probability the slipping receiver took 74-80% of the
    // seasonal lane, and its 240-900 minute appointment slips are LARGER THAN
    // THE ENTIRE SEASONAL TERM (120-260). Measured: wherever its share reached
    // 74% the out-of-season median rose from 0 to 202-274 min and the plant was
    // unrecoverable on any basis.
    //
    // AND THE PARAMETER WAS DENOMINATED WRONG, which is why lowering it to 0.35
    // still produced 62-75%. It set a PROBABILITY OF FORCING, and the receiver
    // then also won its share of the ordinary draw among DET's receivers:
    // 0.35 + 0.65/3 ~= 0.57. The number was plausible and it measured something
    // other than what its name said — the same failure the materiality gate
    // exists to catch, in the generator.
    //
    // Drawing from the OTHERS on the complement makes the constant a TARGET
    // SHARE, so it means what it is named. The ceiling below is kept anyway.
    const others = dests.filter(f => f.facilityId !== slipping.facilityId);
    const destF = (lane.dest === SLIPPING_RECEIVER_CITY && others.length)
      ? (r() < CONFOUND_SHARE ? slipping : pick(r, others))
      : pick(r, dests);

    const shipper = pick(r, shippers);
    const carrier = pick(r, carriers);
    const equipment = pick(r, EQUIPMENT);
    const commodity = pick(r, COMMODITY);

    const bookedAt = sec(t0 + between(r, 0, windowDays) * DAY);
    const estimatedTransitHours = Math.round(lane.distanceKm / 82 + (lane.crossBorder ? 2.5 : 0.5));
    const promisedPickupAt = sec(bookedAt + between(r, 12, 72) * HOUR);
    const promisedDeliveryAt = sec(promisedPickupAt + estimatedTransitHours * HOUR + between(r, 2, 10) * HOUR);

    // PLANT-8 — seasonal detention, keyed on the month of PROMISED PICKUP.
    // The plant's own partition is recorded (`SEASONAL_MONTHS`) so an analysis can
    // be run on the plant's basis and on a naive calendar-quarter basis and the
    // difference measured, rather than a quarter being assumed to be the season.
    const pickupMonth = new Date(promisedPickupAt).getUTCMonth();
    const inSeason = SEASONAL_MONTHS.includes(pickupMonth);
    const seasonalDetention = lane.laneId === SEASONAL_LANE && inSeason ? between(r, 120, 260) : 0;

    // Detention is BIMODAL: near zero, or a blown appointment. That is what real
    // detention looks like, and it is why a MEAN over it is the wrong estimator.
    const apptSlip = r() > destF.appointmentReliability ? between(r, 240, 900) : between(r, -15, 20);
    const detention = Math.round(Math.max(0, apptSlip - destF.freeTimeMinutes / 2 + seasonalDetention));
    const unloadMinutes = intBetween(r, 35, 95);

    const pickupLate = r() > carrier.onTimePickup ? between(r, 20, 240) : between(r, -20, 15);
    const actualPickupAt = sec(promisedPickupAt + pickupLate * MIN);
    // A border wait DELAYS ARRIVAL. Found by the monotonicity guard below on the
    // first run: arrival was a flat estimate that did not include the crossing,
    // so on a short cross-border lane the truck re-entered transit AFTER it had
    // already been recorded at the destination. The predecessor design had the
    // same inconsistency and no guard, so it shipped as a clean chain.
    const borderWaitMinutes = lane.crossBorder ? between(r, 20, 180) : 0;
    const arrivalAt = sec(actualPickupAt + estimatedTransitHours * HOUR
      + borderWaitMinutes * MIN + between(r, -30, 90) * MIN);
    const actualDeliveryAt = sec(arrivalAt + (detention + unloadMinutes) * MIN);

    // economics
    const baseRatePerKm = between(r, 1.55, 2.35) / 1.609;
    const marketCarrier = Math.round(lane.distanceKm * baseRatePerKm + between(r, 60, 220));
    const carrierRate = Math.round(marketCarrier * (1 + carrier.quoteBiasPct));
    const targetMargin = between(r, 0.11, 0.19);
    const quotedToShipper = Math.round(carrierRate / (1 - targetMargin));
    // PLANT-1 — the underquoter's invoice drifts back up to market.
    const isUnderquoter = carrier.carrierId === underquoter.carrierId;
    const carrierInvoice = Math.round(carrierRate * (isUnderquoter ? between(r, 1.08, 1.16) : between(r, 0.99, 1.03)));
    const accessorialsBilled = Math.round(detention > 60 ? (detention - 60) * between(r, 0.9, 1.6) : 0);
    const invoicedToShipper = Math.round(quotedToShipper + (r() < 0.22 ? accessorialsBilled * between(r, 0.4, 1.0) : 0));

    const declaredValue = commodity === 'pharma' || r() < 0.14
      ? { amount: Math.round(between(r, 35_000, 240_000)), currency: 'CAD' as const }
      : (r() < 0.75 ? { amount: Math.round(between(r, 4_000, 40_000)), currency: 'CAD' as const } : null);

    // ── the lifecycle, in the REAL vocabulary ──────────────────────────────
    //
    // `occurredAtBasis` is not decoration. A geofence crossing is OUR
    // reconstruction of when the truck arrived, so `detectionLatencySeconds`
    // returns null for it — a latency computed over a mix of observed and
    // inferred instants is a distribution over two different quantities.
    const chain: Array<[LoadState | null, LoadState, number, 'observed' | 'inferred', number, string]> = [
      [null, 'booked', bookedAt, 'observed', 5, 'operator'],
      ['booked', 'tendered', bookedAt + 2 * HOUR, 'observed', 5, 'operator'],
      ['tendered', 'accepted', bookedAt + 3 * HOUR, 'observed', intBetween(r, 5, 40), `carrier:${carrier.carrierId}`],
      ['accepted', 'dispatched', actualPickupAt - 4 * HOUR, 'observed', intBetween(r, 10, 90), `carrier:${carrier.carrierId}`],
      ['dispatched', 'at_origin', actualPickupAt - 25 * MIN, 'inferred', intBetween(r, 5, 45), 'geofence'],
      ['at_origin', 'loading', actualPickupAt, 'observed', intBetween(r, 10, 60), 'document:bol'],
      ['loading', 'loaded', actualPickupAt + 25 * MIN, 'observed', intBetween(r, 10, 60), 'document:bol'],
      ['loaded', 'in_transit', actualPickupAt + 35 * MIN, 'inferred', intBetween(r, 5, 50), 'geofence'],
      ...(lane.crossBorder
        ? ([
            ['in_transit', 'at_border', actualPickupAt + estimatedTransitHours * HOUR * 0.45, 'inferred', intBetween(r, 10, 70), 'geofence'],
            ['at_border', 'in_transit', actualPickupAt + estimatedTransitHours * HOUR * 0.45 + borderWaitMinutes * MIN, 'inferred', intBetween(r, 10, 70), 'geofence'],
          ] as typeof chain)
        : []),
      ['in_transit', 'at_destination', arrivalAt, 'inferred', intBetween(r, 5, 45), 'geofence'],
      ['at_destination', 'unloading', arrivalAt + detention * MIN, 'observed', intBetween(r, 10, 60), 'document:pod'],
      ['unloading', 'delivered', actualDeliveryAt, 'observed', intBetween(r, 15, 120), 'document:pod'],
    ];

    const transitions: Transition[] = [];
    let prevAt = -Infinity;
    for (const [from, to, at, basis, lagMin, reportedBy] of chain) {
      // THE ASSERTION THAT MAKES "EVERY CHAIN LEGAL" A CLAIM ABOUT THE ENGINE.
      // Checked as it is BUILT, so an illegal hop cannot reach a fixture and be
      // walked cleanly by a runner using a private table.
      if (from !== null && !isLegalTransition(from, to)) {
        throw new Error(
          `freightWorld: ${loadId} would emit ${from} → ${to}, which TRANSITIONS refuses. ` +
          'The generator does not get its own state machine.',
        );
      }
      if (at < prevAt) {
        throw new Error(
          `freightWorld: ${loadId} emits ${to} at ${iso(at)}, before its predecessor. ` +
          'A non-monotonic chain breaks the notary ordering obligation and every dwell it derives.',
        );
      }
      prevAt = at;
      transitions.push({
        loadId, from, to,
        occurredAt: iso(at), occurredAtBasis: basis,
        firstReportedAt: iso(at + lagMin * MIN),
        reportedBy,
      });
    }

    // ── notary material ───────────────────────────────────────────────────
    let readings: Reading[] | null = null;
    let commitmentPostedAt: string | null = null;
    let handoffs: WorldLoad['handoffs'] = null;
    const notarized = equipment === 'reefer_53' || (declaredValue?.amount ?? 0) >= 50_000;
    if (notarized) {
      readings = [];
      for (let ts = actualPickupAt; ts <= actualDeliveryAt; ts += 10 * MIN) {
        // One decimal, converted through the real ingest guard.
        readings.push({
          at: iso(ts), channel: 'temperature_c',
          valueMilli: toMilli(Math.round(between(r, 3.4, 6.2) * 10) / 10),
          deviceId: `PROBE-${carrier.carrierId}`,
        });
      }
      commitmentPostedAt = iso(actualDeliveryAt + between(r, 2, 12) * MIN);
      handoffs = [
        { at: iso(actualPickupAt), fromParty: shipper.shipperId, toParty: carrier.carrierId, signed: true },
        { at: iso(actualDeliveryAt), fromParty: carrier.carrierId, toParty: destF.facilityId, signed: r() > 0.06 },
      ];
    }

    loads.push({
      loadId, laneId: lane.laneId, shipperId: shipper.shipperId, carrierId: carrier.carrierId,
      originFacilityId: originF.facilityId, destFacilityId: destF.facilityId,
      equipment, commodity, declaredValue,
      quotedToShipper, quotedBasis: r() < 0.7 ? 'all_in' : 'linehaul_plus_fsc',
      carrierRate,
      promisedPickupAt: iso(promisedPickupAt), promisedDeliveryAt: iso(promisedDeliveryAt),
      estimatedTransitHours,
      actualPickupAt: iso(actualPickupAt), actualDeliveryAt: iso(actualDeliveryAt),
      invoicedToShipper, carrierInvoice, accessorialsBilled,
      detentionMinutes: detention,
      borderWaitMinutes: Math.round(borderWaitMinutes),
      invoicedAt: iso(actualDeliveryAt + between(r, 4, 48) * HOUR),
      transitions, readings, commitmentPostedAt, handoffs,
      bolCarrierId: carrier.carrierId, flags: [],
    });
  }

  // ── plants that need a specific load: SELECT, never assert ────────────────
  const taken = new Set<string>();
  const free = (l: WorldLoad) => !taken.has(l.loadId);

  // PLANT-5 — the bill of lading names a carrier we did not tender to.
  const p5 = bindPlant('PLANT-5', loads, 'any load', free);
  taken.add(p5.loadId);
  p5.bolCarrierId = carriers.find(c => c.carrierId !== p5.carrierId)!.carrierId;
  p5.flags.push('bol_carrier_mismatch');

  // PLANT-4 — a load moving under a carrier whose insurance lapses mid-window.
  const p4 = bindPlant(
    'PLANT-4', loads, `carried by ${lapsed.carrierId} after ${lapsed.insuranceExpiresAt}`,
    l => free(l) && l.carrierId === lapsed.carrierId &&
      Date.parse(l.actualPickupAt) > Date.parse(lapsed.insuranceExpiresAt));
  taken.add(p4.loadId);
  p4.flags.push('insurance_lapse_in_window');

  // PLANT-6 — a reefer excursion above 8.0 C.
  const p6 = bindPlant('PLANT-6', loads, 'notarized load with >= 20 readings',
    l => free(l) && l.readings !== null && l.readings.length >= 20);
  taken.add(p6.loadId);
  {
    const rs = p6.readings!;
    const mid = Math.floor(rs.length / 2);
    for (let k = mid; k < mid + 5; k++) rs[k] = { ...rs[k], valueMilli: toMilli(9.2 + k * 0.04) };
    p6.flags.push('reefer_excursion');
  }

  // PLANT-7 — a telemetry gap, so the condition is UNPROVABLE rather than held.
  const p7 = bindPlant('PLANT-7', loads, 'notarized load with >= 60 readings',
    l => free(l) && l.readings !== null && l.readings.length >= 60);
  taken.add(p7.loadId);
  {
    const rs = p7.readings!;
    const cut = Math.floor(rs.length * 0.4);
    p7.readings = [...rs.slice(0, cut), ...rs.slice(cut + 30)];   // 30 x 10min = 5h
    p7.flags.push('telemetry_gap');
  }

  // PLANT-9 — a commitment posted after the fact. Must never yield `held`.
  const p9 = bindPlant('PLANT-9', loads, 'notarized load with a commitment',
    l => free(l) && l.readings !== null && l.commitmentPostedAt !== null);
  taken.add(p9.loadId);
  p9.commitmentPostedAt = iso(Date.parse(p9.actualDeliveryAt) + 3 * DAY);
  p9.flags.push('commitment_retroactive');

  // STRUCTURAL PLANTS NEED A POPULATION TOO.
  //
  // `bindPlant` refuses when no LOAD qualifies. PLANT-2 and PLANT-8 bind to a
  // facility and a lane, so they passed that check while carrying no freight at
  // all. A plant the manifest advertises and the world does not contain makes
  // every detector run over it look like a failure of the detector.
  //
  // The floors are the reporting floors the analysis actually uses, so a plant
  // that binds is a plant the analysis can see — not merely one that exists.
  const seasonalLoads = loads.filter(l => l.laneId === SEASONAL_LANE);
  if (seasonalLoads.length < MIN_LANE_N) {
    throw new PlantNotBound('PLANT-8', `>= ${MIN_LANE_N} loads on lane ${SEASONAL_LANE}`, seasonalLoads.length);
  }
  for (const months of [SEASONAL_MONTHS, null] as const) {
    const sel = months
      ? seasonalLoads.filter(l => months.includes(new Date(l.promisedPickupAt).getUTCMonth()))
      : seasonalLoads.filter(l => !SEASONAL_MONTHS.includes(new Date(l.promisedPickupAt).getUTCMonth()));
    if (sel.length < MIN_SEASON_CELL_N) {
      throw new PlantNotBound(
        'PLANT-8', `>= ${MIN_SEASON_CELL_N} loads ${months ? 'in' : 'out of'} season on ${SEASONAL_LANE}`,
        seasonalLoads.length);
    }
  }
  {
    const inSeason = seasonalLoads.filter(l =>
      SEASONAL_MONTHS.includes(new Date(l.promisedPickupAt).getUTCMonth()));
    // A winter spans a year boundary, so December and the January after it are
    // ONE season. Key on the year the December belongs to.
    const seasons = new Set(inSeason.map(l => {
      const d = new Date(l.promisedPickupAt);
      return d.getUTCMonth() === 11 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    }));
    if (seasons.size < MIN_SEASONS_OBSERVED) {
      throw new PlantNotBound(
        'PLANT-8',
        `>= ${MIN_SEASONS_OBSERVED} distinct winters on ${SEASONAL_LANE} (found ${seasons.size})`,
        inSeason.length);
    }
  }

  {
    const onLane = seasonalLoads.filter(l => l.destFacilityId === slipping.facilityId).length;
    const share = seasonalLoads.length ? onLane / seasonalLoads.length : 0;
    if (share > MAX_CONFOUND_SHARE) {
      throw new PlantNotBound(
        'PLANT-8',
        `the confounding receiver takes ${(share * 100).toFixed(0)}% of ${SEASONAL_LANE}, above the ` +
        `${(MAX_CONFOUND_SHARE * 100).toFixed(0)}% ceiling — at that share it is not a confound, it is the lane`,
        seasonalLoads.length);
    }
  }

  const slippingLoads = loads.filter(l => l.destFacilityId === slipping.facilityId);
  if (slippingLoads.length < MIN_FACILITY_N) {
    throw new PlantNotBound(
      'PLANT-2', `>= ${MIN_FACILITY_N} loads into ${slipping.facilityId}`, slippingLoads.length);
  }

  const plants: PlantRecord[] = [
    { id: 'PLANT-1', description: 'carrier quotes ~11% under market, invoices back up',
      boundTo: [underquoter.carrierId],
      expect: 'top carrier by (invoice - quoted) / quoted' },
    { id: 'PLANT-2', description: 'receiver at 41% appointment reliability',
      boundTo: [slipping.facilityId],
      expect: 'worst receiver by late rate AND by detention — the two need not agree' },
    { id: 'PLANT-3', description: 'one physical yard under two address spellings',
      boundTo: [dupA, dupB],
      expect: 'same normalized address, metres apart' },
    { id: 'PLANT-4', description: 'cargo insurance lapses inside the window',
      boundTo: [lapsed.carrierId, p4.loadId],
      expect: 'vetting gate blocks' },
    { id: 'PLANT-5', description: 'BOL carrier differs from the tendered carrier',
      boundTo: [p5.loadId],
      expect: 'double-brokering surfaces' },
    { id: 'PLANT-6', description: 'reefer excursion above 8.0 C',
      boundTo: [p6.loadId],
      expect: 'notary verdict breached' },
    { id: 'PLANT-7', description: '5h telemetry gap',
      boundTo: [p7.loadId],
      expect: 'notary verdict unproven / coverage_gap — never held' },
    { id: 'PLANT-8', description: `seasonal detention on ${SEASONAL_LANE}, months ${SEASONAL_MONTHS.join(',')}`,
      boundTo: [SEASONAL_LANE],
      expect: 'recoverable on the plant’s partition and estimator; NOT on calendar-quarter means' },
    { id: 'PLANT-9', description: 'commitment posted 3 days after the fact',
      boundTo: [p9.loadId],
      expect: 'notary verdict unproven / posted after the fact — never held' },
  ];

  return {
    meta: {
      worldId: `freight-world-${seed}`,
      seed,
      generatedAt: opts.generatedAt,
      windowStart,
      attestation: worldAttestation('generated freight world; no record here was observed'),
      disclaimer:
        'SIMULATED. Facilities, carriers, shippers and loads are generated, not observed. ' +
        'City coordinates are real; everything else is synthetic. Every record is stamped ' +
        'representative, so isAdmissible() is false for anything derived from it. The signals ' +
        'are PLANTED so the analytics have something true to find, and each plant records the ' +
        'entity it actually bound to rather than one it was advertised to bind to.',
      plants,
      loadsRequested: loadCount,
      loadsProduced: loads.length,
      loadsDroppedNoFacility: dropped,
    },
    facilities, carriers, shippers, lanes: servable, loads,
  };
}
