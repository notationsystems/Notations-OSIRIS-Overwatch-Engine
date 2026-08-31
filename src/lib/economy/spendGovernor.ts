/**
 * Payload Terminal — the credit governor for metered providers.
 *
 * WHAT WAS ALREADY HERE, so this builds the gap and not a fourth copy of
 * a solved problem:
 *
 *   `ssrf-guard.ts`      allowlisted destinations, `safeFetch`, per-IP throttle
 *   `outboundRate.ts`    process-wide per-host pacing, so two callers cannot compound
 *   `sourceCache.ts`     TTL cache with stale-on-failure fallback
 *   `/api/proxy-tiles`   the server-side proxy that keeps a key off the client
 *
 * None of those knows what a request COSTS. They decide whether a host is
 * reachable, how fast, and whether the answer is already held. A metered
 * vendor bills anyway. The missing organ is the one that can say *no more
 * this month*, and that is all this module is.
 *
 * FOUR DECISIONS, each stated because each could have gone the other way.
 *
 * 1. AN UNREGISTERED PROVIDER IS REFUSED, not permitted. A governor that
 *    waves through what it does not recognise governs nothing: the first
 *    vendor someone forgets to register is the one that runs up the bill.
 *    Registration is the act of deciding what a provider may spend, so a
 *    provider nobody has decided about has a budget of nothing.
 *
 * 2. COST IS DECLARED IN THE BUDGET'S UNIT, and a mismatch refuses. A cap
 *    of 100_000 tokens and a call costing "1 request" are not comparable,
 *    and the arithmetic that pretends they are produces a number that
 *    looks fine. Two figures denominated differently must never be added
 *    — the same discipline the pricing engine needed for accessorials.
 *
 * 3. RESERVE, THEN SETTLE. For a per-request vendor the cost is known
 *    before the call. For a token-metered one it is known only from the
 *    response, so a governor that can only charge up front cannot govern
 *    it at all. `reserve()` holds the declared estimate against the cap;
 *    `settle()` replaces it with what was actually spent; `release()`
 *    returns it when the call failed. An unsettled reservation keeps
 *    counting — the conservative direction — and is reported separately,
 *    so a leak shows up as held credit rather than silently eating the
 *    budget.
 *
 * 4. THE LEDGER SAYS HOW DURABLE IT IS, on every single decision. Counters
 *    in process memory reset when the process does, which means a crash
 *    loop restores the full monthly budget on every restart while the
 *    vendor's meter keeps climbing. That is not a bug to fix by pretending
 *    otherwise; it is a property of where the ledger lives. So
 *    `durability` ships with every decision and is `'process_memory'`
 *    until a caller supplies a durable store. A cap this module cannot
 *    actually enforce is never reported as one it did.
 */

import { processSingleton } from './processSingleton';

/**
 * What a budget is counted in. There is no `unit: string`, because the
 * point of the unit is that only equal units may be compared.
 *
 * `usd_micros` is integer millionths of a dollar. Money is never a float
 * here: 0.1 + 0.2 is a rounding argument nobody should have with a vendor.
 */
export type SpendUnit = 'requests' | 'tiles' | 'tokens' | 'usd_micros';

export interface ProviderBudget {
  readonly provider: string;
  readonly unit: SpendUnit;
  /** Ceiling for one period, in `unit`. */
  readonly cap: number;
  /** Length of the accounting period, in ms. */
  readonly periodMs: number;
  /** Where the cap comes from — a plan page, a contract, a decision. */
  readonly basis: string;
}

export type SpendVerdict = 'permitted' | 'refused' | 'undetermined';

export type SpendReason =
  | 'within_cap'
  | 'would_exceed_cap'
  | 'provider_not_budgeted'
  | 'unit_mismatch'
  | 'cost_not_stated'
  | 'reservation_unknown'
  | 'reservation_already_settled';

/** Where the numbers backing a decision live, and therefore what they survive. */
export type LedgerDurability = 'process_memory' | 'durable';

