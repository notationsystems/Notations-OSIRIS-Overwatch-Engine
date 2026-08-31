import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerBudget, registeredBudgets, reserve, settle, release,
  spendReport, spendTally, resetSpendGovernor,
} from './spendGovernor';

const T0 = Date.parse('2026-08-31T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const tiles = {
  provider: 'google-tiles',
  unit: 'tiles' as const,
  cap: 100,
  periodMs: 30 * DAY,
  basis: 'plan allowance, 100 tiles/month on the free tier',
};

beforeEach(resetSpendGovernor);

describe('an unregistered provider is refused, not permitted', () => {
  it('refuses a provider nobody has decided a budget for', () => {
    const d = reserve('some-vendor', 1, 'requests', T0);
    expect(d.verdict).toBe('refused');
    expect(d.reason).toBe('provider_not_budgeted');
    // Refusals carry a remedy, never a bare no.
    expect(d.remedy).toContain('Register a budget');
    // And it reports nothing it does not know.
    expect(d.cap).toBeNull();
    expect(d.spent).toBeNull();
  });

  it('permits the same call once a budget exists', () => {
    registerBudget(tiles);
    expect(reserve('google-tiles', 1, 'tiles', T0).verdict).toBe('permitted');
  });
});

describe('units are not interchangeable', () => {
  it('refuses a cost declared in a unit the cap is not denominated in', () => {
    registerBudget(tiles);
    const d = reserve('google-tiles', 1, 'requests', T0);
    expect(d.verdict).toBe('refused');
    expect(d.reason).toBe('unit_mismatch');
    // It reports the cap's unit so the caller can convert at the call site.
    expect(d.unit).toBe('tiles');
    expect(d.remedy).toContain('tiles');

    // THE POINT: the mismatched cost was NOT added to the ledger. A figure in
    // the wrong unit must not move the number it is not comparable to.
    const [rep] = spendReport(T0);
    expect(rep.committed).toBe(0);
    expect(rep.held).toBe(0);
  });

  it('refuses a cost that is not a number rather than treating it as zero', () => {
    registerBudget(tiles);
    for (const bad of [NaN, Infinity, -1]) {
      const d = reserve('google-tiles', bad, 'tiles', T0);
      expect(d.verdict, `cost ${bad}`).toBe('refused');
      expect(d.reason).toBe('cost_not_stated');
    }
  });
});

describe('the cap actually holds', () => {
  it('permits up to the cap and refuses the call that would cross it', () => {
    registerBudget({ ...tiles, cap: 10 });
    for (let i = 0; i < 10; i++) {
      expect(reserve('google-tiles', 1, 'tiles', T0).verdict, `call ${i}`).toBe('permitted');
    }
    const over = reserve('google-tiles', 1, 'tiles', T0);
    expect(over.verdict).toBe('refused');
    expect(over.reason).toBe('would_exceed_cap');
    expect(over.spent).toBe(10);
    expect(over.cap).toBe(10);
    // The remedy names the cap's basis and when relief arrives.
    expect(over.remedy).toContain('plan allowance');
    expect(over.remedy).toContain(over.periodEndsAt!);
  });

  it('refuses on the boundary, not one past it', () => {
    registerBudget({ ...tiles, cap: 10 });
    expect(reserve('google-tiles', 10, 'tiles', T0).verdict).toBe('permitted');
    expect(reserve('google-tiles', 1, 'tiles', T0).reason).toBe('would_exceed_cap');
  });

  it('rolls the ledger when the period ends, and not a moment before', () => {
    registerBudget({ ...tiles, cap: 10, periodMs: DAY });
    reserve('google-tiles', 10, 'tiles', T0);

    // One ms before the period ends: still spent.
    expect(reserve('google-tiles', 1, 'tiles', T0 + DAY - 1).reason).toBe('would_exceed_cap');
    // Exactly at the boundary: a new period.
    const rolled = reserve('google-tiles', 1, 'tiles', T0 + DAY);
    expect(rolled.verdict).toBe('permitted');
    expect(rolled.spent).toBe(1);
  });
});

