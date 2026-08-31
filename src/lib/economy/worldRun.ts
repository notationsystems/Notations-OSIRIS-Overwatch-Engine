// src/lib/economy/worldRun.ts
//
// THE END-TO-END RUN over the simulated world, through the real engine.
//
// Building the world was not the work. RUNNING it was — every defect in the
// predecessor design was found by putting a detector on it and asking whether
// the detector found the thing that was planted, by the id the plant records.
//
// The single rule this file obeys: a detector is checked against
// `world.meta.plants[].boundTo`, NEVER against a load id written into a report.
// A runner that checks against an advertisement reports finding signals that
// are not there — measured on the predecessor, which reported nine plants
// recovered from a fixture where three had bound to the wrong loads.

import {
  makeFreightWorld, SEASONAL_LANE, SEASONAL_MONTHS,
  type FreightWorld, type WorldLoad,
} from './freightWorld';
import { applyTransition, detectionLatencySeconds } from './lifecycle';
import { authorize, notarizationRequired, type Authorization } from './authorization';
import { merkleRoot, notarizeCondition } from './notary';
import { simulatedProver, isSimulatedProof, simulatedProvingMs } from './simulatedProver';
import type { Commitment, ConditionPredicate, DeviceTrust } from './notary.types';
import { toMilli } from './notary.types';
import { isAdmissible } from './attestation';
import type { Attestation } from './attestation';

// ─────────────────────────────────────────────────────────────────────────────
// Small statistics, named so the estimator is never implicit
// ─────────────────────────────────────────────────────────────────────────────

