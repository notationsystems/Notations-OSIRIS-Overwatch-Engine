// src/lib/economy/pricing.ts
//
// LANE PRICING — quoting from your own record rather than a market reference.
//
// This is the module the whole measurement layer exists to feed. Everything
// before it records and verifies; this is the first that PRICES, and the first
// where the record either pays for itself or reveals it has nothing to say yet.
//
// The governing behaviour is not the price. It is knowing when there isn't one:
//
//   n >= confidentFloor     price from own record, normal band, CONFIDENT
//   n >= indicativeFloor    price from own record, WIDER band, INDICATIVE
//   n <  indicativeFloor    REFUSE, and name the fallback
//   too concentrated        REFUSE REGARDLESS OF n
//   all of it stale         REFUSE, and say STALE rather than "insufficient"
//
// A quote from four loads and a quote from eighty are different objects.
// Rendering them identically is the defect this codebase keeps catching.

import type { ISODateTime } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Input — decoupled from the fixture that happens to supply it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What pricing needs, and nothing else.
 *
 * Deliberately NOT `WorldLoad`. The pricer taking the generator's type would
 * make the fixture a dependency of the product, and the first real load would
 * arrive shaped differently. `observationsFrom` adapts; the engine never sees a
 * world.
 */
export interface LaneObservation {
  loadId: string;
  laneId: string;
  equipment: string;
  /** Committed. */
  carrierRate: number;
  quotedToShipper: number;
  /** Observed. `null` = the load has not settled, which is not a zero. */
  carrierInvoice: number | null;
  accessorialsBilled: number;
  detentionMinutes: number;
  deliveredAt: ISODateTime;
  carrierId: string;
  /**
   * Whether we won this quote. A book of SETTLED LOADS is all `true` by
   * construction — see `winCurve`, which refuses on exactly that.
   */
  won: boolean;
}

export interface PricingPolicy {
  /** Below this, the record cannot price a lane. */
  indicativeFloor: number;
  /** At or above this, the record prices with a normal band. */
  confidentFloor: number;
  /**
   * Observations older than this are excluded. Rates and carrier performance
   * decay, and a median over three-year-old loads is a fact about a market that
   * no longer exists.
   */
  maxAgeDays: number;
  targetMarginPct: number;
  /** Factoring/financing cost, priced INTO the quote rather than left to finance. */
  financingCostPct: number;
  /**
   * The largest share one carrier may hold. A generalisation of "all on one
   * carrier": a rule keyed on `distinctCarriers > 1` passes 15-of-17, which is
   * not meaningfully better than 17-of-17.
   */
  maxCarrierShare: number;
}

export const DEFAULT_PRICING: PricingPolicy = {
  indicativeFloor: 5,
  confidentFloor: 20,
  maxAgeDays: 270,
  targetMarginPct: 0.15,
  financingCostPct: 0.03,
  maxCarrierShare: 0.7,
};

// ─────────────────────────────────────────────────────────────────────────────
// 2. The lane statistic — never a bare mean, and every denominator named
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneStat {
  laneId: string;
  equipment: string;
  /** Everything on record for this pair. */
  n: number;
  /** What survived the age filter AND carries a settled invoice. */
  nUsed: number;
  /** Accounted for, never inferred from the difference. */
  droppedStale: number;
  droppedUnsettled: number;

  medianCarrierCost: number;
  p25: number;
  p75: number;
  /** IQR as a fraction of median — the variance you must price for. */
  spreadPct: number;

  /**
   * TWO ACCESSORIAL FIGURES, NAMED, BECAUSE THEY ARE DENOMINATED DIFFERENTLY.
   *
   * `accessorialPerLoad` averages over ALL used loads, zeros included — it IS
   * the expected accessorial on the next load, and it is what belongs in a
   * quote. `accessorialWhenIncurred` averages only over the loads that incurred
   * one, which is the number an operator quotes when arguing about a specific
   * detention bill.
   *
   * They differ by `accessorialIncidence`, and multiplying the FIRST by the
   * incidence applies the discount twice. Measured on TOR-DET van_53, n=37,
   * $5,070 billed: the true expected per load is $137.03, and
   * `perLoad x incidence` gives $44.44 — understating by 3.1x. The wrong figure
   * is plausible, which is why it ships.
   */
  accessorialPerLoad: number;
  accessorialWhenIncurred: number;
  accessorialIncidence: number;

  meanDetentionMinutes: number;

  distinctCarriers: number;
  /** n is not independence. */
  maxCarrierShare: number;

  oldestUsed: ISODateTime | null;
  newestUsed: ISODateTime | null;
  /** newest − oldest. How much history the statistic spans. */
  windowDays: number;
  /**
   * asOf − newest. HOW OLD THE FRESHEST OBSERVATION IS.
   *
   * Distinct from `windowDays` and routinely confused with it: "from 37 loads
   * over 676 days" reads as depth and can equally mean the most recent load
   * settled a year ago. Depth and currency are different properties and a quote
   * needs both.
   */
  stalenessDays: number;
}