describe('reserve then settle — the half that makes token metering governable', () => {
  const llm = {
    provider: 'model-vendor',
    unit: 'tokens' as const,
    cap: 1000,
    periodMs: DAY,
    basis: 'monthly token allowance',
  };

  it('holds the estimate, then replaces it with what was actually spent', () => {
    registerBudget(llm);
    const r = reserve('model-vendor', 400, 'tokens', T0); // an upper estimate
    expect(r.verdict).toBe('permitted');
    expect(r.held).toBe(400);

    // The response came back cheaper than feared.
    const s = settle(r.reservationId!, 120, T0);
    expect(s.verdict).toBe('permitted');
    expect(s.held).toBe(0);
    expect(s.spent).toBe(120); // committed, not the estimate

    // The 280 the estimate held is available again.
    expect(reserve('model-vendor', 880, 'tokens', T0).verdict).toBe('permitted');
  });

  it('counts an unsettled reservation against the cap and reports it as held', () => {
    registerBudget(llm);
    reserve('model-vendor', 900, 'tokens', T0); // never settled — a leak
    const [rep] = spendReport(T0);
    expect(rep.committed).toBe(0);
    expect(rep.held).toBe(900);
    expect(rep.openReservations).toBe(1);
    // Conservative: the leak refuses further calls rather than being ignored.
    expect(reserve('model-vendor', 200, 'tokens', T0).reason).toBe('would_exceed_cap');
  });

  it('records an overrun rather than rejecting it — the vendor already billed', () => {
    registerBudget(llm);
    const r = reserve('model-vendor', 100, 'tokens', T0);
    const s = settle(r.reservationId!, 1500, T0); // the call cost far more
    expect(s.verdict).toBe('permitted'); // it HAPPENED; refusing it would not unbill it
    expect(s.spent).toBe(1500);
    expect(s.remedy).toContain('OVERRUN');
    // And the next call is refused on the real number.
    expect(reserve('model-vendor', 1, 'tokens', T0).reason).toBe('would_exceed_cap');
  });

  it('refuses to settle twice, or to settle an id it never issued', () => {
    registerBudget(llm);
    const r = reserve('model-vendor', 100, 'tokens', T0);
    expect(settle(r.reservationId!, 100, T0).verdict).toBe('permitted');
    const again = settle(r.reservationId!, 100, T0);
    expect(again.verdict).toBe('refused');
    expect(again.reason).toBe('reservation_already_settled');
    // The double settle did not land.
    expect(spendReport(T0)[0].committed).toBe(100);

    expect(settle('model-vendor#9999', 5, T0).reason).toBe('reservation_unknown');
  });

  it('release returns the hold, and cannot credit back spend that happened', () => {
    registerBudget(llm);
    const r = reserve('model-vendor', 400, 'tokens', T0);
    expect(release(r.reservationId!, T0).held).toBe(0);
    expect(spendReport(T0)[0].committed).toBe(0);

    const r2 = reserve('model-vendor', 400, 'tokens', T0);
    settle(r2.reservationId!, 400, T0);
    expect(release(r2.reservationId!, T0).reason).toBe('reservation_already_settled');
    expect(spendReport(T0)[0].committed).toBe(400);
  });
});

describe('the governor says what it does not know', () => {
  it('marks every decision as resting on process memory', () => {
    registerBudget(tiles);
    // A cap enforced only in memory is restored by a restart while the
    // vendor's meter keeps climbing. Every decision carries that.
    expect(reserve('google-tiles', 1, 'tiles', T0).durability).toBe('process_memory');
    expect(reserve('nope', 1, 'tiles', T0).durability).toBe('process_memory');
    expect(spendReport(T0)[0].durability).toBe('process_memory');
  });

  it('distinguishes never hitting the cap from never being asked', () => {
    registerBudget({ ...tiles, cap: 1 });
    expect(spendTally()).toEqual({ permitted: 0, refused: 0, undetermined: 0 });
    reserve('google-tiles', 1, 'tiles', T0);
    reserve('google-tiles', 1, 'tiles', T0);
    expect(spendTally().permitted).toBe(1);
    expect(spendTally().refused).toBe(1);
  });
});

describe('registration is a decision, and refuses to be a guess', () => {
  it('will not register a budget without a basis, a finite cap, or a period', () => {
    expect(() => registerBudget({ ...tiles, basis: '   ' })).toThrow(/basis/);
    expect(() => registerBudget({ ...tiles, cap: NaN })).toThrow(/cap/);
    expect(() => registerBudget({ ...tiles, cap: -1 })).toThrow(/cap/);
    expect(() => registerBudget({ ...tiles, periodMs: 0 })).toThrow(/periodMs/);
    expect(registeredBudgets()).toEqual([]);
  });

  it('raising a cap mid-period does not forgive the spend already on it', () => {
    registerBudget({ ...tiles, cap: 10 });
    reserve('google-tiles', 10, 'tiles', T0);
    registerBudget({ ...tiles, cap: 20 });
    const rep = spendReport(T0)[0];
    expect(rep.cap).toBe(20);
    expect(rep.held).toBe(10); // carried, not reset
    expect(reserve('google-tiles', 11, 'tiles', T0).reason).toBe('would_exceed_cap');
    expect(reserve('google-tiles', 10, 'tiles', T0).verdict).toBe('permitted');
  });
});
