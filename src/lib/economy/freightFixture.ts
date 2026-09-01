// src/lib/economy/freightFixture.ts
//
// A SIMULATED LOAD BOOK — enough freight to run the whole chain end to end.
//
// Every fixture in this tree carries PLANTED DEFECTS, because a fixture too
// clean to fail its own guards proves the guards run and nothing else. The
// Python side records adding a seventh plant after "disabling the requirement
// left the suite green". The plants here are listed by name so a reader can
// check each one is still reachable rather than trusting that it is.
//
//   PLANT 1  a load gone silent past its cadence          -> unobserved, not "in transit"
//   PLANT 2  a handoff signed by only one party            -> custody unproven
//   PLANT 3  a downstream load with an unknown contribution-> unassessed, never zero
//   PLANT 4  a downstream load with no appointment         -> breach null, not false
//   PLANT 5  a contribution in a foreign currency          -> the total refuses
//   PLANT 6  a reefer excursion past tolerance             -> condition breached
//   PLANT 7  an exception with evidence but no action      -> suppressed, and counted
//   PLANT 8  a truck over the modelled clearance           -> the restriction binds
//
// Coordinates are [lon, lat]. They are real places because a demo nobody can
// picture is a demo nobody checks, but the NETWORK is synthetic and every route
// over it is labelled SIMULATED at the point of use.

import type { Position, VehicleProfile } from '../spatial/engine.types';
import type { Transition } from './lifecycle.types';
import type { Money } from './lifecycle.types';
import { attestationOf } from './attestation';
import { toMilli } from './notary.types';
import { reading, type Reading, type Handoff } from './notary';

export const DEMO_NOW = '2026-08-31T18:00:00.000Z';

/* ── places ──────────────────────────────────────────────────────────────── */

export interface Place { id: string; name: string; at: Position }

export const PLACES: readonly Place[] = [
  { id: 'fac:toronto',  name: 'Toronto DC',     at: [-79.3832, 43.6532] },
  { id: 'fac:montreal', name: 'Montreal Depot', at: [-73.5673, 45.5019] },
  { id: 'fac:windsor',  name: 'Windsor Cross',  at: [-83.0364, 42.3149] },
  { id: 'fac:ottawa',   name: 'Ottawa Yard',    at: [-75.6972, 45.4215] },
  { id: 'fac:london',   name: 'London ON Hub',  at: [-81.2497, 42.9849] },
];

export const placeById = (id: string): Place => {
  const p = PLACES.find(x => x.id === id);
  if (!p) throw new Error(`freightFixture: no place ${id}`);
  return p;
};

/* ── vehicles ────────────────────────────────────────────────────────────── */

/** PLANT 8 — over the modelled 4 150 mm clearance, so the restriction binds. */
export const TALL_REEFER: VehicleProfile = {
  profileId: 'reefer_53ft_tall@1.0.0', mode: 'truck',
  heightMm: 4_270, widthMm: 2_600, lengthMm: 16_150,
  grossWeightKg: 34_500, hosRuleset: 'ca_nsc',
};

/** Under every modelled limit — the control against which the plant discriminates. */
export const STANDARD_DRYVAN: VehicleProfile = {
  profileId: 'dryvan_53ft@1.0.0', mode: 'truck',
  heightMm: 4_100, widthMm: 2_600, lengthMm: 16_150,
  grossWeightKg: 34_500, hosRuleset: 'ca_nsc',
};

/* ── the load book ───────────────────────────────────────────────────────── */

export interface DemoLoad {
  loadId: string;
  originId: string;
  destinationId: string;
  profile: VehicleProfile;
  /** Null where the fixture deliberately has none — PLANT 4. */
  appointmentAt: string | null;
  bufferMinutes: number | null;
  contribution: Money | null;
  transitions: Transition[];
}

const SHIPPER_CLAIM = attestationOf('reported', 'medium', 'negotiating_position',
  'shipper-stated appointment cost');