export interface SpendDecision {
  readonly verdict: SpendVerdict;
  readonly provider: string;
  readonly reason: SpendReason;
  /** Present only when this call may proceed. Pass it to settle/release. */
  readonly reservationId: string | null;
  /** Committed + held, in the budget's unit. Null when there is no budget. */
  readonly spent: number | null;
  /** Of `spent`, the part held by reservations that have not settled. */
  readonly held: number | null;
  readonly cap: number | null;
  readonly unit: SpendUnit | null;
  readonly periodEndsAt: string | null;
  readonly durability: LedgerDurability;
  /** What the caller can do about a refusal. Empty when permitted. */
  readonly remedy: string;
}

interface Reservation {
  id: string;
  provider: string;
  cost: number;
  settled: boolean;
}

interface PeriodLedger {
  /** Start of the current period, ms since epoch. */
  startedAt: number;
  /** Settled spend in this period. */
  committed: number;
  /** Sum of the costs of reservations still open. */
  held: number;
}

interface GovernorState {
  budgets: Map<string, ProviderBudget>;
  ledgers: Map<string, PeriodLedger>;
  reservations: Map<string, Reservation>;
  /** Monotonic; ids are opaque to callers but stable within a process. */
  seq: number;
  /** Every decision, by verdict — so "never hit the cap" and "never asked" differ. */
  tally: Record<SpendVerdict, number>;
}

const shared = () => processSingleton<GovernorState>('spend-governor', () => ({
  budgets: new Map(),
  ledgers: new Map(),
  reservations: new Map(),
  seq: 0,
  tally: { permitted: 0, refused: 0, undetermined: 0 },
}));

/**
 * Declare what a provider may spend. Re-registering replaces the budget and
 * KEEPS the period ledger: raising a cap mid-month must not also forgive the
 * spend already on it.
 */
export function registerBudget(budget: ProviderBudget): void {
  if (!Number.isFinite(budget.cap) || budget.cap < 0) {
    throw new Error(`spendGovernor: ${budget.provider} cap must be a finite non-negative number in ${budget.unit}`);
  }
  if (!Number.isFinite(budget.periodMs) || budget.periodMs <= 0) {
    throw new Error(`spendGovernor: ${budget.provider} periodMs must be positive`);
  }
  if (!budget.basis.trim()) {
    throw new Error(`spendGovernor: ${budget.provider} needs a basis — where the cap comes from`);
  }
  shared().budgets.set(budget.provider, budget);
}

/**
 * Whether a provider has a budget at all.
 *
 * A call site uses this to tell two states apart that otherwise look
 * identical from outside: *ungoverned because someone decided this vendor
 * does not need a cap*, and *ungoverned because nobody has looked*. The
 * governor itself refuses an unregistered provider — that is right for
 * `reserve()`, which means "govern this call". Whether to govern a surface
 * at all is a deployment decision, and one that has to be visible.
 */
export function isGoverned(provider: string): boolean {
  return shared().budgets.has(provider);
}

