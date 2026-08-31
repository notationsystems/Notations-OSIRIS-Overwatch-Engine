/**
 * Payload — is a vehicle restriction actually honoured?
 *
 * THE MEASUREMENT THIS EXISTS FOR. A live probe of a public routing instance,
 * sweeping a height restriction across a bridge threshold:
 *
 *     height    distance      duration
 *     3.00 m    18.261 km     1102 s
 *     4.11 m    18.261 km     1102 s
 *     4.60 m    18.202 km     1851 s
 *
 * The first two rows are BYTE-IDENTICAL. The endpoint accepted the height
 * parameter and applied nothing. So calling a truck endpoint proves nothing,
 * and a backend's claim to honour a restriction is a claim, not a fact.
 *
 * Legality is therefore never derived from which URL was called. It is
 * derived from a DECLARED CAPABILITY VERIFIED BY A DISCRIMINATING PROBE —
 * one whose result measurably changes across the threshold. A probe whose
 * two sides are identical is not weak evidence that the restriction works;
 * it is positive evidence that it does not.
 *
 * THE SECOND RULE FROM THE SAME MEASUREMENT. Crossing the threshold moved
 * distance by −0.3% and duration by +68%. An economics stage comparing
 * DISTANCES reads a legal and an illegal route as the same number. So
 * duration is the discriminating axis, distance cannot establish legality on
 * its own, and a matrix of distances alone cannot cost a lane.
 */

/** The restrictions a probe can interrogate, named as the profile names them. */
export type Restriction = 'heightM' | 'widthM' | 'lengthM' | 'weightKg' | 'axleLoadKg' | 'hazmat';

/**
 * FOUR STATES, NOT TWO.
 *
 * A boolean `honoured` flag collapses `refuted` into `honoured` — the backend
 * says it supports height, nothing contradicts it, the flag reads true, and
 * the truck meets the bridge. That collapse is exactly how the failure ships,
 * so the states stay distinct.
 */
export type CapabilityState =
  /** Declared AND a discriminating probe confirmed a real effect. */
  | 'assured'
  /** Declared by the backend and never probed. Not a fault — an absence of
   *  evidence, and refused in strict mode because a load moves on it. */
  | 'unverified'
  /** Probed, and the probe showed NO effect. The measured case above. This
   *  is a positive finding, not a missing one. */
  | 'refuted'
  /** The backend does not accept the parameter at all. Honest, and at least
   *  it does not pretend. */
  | 'unhonoured';

/** One side of a probe: the route the backend returned for a given profile. */
export interface ProbeSide {
  readonly distanceM: number;
  readonly durationS: number;
}

export interface RestrictionProbe {
  readonly restriction: Restriction;
  /** Profile value just BELOW the threshold — the restriction should not bind. */
  readonly below: ProbeSide;
  /** Profile value just ABOVE it — the restriction should bind and reroute. */
  readonly above: ProbeSide;
  /** What the two sides were, for the record. */
  readonly belowValue: number;
  readonly aboveValue: number;
}

export interface CapabilityVerdict {
  readonly restriction: Restriction;
  readonly state: CapabilityState;
  readonly reason: string;
  /** The relative duration change the probe produced, when it ran. */
  readonly durationDelta?: number;
  readonly distanceDelta?: number;
}

/**
 * The floor a duration change must clear to count as a real effect.
 *
 * Derived from the measurement, not chosen by taste: a restriction that IS
 * honoured moved duration 68%, and one that is not moved it 0%. Distance for
 * the same real restriction moved 0.3% — which is why distance is not the
 * axis and why the floor sits well above it. Anything between 1% and 60%
 * would separate the measured cases; 1% is the conservative end, and a
 * backend producing a 1% duration change from a binding restriction is
 * reporting something real.
 */
export const DISCRIMINATION_FLOOR = 0.01;

