import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  charge,
  budgetState,
  resetBudgets,
  dayKey,
  PROVIDER_BUDGETS,
} from './providerBudget';

/**
 * THE BUDGET THAT WAS ONLY EVER PROSE (ledger phase 77).
 *
 * `api/flights` explains the OpenSky credit budget across ten lines of
 * comment — 4,000 a day authenticated, 400 anonymous, and the observation that
 * polling anonymously on the same TTL "burns the whole day's budget in about
 * half an hour". The reasoning is right. Nothing counted, so the enforcement
 * was an argument about an expected call rate rather than a mechanism, and it
 * held only while nothing else called the same provider.
 */

const T0 = Date.parse('2026-08-31T10:00:00Z');
const NEXT_DAY = Date.parse('2026-09-01T00:30:00Z');

beforeEach(() => resetBudgets());

describe('spend is counted, not argued about', () => {
  it('records spend and reports what is left', () => {
    const r = charge('opensky-authenticated', 100, T0);
    expect(r.status).toBe('within');
    expect(r.spent).toBe(100);
    expect(r.remaining).toBe(3900);
  });

  it('accumulates across calls within a day', () => {
    charge('opensky-authenticated', 100, T0);
    charge('opensky-authenticated', 250, T0);
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(350);
  });

  it('refuses the call that would cross the cap', () => {
    charge('opensky-anonymous', 399, T0);
    const r = charge('opensky-anonymous', 2, T0);
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/exceed the daily cap of 400/);
  });

  /**
   * A refused call was never made, so charging for it would carry a phantom
   * spend into the next window and make tomorrow's first request look like
   * today's overrun.
   */
  it('does not record spend for a refused call', () => {
    charge('opensky-anonymous', 399, T0);
    charge('opensky-anonymous', 50, T0);
    expect(budgetState('opensky-anonymous', T0)?.spent).toBe(399);
  });

  it('resets at the UTC day boundary', () => {
    charge('opensky-anonymous', 400, T0);
    expect(charge('opensky-anonymous', 1, T0).status).toBe('refused');
    expect(charge('opensky-anonymous', 1, NEXT_DAY).status).toBe('within');
    expect(dayKey(T0)).not.toBe(dayKey(NEXT_DAY));
  });
});

describe('three values, and the middle one still permits', () => {
  /**
   * THE DISCRIMINATING CASE. `warned` and `refused` must be distinguishable in
   * both directions: a warn that blocked would silently cut the feed at 80%,
   * and a refusal that permitted would be a cap in name only.
   */
  it('warns without blocking, and refuses without warning', () => {
    const warn = charge('opensky-authenticated', 3300, T0);
    expect(warn.status).toBe('warned');
    expect(warn.spent).toBe(3300);

    const stillPermitted = charge('opensky-authenticated', 100, T0);
    expect(stillPermitted.status).toBe('warned');
    expect(stillPermitted.spent).toBe(3400);

    const refused = charge('opensky-authenticated', 1000, T0);
    expect(refused.status).toBe('refused');
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(3400);
  });

  it('is under the warn line below the threshold', () => {
    expect(charge('opensky-authenticated', 3199, T0).status).toBe('within');
  });
});

describe('an undeclared provider is refused, not assumed free', () => {
  /**
   * Refuse, don't default. An unknown provider is not an unmetered one — it is
   * a call nobody costed, and treating it as free means the cap is discovered
   * by a vendor's 429 rather than here.
   */
  it('refuses a provider with no declared budget', () => {
    const r = charge('tomtom-traffic', 1, T0);
    expect(r.status).toBe('refused');
    expect(r.reason).toMatch(/No budget is declared/);
  });

  it('has no state to report for one either', () => {
    expect(budgetState('tomtom-traffic', T0)).toBeNull();
  });

  it('refuses a nonsensical spend rather than coercing it', () => {
    expect(charge('opensky-authenticated', -5, T0).status).toBe('refused');
    expect(charge('opensky-authenticated', NaN, T0).status).toBe('refused');
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(0);
  });
});

describe('a cap says how well it is known', () => {
  /**
   * The half taken from `gods-eye-view`'s cost registry: a published limit is
   * an EXTERNAL FACT THAT DRIFTS, so it carries the date it was read and the
   * page it came from. The half added here: a cap nobody verified says so, and
   * is enforced without becoming quotable.
   */
  it('marks every current cap as restated rather than verified', () => {
    for (const [name, b] of Object.entries(PROVIDER_BUDGETS)) {
      expect(b.provenance, `${name} claims a provenance it cannot support`).toBe('restated');
      expect(b.verifiedOn, `${name} restated but carries a verification date`).toBeNull();
      expect(b.source.length).toBeGreaterThan(20);
    }
  });

  it('enforces a restated cap exactly as hard as a verified one', () => {
    expect(charge('opensky-anonymous', 401, T0).status).toBe('refused');
  });

  it('refuses to call a restated cap quotable, and says why on every charge', () => {
    const state = budgetState('opensky-anonymous', T0)!;
    expect(state.quotable).toBe(false);
    expect(state.stalenessDays).toBeNull();
    expect(charge('opensky-anonymous', 1, T0).reason).toMatch(/NOT verified/);
  });

  /**
   * Staleness is reported separately from spend. Phase 67 established that a
   * single number carrying both depth and age gets read as the flattering one;
   * a cap verified long ago is not a fact about today's pricing page.
   */
  it('keeps staleness a separate axis from spend', () => {
    const state = budgetState('opensky-authenticated', T0)!;
    expect(Object.keys(state)).toContain('stalenessDays');
    expect(state.spent).toBe(0);
    expect(state.stalenessDays).toBeNull();
  });
});

describe('the counter is process-wide, not per module context', () => {
  /**
   * Instance 4 of the severance class was `sessionTelemetry`: a module-level
   * counter that Next.js instantiated twice, so each copy under-counted while
   * every write looked correct. A budget is the worst possible state to lose
   * that way — two half-counts never reach a cap that one whole count would.
   */
  it('shares spend across a genuinely re-evaluated module instance', async () => {
    charge('opensky-authenticated', 500, T0);

    // `await import()` alone returns the SAME instance, so it would pass for a
    // plain module-level Map and prove nothing — the vacuous-example class, in
    // the test written to rule out severance. Resetting the registry forces a
    // real re-evaluation: a module-level Map comes back empty, state anchored
    // on globalThis survives.
    vi.resetModules();
    const fresh = await import('./providerBudget');

    expect(fresh.budgetState('opensky-authenticated', T0)?.spent).toBe(500);
    expect(fresh.charge('opensky-authenticated', 100, T0).spent).toBe(600);
    expect(budgetState('opensky-authenticated', T0)?.spent).toBe(600);
  });
});