export function registeredBudgets(): ProviderBudget[] {
  return [...shared().budgets.values()].sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Roll the ledger forward if `now` has left the period it was opened in. */
function ledgerFor(g: GovernorState, budget: ProviderBudget, now: number): PeriodLedger {
  const existing = g.ledgers.get(budget.provider);
  if (!existing) {
    const fresh = { startedAt: now, committed: 0, held: 0 };
    g.ledgers.set(budget.provider, fresh);
    return fresh;
  }
  if (now - existing.startedAt >= budget.periodMs) {
    // A new period. Open reservations belong to the period they were taken
    // in and are NOT carried: their settle will find the reservation and
    // charge the new period, which is the conservative direction.
    const rolled = { startedAt: now, committed: 0, held: 0 };
    g.ledgers.set(budget.provider, rolled);
    return rolled;
  }
  return existing;
}

function decide(g: GovernorState, d: SpendDecision): SpendDecision {
  g.tally[d.verdict] += 1;
  return d;
}

const refusal = (
  g: GovernorState,
  provider: string,
  reason: SpendReason,
  remedy: string,
  extra: Partial<SpendDecision> = {},
): SpendDecision => decide(g, {
  verdict: 'refused',
  provider,
  reason,
  reservationId: null,
  spent: null,
  held: null,
  cap: null,
  unit: null,
  periodEndsAt: null,
  durability: 'process_memory',
  remedy,
  ...extra,
});

/**
 * Ask whether a call may proceed, and hold its declared cost against the cap
 * if so.
 *
 * `now` is a parameter rather than a clock read, so a period boundary can be
 * tested rather than waited for.
 */
export function reserve(
  provider: string,
  cost: number,
  unit: SpendUnit,
  now: number,
): SpendDecision {
  const g = shared();
  const budget = g.budgets.get(provider);

  if (!budget) {
    return refusal(g, provider, 'provider_not_budgeted',
      `Register a budget for '${provider}' before calling it. An unregistered provider is refused, not permitted — otherwise the first vendor nobody registers is the one that runs up the bill.`);
  }
  if (unit !== budget.unit) {
    return refusal(g, provider, 'unit_mismatch',
      `'${provider}' is capped in ${budget.unit}; this call declared its cost in ${unit}. Convert at the call site, where the conversion rate is known, or register a second budget.`,
      { cap: budget.cap, unit: budget.unit });
  }
  if (!Number.isFinite(cost) || cost < 0) {
    return refusal(g, provider, 'cost_not_stated',
      `A call that cannot state its cost in ${budget.unit} cannot be governed. Declare an upper estimate and correct it with settle().`,
      { cap: budget.cap, unit: budget.unit });
  }

  const ledger = ledgerFor(g, budget, now);
  const spent = ledger.committed + ledger.held;
  const periodEndsAt = new Date(ledger.startedAt + budget.periodMs).toISOString();

  if (spent + cost > budget.cap) {
    return decide(g, {
      verdict: 'refused',
      provider,
      reason: 'would_exceed_cap',
      reservationId: null,
      spent,
      held: ledger.held,
      cap: budget.cap,
      unit: budget.unit,
      periodEndsAt,
      durability: 'process_memory',
      remedy: `${spent} of ${budget.cap} ${budget.unit} committed or held this period (cap basis: ${budget.basis}); this call needs ${cost}. Wait for the period to roll at ${periodEndsAt}, raise the cap deliberately, or serve the request from cache.`,
    });
  }

  g.seq += 1;
  const id = `${provider}#${g.seq}`;
  g.reservations.set(id, { id, provider, cost, settled: false });
  ledger.held += cost;

  return decide(g, {
    verdict: 'permitted',
    provider,
    reason: 'within_cap',
    reservationId: id,
    spent: spent + cost,
    held: ledger.held,
    cap: budget.cap,
    unit: budget.unit,
    periodEndsAt,
    durability: 'process_memory',
    remedy: '',
  });
}

/**
 * Replace a reservation's estimate with what the call actually cost.
 *
 * This is the half that makes token-metered providers governable: the
 * estimate goes in before the request, the truth goes in after it.
 */
export function settle(reservationId: string, actualCost: number, now: number): SpendDecision {
  const g = shared();
  const r = g.reservations.get(reservationId);
  if (!r) {
    return refusal(g, 'unknown', 'reservation_unknown',
      `No reservation '${reservationId}'. Settling an id the governor never issued would charge a provider for a call it cannot attribute.`);
  }
  if (r.settled) {
    return refusal(g, r.provider, 'reservation_already_settled',
      `Reservation '${reservationId}' is already settled. Settling twice would double-charge the period.`);
  }
  const budget = g.budgets.get(r.provider)!;
  if (!Number.isFinite(actualCost) || actualCost < 0) {
    return refusal(g, r.provider, 'cost_not_stated',
      `settle() needs the real cost in ${budget.unit}. Use release() when the call produced no billable spend.`,
      { cap: budget.cap, unit: budget.unit });
  }

  const ledger = ledgerFor(g, budget, now);
  r.settled = true;
  ledger.held = Math.max(0, ledger.held - r.cost);
  ledger.committed += actualCost;

  const spent = ledger.committed + ledger.held;
  return decide(g, {
    verdict: 'permitted',
    provider: r.provider,
    reason: 'within_cap',
    reservationId: r.id,
    spent,
    held: ledger.held,
    cap: budget.cap,
    unit: budget.unit,
    periodEndsAt: new Date(ledger.startedAt + budget.periodMs).toISOString(),
    durability: 'process_memory',
    // Settling ABOVE the cap is recorded, not rejected: the vendor already
    // billed it. The overrun is visible in `spent` for the next reserve() to
    // refuse on, which is the only honest order of events.
    remedy: spent > budget.cap
      ? `OVERRUN: ${spent} of ${budget.cap} ${budget.unit} — the call cost more than it reserved. Further calls refuse until ${new Date(ledger.startedAt + budget.periodMs).toISOString()}.`
      : '',
  });
}

/** Return a reservation whose call produced no billable spend. */
export function release(reservationId: string, now: number): SpendDecision {
  const g = shared();
  const r = g.reservations.get(reservationId);
  if (!r) {
    return refusal(g, 'unknown', 'reservation_unknown', `No reservation '${reservationId}' to release.`);
  }
  if (r.settled) {
    return refusal(g, r.provider, 'reservation_already_settled',
      `Reservation '${reservationId}' is already settled; releasing it would credit back spend that happened.`);
  }
  const budget = g.budgets.get(r.provider)!;
  const ledger = ledgerFor(g, budget, now);
  r.settled = true;
  ledger.held = Math.max(0, ledger.held - r.cost);

  return decide(g, {
    verdict: 'permitted',
    provider: r.provider,
    reason: 'within_cap',
    reservationId: r.id,
    spent: ledger.committed + ledger.held,
    held: ledger.held,
    cap: budget.cap,
    unit: budget.unit,
    periodEndsAt: new Date(ledger.startedAt + budget.periodMs).toISOString(),
    durability: 'process_memory',
    remedy: '',
  });
}

export interface ProviderSpend {
  provider: string;
  unit: SpendUnit;
  cap: number;
  committed: number;
  /** Held by reservations that never settled — a leak reads as held credit. */
  held: number;
  openReservations: number;
  periodStartedAt: string;
  periodEndsAt: string;
  durability: LedgerDurability;
}

/** What the governor actually did, per provider. */
export function spendReport(now: number): ProviderSpend[] {
  const g = shared();
  return [...g.budgets.values()].map(b => {
    const l = ledgerFor(g, b, now);
    const open = [...g.reservations.values()].filter(r => r.provider === b.provider && !r.settled).length;
    return {
      provider: b.provider,
      unit: b.unit,
      cap: b.cap,
      committed: l.committed,
      held: l.held,
      openReservations: open,
      periodStartedAt: new Date(l.startedAt).toISOString(),
      periodEndsAt: new Date(l.startedAt + b.periodMs).toISOString(),
      durability: 'process_memory' as const,
    };
  }).sort((a, b) => a.provider.localeCompare(b.provider));
}

/**
 * Decision counts by verdict.
 *
 * Reported because "we never hit the cap" and "nothing ever asked" are the
 * same number of refusals and completely different facts.
 */
export function spendTally(): Readonly<Record<SpendVerdict, number>> {
  return { ...shared().tally };
}

/** Test seam: forget every budget, ledger and reservation. */
export function resetSpendGovernor(): void {
  const g = shared();
  g.budgets.clear();
  g.ledgers.clear();
  g.reservations.clear();
  g.seq = 0;
  g.tally = { permitted: 0, refused: 0, undetermined: 0 };
}
