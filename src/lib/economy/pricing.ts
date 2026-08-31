// src/lib/economy/pricing.ts
//
// QUOTING FROM YOUR OWN RECORD.
//
// Everything before this records and verifies. This is the first module that
// PRICES — and the first where the record either pays for itself or reveals it
// has nothing to say yet.
//
// The governing behaviour is not the price. It is knowing when there isn't one:
//
//   n >= CONFIDENT_FLOOR   price from own record, normal band, CONFIDENT
//   n >= INDICATIVE_FLOOR  price from own record, wider band, INDICATIVE
//   n <  INDICATIVE_FLOOR  REFUSE, and name the fallback
//   any n, too concentrated  REFUSE REGARDLESS OF n
//
// A quote from four loads and a quote from eighty are different objects.
// Rendering them identically is the defect this codebase keeps catching.

import type { WorldLoad } from './freightWorld';

export type Currency = 'CAD' | 'USD';
export interface Money { amount: number; currency: Currency }

/** Below this, a price is not offered at all. */
export const INDICATIVE_FLOOR = 5;
/** At or above this, the band narrows and the quote is called confident. */
export const CONFIDENT_FLOOR = 20;
/**
 * THE CONCENTRATION CEILING — a generalisation of the single-carrier rule.
 *
 * "All on one carrier" is the clean case, and refusing it is right: n over one
 * carrier is ONE OBSERVATION REPEATED, and its median tells you what that carrier
 * charges, not what the lane costs.
 *
 * But 17 loads with 15 on one carrier is not meaningfully better, and a rule
 * keyed on `distinctCarriers > 1` passes it. The lane's own concentration is
 * the thing being asked about, so it is measured as a share and compared to a
 * ceiling — the same discipline as the HHI work in the commodity layer, where
 * "how many independent observers" is never answered by counting rows.
 */
export const MAX_CARRIER_SHARE = 0.7;
/** Win rates need this many recorded QUOTES — won and lost — before they mean anything. */
export const WIN_CURVE_FLOOR = 20;

// ─────────────────────────────────────────────────────────────────────────────
// 1. What a lane's history actually supports
// ─────────────────────────────────────────────────────────────────────────────

export interface LaneStats {
  laneId: string;
  equipment: string;
  n: number;
  distinctCarriers: number;
  /** The largest share any single carrier holds. n is not independence. */
  maxCarrierShare: number;
  spanDays: number;
  carrierCostMedian: number;
  carrierCostP25: number;
  carrierCostP75: number;
  /** (p75 - p25) / median. What the lane actually varies by. */
  spreadPct: number;
  accessorialMean: number;
  accessorialIncidence: number;
  currency: Currency;
}

