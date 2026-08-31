import { charge, type ChargeStatus } from './providerBudget';

/**
 * Payload — the decision to call OpenSky, as a function that can be asked.
 *
 * WHY IT IS OUT HERE (ledger phase 80). `api/flights` decides whether to issue
 * the call from three conditions — a 429 cooldown, a per-pool interval, and now
 * a daily credit budget — and that decision lives inside a route handler that
 * cannot be exercised without the network. Every prior phase this session that
 * asked "what does this actually return" found something; every one that
 * checked the source instead could only ask whether a field was mentioned.
 *
 * So the conditions compose here, where a test can plant an exhausted budget
 * and see what comes back.
 */

export type OpenSkySkipReason =
  /** A 429 put the provider in cooldown. */
  | 'cooldown'
  /** The snapshot is younger than this pool's polling interval. */
  | 'interval'
  /** The day's credits are spent. */
  | 'budget';

export interface OpenSkyDecision {
  readonly call: boolean;
  /** Null when calling. Otherwise WHICH of the three reasons applied. */
  readonly skippedBecause: OpenSkySkipReason | null;
  /** Human-readable detail, carried only for a budget refusal. */
  readonly reason: string | null;
  /** The charge outcome, when one was attempted. */
  readonly chargeStatus: ChargeStatus | null;
}

export interface OpenSkyConditions {
  readonly now: number;
  readonly cooldownUntil: number;
  readonly snapshotTime: number;
  readonly intervalMs: number;
  readonly provider: string;
  readonly callCost: number;
}

/**
 * Decide whether to issue the call, and charge for it when the answer is yes.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY. Cooldown and interval are checked BEFORE
 * the budget, so a call that was never going to be made does not spend a
 * credit. Charging first would drain the pool at the polling rate rather than
 * the call rate — the mechanism built to protect the budget would become the
 * thing that exhausts it.
 */
export function decideOpenSkyCall(c: OpenSkyConditions): OpenSkyDecision {
  if (c.now < c.cooldownUntil) {
    return { call: false, skippedBecause: 'cooldown', reason: null, chargeStatus: null };
  }
  if (c.now - c.snapshotTime < c.intervalMs) {
    return { call: false, skippedBecause: 'interval', reason: null, chargeStatus: null };
  }

  const decision = charge(c.provider, c.callCost, c.now);
  if (decision.status === 'refused') {
    return {
      call: false,
      skippedBecause: 'budget',
      reason: decision.reason ?? 'daily credit budget exhausted',
      chargeStatus: decision.status,
    };
  }
  return { call: true, skippedBecause: null, reason: null, chargeStatus: decision.status };
}