const rel = (a: number, b: number): number => (a === 0 ? (b === 0 ? 0 : 1) : Math.abs(b - a) / a);

/**
 * Decide what a probe established.
 *
 * `undefined` probe means never run — `unverified`, which is an absence of
 * evidence and must not read as a pass.
 */
export function arbitrate(
  restriction: Restriction,
  probe: RestrictionProbe | undefined,
  accepted: boolean,
): CapabilityVerdict {
  if (!accepted) {
    return {
      restriction, state: 'unhonoured',
      reason:
        `the backend does not accept ${restriction}. It is not pretending to apply a ` +
        'restriction it ignores, which is the honest failure — but a load planned here is ' +
        'planned without this constraint.',
    };
  }
  if (!probe) {
    return {
      restriction, state: 'unverified',
      reason:
        `the backend declares ${restriction} and no discriminating probe has been run. This is ` +
        'an absence of evidence, not evidence of absence — and a declared capability that ' +
        'nobody checked is exactly what the measured case looked like before it was checked.',
    };
  }

  const durationDelta = rel(probe.below.durationS, probe.above.durationS);
  const distanceDelta = rel(probe.below.distanceM, probe.above.distanceM);

  if (probe.below.durationS === probe.above.durationS
      && probe.below.distanceM === probe.above.distanceM) {
    return {
      restriction, state: 'refuted', durationDelta, distanceDelta,
      reason:
        `probing ${restriction} at ${probe.belowValue} and ${probe.aboveValue} returned an ` +
        'IDENTICAL route. The parameter was accepted and applied nothing. This is positive ' +
        'evidence the restriction is not honoured, not a weak signal.',
    };
  }

  if (durationDelta < DISCRIMINATION_FLOOR) {
    return {
      restriction, state: 'refuted', durationDelta, distanceDelta,
      reason:
        `probing ${restriction} moved duration ${(durationDelta * 100).toFixed(2)}% ` +
        `(distance ${(distanceDelta * 100).toFixed(2)}%), below the ` +
        `${(DISCRIMINATION_FLOOR * 100).toFixed(0)}% floor. Distance alone cannot establish ` +
        'legality: measured, a restriction that IS honoured moved distance only 0.3% while ' +
        'moving duration 68%, so a distance-only change is consistent with the restriction ' +
        'being ignored.',
    };
  }

  return {
    restriction, state: 'assured', durationDelta, distanceDelta,
    reason:
      `probing ${restriction} at ${probe.belowValue} and ${probe.aboveValue} moved duration ` +
      `${(durationDelta * 100).toFixed(1)}% — the route measurably changed, so the restriction ` +
      'is applied rather than accepted and discarded.',
  };
}

/** Legality is assured only when EVERY requested restriction is assured. */
export function legalityAssured(verdicts: readonly CapabilityVerdict[]): boolean {
  return verdicts.length > 0 && verdicts.every(v => v.state === 'assured');
}

/** The restrictions that are not assured, with why — what a refusal names. */
export function shortfall(verdicts: readonly CapabilityVerdict[]): CapabilityVerdict[] {
  return verdicts.filter(v => v.state !== 'assured');
}

export const LEGALITY_NOT_ASSURED = 'LEGALITY_NOT_ASSURED';

/**
 * The warning a degraded (non-strict) route carries.
 *
 * Strict is the freight default: `route()` refuses rather than returning a
 * route that may be illegal. Non-strict returns the route WITH this attached,
 * and there is no silent downgrade — the caller asked for it and the answer
 * says what it is.
 */
export function degradedWarning(verdicts: readonly CapabilityVerdict[]): string {
  const short = shortfall(verdicts);
  return (
    'LEGALITY NOT ASSURED — ' +
    short.map(v => `${v.restriction}: ${v.state}`).join(', ') +
    '. Do not send a driver on this route without confirming clearances independently. ' +
    'A route returned under an unhonoured restriction is a car route wearing a lorry label.'
  );
}
