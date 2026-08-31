import { describe, it, expect } from 'vitest';
import {
  arbitrate, legalityAssured, shortfall, degradedWarning,
  DISCRIMINATION_FLOOR, type RestrictionProbe,
} from './capability';

/**
 * The measured probe, reproduced as the fixture it became.
 *
 *   3.00 m  18.261 km  1102 s
 *   4.11 m  18.261 km  1102 s   <- identical to 3.00 m
 *   4.60 m  18.202 km  1851 s   <- distance -0.3%, duration +68%
 */
const IDENTICAL: RestrictionProbe = {
  restriction: 'heightM', belowValue: 3.0, aboveValue: 4.11,
  below: { distanceM: 18261, durationS: 1102 },
  above: { distanceM: 18261, durationS: 1102 },
};

const DISCRIMINATING: RestrictionProbe = {
  restriction: 'heightM', belowValue: 4.11, aboveValue: 4.6,
  below: { distanceM: 18261, durationS: 1102 },
  above: { distanceM: 18202, durationS: 1851 },
};

/** Distance moved as it really does for a binding restriction; duration did not. */
const DISTANCE_ONLY: RestrictionProbe = {
  restriction: 'heightM', belowValue: 4.11, aboveValue: 4.6,
  below: { distanceM: 18261, durationS: 1102 },
  above: { distanceM: 18202, durationS: 1102 },
};

describe('a restriction is assured only by a discriminating probe', () => {
  it('IDENTICAL sides are REFUTED — positive evidence, not a weak signal', () => {
    const v = arbitrate('heightM', IDENTICAL, true);
    expect(v.state).toBe('refuted');
    expect(v.reason).toContain('applied nothing');
    expect(v.reason).toContain('positive evidence');
    // The failure this prevents: refuted must never read as assured.
    expect(v.state).not.toBe('assured');
  });

  it('a +68% duration change is ASSURED', () => {
    const v = arbitrate('heightM', DISCRIMINATING, true);
    expect(v.state).toBe('assured');
    expect(v.durationDelta).toBeGreaterThan(0.6);
    expect(v.reason).toContain('measurably changed');
  });

  it('DISTANCE ALONE cannot establish legality', () => {
    // -0.3% is what a REAL restriction did to distance. So a distance-only
    // change is consistent with the restriction being ignored, and must not
    // be read as confirmation.
    const v = arbitrate('heightM', DISTANCE_ONLY, true);
    expect(v.state).toBe('refuted');
    expect(v.distanceDelta).toBeGreaterThan(0);
    expect(v.durationDelta).toBe(0);
    expect(v.reason).toContain('Distance alone cannot establish legality');
  });

  it('the floor sits above the measured distance delta and below the duration delta', () => {
    // Not a taste constant: it separates the two measured cases.
    expect(DISCRIMINATION_FLOOR).toBeGreaterThan(0.003);
    expect(DISCRIMINATION_FLOOR).toBeLessThan(0.68);
  });

  it('never probed is UNVERIFIED — absence of evidence, not a pass', () => {
    const v = arbitrate('weightKg', undefined, true);
    expect(v.state).toBe('unverified');
    expect(v.reason).toContain('absence of evidence, not evidence of absence');
  });

  it('not accepted at all is UNHONOURED, and that is the honest failure', () => {
    const v = arbitrate('axleLoadKg', undefined, false);
    expect(v.state).toBe('unhonoured');
    expect(v.reason).toContain('not pretending');
  });

  it('the four states are distinct — a boolean would collapse refuted into honoured', () => {
    const states = new Set([
      arbitrate('heightM', DISCRIMINATING, true).state,
      arbitrate('heightM', IDENTICAL, true).state,
      arbitrate('heightM', undefined, true).state,
      arbitrate('heightM', undefined, false).state,
    ]);
    expect(states).toEqual(new Set(['assured', 'refuted', 'unverified', 'unhonoured']));
  });
});

describe('legality is assured only when every restriction is', () => {
  it('one refuted restriction denies the whole route', () => {
    const verdicts = [
      arbitrate('heightM', DISCRIMINATING, true),
      arbitrate('weightKg', IDENTICAL, true),
    ];
    expect(legalityAssured(verdicts)).toBe(false);
    expect(shortfall(verdicts).map(v => v.restriction)).toEqual(['weightKg']);
  });

  it('no restrictions checked is NOT assured — vacuous truth refused', () => {
    // every() over an empty array is true, which would make "we checked
    // nothing" the strongest possible claim.
    expect(legalityAssured([])).toBe(false);
  });

  it('all assured is assured', () => {
    expect(legalityAssured([arbitrate('heightM', DISCRIMINATING, true)])).toBe(true);
  });

  it('the degraded warning names the shortfall and tells a dispatcher not to send', () => {
    const verdicts = [arbitrate('heightM', IDENTICAL, true), arbitrate('weightKg', undefined, true)];
    const w = degradedWarning(verdicts);
    expect(w).toContain('LEGALITY NOT ASSURED');
    expect(w).toContain('heightM: refuted');
    expect(w).toContain('weightKg: unverified');
    expect(w).toContain('Do not send a driver');
    expect(w).toContain('car route wearing a lorry label');
  });
});