export const mean = (xs: readonly number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

export const median = (xs: readonly number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export const rateAbove = (xs: readonly number[], t: number): number | null =>
  xs.length ? xs.filter(x => x > t).length / xs.length : null;

const pct = (x: number | null, d = 0) => (x === null ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const num = (x: number | null, d = 0) => (x === null ? 'n/a' : x.toFixed(d));

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface PlantOutcome {
  plant: string;
  /** What the plant bound to, from the world's own manifest. */
  boundTo: string[];
  /** What the detector actually named. */
  detected: string[];
  /**
   * THREE-VALUED. `recovered` = the detector named the bound entity.
   * `missed` = it ran and named something else or nothing.
   * `not_attempted` = no detector was run for this plant, which is a different
   * fact from a detector that ran and failed, and collapsing them is how an
   * unrun check reads as a pass.
   */
  status: 'recovered' | 'missed' | 'not_attempted';
  note: string;
}

export interface WorldRunReport {
  worldId: string;
  generatedAt: string;
  now: string;
  /**
   * The lattice class every figure below rests on, carried rather than implied.
   * `admissible: false` is the consequence; this is the reason, and a consumer
   * reading the JSON should not have to know which route produced it.
   */
  attestation: Attestation;
  admissible: false;

  lifecycle: {
    loads: number;
    transitions: number;
    illegal: number;
    /** Latency is computed ONLY over observed instants. */
    latencyObserved: number;
    latencyInferredExcluded: number;
    latencyP50Min: number | null;
    latencyP90Min: number | null;
  };

  authorization: {
    authorized: number;
    refused: number;
    undetermined: number;
    refusalsByCheck: Record<string, number>;
    undeterminedByCheck: Record<string, number>;
    examples: string[];
  };

  divergence: Array<{ carrierId: string; n: number; variancePct: number; totalDelta: number }>;

  facilities: {
    byLateRate: Array<{ facilityId: string; n: number; lateRate: number }>;
    byDetention: Array<{ facilityId: string; n: number; meanDetention: number; medianDetention: number }>;
    /** The two rankings need not agree, and which one is "reliability" is a definition. */
    agree: boolean;
  };

  duplicates: Array<{ a: string; b: string; normalized: string; metresApart: number }>;

  notary: {
    attempted: number;
    held: number;
    breached: number;
    unproven: number;
    unprovenReasons: Record<string, number>;
    notarizationRequiredCount: number;
    /** Verdicts whose proof is a rehearsal. A counterparty must be told. */
    restingOnSimulatedProof: number;
    /** What the separation from the critical path is worth, in milliseconds. */
    provingMsTotal: number;
    provingMsMean: number;
  };

  seasonality: SeasonalityFinding;

  economics: {
    loads: number;
    revenue: number;
    carrierCost: number;
    grossMargin: number;
    marginPct: number;
    currency: string;
  };

  plants: PlantOutcome[];
}

/**
 * THE ESTIMATOR FINDING.
 *
 * A planted seasonal effect can be present in the data and absent from a
 * statistic computed over it. Three separate misdenominations do it, and each
 * one alone is enough:
 *
 *   PARTITION  the plant fires Dec-Mar; calendar quarters split that across Q1
 *              and Q4, so Q4 is two-thirds out of season and the effect is
 *              diluted into it by construction.
 *   ESTIMATOR  detention is bimodal — near zero, or a blown appointment at
 *              240-900 minutes. A MEAN over that is driven by whichever cell
 *              caught an outlier; at n≈10 one load moves it by ~50 minutes.
 *   TIME BASIS the plant is keyed on pickup; a quarter computed on delivery
 *              smears loads across the boundary.
 *
 * Measured on the predecessor: quarterly means read Q3 (summer) at 299 min
 * above Q1 (winter) at 261, and after stratifying out the confounding receiver
 * Q3 was still 197 against Q4's 92. The conclusion drawn was "seasonality on
 * this lane is unmeasurable". That conclusion is a claim about the WORLD; the
 * measurement here is a claim about the QUERY, and the two have opposite
 * remedies — one says collect more data, the other says fix the statistic.
 */
export interface SeasonalityFinding {
  lane: string;
  plantMonths: readonly number[];
  /** The naive read: calendar quarters, means, on delivery date. */
  naive: {
    basis: string;
    cells: Array<{ label: string; n: number; mean: number | null }>;
    /** Whether the in-season cells came out above the out-of-season ones. */
    recovers: boolean;
  };
  /** The plant's own partition, with an estimator that survives bimodality. */
  onPlantBasis: {
    basis: string;
    inSeason: { n: number; mean: number | null; median: number | null; rateAbove120: number | null };
    outSeason: { n: number; mean: number | null; median: number | null; rateAbove120: number | null };
    recovers: boolean;
  };
  verdict: 'recovered' | 'not_recovered';
  explanation: string;
}

/**
 * A DETECTOR THAT NAMES EVERYTHING HAS FOUND NOTHING.
 *
 * Measured on the first run of this file: with no prover configured, all 243
 * notarizable loads came back `unproven`, and the detectors for PLANT-7 and
 * PLANT-9 — both of which asked only "is this load in the unproven set" —
 * reported RECOVERED. They were correct set-membership tests over a set that
 * happened to contain the whole population.
 *
 * Containment is not detection. Recovery therefore requires BOTH that the named
 * set contains the planted entity AND that the named set is a small fraction of
 * the population it was drawn from.
 *
 * The ceiling is a floor of 5 OR 5% of the population, whichever is larger, so a
 * genuinely small population does not make every detector look sharp.
 */
export function discriminationCeiling(population: number): number {
  return Math.max(5, Math.ceil(population * 0.05));
}

export function assessDetector(
  boundTo: readonly string[], detected: readonly string[], population: number, note: string,
): Omit<PlantOutcome, 'plant'> {
  const ceiling = discriminationCeiling(population);
  const out = { boundTo: [...boundTo], detected: [...detected] };
  if (!boundTo.some(b => detected.includes(b))) {
    return { ...out, status: 'missed', note };
  }
  if (detected.length > ceiling) {
    return {
      ...out, status: 'missed',
      note: `${note} — BUT the detector named ${detected.length} of ${population}, above the ` +
        `discrimination ceiling of ${ceiling}. Containing the planted entity is not finding it.`,
    };
  }
  return { ...out, status: 'recovered', note };
}

const TEMP_PREDICATE: ConditionPredicate = {
  predicateId: 'payload.reefer.temp.max8c.v1',
  channel: 'temperature_c',
  statement: 'Product temperature stays at or below 8.0 C for the whole of carriage.',
  bounds: { maxMilli: toMilli(8) },
  toleranceSeconds: 900,
  maxGapSeconds: 3600,
  boundaryIsBreach: false,
};

const DEVICE: DeviceTrust = {
  deviceId: 'PROBE',
  attestation: 'carrier_asserted',
  lastCalibratedAt: null,
  note: 'simulated probe; the carrier asserts the reading and nothing attests the device',
};

/** Notarization threshold. Off the critical path — this decides evidence, not permission. */
export const NOTARIZE_ABOVE = 50_000;
export const NOTARIZE_CURRENCY = 'CAD';

export function runWorld(world: FreightWorld, now: string): WorldRunReport {
  const loads = world.loads;

  // ── 1. lifecycle, through the real table ────────────────────────────────
  let transitions = 0, illegal = 0;
  const latencies: number[] = [];
  let inferredExcluded = 0;
  for (const l of loads) {
    let state: string | null = null;
    for (const t of l.transitions) {
      transitions++;
      try {
        if (t.from !== null) state = applyTransition(t.from, t.to);
        else state = t.to;
      } catch { illegal++; }
      const lat = detectionLatencySeconds(t);
      if (lat === null) inferredExcluded++; else latencies.push(lat / 60);
    }
    void state;
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const q = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);

  // ── 2. authorization, on the critical path ──────────────────────────────
  const carrierById = new Map(world.carriers.map(c => [c.carrierId, c]));
  const auths: Authorization[] = loads.map(l => {
    const c = carrierById.get(l.carrierId)!;
    return authorize({
      loadId: l.loadId,
      tenderedCarrierId: l.carrierId,
      bolCarrierId: l.bolCarrierId,
      pickupAt: l.actualPickupAt,
      bookedAt: l.transitions[0].occurredAt,
      declaredValue: l.declaredValue,
      carrier: {
        carrierId: c.carrierId,
        insuranceExpiresAt: c.insuranceExpiresAt,
        cargoCoverAmount: c.cargoCoverAmount,
        authorityGrantedAt: c.authorityGrantedAt,
        authorityRevokedAt: null,
      },
      actingAuthority: { principal: 'payload.dispatch', mayBind: true },
    }, now);
  });
  const refusalsByCheck: Record<string, number> = {};
  const undeterminedByCheck: Record<string, number> = {};
  for (const a of auths) for (const c of a.checks) {
    if (c.outcome === 'refused') refusalsByCheck[c.check] = (refusalsByCheck[c.check] ?? 0) + 1;
    if (c.outcome === 'undetermined') undeterminedByCheck[c.check] = (undeterminedByCheck[c.check] ?? 0) + 1;
  }

  // ── 3. divergence: committed vs invoiced, per carrier ───────────────────
  const perCarrier = new Map<string, { n: number; quoted: number; invoiced: number }>();
  for (const l of loads) {
    const e = perCarrier.get(l.carrierId) ?? { n: 0, quoted: 0, invoiced: 0 };
    e.n++; e.quoted += l.carrierRate; e.invoiced += l.carrierInvoice;
    perCarrier.set(l.carrierId, e);
  }
  const divergence = [...perCarrier]
    .map(([carrierId, e]) => ({
      carrierId, n: e.n,
      variancePct: e.quoted === 0 ? 0 : (e.invoiced - e.quoted) / e.quoted,
      totalDelta: e.invoiced - e.quoted,
    }))
    .sort((a, b) => b.variancePct - a.variancePct);

  // ── 4. facility reliability, on TWO metrics that need not agree ─────────
  const perFacility = new Map<string, { late: number[]; detention: number[] }>();
  for (const l of loads) {
    const e = perFacility.get(l.destFacilityId) ?? { late: [], detention: [] };
    e.late.push(Date.parse(l.actualDeliveryAt) > Date.parse(l.promisedDeliveryAt) ? 1 : 0);
    e.detention.push(l.detentionMinutes);
    perFacility.set(l.destFacilityId, e);
  }
  const MIN_N = 15;
  const facRows = [...perFacility].filter(([, e]) => e.late.length >= MIN_N);
  const byLateRate = facRows
    .map(([facilityId, e]) => ({ facilityId, n: e.late.length, lateRate: mean(e.late)! }))
    .sort((a, b) => b.lateRate - a.lateRate);
  const byDetention = facRows
    .map(([facilityId, e]) => ({
      facilityId, n: e.detention.length,
      meanDetention: mean(e.detention)!, medianDetention: median(e.detention)!,
    }))
    .sort((a, b) => b.meanDetention - a.meanDetention);

  // ── 5. duplicate facilities ─────────────────────────────────────────────
  const normalize = (s: string) => s.toLowerCase()
    .replace(/\bdrive\b/g, 'dr').replace(/\broad\b/g, 'rd').replace(/\bboulevard\b/g, 'blvd')
    .replace(/\bunit \d+\b/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const byNorm = new Map<string, string[]>();
  for (const f of world.facilities) {
    const k = `${f.cityCode}|${normalize(f.addressRaw)}`;
    byNorm.set(k, [...(byNorm.get(k) ?? []), f.facilityId]);
  }
  const facById = new Map(world.facilities.map(f => [f.facilityId, f]));
  const duplicates: WorldRunReport['duplicates'] = [];
  for (const [k, ids] of byNorm) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length - 1; i++) {
      const a = facById.get(ids[i])!, b = facById.get(ids[i + 1])!;
      const R = 6371000, rad = (d: number) => (d * Math.PI) / 180;
      const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
      const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
      duplicates.push({
        a: a.facilityId, b: b.facilityId, normalized: k.split('|')[1],
        metresApart: Math.round(2 * R * Math.asin(Math.sqrt(s))),
      });
    }
  }

  // ── 6. notary, off the critical path ────────────────────────────────────
  let held = 0, breached = 0, unproven = 0, attempted = 0, needNotary = 0;
  let simulated = 0, provingMsTotal = 0;
  const unprovenReasons: Record<string, number> = {};
  const verdictByLoad = new Map<string, string>();
  const unprovenByReason = new Map<string, string[]>();
  for (const l of loads) {
    const trig = notarizationRequired(l.declaredValue, l.equipment, NOTARIZE_ABOVE, NOTARIZE_CURRENCY);
    if (trig.required) needNotary++;
    if (!l.readings || !l.readings.length || !l.commitmentPostedAt) continue;
    attempted++;
    const { root, leafCount } = merkleRoot(l.readings);
    const commitment: Commitment = {
      commitmentId: `C-${l.loadId}`, root, leafCount,
      subject: { kind: 'load_condition', loadId: l.loadId, channel: 'temperature_c' },
      coversFrom: l.actualPickupAt, coversTo: l.actualDeliveryAt,
      postedAt: l.commitmentPostedAt,
      anchor: { kind: 'internal', logId: `log:${l.loadId}` },
      postedBy: l.carrierId, authority: 'payload.notary',
    };
    const v = notarizeCondition({
      readings: l.readings, commitment, predicate: TEMP_PREDICATE,
      from: l.actualPickupAt, to: l.actualDeliveryAt,
      device: { ...DEVICE, deviceId: l.readings[0].deviceId }, now,
      // THE MISSING ACTOR. Without this every verdict was
      // unproven/proof_generation_failed, which is a fact about the deployment
      // and not about any load.
      prove: simulatedProver({ readings: l.readings, predicate: TEMP_PREDICATE, now }),
    });
    const pr = (v as { proof?: unknown }).proof;
    if (isSimulatedProof(pr as never)) simulated++;
    provingMsTotal += simulatedProvingMs(l.readings.length);
    verdictByLoad.set(l.loadId, v.status);
    if (v.status === 'held') held++;
    else if (v.status === 'breached') breached++;
    else {
      unproven++;
      const reason = (v as { reason?: string }).reason ?? 'unspecified';
      unprovenReasons[reason] = (unprovenReasons[reason] ?? 0) + 1;
      unprovenByReason.set(reason, [...(unprovenByReason.get(reason) ?? []), l.loadId]);
    }
  }

  // ── 7. seasonality: the same signal under two queries ───────────────────
  const seasonality = analyseSeasonality(loads);

  // ── 8. economics ────────────────────────────────────────────────────────
  const revenue = loads.reduce((a, l) => a + l.invoicedToShipper, 0);
  const carrierCost = loads.reduce((a, l) => a + l.carrierInvoice, 0);

  // ── 9. plant recovery, checked against boundTo ──────────────────────────
  const plantOf = (id: string) => world.meta.plants.find(p => p.id === id)!;
  const outcome = (id: string, detected: string[], note: string): PlantOutcome => {
    const p = plantOf(id);
    return { plant: id, ...assessDetector(p.boundTo, detected, loads.length, note) };
  };

  const breachedLoads = [...verdictByLoad].filter(([, v]) => v === 'breached').map(([k]) => k);
  const bolRefused = auths.filter(a =>
    a.checks.some(c => c.check === 'bol_matches_tendered_carrier' && c.outcome === 'refused')).map(a => a.loadId);
  const insRefusedLoads = auths.filter(a =>
    a.checks.some(c => c.check === 'insurance_valid_at_pickup' && c.outcome === 'refused')).map(a => a.loadId);
  // AN INSURANCE LAPSE IS A FACT ABOUT A CARRIER, NOT A LOAD. Every load that
  // carrier moved after the expiry is refused, so the load-level set is as large
  // as its book — 31 of 520 on the first run, which the discrimination ceiling
  // then read as a non-finding. The detector was denominated wrong, not blunt:
  // the right question is WHICH CARRIER is being refused, and that answer is one row.
  const loadCarrier = new Map(loads.map(l => [l.loadId, l.carrierId]));
  const insRefused = [...new Set(insRefusedLoads.map(id => loadCarrier.get(id)!))];

  const plants: PlantOutcome[] = [
    outcome('PLANT-1', divergence.length ? [divergence[0].carrierId] : [],
      divergence.length ? `top by rate variance, ${pct(divergence[0].variancePct, 1)} over ${divergence[0].n} loads` : 'no carriers'),
    outcome('PLANT-2', [byLateRate[0]?.facilityId, byDetention[0]?.facilityId].filter(Boolean) as string[],
      `worst by late rate ${byLateRate[0]?.facilityId ?? 'n/a'} (${pct(byLateRate[0]?.lateRate ?? null)}), ` +
      `worst by mean detention ${byDetention[0]?.facilityId ?? 'n/a'} (${num(byDetention[0]?.meanDetention ?? null)} min)`),
    outcome('PLANT-3', duplicates.flatMap(d => [d.a, d.b]),
      duplicates.length ? `${duplicates[0].metresApart} m apart, same normalized address` : 'no duplicate found'),
    outcome('PLANT-4', insRefused,
      `${insRefused.length} carrier(s) refused for insurance expired at pickup, over ` +
      `${insRefusedLoads.length} load(s)`),
    outcome('PLANT-5', bolRefused,
      `${bolRefused.length} load(s) refused for BOL carrier mismatch`),
    outcome('PLANT-6', breachedLoads, `${breachedLoads.length} breached`),
    // REASON-SPECIFIC. Both plants land in the unproven set, so a detector that
    // only asks "is it unproven" cannot tell them apart and would credit either
    // for the other's evidence.
    outcome('PLANT-7', unprovenByReason.get('telemetry_gap_exceeds_max') ?? [],
      `unproven/telemetry_gap_exceeds_max x${(unprovenByReason.get('telemetry_gap_exceeds_max') ?? []).length}`),
    { plant: 'PLANT-8', boundTo: plantOf('PLANT-8').boundTo,
      detected: seasonality.verdict === 'recovered' ? [SEASONAL_LANE] : [],
      status: seasonality.verdict === 'recovered' ? 'recovered' : 'missed',
      note: seasonality.explanation },
    outcome('PLANT-9', unprovenByReason.get('commitment_posted_after_the_fact') ?? [],
      `unproven/commitment_posted_after_the_fact x${(unprovenByReason.get('commitment_posted_after_the_fact') ?? []).length}`),
  ];

  return {
    worldId: world.meta.worldId,
    generatedAt: world.meta.generatedAt,
    now,
    attestation: world.meta.attestation,
    admissible: false,
    lifecycle: {
      loads: loads.length, transitions, illegal,
      latencyObserved: latencies.length, latencyInferredExcluded: inferredExcluded,
      latencyP50Min: q(0.5), latencyP90Min: q(0.9),
    },
    authorization: {
      authorized: auths.filter(a => a.decision === 'authorized').length,
      refused: auths.filter(a => a.decision === 'refused').length,
      undetermined: auths.filter(a => a.decision === 'undetermined').length,
      refusalsByCheck, undeterminedByCheck,
      examples: auths.filter(a => a.decision === 'refused').slice(0, 4).map(a => a.statement),
    },
    divergence: divergence.slice(0, 5),
    facilities: {
      byLateRate: byLateRate.slice(0, 3),
      byDetention: byDetention.slice(0, 3),
      agree: byLateRate[0]?.facilityId === byDetention[0]?.facilityId,
    },
    duplicates,
    notary: {
      attempted, held, breached, unproven, unprovenReasons,
      notarizationRequiredCount: needNotary,
      restingOnSimulatedProof: simulated,
      provingMsTotal,
      provingMsMean: attempted ? Math.round(provingMsTotal / attempted) : 0,
    },
    seasonality,
    economics: {
      loads: loads.length, revenue, carrierCost,
      grossMargin: revenue - carrierCost,
      marginPct: revenue === 0 ? 0 : (revenue - carrierCost) / revenue,
      currency: 'CAD',
    },
    plants,
  };
}

/** The two queries over the same planted effect. */
export function analyseSeasonality(loads: readonly WorldLoad[]): SeasonalityFinding {
  const lane = loads.filter(l => l.laneId === SEASONAL_LANE);
  const det = (ls: readonly WorldLoad[]) => ls.map(l => l.detentionMinutes);

  // The naive read, exactly as the predecessor computed it.
  const quarterOfDelivery = (l: WorldLoad) => Math.floor(new Date(l.actualDeliveryAt).getUTCMonth() / 3) + 1;
  const cells = [1, 2, 3, 4].map(Q => {
    const xs = det(lane.filter(l => quarterOfDelivery(l) === Q));
    return { label: `Q${Q}`, n: xs.length, mean: mean(xs) };
  });
  // Q1 and Q4 hold the winter months; Q2 and Q3 hold none.
  const winterQ = [cells[0].mean, cells[3].mean].filter((x): x is number => x !== null);
  const summerQ = [cells[1].mean, cells[2].mean].filter((x): x is number => x !== null);
  const naiveRecovers = winterQ.length > 0 && summerQ.length > 0 &&
    Math.min(...winterQ) > Math.max(...summerQ);

  // The plant's own partition, and an estimator that survives a bimodal variable.
  const monthOfPickup = (l: WorldLoad) => new Date(l.promisedPickupAt).getUTCMonth();
  const inL = lane.filter(l => SEASONAL_MONTHS.includes(monthOfPickup(l)));
  const outL = lane.filter(l => !SEASONAL_MONTHS.includes(monthOfPickup(l)));
  const cell = (ls: readonly WorldLoad[]) => ({
    n: ls.length, mean: mean(det(ls)), median: median(det(ls)), rateAbove120: rateAbove(det(ls), 120),
  });
  const inC = cell(inL), outC = cell(outL);
  const plantRecovers =
    inC.n > 3 && outC.n > 3 &&
    inC.median !== null && outC.median !== null && inC.median > outC.median &&
    inC.rateAbove120 !== null && outC.rateAbove120 !== null && inC.rateAbove120 > outC.rateAbove120;

  const explanation = plantRecovers && !naiveRecovers
    ? 'The effect IS in the data and the naive query does not see it. Calendar quarters split ' +
      `the plant's ${SEASONAL_MONTHS.length} months across two of them, a MEAN over bimodal ` +
      'detention follows whichever cell caught an outlier, and a quarter keyed on delivery ' +
      'smears loads across the boundary. Three misdenominations, each sufficient. The remedy ' +
      'is to fix the statistic, not to collect more data — and "unmeasurable at this n" would ' +
      'have prescribed the opposite.'
    : plantRecovers && naiveRecovers
      ? 'Both queries recover it. The naive read happens to agree here; it is not therefore sound.'
      : 'Not recovered on either basis. The effect may be too small against the appointment ' +
        'noise it competes with, which is a fact about this detector at this n, not about the world.';

  return {
    lane: SEASONAL_LANE,
    plantMonths: SEASONAL_MONTHS,
    naive: { basis: 'calendar quarter of DELIVERY, arithmetic mean', cells, recovers: naiveRecovers },
    onPlantBasis: {
      basis: `months ${SEASONAL_MONTHS.join(',')} of PICKUP, median and rate above 120 min`,
      inSeason: inC, outSeason: outC, recovers: plantRecovers,
    },
    verdict: plantRecovers ? 'recovered' : 'not_recovered',
    explanation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

const RULE = '─'.repeat(78);

export function renderWorldRun(r: WorldRunReport): string {
  const L: string[] = [];
  const h = (t: string) => { L.push('', RULE, t, RULE); };

  L.push(RULE, 'PAYLOAD — SIMULATED FREIGHT WORLD, END TO END', RULE);
  L.push(`world ${r.worldId}   generated ${r.generatedAt}   evaluated at ${r.now}`);
  L.push('sourceClass: representative  →  isAdmissible() is false at every derivation');

  h('1. LIFECYCLE — the ENGINE\'s transition table, not a private one');
  L.push(`loads ${r.lifecycle.loads}   transitions ${r.lifecycle.transitions}   illegal ${r.lifecycle.illegal}`);
  L.push(`detection latency  p50 ${num(r.lifecycle.latencyP50Min)}min   p90 ${num(r.lifecycle.latencyP90Min)}min`);
  L.push(`  over ${r.lifecycle.latencyObserved} OBSERVED instants; ${r.lifecycle.latencyInferredExcluded} inferred ones excluded.`);
  L.push('  A geofence crossing is our reconstruction of when the truck arrived, not a report of');
  L.push('  it. Averaging the two produces a distribution over two different quantities.');

  h('2. AUTHORIZATION — deterministic, blocking, ON the critical path');
  L.push(`authorized ${r.authorization.authorized}   refused ${r.authorization.refused}   undetermined ${r.authorization.undetermined}`);
  for (const [k, n] of Object.entries(r.authorization.refusalsByCheck)) L.push(`  refused: ${k} x${n}`);
  for (const [k, n] of Object.entries(r.authorization.undeterminedByCheck)) L.push(`  undetermined: ${k} x${n}`);
  for (const e of r.authorization.examples) L.push(`  ${e}`);
  L.push('  UNDETERMINED IS NOT CLEARED. It blocks like a refusal; only the remedy differs.');

  h('3. DIVERGENCE — committed vs invoiced, per carrier');
  for (const d of r.divergence) {
    L.push(`  ${d.carrierId}  n=${String(d.n).padStart(3)}  ${(d.variancePct >= 0 ? '+' : '')}${pct(d.variancePct, 1)}  ${d.totalDelta >= 0 ? '+' : ''}${d.totalDelta} CAD`);
  }

  h('4. FACILITY RELIABILITY — two metrics, and they need not agree');
  L.push('  by LATE RATE                        by MEAN DETENTION');
  for (let i = 0; i < Math.max(r.facilities.byLateRate.length, r.facilities.byDetention.length); i++) {
    const a = r.facilities.byLateRate[i], b = r.facilities.byDetention[i];
    L.push(`  ${(a ? `${a.facilityId} n=${String(a.n).padStart(3)} ${pct(a.lateRate)}` : '').padEnd(36)}${b ? `${b.facilityId} n=${String(b.n).padStart(3)} mean ${num(b.meanDetention)} / median ${num(b.medianDetention)} min` : ''}`);
  }
  L.push(`  the two rankings ${r.facilities.agree ? 'AGREE' : 'DISAGREE'} on the worst receiver.`);
  L.push('  Which one is "reliability" is a definition, not a fact, so both are reported.');

  h('5. FACILITY RESOLUTION — the duplicate that would break lane memory');
  for (const d of r.duplicates) {
    L.push(`  ${d.a} / ${d.b}  →  "${d.normalized}"  ${d.metresApart} m apart`);
  }
  L.push('  Unresolved, these are two facilities and every load is a first load.');

  h('6. NOTARY — cryptographic, threshold-gated, OFF the critical path');
  L.push(`notarization required for ${r.notary.notarizationRequiredCount} loads; ${r.notary.attempted} had committed readings`);
  L.push(`  held ${r.notary.held}   breached ${r.notary.breached}   unproven ${r.notary.unproven}`);
  for (const [k, n] of Object.entries(r.notary.unprovenReasons)) L.push(`    unproven/${k} x${n}`);
  L.push(`  ${r.notary.restingOnSimulatedProof} verdict(s) rest on a SIMULATED proof and are a rehearsal,`);
  L.push('  not evidence. `system: sp1` alone cannot say that, so the vkey and proofId carry it.');
  L.push(`  proving cost, were it on the critical path: ${r.notary.provingMsMean} ms mean, ` +
    `${(r.notary.provingMsTotal / 1000).toFixed(1)} s total over ${r.notary.attempted} loads.`);
  L.push('  That is the number the architecture separation is worth. A dispatcher does not wait');
  L.push('  for it; the evidence is produced behind the execution it describes.');

  h(`7. SEASONALITY ON ${r.seasonality.lane} — the same signal under two queries`);
  L.push(`  NAIVE: ${r.seasonality.naive.basis}`);
  for (const c of r.seasonality.naive.cells) L.push(`    ${c.label}  n=${String(c.n).padStart(3)}  mean ${num(c.mean)} min`);
  L.push(`    recovers the plant: ${r.seasonality.naive.recovers ? 'YES' : 'NO'}`);
  L.push(`  ON THE PLANT'S BASIS: ${r.seasonality.onPlantBasis.basis}`);
  const ins = r.seasonality.onPlantBasis.inSeason, outs = r.seasonality.onPlantBasis.outSeason;
  L.push(`    in season   n=${String(ins.n).padStart(3)}  mean ${num(ins.mean)}  median ${num(ins.median)}  >120min ${pct(ins.rateAbove120)}`);
  L.push(`    out         n=${String(outs.n).padStart(3)}  mean ${num(outs.mean)}  median ${num(outs.median)}  >120min ${pct(outs.rateAbove120)}`);
  L.push(`    recovers the plant: ${r.seasonality.onPlantBasis.recovers ? 'YES' : 'NO'}`);
  L.push(`  VERDICT: ${r.seasonality.verdict.toUpperCase()}`);
  for (const line of wrap(r.seasonality.explanation, 74)) L.push(`  ${line}`);

  h('8. ECONOMICS');
  L.push(`  loads ${r.economics.loads}   revenue ${r.economics.revenue} ${r.economics.currency}   carrier cost ${r.economics.carrierCost}`);
  L.push(`  gross margin ${r.economics.grossMargin} (${pct(r.economics.marginPct, 1)})`);

  h('9. PLANT RECOVERY — checked against the world\'s OWN manifest');
  for (const p of r.plants) {
    const mark = p.status === 'recovered' ? 'OK  ' : p.status === 'missed' ? 'MISS' : '----';
    L.push(`  ${mark} ${p.plant}  bound ${p.boundTo.join(',')}`);
    L.push(`       ${p.note}`);
  }
  L.push('  Checked against boundTo, never against an id written into a report. A runner that');
  L.push('  checks its detector against an advertisement reports finding what is not there.');

  h('10. ADMISSIBILITY');
  L.push('  Every figure above derives from records stamped `representative`.');
  L.push('  isAdmissible() === false, by construction, at every derivation.');
  L.push('  These numbers demonstrate that the MACHINERY WORKS. They are not claims about the');
  L.push('  world. The same code paths, fed one real load, produce the same shapes with');
  L.push('  admissible:true for that record alone.');
  L.push('');
  return L.join('\n');
}

function wrap(s: string, w: number): string[] {
  const words = s.split(/\s+/);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > w) { out.push(line.trim()); line = word; }
    else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/** Convenience for the route and the CLI. Holds no clock: `now` is required. */
export function runDefaultWorld(now: string, seed?: number): WorldRunReport {
  const world = makeFreightWorld({ seed, generatedAt: now });
  const report = runWorld(world, now);
  // Self-check: the run must never claim admissibility it cannot have.
  if (isAdmissible(world.meta.attestation)) {
    throw new Error('worldRun: a representative world reported admissible inputs');
  }
  return report;
}
