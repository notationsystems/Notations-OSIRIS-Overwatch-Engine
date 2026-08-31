import { describe, it, expect, beforeEach } from 'vitest';
import { decideOpenSkyCall } from './openSkyGate';
import { resetBudgets, budgetState } from './providerBudget';

/**
 * THE THREE REASONS A CALL IS NOT MADE, KEPT APART (ledger phase 80).
 *
 * A thin OpenSky snapshot previously had three possible causes — the interval
 * has not elapsed, the provider 429'd, the day's credits are gone — and all
 * three rendered as the same slightly-emptier map. The route's own comment
 * diagnoses the third as what "emptied the map", found after the fact by
 * reasoning about it rather than by anything the system reported.
 */

const T0 = Date.parse('2026-08-31T10:00:00Z');
const INTERVAL = 90_000;

const base = {
  now: T0,
  cooldownUntil: 0,
  snapshotTime: T0 - INTERVAL - 1,
  intervalMs: INTERVAL,
  provider: 'opensky-authenticated',
  callCost: 4,
};

beforeEach(() => resetBudgets());

describe('a call is made when all three conditions allow it', () => {
  it('calls, and charges for the call', () => {
    const d = decideOpenSkyCall(base);
    expect(d.call).toBe(true);
    expect(d.skippedBecause).toBeNull();
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(4);
  });
});

describe('each reason is reported as itself', () => {
  it('names the cooldown', () => {
    const d = decideOpenSkyCall({ ...base, cooldownUntil: T0 + 60_000 });
    expect(d.call).toBe(false);
    expect(d.skippedBecause).toBe('cooldown');
  });

  it('names the interval', () => {
    const d = decideOpenSkyCall({ ...base, snapshotTime: T0 - 1_000 });
    expect(d.call).toBe(false);
    expect(d.skippedBecause).toBe('interval');
  });

  it('names the budget, and says why', () => {
    for (let i = 0; i < 100; i++) decideOpenSkyCall({ ...base, provider: 'opensky-anonymous' });
    const d = decideOpenSkyCall({ ...base, provider: 'opensky-anonymous' });
    expect(d.call).toBe(false);
    expect(d.skippedBecause).toBe('budget');
    expect(d.reason).toMatch(/exceed the daily cap of 400/);
  });

  /**
   * THE DISCRIMINATING TRIPLE. All three are `call: false`, so a boolean cannot
   * tell them apart — which is exactly the state the route was in before this
   * phase, and why an exhausted budget looked like a quiet sky.
   */
  it('distinguishes the three despite all being a refusal to call', () => {
    const cooldown = decideOpenSkyCall({ ...base, cooldownUntil: T0 + 60_000 });
    const interval = decideOpenSkyCall({ ...base, snapshotTime: T0 - 1_000 });
    for (let i = 0; i < 100; i++) decideOpenSkyCall({ ...base, provider: 'opensky-anonymous' });
    const budget = decideOpenSkyCall({ ...base, provider: 'opensky-anonymous' });

    expect([cooldown.call, interval.call, budget.call]).toEqual([false, false, false]);
    expect(new Set([cooldown.skippedBecause, interval.skippedBecause, budget.skippedBecause]).size).toBe(3);
  });
});

describe('a call that was never going to be made spends nothing', () => {
  /**
   * Order matters. If the budget were charged before the cooldown and interval
   * were checked, the pool would drain at the POLLING rate rather than the CALL
   * rate — the mechanism built to protect the budget would become the thing
   * that exhausts it. On the anonymous pool, where a refetch is due every 15
   * minutes but the route is polled every 90 seconds, that is a 10x error.
   */
  it('does not charge while in cooldown', () => {
    decideOpenSkyCall({ ...base, cooldownUntil: T0 + 60_000 });
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(0);
  });

  it('does not charge while inside the interval', () => {
    for (let i = 0; i < 50; i++) decideOpenSkyCall({ ...base, snapshotTime: T0 - 1_000 });
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(0);
  });
});