const quantile = (sorted: readonly number[], q: number): number => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

const DAY = 86_400_000;

export function laneStat(
  obs: readonly LaneObservation[], laneId: string, equipment: string, asOf: string,
  policy: PricingPolicy = DEFAULT_PRICING,
): LaneStat {
  const all = obs.filter(o => o.laneId === laneId && o.equipment === equipment);
  const cutoff = Date.parse(asOf) - policy.maxAgeDays * DAY;
  const fresh = all.filter(o => Date.parse(o.deliveredAt) >= cutoff);
  const used = fresh.filter(o => o.carrierInvoice !== null);

  const costs = used.map(o => o.carrierInvoice as number).sort((a, b) => a - b);
  const med = quantile(costs, 0.5), p25 = quantile(costs, 0.25), p75 = quantile(costs, 0.75);
  const times = used.map(o => Date.parse(o.deliveredAt)).sort((a, b) => a - b);

  const byCarrier = new Map<string, number>();
  for (const o of used) byCarrier.set(o.carrierId, (byCarrier.get(o.carrierId) ?? 0) + 1);

  const totalAcc = used.reduce((s, o) => s + o.accessorialsBilled, 0);
  const incurring = used.filter(o => o.accessorialsBilled > 0).length;

  return {
    laneId, equipment,
    n: all.length, nUsed: used.length,
    droppedStale: all.length - fresh.length,
    droppedUnsettled: fresh.length - used.length,
    medianCarrierCost: med, p25, p75,
    spreadPct: Number.isFinite(med) && med > 0 ? (p75 - p25) / med : NaN,
    accessorialPerLoad: used.length ? totalAcc / used.length : NaN,
    accessorialWhenIncurred: incurring ? totalAcc / incurring : 0,
    accessorialIncidence: used.length ? incurring / used.length : NaN,
    meanDetentionMinutes: used.length
      ? used.reduce((s, o) => s + o.detentionMinutes, 0) / used.length : NaN,
    distinctCarriers: byCarrier.size,
    maxCarrierShare: used.length ? Math.max(...byCarrier.values()) / used.length : NaN,
    oldestUsed: times.length ? new Date(times[0]).toISOString() : null,
    newestUsed: times.length ? new Date(times[times.length - 1]).toISOString() : null,
    windowDays: times.length ? Math.round((times[times.length - 1] - times[0]) / DAY) : 0,
    stalenessDays: times.length
      ? Math.round((Date.parse(asOf) - times[times.length - 1]) / DAY) : Infinity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Capital — an AMOUNT and a DURATION, which are not one number
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BOTH EARLIER VERSIONS OF THIS WERE A HYBRID, IN DIFFERENT DIRECTIONS.
 *
 * One computed `carrierCost x (paymentTermsDays / 30)` — at 45-day terms that is
 * 1.5x the carrier cost for a single load, which is not an amount anyone ever
 * finances. The other added an arbitrary 15% and a term adder.
 *
 * The load ties up ONE carrier cost, for the days between paying the carrier and
 * being paid by the shipper. That is an amount and a duration. What scales with
 * the term is the WORKING CAPITAL you need to run at a given rate — a different
 * quantity, denominated in loads per week, and derived rather than folded in.
 */
export interface CapitalProfile {
  /** What one load ties up. */
  perLoad: number;
  /** For how long: shipper terms minus how fast you pay the carrier. */
  outstandingDays: number;
  /** Working capital to sustain a run rate. Requires the rate; refuses without it. */
  atRate(loadsPerWeek: number): number;
}

export function capitalProfile(
  carrierCost: number, paymentTermsDays: number, carrierPaidInDays = 0,
): CapitalProfile {
  const outstandingDays = Math.max(0, paymentTermsDays - carrierPaidInDays);
  return {
    perLoad: Math.round(carrierCost),
    outstandingDays,
    atRate(loadsPerWeek: number) {
      if (!(loadsPerWeek > 0)) {
        throw new Error(
          'pricing: working capital at a rate of zero loads per week is not zero capital, it ' +
          'is an undefined question. Supply the rate you actually intend to run.',
        );
      }
      return Math.round(carrierCost * loadsPerWeek * (outstandingDays / 7));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The quote — or the refusal, which is the product
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteComponents {
  expectedCarrierCost: number;
  accessorialExposure: number;
  financingCost: number;
  marginTarget: number;
  quote: number;
}

export type QuoteRefusal =
  | 'no_cost_data'
  | 'stale_history'
  | 'insufficient_lane_history'
  | 'carrier_concentration';

export type QuoteResult =
  | {
      status: 'priced';
      basis: 'own_record';
      confidence: 'confident' | 'indicative';
      components: QuoteComponents;
      band: { low: number; high: number };
      stat: LaneStat;
      capital: CapitalProfile;
      renderedClaim: string;
    }
  | {
      status: 'refused';
      reason: QuoteRefusal;
      stat: LaneStat;
      fallback: string;
      remedy: string;
      renderedClaim: string;
    };

export function quoteLane(args: {
  obs: readonly LaneObservation[];
  laneId: string;
  equipment: string;
  asOf: string;
  paymentTermsDays: number;
  carrierPaidInDays?: number;
  policy?: PricingPolicy;
}): QuoteResult {
  const policy = args.policy ?? DEFAULT_PRICING;
  const stat = laneStat(args.obs, args.laneId, args.equipment, args.asOf, policy);
  const head = `${args.laneId} ${args.equipment}`;

  if (stat.nUsed === 0) {
    // WHICH KIND OF NOTHING. A lane with 40 loads all older than the window is
    // not a lane with no history; reporting it as "insufficient" sends an
    // operator to build history they already have. The remedy differs.
    const stale = stat.droppedStale > 0 && stat.droppedStale >= stat.droppedUnsettled;
    return {
      status: 'refused', reason: stale ? 'stale_history' : 'no_cost_data', stat,
      fallback: 'Price from a market reference or a carrier call, and mark the quote as not record-based.',
      remedy: stale
        ? `${stat.droppedStale} observation(s) exist on ${head} but all are older than the ` +
          `${policy.maxAgeDays}-day window. The history is STALE, not absent — widen the window ` +
          'deliberately if the lane has not moved, or re-establish it with a current tender.'
        : `No settled loads on ${head} within ${policy.maxAgeDays} days. ${stat.n} observation(s) ` +
          `exist; ${stat.droppedUnsettled} carry no carrier invoice yet.`,
      renderedClaim:
        `NO RECORD-BASED PRICE for ${head} — ` +
        (stale ? `${stat.droppedStale} loads, all beyond the ${policy.maxAgeDays}-day window.`
               : '0 settled loads in window.'),
    };
  }
  if (stat.nUsed < policy.indicativeFloor) {
    return {
      status: 'refused', reason: 'insufficient_lane_history', stat,
      fallback: 'Price from a market reference. Record the outcome — this lane needs history before it can price itself.',
      remedy:
        `${stat.nUsed} settled load(s) is below the ${policy.indicativeFloor} floor. ` +
        `A median over ${stat.nUsed} is noise wearing a number.`,
      renderedClaim: `NO RECORD-BASED PRICE for ${head} — ${stat.nUsed} loads, floor ${policy.indicativeFloor}.`,
    };
  }
  if (stat.distinctCarriers < 2 || stat.maxCarrierShare > policy.maxCarrierShare) {
    // THE REFUSAL THAT LOOKS LIKE A FALSE NEGATIVE AND IS NOT. n looks fine and
    // the statistic is worthless; most pricing tools quote confidently here.
    return {
      status: 'refused', reason: 'carrier_concentration', stat,
      fallback: 'Price from a market reference, or tender to two more carriers to establish a comparison.',
      remedy:
        `${stat.nUsed} loads across ${stat.distinctCarriers} carrier(s), the largest holding ` +
        `${(stat.maxCarrierShare * 100).toFixed(0)}% (ceiling ${(policy.maxCarrierShare * 100).toFixed(0)}%). ` +
        "That is one carrier's pricing, not the lane's — it cannot tell you whether you are paying market.",
      renderedClaim:
        `NO RECORD-BASED PRICE for ${head} — ${stat.nUsed} loads, but ` +
        `${(stat.maxCarrierShare * 100).toFixed(0)}% on one carrier.`,
    };
  }

  const confidence = stat.nUsed >= policy.confidentFloor ? 'confident' as const : 'indicative' as const;

  const expectedCarrierCost = stat.medianCarrierCost;
  // ALREADY the expected value per load. Multiplying by the incidence rate here
  // discounts it twice — measured at 3.1x understatement on TOR-DET van_53.
  const accessorialExposure = stat.accessorialPerLoad;
  const base = expectedCarrierCost + accessorialExposure;
  const grossUp = 1 - policy.targetMarginPct - policy.financingCostPct;
  if (grossUp <= 0) {
    throw new Error(
      `pricing: target margin ${policy.targetMarginPct} plus financing ${policy.financingCostPct} ` +
      'is 100% or more of the quote. There is no price that satisfies it, and dividing by a ' +
      'non-positive number would return one anyway.',
    );
  }
  const quote = base / grossUp;

  // The band widens for observed spread AND for low confidence. Both are real
  // sources of error, and collapsing them hides which one is biting.
  const spreadWiden = Number.isFinite(stat.spreadPct) ? stat.spreadPct / 2 : 0.1;
  const confWiden = confidence === 'indicative' ? 0.06 : 0.02;
  const band = {
    low: Math.round(quote * (1 - spreadWiden - confWiden)),
    high: Math.round(quote * (1 + spreadWiden + confWiden)),
  };

  const capital = capitalProfile(expectedCarrierCost, args.paymentTermsDays, args.carrierPaidInDays ?? 0);

  return {
    status: 'priced', basis: 'own_record', confidence,
    components: {
      expectedCarrierCost: Math.round(expectedCarrierCost),
      accessorialExposure: Math.round(accessorialExposure),
      financingCost: Math.round(quote * policy.financingCostPct),
      marginTarget: Math.round(quote * policy.targetMarginPct),
      quote: Math.round(quote),
    },
    band, stat, capital,
    renderedClaim:
      `$${Math.round(quote)} on ${head} — ${confidence.toUpperCase()}, from ${stat.nUsed} settled ` +
      `loads across ${stat.distinctCarriers} carriers (largest ${(stat.maxCarrierShare * 100).toFixed(0)}%), ` +
      `spanning ${stat.windowDays} days and current to ${stat.stalenessDays} days ago. ` +
      `Carrier cost median $${Math.round(expectedCarrierCost)} ` +
      `(IQR $${Math.round(stat.p25)}-$${Math.round(stat.p75)}, spread ${(stat.spreadPct * 100).toFixed(0)}%), ` +
      `accessorial exposure $${Math.round(accessorialExposure)} per load ` +
      `(${(stat.accessorialIncidence * 100).toFixed(0)}% incur one, averaging ` +
      `$${Math.round(stat.accessorialWhenIncurred)} when they do). ` +
      `Work within $${band.low}-$${band.high}. ` +
      `Ties up $${capital.perLoad} for ${capital.outstandingDays} days.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Density — the commercial argument, made quantitative
// ─────────────────────────────────────────────────────────────────────────────

export interface DensityTier {
  atConfidentFloor: number;
  atIndicativeFloor: number;
  unpriceable: number;
  densest: Array<{ laneId: string; equipment: string; n: number }>;
}

export interface DensityReport {
  pairs: number;
  /** Counting every observation on record, regardless of age. */
  allTime: DensityTier;
  /**
   * Counting only what the QUOTER would actually use.
   *
   * REPORTED SEPARATELY BECAUSE THE TWO DISAGREE, AND THE ALL-TIME FIGURE IS THE
   * FLATTERING ONE. An earlier version of this function counted all-time while
   * `quoteLane` refused anything beyond `maxAgeDays` — a density report and a
   * quoter answering the same question over different populations, with the
   * report always the optimistic half.
   *
   * Measured on a 900-load, 24-month book with a 270-day window:
   *
   *     ALL-TIME    confident 18   indicative  5   unpriceable 183   of 206
   *     IN-WINDOW   confident  0   indicative 20   unpriceable 186   of 206
   *
   * NOT ONE PAIR prices confidently once the history has to be current. Every one
   * of the 18 was confident only by counting loads up to two years old. That is
   * the lane-concentration argument at full strength: at ~8.7 loads/week across
   * 206 pairs, no pair accumulates 20 loads inside a 270-day window, and the
   * remedy is fewer lanes or more volume — not a longer window.
   */
  inWindow: DensityTier;
  asOf: ISODateTime;
  maxAgeDays: number;
  note: string;
}

function tierOf(
  rows: Array<{ laneId: string; equipment: string; n: number }>, policy: PricingPolicy,
): DensityTier {
  return {
    atConfidentFloor: rows.filter(r => r.n >= policy.confidentFloor).length,
    atIndicativeFloor: rows.filter(r => r.n >= policy.indicativeFloor).length,
    unpriceable: rows.filter(r => r.n < policy.indicativeFloor).length,
    densest: [...rows].sort((a, b) => b.n - a.n).slice(0, 6),
  };
}

export function laneDensity(
  obs: readonly LaneObservation[], asOf: string, policy: PricingPolicy = DEFAULT_PRICING,
): DensityReport {
  const cutoff = Date.parse(asOf) - policy.maxAgeDays * DAY;
  const all = new Map<string, number>();
  const win = new Map<string, number>();
  for (const o of obs) {
    const k = `${o.laneId}|${o.equipment}`;
    all.set(k, (all.get(k) ?? 0) + 1);
    if (Date.parse(o.deliveredAt) >= cutoff && o.carrierInvoice !== null) {
      win.set(k, (win.get(k) ?? 0) + 1);
    }
  }
  const rowsOf = (m: Map<string, number>, keys: Iterable<string>) =>
    [...keys].map(k => {
      const [laneId, equipment] = k.split('|');
      return { laneId, equipment, n: m.get(k) ?? 0 };
    });
  return {
    pairs: all.size,
    allTime: tierOf(rowsOf(all, all.keys()), policy),
    inWindow: tierOf(rowsOf(win, all.keys()), policy),
    asOf, maxAgeDays: policy.maxAgeDays,
    note:
      'Spot variety starves the pricer, and STALENESS starves it again. The same book ' +
      'concentrated on a handful of lanes prices all of them; spread thin it prices almost none, ' +
      'and spread thin over two years it prices none confidently at all. That is a decision ' +
      'about which lanes to chase, visible here rather than left to instinct.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The win curve — and why it REFUSES a book of settled loads
// ─────────────────────────────────────────────────────────────────────────────

export interface WinCurvePoint { marginPct: number; offered: number; won: number; winRate: number }

export type WinCurve =
  | {
      status: 'measured'; laneId: string; points: WinCurvePoint[];
      suggestedMarginPct: number; renderedClaim: string;
    }
  | {
      status: 'refused'; laneId: string;
      reason: 'no_loss_records' | 'insufficient_quotes';
      observed: string; remedy: string; renderedClaim: string;
    };

/**
 * A quote you always win is priced too low; one you never win is priced too
 * high. Most brokers cannot measure this because they discard the losses.
 *
 * WHICH IS PRECISELY WHY THIS REFUSES A BOOK OF SETTLED LOADS.
 *
 * Every settled load is a won one, so a win rate computed over them has the won
 * loads as its denominator and answers "of the loads we won, how many did we
 * win" — 100% at every margin, by construction.
 *
 * This was found by building it the other way: losses were synthesized at ~45%
 * with a hand-chosen margin/win relationship, the machinery ran, and the write-up
 * carried a note saying the resulting 87-95% rates were an artifact. The note is
 * correct and prose is the wrong place for it — a caveat is what gets dropped
 * when the number is copied into a deck. So the refusal is in the ENGINE.
 *
 * It is a SELECTION defect, not a small-n one. More loads will not fix it.
 */
export function winCurve(
  obs: readonly LaneObservation[], laneId: string, floor = 20,
): WinCurve {
  const lane = obs.filter(o => o.laneId === laneId && o.quotedToShipper > 0);
  const lost = lane.filter(o => !o.won).length;

  if (lane.length && lost === 0) {
    return {
      status: 'refused', laneId, reason: 'no_loss_records',
      observed: `${lane.length} quote(s) on record, ${lost} lost`,
      remedy:
        'A win rate over a book that records only wins is 100% by construction, at every margin. ' +
        'This is a SELECTION defect, not a small-n one, and more quotes will not fix it. Record ' +
        'the quotes you LOSE, from load one — a workflow change, not a code one.',
      renderedClaim:
        `WIN CURVE REFUSED for ${laneId} — ${lane.length} quotes on record and none lost. Every ` +
        'quote here is a won one, so any win rate from it is 100% by construction.',
    };
  }
  if (lane.length < floor) {
    return {
      status: 'refused', laneId, reason: 'insufficient_quotes',
      observed: `${lane.length} quote(s), floor ${floor}`,
      remedy: `Record ${Math.max(0, floor - lane.length)} more quotes on this lane, won and lost.`,
      renderedClaim: `WIN CURVE WITHHELD for ${laneId} — ${lane.length} quotes, floor ${floor}.`,
    };
  }

  const buckets = [0.08, 0.12, 0.16, 0.20, 0.25];
  const points: WinCurvePoint[] = buckets.map((m, i) => {
    const lo = i === 0 ? -Infinity : buckets[i - 1];
    const inB = lane.filter(o => {
      const margin = (o.quotedToShipper - o.carrierRate) / o.quotedToShipper;
      return margin > lo && margin <= m;
    });
    return {
      marginPct: m, offered: inB.length, won: inB.filter(o => o.won).length,
      winRate: inB.length ? inB.filter(o => o.won).length / inB.length : NaN,
    };
  }).filter(p => p.offered > 0);

  // Deliberately crude. A curve fitted to this little data would be false precision.
  const viable = points.filter(p => p.winRate >= 0.5);
  const suggested = viable.length ? viable[viable.length - 1].marginPct : points[0]?.marginPct ?? 0.12;

  return {
    status: 'measured', laneId, points, suggestedMarginPct: suggested,
    renderedClaim:
      `${laneId}: ` +
      points.map(p => `${(p.marginPct * 100).toFixed(0)}% → ${(p.winRate * 100).toFixed(0)}% win (${p.won}/${p.offered})`).join(', ') +
      `. Highest margin still winning >50%: ${(suggested * 100).toFixed(0)}%. ` +
      'Bucketed, not fitted — a curve over this n would be false precision.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Adapter — the only place that knows what a world load looks like
// ─────────────────────────────────────────────────────────────────────────────

export function observationsFrom(
  loads: readonly {
    loadId: string; laneId: string; equipment: string; carrierRate: number;
    quotedToShipper: number; carrierInvoice: number; accessorialsBilled: number;
    detentionMinutes: number; actualDeliveryAt: string; carrierId: string;
  }[],
): LaneObservation[] {
  return loads.map(l => ({
    loadId: l.loadId, laneId: l.laneId, equipment: l.equipment,
    carrierRate: l.carrierRate, quotedToShipper: l.quotedToShipper,
    carrierInvoice: l.carrierInvoice, accessorialsBilled: l.accessorialsBilled,
    detentionMinutes: l.detentionMinutes, deliveredAt: l.actualDeliveryAt,
    carrierId: l.carrierId,
    // EVERY SETTLED LOAD IS A WON ONE. Stamped true because it is true, and
    // `winCurve` refuses on exactly that rather than the fixture pretending
    // otherwise.
    won: true,
  }));
}
