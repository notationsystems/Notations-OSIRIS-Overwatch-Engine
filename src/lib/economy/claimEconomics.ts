// src/lib/economy/claimEconomics.ts
//
// INCENTIVES AND CONSEQUENCES ON CLAIMABLE ARTIFACTS
//
// A claim without consequence is a suggestion. But the consequences available to
// a broker are narrower than instinct suggests, and building the wrong one
// produces a clause that is unenforceable exactly when you need it.
//
//   ✓ COVER COST — tendered $2,400, they no-showed, you re-covered at $2,700.
//     The $300 is a REAL, COMPUTED damage evidenced by two records you hold.
//   ✓ DECAY PRICING — the offer is worth less the longer it sits. Needs no
//     enforcement at all; it is simply the terms of the offer.
//   ✓ PRIORITY TIERING — good records see loads first. Costs nothing.
//   ✗ PENALTY CLAUSES — a fixed "$500 no-show fee" unrelated to actual loss is a
//     penalty, and penalty clauses are generally unenforceable in Canadian and US
//     common law. Liquidated damages must be a reasonable pre-estimate of loss.
//     A cover cost IS that; a round number is not.
//
// And the symmetry, which is both fairer and more defensible: if you charge cover
// costs when a carrier defaults, you owe TONU when you cancel on a carrier who
// dispatched. A one-sided regime is the first thing a carrier's lawyer attacks
// and the first thing a good carrier declines to sign.
//
// NOT LEGAL ADVICE. The enforceability reasoning above is why the code is shaped
// this way; whether a given clause holds is for counsel and jurisdiction.

import type { ISODateTime } from './types';
import { MIN_OBSERVATIONS } from './carrierTrust';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Incentive — priced into the offer, needing no enforcement
// ─────────────────────────────────────────────────────────────────────────────

export type Currency = 'CAD' | 'USD';

export interface Money { amount: number; currency: Currency }

export interface ClaimIncentive {
  baseRate: number;
  currency: Currency;
  /**
   * The offer is worth less the longer it sits — because it IS worth less:
   * coverage risk rises, alternatives narrow, the shipper's window closes. Not a
   * penalty; the offer repricing against a real cost.
   */
  decay: Array<{ afterSeconds: number; rate: number }>;
  /** Carriers in a higher tier see the offer earlier. Zero cost, pure sequencing. */
  tierHeadStartSeconds: number;
  raceToClaim: boolean;
}

export type RateAtClaim =
  | { status: 'priced'; rate: number; currency: Currency; elapsedSeconds: number; stepApplied: number | null }
  | { status: 'refused'; reason: 'claimed_before_offered'; elapsedSeconds: number; detail: string };