const CARRIER_SAYS = attestationOf('reported', 'medium', 'self_reported',
  'carrier status update');

const t = (
  loadId: string, from: Transition['from'], to: Transition['to'],
  occurredAt: string, over: Partial<Transition> = {},
): Transition => ({
  loadId, from, to, occurredAt, occurredAtBasis: 'observed',
  firstReportedAt: occurredAt, reportedBy: 'carrier:northline', ...over,
});

export const LOADS: readonly DemoLoad[] = [
  {
    // The origin load. Its delay is what propagates.
    loadId: 'L-1', originId: 'fac:toronto', destinationId: 'fac:montreal',
    profile: TALL_REEFER,
    appointmentAt: '2026-08-31T20:00:00.000Z',
    bufferMinutes: 0,
    contribution: { minor: 120_000, currency: 'CAD', attestation: SHIPPER_CLAIM },
    transitions: [
      t('L-1', null, 'booked', '2026-08-29T12:00:00.000Z'),
      t('L-1', 'booked', 'tendered', '2026-08-29T14:00:00.000Z'),
      t('L-1', 'tendered', 'accepted', '2026-08-29T15:30:00.000Z'),
      t('L-1', 'accepted', 'dispatched', '2026-08-31T06:00:00.000Z'),
      t('L-1', 'dispatched', 'at_origin', '2026-08-31T08:00:00.000Z'),
      t('L-1', 'at_origin', 'loading', '2026-08-31T09:00:00.000Z'),
      t('L-1', 'loading', 'loaded', '2026-08-31T11:00:00.000Z'),
      t('L-1', 'loaded', 'in_transit', '2026-08-31T11:30:00.000Z'),
      // Recent enough to read KNOWN against the 4h in_transit cadence.
      t('L-1', 'in_transit', 'at_border', '2026-08-31T16:30:00.000Z'),
    ],
  },
  {
    // PLANT 1 — last transition 14h before DEMO_NOW, cadence for in_transit is 4h.
    loadId: 'L-2', originId: 'fac:montreal', destinationId: 'fac:ottawa',
    profile: STANDARD_DRYVAN,
    appointmentAt: '2026-08-31T22:00:00.000Z',
    bufferMinutes: 30,
    contribution: { minor: 40_000, currency: 'CAD', attestation: SHIPPER_CLAIM },
    transitions: [
      t('L-2', null, 'booked', '2026-08-30T09:00:00.000Z'),
      t('L-2', 'booked', 'tendered', '2026-08-30T10:00:00.000Z'),
      t('L-2', 'tendered', 'accepted', '2026-08-30T11:00:00.000Z'),
      t('L-2', 'accepted', 'dispatched', '2026-08-31T02:00:00.000Z'),
      t('L-2', 'dispatched', 'at_origin', '2026-08-31T03:00:00.000Z'),
      t('L-2', 'at_origin', 'loading', '2026-08-31T03:30:00.000Z'),
      t('L-2', 'loading', 'loaded', '2026-08-31T04:00:00.000Z'),
      t('L-2', 'loaded', 'in_transit', '2026-08-31T04:00:00.000Z'),
    ],
  },
  {
    // PLANT 3 — appointment exists, cost does not. Unassessed, never zero.
    // ALSO PLANT 9 — no transitions at all. A load in the book that no carrier
    // has reported on is `no_history`, which is NOT "booked" by default.
    loadId: 'L-3', originId: 'fac:ottawa', destinationId: 'fac:toronto',
    profile: STANDARD_DRYVAN,
    appointmentAt: '2026-09-01T02:00:00.000Z',
    bufferMinutes: 0,
    contribution: null,
    transitions: [],
  },
  {
    // PLANT 4 — no appointment at all. breachesAppointment is null, not false.
    loadId: 'L-4', originId: 'fac:toronto', destinationId: 'fac:london',
    profile: STANDARD_DRYVAN,
    appointmentAt: null,
    bufferMinutes: 0,
    contribution: { minor: 30_000, currency: 'CAD', attestation: SHIPPER_CLAIM },
    transitions: [t('L-4', null, 'booked', '2026-08-31T12:00:00.000Z')],
  },
  {
    // PLANT 5 — a USD contribution against a CAD total. The sum must refuse.
    loadId: 'L-5', originId: 'fac:windsor', destinationId: 'fac:london',
    profile: STANDARD_DRYVAN,
    appointmentAt: '2026-09-01T06:00:00.000Z',
    bufferMinutes: 15,
    contribution: { minor: 25_000, currency: 'USD', attestation: SHIPPER_CLAIM },
    transitions: [t('L-5', null, 'booked', '2026-08-31T13:00:00.000Z')],
  },
];

