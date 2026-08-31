import { processSingleton } from './economy/processSingleton';

/**
 * Payload — metered-provider credit governor.
 *
 * WHY THIS EXISTS (ledger phase 77). `api/flights` carries ten lines of
 * comment about the OpenSky credit budget: 4,000 credits a day authenticated,
 * 400 anonymous, "polling it on the same 90s TTL burns the whole day's budget
 * in about half an hour". The analysis is correct and unusually careful.
 *
 * Nothing counted. The budget was enforced by a TTL chosen by hand to keep the
 * expected call rate under a number written in a comment, which means the
 * enforcement is an ARGUMENT rather than a mechanism: it holds exactly as long
 * as no second caller appears, no retry loop fires, and nobody edits the TTL
 * without re-doing the arithmetic. A quantity maintained in prose, describing
 * something no mechanism tracks, is the shape this codebase has paid for more
 * than once.
 *
 * THE PART TAKEN FROM ELSEWHERE, AND WHY IT FITS. The structure of the rate
 * registry below is adapted from `voiceCost.js` in the MIT-licensed
 * `gods-eye-view` project, which states the principle better than I would
 * have: *model ids and prices are external facts that drift*, so each rate
 * carries the date it was read and the page it was read from, and a release
 * check re-reads them. That is `knownAt` under another name, and it is the
 * missing half of every cap in this tree.
 *
 * WHAT IS DIFFERENT HERE, and it is the point. A cap this module has never
 * verified is not silently treated as fact. Every entry declares its
 * provenance as one of two states:
 *
 *   - `verified`   — read from the provider's own published page, on a date,
 *                    with the URL recorded.
 *   - `restated`   — copied from a comment in this repository by someone who
 *                    did not check it. Usable, never quotable.
 *
 * Both are enforced identically; they differ in what a caller may SAY about
 * them. Every cap below is `restated`, because that is the truth: they were
 * lifted from `api/flights`'s comments during this phase and no vendor page
 * was opened. Recording that is cheaper than discovering later that a number
 * everybody trusted came from a comment somebody wrote from memory.
 */

/** How a cap came to be believed. Never collapse these into one. */
export type CapProvenance =
  /** Read from the provider's published limits, on a date, with a URL. */
  | 'verified'
  /** Copied from a comment in this repository. Enforced, not quotable. */
  | 'restated';

export interface ProviderBudget {
  /** What one unit of spend is. Credits and requests are not the same thing. */
  readonly unit: 'credit' | 'request';
  /** Units permitted per UTC day. */
  readonly dailyCap: number;
  /** Fraction of the cap at which a caller is warned rather than refused. */
  readonly warnAt: number;
  readonly provenance: CapProvenance;
  /** ISO date the cap was read from `source`. Null when `restated`. */
  readonly verifiedOn: string | null;
  /** Where the number came from — a URL when verified, a path when restated. */
  readonly source: string;
}

/**
 * The metered providers this instrument calls.
 *
 * Adding one here is the whole registration: `charge()` REFUSES an unknown
 * provider rather than waving it through, so a new metered call cannot reach a
 * vendor without someone writing down what it costs and where that number came
 * from. That is the route-disposition rule applied to spend.
 */
export const PROVIDER_BUDGETS: Readonly<Record<string, ProviderBudget>> = {
  'opensky-authenticated': {
    unit: 'credit',
    dailyCap: 4000,
    warnAt: 0.8,
    provenance: 'restated',
    verifiedOn: null,
    source: 'src/app/api/flights/route.ts comment, phase 77 — not checked against OpenSky',
  },
  'opensky-anonymous': {
    unit: 'credit',
    dailyCap: 400,
    warnAt: 0.8,
    provenance: 'restated',
    verifiedOn: null,
    source: 'src/app/api/flights/route.ts comment, phase 77 — not checked against OpenSky',
  },
};

/** The three answers a spend request can get. Never a boolean. */
export type ChargeStatus =
  /** Spend recorded, comfortably inside the cap. */
  | 'within'
  /** Spend recorded, and the caller is past `warnAt`. Still permitted. */
  | 'warned'
  /** Spend NOT recorded. The call must not be made. */
  | 'refused';

export interface ChargeResult {
  readonly status: ChargeStatus;
  readonly provider: string;
  readonly spent: number;
  readonly remaining: number;
  readonly cap: number;
  /** Present when refused, and when a cap is enforced but not quotable. */
  readonly reason?: string;
  readonly provenance?: CapProvenance;
}

type DayLedger = Map<string, number>;