/** Deterministic. A claim before the offer existed is refused, not priced at base. */
export function rateAtClaim(inc: ClaimIncentive, offeredAt: string, claimedAt: string): RateAtClaim {
  const elapsed = (Date.parse(claimedAt) - Date.parse(offeredAt)) / 1000;
  if (!Number.isFinite(elapsed)) {
    return { status: 'refused', reason: 'claimed_before_offered', elapsedSeconds: NaN,
      detail: 'unparseable instants; a rate cannot be derived from a duration that does not exist' };
  }
  if (elapsed < 0) {
    // Falling through to the base rate here would price a claim that predates its
    // own offer, and price it FAVOURABLY — the cheapest possible attack on a decay
    // schedule is a clock that runs backwards.
    return {
      status: 'refused', reason: 'claimed_before_offered', elapsedSeconds: elapsed,
      detail:
        `claimed ${Math.abs(elapsed)}s BEFORE the offer was made. Pricing this at base would ` +
        'reward a backwards clock with the best rate on the schedule.',
    };
  }
  let rate = inc.baseRate, step: number | null = null;
  for (const d of [...inc.decay].sort((a, b) => a.afterSeconds - b.afterSeconds)) {
    if (elapsed >= d.afterSeconds) { rate = d.rate; step = d.afterSeconds; }
  }
  return { status: 'priced', rate, currency: inc.currency, elapsedSeconds: elapsed, stepApplied: step };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Default — what happens when a claim is accepted and then broken
// ─────────────────────────────────────────────────────────────────────────────

export type DefaultKind =
  | 'no_show'
  | 'late_cancel'
  | 'lapsed_unclaimed'     // never claimed — not a default, but a recorded non-response
  | 'broker_cancelled';    // WE cancelled after they accepted — symmetric obligation

export interface ClaimDefault {
  defaultId: string;
  claimableId: string;
  loadId: string;
  party: string;
  kind: DefaultKind;
  occurredAt: ISODateTime;
  /** Notice given, in seconds before the pickup window. Drives the TONU tier. */
  noticeSeconds: number | null;
  evidenceIds: string[];
}

/**
 * Cover cost: the only figure here that is a genuine damage rather than an
 * asserted one, computed from two records you already hold.
 *
 * FOUR-VALUED, because the currency case is its own answer.
 *
 * The supplied design took bare numbers for both rates. `ClaimIncentive` and
 * `TonuSchedule` beside it each carry a currency, so the one figure that ends up
 * on an invoice was the one with no unit. A CAD tender re-covered by a US carrier
 * at USD 2,700 subtracts to "300" and gets billed in whichever currency the
 * caller assumed. `downstreamImpact` in `lifecycle.ts` already throws
 * MIXED_CURRENCY on exactly this shape; refusing here is the same rule applied
 * where the money leaves the building.
 */
export type CoverCost =
  | { status: 'incurred'; amount: Money; original: Money; recovered: Money; recoveredWith: string; evidenceIds: string[] }
  | { status: 'none'; reason: 'recovered_at_or_below_original'; original: Money; recovered: Money }
  | { status: 'undetermined'; reason: 'load_not_recovered' | 'recovery_rate_unknown'; remedy: string }
  | { status: 'refused'; reason: 'mixed_currency'; original: Money; recovered: Money; remedy: string };

export function computeCoverCost(args: {
  original: Money;
  recovery: { rate: Money; carrierId: string; evidenceIds: string[] } | null;
  loadWasMoved: boolean;
}): CoverCost {
  if (!args.recovery) {
    return args.loadWasMoved
      ? { status: 'undetermined', reason: 'recovery_rate_unknown',
          remedy:
            'The load moved but the covering rate is not recorded. Cover cost cannot be computed ' +
            'from an unrecorded rate — enter it, or the claim is unevidenced.' }
      : { status: 'undetermined', reason: 'load_not_recovered',
          remedy:
            'The load was not re-covered, so NO COVER COST WAS INCURRED. Other damages may exist ' +
            '(a lost customer, a missed window) but they are not this figure and must not be ' +
            'billed as it. Billing one anyway converts damages into a penalty, which is the ' +
            'thing that makes the clause unenforceable.' };
  }
  if (args.recovery.rate.currency !== args.original.currency) {
    return {
      status: 'refused', reason: 'mixed_currency',
      original: args.original, recovered: args.recovery.rate,
      remedy:
        `Tendered in ${args.original.currency}, re-covered in ${args.recovery.rate.currency}. ` +
        'A cover cost is a subtraction, and subtracting across currencies needs a rate and a ' +
        'date this function does not have. Restate one leg, or the figure is a number with no ' +
        'unit wearing the label of one — on an invoice.',
    };
  }
  const delta = args.recovery.rate.amount - args.original.amount;
  if (delta <= 0) {
    return { status: 'none', reason: 'recovered_at_or_below_original',
      original: args.original, recovered: args.recovery.rate };
  }
  return {
    status: 'incurred',
    amount: { amount: delta, currency: args.original.currency },
    original: args.original, recovered: args.recovery.rate,
    recoveredWith: args.recovery.carrierId, evidenceIds: args.recovery.evidenceIds,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Symmetry — TONU when we are the ones who cancel
// ─────────────────────────────────────────────────────────────────────────────

export interface TonuSchedule {
  /** Notice bands. Shorter notice, larger obligation — their cost is real. */
  bands: Array<{ withinSeconds: number; amount: number }>;
  currency: Currency;
}

export const DEFAULT_TONU: TonuSchedule = {
  currency: 'CAD',
  bands: [
    { withinSeconds: 2 * 3600, amount: 250 },    // driver already rolling
    { withinSeconds: 12 * 3600, amount: 150 },
    { withinSeconds: 24 * 3600, amount: 75 },
  ],
};

/**
 * What WE owe when we cancel on a carrier who accepted. Not generosity — the
 * clause that makes the cover-cost clause survive a carrier's lawyer, and the
 * reason a good carrier signs your agreement rather than someone else's.
 */
export function tonuOwed(noticeSeconds: number, sched: TonuSchedule = DEFAULT_TONU): {
  owed: Money; band: number | null; note: string;
} {
  const h = (s: number) => Math.round(s / 3600);
  for (const b of [...sched.bands].sort((a, x) => a.withinSeconds - x.withinSeconds)) {
    if (noticeSeconds <= b.withinSeconds) {
      return {
        owed: { amount: b.amount, currency: sched.currency }, band: b.withinSeconds,
        note: `${h(noticeSeconds)}h notice — within the ${h(b.withinSeconds)}h band.`,
      };
    }
  }
  return {
    owed: { amount: 0, currency: sched.currency }, band: null,
    note: `${h(noticeSeconds)}h notice — beyond all bands, no TONU owed.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The compounding lever — defaults become trust components
// ─────────────────────────────────────────────────────────────────────────────

export interface ResponseProfile {
  party: string;
  offersMade: number;
  claimed: number;
  accepted: number;
  declined: number;
  lapsed: number;
  noShows: number;
  lateCancels: number;
  /** Median seconds to claim. Median, not mean — one 3-day outlier is not the story. */
  medianClaimSeconds: number | null;
  coverCostIncurred: Money;
}

export type Tier = 'priority' | 'standard' | 'restricted';

export type ResponseVerdict =
  | {
      status: 'assessed';
      profile: ResponseProfile;
      /** null when there is no denominator. A rate over zero accepted is not 0%. */
      noShowRate: number | null;
      lapseRate: number;
      tier: Tier;
      renderedClaim: string;
    }
  | {
      status: 'insufficient_observations';
      offersMade: number; floor: number; remedy: string; renderedClaim: string;
    };

/**
 * The n-floor: two no-shows out of three offers is a 67% no-show rate and it is
 * NOT a fact about the carrier. Below the floor the components are WITHHELD
 * rather than reported with a caveat, because a rate reported with a caveat gets
 * quoted without one.
 *
 * The floor is `MIN_OBSERVATIONS`, imported rather than defaulted here. The
 * supplied design had `floor = 10` in this function and `8` in the trust policy,
 * and quoted both numbers in one report — so a carrier with 9 loads had its
 * behavioural components admitted to the trust basis and its response profile
 * withheld, in the same assessment.
 */
export function assessResponse(p: ResponseProfile, floor: number = MIN_OBSERVATIONS): ResponseVerdict {
  if (p.offersMade < floor) {
    return {
      status: 'insufficient_observations', offersMade: p.offersMade, floor,
      remedy:
        `${p.offersMade} offers is below the ${floor} floor. Response rates are withheld, not ` +
        'estimated — a 2-of-3 no-show rate is noise wearing a percentage.',
      renderedClaim: `Response profile WITHHELD for ${p.party} — ${p.offersMade} offers, floor ${floor}.`,
    };
  }

  // NO SILENT DENOMINATOR. The supplied design divided by `Math.max(accepted, 1)`,
  // so a carrier with 15 offers and 0 accepted reported "No-show 0.0% (0/0)" — a
  // clean record computed over an empty population, which reads as evidence of
  // reliability and is evidence of nothing.
  const noShowRate = p.accepted > 0 ? p.noShows / p.accepted : null;
  const lapseRate = p.lapsed / p.offersMade;

  const tier: Tier =
    noShowRate === 0 && lapseRate < 0.2 && (p.medianClaimSeconds ?? Infinity) < 30 * 60 ? 'priority'
    : (noShowRate !== null && noShowRate > 0.08) || lapseRate > 0.55 ? 'restricted'
    : 'standard';

  const med = p.medianClaimSeconds === null ? 'unknown' : `${Math.round(p.medianClaimSeconds / 60)} min`;
  const noShowText = noShowRate === null
    ? `No-show rate UNDETERMINED — ${p.noShows} no-show(s) but 0 accepted, so there is no denominator`
    : `No-show ${(noShowRate * 100).toFixed(1)}% of accepted (${p.noShows}/${p.accepted})`;

  return {
    status: 'assessed', profile: p, noShowRate, lapseRate, tier,
    renderedClaim:
      `${p.party}: ${p.offersMade} offers, ${p.claimed} claimed, median response ${med}. ` +
      `${noShowText}, lapse ${(lapseRate * 100).toFixed(0)}%. ` +
      `Cover cost incurred ${p.coverCostIncurred.amount} ${p.coverCostIncurred.currency}. ` +
      `Tier: ${tier.toUpperCase()}` +
      (tier === 'priority' ? ' — sees offers first'
        : tier === 'restricted' ? ' — offers held back pending review' : '') +
      '. Observed from our own records; not a purchased score.',
  };
}

/**
 * Tier drives ACCESS, never exclusion by itself. A restricted carrier still
 * receives offers after the head-start window — a trust profile gates a tender,
 * a human decides a relationship. That line is deliberate, and it is what keeps
 * this from becoming an unreviewable blocklist.
 */
export function headStartFor(tier: Tier, inc: ClaimIncentive): number {
  return tier === 'priority' ? 0
    : tier === 'standard' ? inc.tierHeadStartSeconds
    : inc.tierHeadStartSeconds * 3;
}