const quantile = (sorted: readonly number[], q: number): number => {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

export function laneStats(loads: readonly WorldLoad[], laneId: string, equipment: string): LaneStats | null {
  const sel = loads.filter(l => l.laneId === laneId && l.equipment === equipment);
  if (!sel.length) return null;
  const costs = sel.map(l => l.carrierInvoice).sort((a, b) => a - b);
  const byCarrier = new Map<string, number>();
  for (const l of sel) byCarrier.set(l.carrierId, (byCarrier.get(l.carrierId) ?? 0) + 1);
  const times = sel.map(l => Date.parse(l.actualDeliveryAt));
  const median = quantile(costs, 0.5);
  const p25 = quantile(costs, 0.25), p75 = quantile(costs, 0.75);
  const withAcc = sel.filter(l => l.accessorialsBilled > 0);
  return {
    laneId, equipment, n: sel.length,
    distinctCarriers: byCarrier.size,
    maxCarrierShare: Math.max(...byCarrier.values()) / sel.length,
    spanDays: Math.round((Math.max(...times) - Math.min(...times)) / 86_400_000),
    carrierCostMedian: Math.round(median),
    carrierCostP25: Math.round(p25), carrierCostP75: Math.round(p75),
    spreadPct: median === 0 ? 0 : (p75 - p25) / median,
    accessorialMean: withAcc.length
      ? Math.round(withAcc.reduce((a, l) => a + l.accessorialsBilled, 0) / sel.length) : 0,
    accessorialIncidence: withAcc.length / sel.length,
    currency: 'CAD',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The quote — or the refusal, which is the product
// ─────────────────────────────────────────────────────────────────────────────

export type QuoteRefusal =
  | 'no_lane_history'
  | 'insufficient_lane_history'
  | 'carrier_concentration';

export type Quote =
  | {
      status: 'priced';
      confidence: 'confident' | 'indicative';
      laneId: string; equipment: string;
      quoted: Money;
      /** The band an operator should actually work within. */
      workingBand: { low: number; high: number };
      /** Working capital the load consumes until the shipper pays. */
      capitalTiedUp: Money;
      paymentTermsDays: number;
      stats: LaneStats;
      renderedClaim: string;
    }
  | {
      status: 'refused';
      reason: QuoteRefusal;
      laneId: string; equipment: string;
      observed: string;
      /** Never leave an operator with nothing. */
      fallback: string;
      renderedClaim: string;
    };

export interface QuotePolicy {
  targetMarginPct: number;
  /** Band half-width as a fraction, before the spread and confidence adders. */
  baseBandPct: number;
  paymentTermsDays: number;
}

export const DEFAULT_QUOTE_POLICY: QuotePolicy = {
  targetMarginPct: 0.16, baseBandPct: 0.06, paymentTermsDays: 45,
};

export function quoteLane(
  loads: readonly WorldLoad[], laneId: string, equipment: string,
  policy: QuotePolicy = DEFAULT_QUOTE_POLICY,
): Quote {
  const s = laneStats(loads, laneId, equipment);
  const base = { laneId, equipment };

  if (!s) {
    return {
      ...base, status: 'refused', reason: 'no_lane_history',
      observed: 'no settled loads on this lane and equipment',
      fallback: 'Price from a market reference and record the outcome. This pair has no history at all.',
      renderedClaim: `NO RECORD-BASED PRICE for ${laneId} ${equipment} — no history.`,
    };
  }
  if (s.n < INDICATIVE_FLOOR) {
    return {
      ...base, status: 'refused', reason: 'insufficient_lane_history',
      observed: `${s.n} load(s), floor ${INDICATIVE_FLOOR}`,
      fallback:
        'Price from a market reference. Record the outcome — this lane needs history before it ' +
        'can price itself.',
      renderedClaim:
        `NO RECORD-BASED PRICE for ${laneId} ${equipment} — ${s.n} load(s), floor ${INDICATIVE_FLOOR}. ` +
        'Four observations do not make a median.',
    };
  }
  if (s.distinctCarriers < 2 || s.maxCarrierShare > MAX_CARRIER_SHARE) {
    // THE REFUSAL THAT LOOKS LIKE A FALSE NEGATIVE AND IS NOT. n looks fine and
    // the statistic is worthless: most pricing tools would quote confidently here.
    return {
      ...base, status: 'refused', reason: 'carrier_concentration',
      observed:
        `${s.n} loads but ${s.distinctCarriers} carrier(s), the largest holding ` +
        `${(s.maxCarrierShare * 100).toFixed(0)}% (ceiling ${(MAX_CARRIER_SHARE * 100).toFixed(0)}%)`,
      fallback:
        'Tender this lane to two or three more carriers before pricing from it. Until then the ' +
        'record shows what one carrier charges, not what the lane costs.',
      renderedClaim:
        `NO RECORD-BASED PRICE for ${laneId} ${equipment} — ${s.n} loads, but ` +
        `${(s.maxCarrierShare * 100).toFixed(0)}% on one carrier. That is one carrier's pricing, ` +
        'not the lane\'s — it cannot tell you whether you are paying market.',
    };
  }

  const confidence = s.n >= CONFIDENT_FLOOR ? 'confident' as const : 'indicative' as const;
  const carrierCost = s.carrierCostMedian + s.accessorialMean;
  const quoted = Math.round(carrierCost / (1 - policy.targetMarginPct));

  // THE BAND WIDENS FOR BOTH observed spread and low confidence, because both
  // are real sources of error and collapsing them would hide which one is biting.
  const confidenceAdder = confidence === 'confident' ? 0 : 0.06;
  const half = policy.baseBandPct + s.spreadPct / 2 + confidenceAdder;
  const workingBand = {
    low: Math.round(quoted * (1 - half)),
    high: Math.round(quoted * (1 + half)),
  };
  const capitalTiedUp = Math.round(carrierCost * (1 + policy.paymentTermsDays / 30 * 0.02) + carrierCost * 0.15);

  return {
    ...base, status: 'priced', confidence,
    quoted: { amount: quoted, currency: s.currency },
    workingBand,
    capitalTiedUp: { amount: capitalTiedUp, currency: s.currency },
    paymentTermsDays: policy.paymentTermsDays,
    stats: s,
    renderedClaim:
      `$${quoted} on ${laneId} ${equipment} — ${confidence.toUpperCase()}, from ${s.n} settled ` +
      `loads across ${s.distinctCarriers} carriers over ${s.spanDays} days ` +
      `(largest carrier ${(s.maxCarrierShare * 100).toFixed(0)}%). Carrier cost median ` +
      `$${s.carrierCostMedian} (IQR $${s.carrierCostP25}-$${s.carrierCostP75}, spread ` +
      `${(s.spreadPct * 100).toFixed(0)}%), accessorial exposure $${s.accessorialMean} ` +
      `(${(s.accessorialIncidence * 100).toFixed(0)}% of loads incur one). ` +
      `Work within $${workingBand.low}-$${workingBand.high}. ` +
      `Ties up $${capitalTiedUp} until day ${policy.paymentTermsDays}.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Density — the commercial argument, made quantitative
// ─────────────────────────────────────────────────────────────────────────────

export interface DensityReport {
  pairs: number;
  atConfidentFloor: number;
  atIndicativeFloor: number;
  unpriceable: number;
  densest: Array<{ laneId: string; equipment: string; n: number }>;
  note: string;
}

export function laneDensity(loads: readonly WorldLoad[]): DensityReport {
  const counts = new Map<string, number>();
  for (const l of loads) {
    const k = `${l.laneId}|${l.equipment}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const rows = [...counts].map(([k, n]) => {
    const [laneId, equipment] = k.split('|');
    return { laneId, equipment, n };
  }).sort((a, b) => b.n - a.n);
  return {
    pairs: rows.length,
    atConfidentFloor: rows.filter(r => r.n >= CONFIDENT_FLOOR).length,
    atIndicativeFloor: rows.filter(r => r.n >= INDICATIVE_FLOOR).length,
    unpriceable: rows.filter(r => r.n < INDICATIVE_FLOOR).length,
    densest: rows.slice(0, 6),
    note:
      'Spot variety starves the pricer. The same book concentrated on a handful of lanes ' +
      'prices all of them; spread thin it prices almost none. That is a decision about which ' +
      'lanes to chase, and it is visible here rather than left to instinct.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The win curve — and why this one REFUSES rather than reporting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A quote you always win is priced too low, so the win curve is the half of
 * pricing most brokers cannot measure — they discard the losses.
 *
 * WHICH IS EXACTLY WHY THIS REFUSES.
 *
 * The fixture, and any book of settled loads, records only WON quotes. A win
 * rate computed over won loads has the won loads as its denominator, so it
 * answers "of the loads we won, how many did we win" — which is 100% by
 * construction, whatever the margin.
 *
 * The supplied design synthesized losses at ~45% with a hand-chosen margin/win
 * relationship, exercised the machinery, and flagged in its README that the
 * resulting 87-95% rates were an artifact. That flag is correct and it is the
 * wrong place for it: a caveat in prose is what gets dropped when the number is
 * copied into a deck. So the ENGINE refuses, and the refusal names the workflow
 * change rather than a code one — record the quotes you lose, from load one.
 *
 * This is a SELECTION defect, not a small-n one. More loads will not fix it.
 */
export type WinCurveVerdict =
  | {
      status: 'measured';
      laneId: string;
      buckets: Array<{ marginPct: number; quotes: number; won: number; winRate: number }>;
      highestMarginStillWinning: number | null;
      renderedClaim: string;
    }
  | {
      status: 'refused';
      laneId: string;
      reason: 'no_loss_records' | 'insufficient_quotes';
      observed: string;
      remedy: string;
      renderedClaim: string;
    };

export interface QuoteOutcome {
  laneId: string;
  marginPct: number;
  won: boolean;
}

export function winCurve(
  quotes: readonly QuoteOutcome[], laneId: string, floor = WIN_CURVE_FLOOR,
): WinCurveVerdict {
  const sel = quotes.filter(q => q.laneId === laneId);
  const lost = sel.filter(q => !q.won).length;

  if (lost === 0) {
    // THE LOAD-BEARING REFUSAL. Not "too few" — the wrong population entirely.
    return {
      status: 'refused', laneId, reason: 'no_loss_records',
      observed: `${sel.length} quote(s) on ${laneId}, ${lost} recorded as lost`,
      remedy:
        'A win rate over a book that records only wins is 100% by construction, at every ' +
        'margin. This is a SELECTION defect, not a small-n one, and more loads will not fix ' +
        'it. Record the quotes you LOSE, from load one — a workflow change, not a code one.',
      renderedClaim:
        `WIN CURVE REFUSED for ${laneId} — no lost quotes on record. Every quote here is a won ` +
        'one, so any win rate computed from it is 100% by construction and says nothing about price.',
    };
  }
  if (sel.length < floor) {
    return {
      status: 'refused', laneId, reason: 'insufficient_quotes',
      observed: `${sel.length} quote(s), floor ${floor}`,
      remedy: `Record ${floor - sel.length} more quotes on this lane, won and lost.`,
      renderedClaim: `WIN CURVE WITHHELD for ${laneId} — ${sel.length} quotes, floor ${floor}.`,
    };
  }

  const bucketOf = (m: number) => Math.round(m * 100 / 4) * 4;
  const agg = new Map<number, { quotes: number; won: number }>();
  for (const q of sel) {
    const b = bucketOf(q.marginPct);
    const e = agg.get(b) ?? { quotes: 0, won: 0 };
    e.quotes++; if (q.won) e.won++;
    agg.set(b, e);
  }
  const buckets = [...agg].sort((a, b) => a[0] - b[0])
    .map(([marginPct, e]) => ({ marginPct, quotes: e.quotes, won: e.won, winRate: e.won / e.quotes }));
  const winning = buckets.filter(b => b.winRate > 0.5);

  return {
    status: 'measured', laneId, buckets,
    highestMarginStillWinning: winning.length ? winning[winning.length - 1].marginPct : null,
    renderedClaim:
      `${laneId}: ` +
      buckets.map(b => `${b.marginPct}% → ${(b.winRate * 100).toFixed(0)}% win (${b.won}/${b.quotes})`).join(', ') +
      `. Highest margin still winning >50%: ` +
      `${winning.length ? `${winning[winning.length - 1].marginPct}%` : 'none'}. ` +
      'Bucketed, not fitted — a curve over this n would be false precision.',
  };
}