/**
 * Anchored on `globalThis` rather than a module-level `Map`.
 *
 * Next.js runs the instrumentation hook in a different module context from
 * route handlers, so a module-level counter is TWO counters that each look
 * correct and each under-count. That is instance 4 of the severance class
 * (`sessionTelemetry`, phase 37), and a budget is exactly the kind of state it
 * ruins: two half-counts never reach a cap that one whole count would.
 */
function ledger(): DayLedger {
  return processSingleton<DayLedger>('payload.providerBudget.v1', () => new Map());
}

/** UTC day key. Derived from the passed clock, never from a clock read here. */
export function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function slot(provider: string, at: number): string {
  return `${provider}@${dayKey(at)}`;
}

/**
 * Record spend against a provider's daily cap.
 *
 * THE CLOCK IS AN ARGUMENT. Phase 65 recorded a module that took `atPickup` as
 * a parameter and then called `Date.now()` for the authority window — one
 * mechanism reading two clocks, agreeing with neither caller. `at` is required
 * here for the same reason, and it is the only clock this module has.
 */
export function charge(provider: string, units: number, at: number): ChargeResult {
  const budget = PROVIDER_BUDGETS[provider];

  // Refuse, don't default. An unknown provider is not an unmetered one — it is
  // a call nobody costed, and treating it as free is how a cap gets discovered
  // by a vendor's 429 instead of by this function.
  if (!budget) {
    return {
      status: 'refused',
      provider,
      spent: 0,
      remaining: 0,
      cap: 0,
      reason:
        `No budget is declared for '${provider}'. Add it to PROVIDER_BUDGETS with its cap ` +
        `and where that number came from; an undeclared provider is refused rather than ` +
        `assumed free.`,
    };
  }

  if (!Number.isFinite(units) || units < 0) {
    return {
      status: 'refused',
      provider,
      spent: 0,
      remaining: budget.dailyCap,
      cap: budget.dailyCap,
      reason: `Spend must be a non-negative finite number of ${budget.unit}s; received ${units}.`,
    };
  }

  const key = slot(provider, at);
  const l = ledger();
  const spent = l.get(key) ?? 0;
  const wouldBe = spent + units;

  if (wouldBe > budget.dailyCap) {
    // The spend is NOT recorded: a refused call was not made, so charging for
    // it would make tomorrow's first request look like today's overrun.
    return {
      status: 'refused',
      provider,
      spent,
      remaining: budget.dailyCap - spent,
      cap: budget.dailyCap,
      provenance: budget.provenance,
      reason:
        `${units} ${budget.unit}(s) would exceed the daily cap of ${budget.dailyCap} ` +
        `(${spent} already spent today). The cap resets at the next UTC day.`,
    };
  }

  l.set(key, wouldBe);
  const status: ChargeStatus = wouldBe >= budget.dailyCap * budget.warnAt ? 'warned' : 'within';

  return {
    status,
    provider,
    spent: wouldBe,
    remaining: budget.dailyCap - wouldBe,
    cap: budget.dailyCap,
    provenance: budget.provenance,
    ...(budget.provenance === 'restated'
      ? {
          reason:
            `Cap enforced but NOT verified: it was restated from ${budget.source}. ` +
            `Do not report it as the provider's published limit.`,
        }
      : {}),
  };
}

export interface BudgetState {
  readonly provider: string;
  readonly cap: number;
  readonly spent: number;
  readonly remaining: number;
  readonly provenance: CapProvenance;
  readonly verifiedOn: string | null;
  readonly source: string;
  /** Days since the cap was verified. Null when it never was. */
  readonly stalenessDays: number | null;
  /** True when this figure may be reported as the provider's published limit. */
  readonly quotable: boolean;
}

/**
 * What is known about a provider's budget right now, including how well it is
 * known — so a caller rendering "3,900 of 4,000 credits" can also say whether
 * the 4,000 is a fact or a restatement.
 *
 * `stalenessDays` is separate from `spent` deliberately: phase 67 established
 * that depth and staleness get confused when one number carries both, and a
 * cap verified two years ago is not a fact about today's pricing page.
 */
export function budgetState(provider: string, at: number): BudgetState | null {
  const budget = PROVIDER_BUDGETS[provider];
  if (!budget) return null;
  const spent = ledger().get(slot(provider, at)) ?? 0;
  const stalenessDays =
    budget.verifiedOn === null
      ? null
      : Math.floor((at - Date.parse(budget.verifiedOn)) / 86_400_000);
  return {
    provider,
    cap: budget.dailyCap,
    spent,
    remaining: budget.dailyCap - spent,
    provenance: budget.provenance,
    verifiedOn: budget.verifiedOn,
    source: budget.source,
    stalenessDays,
    quotable: budget.provenance === 'verified',
  };
}

/** Test seam: drop today's counters. */
export function resetBudgets(): void {
  ledger().clear();
}