export const loadById = (id: string): DemoLoad => {
  const l = LOADS.find(x => x.loadId === id);
  if (!l) throw new Error(`freightFixture: no load ${id}`);
  return l;
};

/* ── custody ─────────────────────────────────────────────────────────────── */

/** PLANT 2 — the second handoff carries only one signature. */
export const HANDOFFS: readonly Handoff[] = [
  { at: '2026-08-31T09:00:00.000Z', fromParty: 'shipper:acme', toParty: 'carrier:northline',
    fromSignature: 'sig-a', toSignature: 'sig-b', location: 'fac:toronto' },
  { at: '2026-08-31T14:00:00.000Z', fromParty: 'carrier:northline', toParty: 'carrier:relay',
    fromSignature: 'sig-c', toSignature: null, location: 'fac:ottawa' },
];

/* ── reefer telemetry ────────────────────────────────────────────────────── */

export const REEFER_FROM = '2026-08-31T11:30:00.000Z';
export const REEFER_TO = '2026-08-31T17:30:00.000Z';

/**
 * PLANT 6 — a sustained excursion above 8.0 C from +3h00 to +3h40.
 *
 * Forty minutes, against a ten-minute tolerance, so it breaches rather than
 * being absorbed. Readings every five minutes, inside the 30-minute gap limit.
 */
export function reeferReadings(): Reading[] {
  const out: Reading[] = [];
  const start = Date.parse(REEFER_FROM), end = Date.parse(REEFER_TO);
  let i = 0;
  for (let x = start; x <= end; x += 5 * 60_000, i++) {
    const excursion = i >= 36 && i <= 44;
    out.push(reading(new Date(x).toISOString(), 'temperature_c',
      excursion ? 9.4 : 5.0, 'probe:reefer-1'));
  }
  return out;
}

/** A clean run over the same window — the control the plant discriminates against. */
export function reeferReadingsClean(): Reading[] {
  const out: Reading[] = [];
  const start = Date.parse(REEFER_FROM), end = Date.parse(REEFER_TO);
  for (let x = start; x <= end; x += 5 * 60_000) {
    out.push(reading(new Date(x).toISOString(), 'temperature_c', 5.0, 'probe:reefer-1'));
  }
  return out;
}

export const REEFER_ENVELOPE = {
  predicateId: 'reefer_envelope@1.0.0',
  channel: 'temperature_c' as const,
  statement: 'no reading above 8.0C or below 2.0C',
  bounds: { minMilli: toMilli(2.0), maxMilli: toMilli(8.0) },
  toleranceSeconds: 600,
  maxGapSeconds: 1800,
  boundaryIsBreach: false,
};

/** The evidence a load exception stands on. Carrier-reported, so self_reported. */
export const EXCEPTION_EVIDENCE = [
  { recordId: 'rec:eta-slip-1', note: 'carrier ETA slipped 2h at Kingston', attestation: CARRIER_SAYS },
  { recordId: 'rec:reefer-1', note: 'reefer setpoint excursion logged', attestation: CARRIER_SAYS },
];
