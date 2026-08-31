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
    const v = arbitrate('heightM', 'route', IDENTICAL, true);
    expect(v.state).toBe('refuted');
    expect(v.reason).toContain('applied nothing');
    expect(v.reason).toContain('positive evidence');
    // The failure this prevents: refuted must never read as assured.
    expect(v.state).not.toBe('assured');
  });

  it('a +68% duration change is ASSURED', () => {
    const v = arbitrate('heightM', 'route', DISCRIMINATING, true);
    expect(v.state).toBe('assured');
    expect(v.durationDelta).toBeGreaterThan(0.6);
    expect(v.reason).toContain('measurably changed');
  });

  it('DISTANCE ALONE cannot establish legality', () => {
    // -0.3% is what a REAL restriction did to distance. So a distance-only
    // change is consistent with the restriction being ignored, and must not
    // be read as confirmation.
    const v = arbitrate('heightM', 'route', DISTANCE_ONLY, true);
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
    const v = arbitrate('weightKg', 'route', undefined, true);
    expect(v.state).toBe('unverified');
    expect(v.reason).toContain('absence of evidence, not evidence of absence');
  });

  it('not accepted at all is UNHONOURED, and that is the honest failure', () => {
    const v = arbitrate('axleLoadKg', 'route', undefined, false);
    expect(v.state).toBe('unhonoured');
    expect(v.reason).toContain('not pretending');
  });

  it('the four states are distinct — a boolean would collapse refuted into honoured', () => {
    const states = new Set([
      arbitrate('heightM', 'route', DISCRIMINATING, true).state,
      arbitrate('heightM', 'route', IDENTICAL, true).state,
      arbitrate('heightM', 'route', undefined, true).state,
      arbitrate('heightM', 'route', undefined, false).state,
    ]);
    expect(states).toEqual(new Set(['assured', 'refuted', 'unverified', 'unhonoured']));
  });
});

describe('legality is assured only when every restriction is', () => {
  it('one refuted restriction denies the whole route', () => {
    const verdicts = [
      arbitrate('heightM', 'route', DISCRIMINATING, true),
      arbitrate('weightKg', 'route', IDENTICAL, true),
    ];
    expect(legalityAssured(verdicts, 'route')).toBe(false);
    expect(shortfall(verdicts, 'route').map(v => v.restriction)).toEqual(['weightKg']);
  });

  it('no restrictions checked is NOT assured — vacuous truth refused', () => {
    // every() over an empty array is true, which would make "we checked
    // nothing" the strongest possible claim.
    expect(legalityAssured([], 'route')).toBe(false);
  });

  it('all assured is assured', () => {
    expect(legalityAssured([arbitrate('heightM', 'route', DISCRIMINATING, true)], 'route')).toBe(true);
  });

  it('the degraded warning names the shortfall and tells a dispatcher not to send', () => {
    const verdicts = [arbitrate('heightM', 'route', IDENTICAL, true), arbitrate('weightKg', 'route', undefined, true)];
    const w = degradedWarning(verdicts, 'route');
    expect(w).toContain('LEGALITY NOT ASSURED');
    expect(w).toContain('heightM: refuted');
    expect(w).toContain('weightKg: unverified');
    expect(w).toContain('Do not send a driver');
    expect(w).toContain('car route wearing a lorry label');
  });
});


/**
 * THE PER-ENDPOINT ASYMMETRY.
 *
 * Reconnaissance of a real routing backend found it accepts a truck profile,
 * applies the restrictions on its directions and isochrone endpoints, and
 * DISCARDS them on its matrix endpoint: HTTP 200, well-formed matrix, no
 * warning field, the restriction never read. Upstream, open since 2018.
 *
 * The matrix is what a dispatcher calls for fleet assignment, and a
 * truck-legal matrix is byte-shaped identically to a car-legal one. Before
 * `operation` existed on the verdict, this codebase could not even STATE the
 * situation: "height: assured" was true of one endpoint and false of another
 * with no way to tell them apart.
 */
describe('a capability is per operation, because a backend is not uniform', () => {
  const routeOk = arbitrate('heightM', 'route', DISCRIMINATING, true);
  const matrixDiscarded = arbitrate('heightM', 'matrix', IDENTICAL, true);
  const both = [routeOk, matrixDiscarded];

  it('the same restriction on the same backend can be assured and refuted at once', () => {
    expect(routeOk.state).toBe('assured');
    expect(matrixDiscarded.state).toBe('refuted');
  });

  it('assurance on route does NOT carry to matrix', () => {
    // The whole point. A matrix call must not read the route call's verdict.
    expect(legalityAssured(both, 'route')).toBe(true);
    expect(legalityAssured(both, 'matrix')).toBe(false);
  });

  it('an operation with no verdict at all is NOT assured', () => {
    // Absence of evidence. `isochrone` was never probed here; a filter that
    // yields an empty list must not then pass an `every()`.
    expect(legalityAssured(both, 'isochrone')).toBe(false);
  });

  it('the shortfall and the warning name the operation that is short', () => {
    expect(shortfall(both, 'route')).toEqual([]);
    expect(shortfall(both, 'matrix').map(v => v.restriction)).toEqual(['heightM']);
    const w = degradedWarning(both, 'matrix');
    expect(w).toContain('for matrix');
    expect(w).toContain('heightM: refuted');
  });

  it('and the pin: a verdict list with no operation field could not express this', () => {
    // Strip the operation and the two verdicts become indistinguishable
    // claims about "heightM" — one assured, one refuted, on the same backend,
    // with nothing to say which endpoint each describes. That ambiguity was
    // the type's previous state.
    const stripped = both.map(({ restriction, state }) => ({ restriction, state }));
    const heights = stripped.filter(v => v.restriction === 'heightM');
    expect(heights).toHaveLength(2);
    expect(new Set(heights.map(v => v.state))).toEqual(new Set(['assured', 'refuted']));
  });
});
