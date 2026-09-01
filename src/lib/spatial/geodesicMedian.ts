// src/lib/spatial/geodesicMedian.ts
//
// WHERE TO PUT THE CROSS-DOCK.
//
// The geometric median is the point minimising the SUM OF DISTANCES to a set of
// sample points. Constrained to the Earth's surface and measured along it, it is
// the geodesic median — and it is the answer to the multi-facility location
// problem a broker actually has: given the pickups and deliveries you run,
// weighted by how often you run them, where does a consolidation point go?
//
// Not the centroid. The centroid minimises squared distance and is dragged by
// outliers; the median minimises distance and is robust to them. One load a year
// to Thunder Bay should not move your cross-dock.
//
// Ported from `notationsystems/geodesic-median` (Weiszfeld, generalised to
// geodesic distance). Four things are changed, and each is a defect the original
// has:
//
//   1. THE LOOP IS BOUNDED. `while True` with no cap is a hang in a server.
//      Weiszfeld converges for most inputs but not all, and the degenerate-point
//      nudge below can make it oscillate.
//   2. CONVERGENCE IS TESTED IN METRES, NOT DEGREES. The original tests
//      `euclidean(y, y1) < 1e-6` on a (lat, lng) pair while the objective is in
//      kilometres. A degree of longitude is 111 km at the equator and 0 at the
//      pole, so the same tolerance is a different distance at every latitude —
//      the test and the objective denominated differently.
//   3. THE COINCIDENT-POINT CASE IS HANDLED, NOT NUDGED. Weiszfeld divides by
//      the distance to each sample, so an iterate landing exactly on one is
//      undefined. The original adds 0.1 degrees to both coordinates — about 11 km
//      to the north-east, in a direction unrelated to the data. Vardi and Zhang's
//      correction handles it analytically instead.
//   4. THE RESULT SAYS WHETHER IT CONVERGED. The original returns a point and
//      nothing else, so a capped or oscillating run is indistinguishable from a
//      converged one.
//
// AND ONE DEFECT WORTH NAMING, because it is the class this codebase tracks:
// the original's `geodist` is documented as "mimicking scipy cdist: computing
// all the distances for all the pairs", and its inner loop reads
// `for j in range(0, 1)` — it only ever fills column zero. Apparent scope: all
// pairs. Effective scope: one column. It is correct today only because every
// call site passes a single point, and nothing fails.

import type { ISODateTime } from '../economy/types';

export interface LatLng { lat: number; lng: number }

/** A place with a weight — how much freight moves through it. */
export interface WeightedPoint extends LatLng {
  id: string;
  /** Loads per period, tonnes, or whatever the caller counts. Must be > 0. */
  weight: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Distance, and the basis it rests on
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHICH EARTH. Carried on every result rather than assumed, because the two
 * disagree by up to ~0.5% and a siting decision quoted to the kilometre needs to
 * say which one produced it.
 */
export type DistanceBasis = 'wgs84_ellipsoid' | 'sphere';

const WGS84_A = 6_378_137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const SPHERE_R = 6_371_008.8;
const RAD = Math.PI / 180;

/** Great-circle distance in metres. Fast, and wrong by up to 0.5%. */
export function sphereMetres(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD, dLng = (b.lng - a.lng) * RAD;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * SPHERE_R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * Vincenty inverse on WGS-84, in metres.
 *
 * Returns `null` on the antipodal case, where the formula is known not to
 * converge. A null is propagated as a refusal rather than silently replaced with
 * the spherical figure — substituting a different basis to avoid an empty result
 * is precisely the substitution this codebase refuses everywhere else.
 */
export function ellipsoidMetres(a: LatLng, b: LatLng): number | null {
  const L = (b.lng - a.lng) * RAD;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(a.lat * RAD));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(b.lat * RAD));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let lambda = L, prev = 0, iter = 0;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2SigmaM = 0, cosSqAlpha = 0;

  do {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2);
    if (sinSigma === 0) return 0;                       // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha;
    const C = (WGS84_F / 16) * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    prev = lambda;
    lambda = L + (1 - C) * WGS84_F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 200);

  if (iter >= 200) return null;                          // antipodal: does not converge

  const uSq = (cosSqAlpha * (WGS84_A ** 2 - WGS84_B ** 2)) / WGS84_B ** 2;
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = B * sinSigma * (cos2SigmaM + (B / 4) *
    (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
      (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  return WGS84_B * A * (sigma - deltaSigma);
}

export function distanceMetres(a: LatLng, b: LatLng, basis: DistanceBasis): number | null {
  return basis === 'sphere' ? sphereMetres(a, b) : ellipsoidMetres(a, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. The result — three-valued, and it says what it did
// ─────────────────────────────────────────────────────────────────────────────

export interface MedianRun {
  point: LatLng;
  iterations: number;
  /** Sum of weighted distances at the returned point. The objective, in km. */
  objectiveKm: number;
  /** How far the last step moved, in METRES. The convergence test's own units. */
  lastStepMetres: number;
  basis: DistanceBasis;
  n: number;
  totalWeight: number;
  /** Samples the iterate landed exactly on, handled by the Vardi-Zhang term. */
  coincidences: number;
}

export type MedianResult =
  | { status: 'converged'; run: MedianRun; renderedClaim: string }
  | {
      status: 'refused';
      reason: 'no_points' | 'non_positive_weight' | 'antipodal_pair' | 'not_converged';
      detail: string;
      remedy: string;
      /** Present for `not_converged`: the best iterate reached. */
      run?: MedianRun;
      renderedClaim: string;
    };

export interface MedianOptions {
  basis?: DistanceBasis;
  /** Convergence tolerance in METRES. Not degrees — see the header. */
  toleranceMetres?: number;
  maxIterations?: number;
}

export const DEFAULT_TOLERANCE_METRES = 1;
export const DEFAULT_MAX_ITERATIONS = 500;

// ─────────────────────────────────────────────────────────────────────────────
// 3. Weiszfeld, bounded, with Vardi-Zhang on the coincident case
// ─────────────────────────────────────────────────────────────────────────────

export function geodesicMedian(
  points: readonly WeightedPoint[], opts: MedianOptions = {},
): MedianResult {
  const basis = opts.basis ?? 'wgs84_ellipsoid';
  const tol = opts.toleranceMetres ?? DEFAULT_TOLERANCE_METRES;
  const maxIter = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  if (points.length === 0) {
    return {
      status: 'refused', reason: 'no_points',
      detail: 'no points supplied',
      remedy: 'A median of nothing is not the origin, and returning (0,0) would put a ' +
        'cross-dock in the Gulf of Guinea. Supply at least one facility.',
      renderedClaim: 'NO SITING POINT — no facilities supplied.',
    };
  }
  const bad = points.filter(p => !(p.weight > 0) || !Number.isFinite(p.weight));
  if (bad.length) {
    return {
      status: 'refused', reason: 'non_positive_weight',
      detail: `${bad.length} point(s) carry a non-positive or non-finite weight: ` +
        bad.slice(0, 3).map(p => `${p.id}=${p.weight}`).join(', '),
      remedy: 'A zero-weight facility is one you do not serve — leave it out rather than ' +
        'weighting it zero, so the n reported is the n that mattered.',
      renderedClaim: 'NO SITING POINT — a facility carries a non-positive weight.',
    };
  }

  const totalWeight = points.reduce((s, p) => s + p.weight, 0);
  const objective = (y: LatLng): number | null => {
    let sum = 0;
    for (const p of points) {
      const d = distanceMetres(p, y, basis);
      if (d === null) return null;
      sum += p.weight * d;
    }
    return sum / 1000;
  };

  // The weighted mean is a fair start, exactly as the original has it.
  let y: LatLng = {
    lat: points.reduce((s, p) => s + p.lat * p.weight, 0) / totalWeight,
    lng: points.reduce((s, p) => s + p.lng * p.weight, 0) / totalWeight,
  };

  let iterations = 0, lastStep = Infinity, coincidences = 0;

  for (; iterations < maxIter; iterations++) {
    let wSum = 0, latSum = 0, lngSum = 0;
    // The Vardi-Zhang term: weight of the samples the iterate sits exactly on.
    let atPoint = 0;
    let coincident: WeightedPoint | null = null;

    for (const p of points) {
      const d = distanceMetres(p, y, basis);
      if (d === null) {
        return {
          status: 'refused', reason: 'antipodal_pair',
          detail: `the geodesic from ${p.id} to the current estimate is antipodal, where ` +
            'Vincenty does not converge',
          remedy: 'Split the set, or evaluate on the `sphere` basis and say so — substituting ' +
            'the spherical figure silently would report an ellipsoid answer that is not one.',
          renderedClaim: `NO SITING POINT — an antipodal pair (${p.id}) on the ellipsoid.`,
        };
      }
      if (d < 1e-9) { atPoint += p.weight; coincident = p; continue; }
      const w = p.weight / d;
      wSum += w; latSum += w * p.lat; lngSum += w * p.lng;
    }

    if (wSum === 0) {
      // Every sample is AT the iterate: they are all one place, and that place is
      // the answer. `lastStep` must be set here — leaving it at its Infinity
      // initial value made the convergence check below refuse a run that had
      // converged exactly, which is the one case where the answer is certain.
      lastStep = 0;
      iterations++;
      break;
    }

    const t: LatLng = { lat: latSum / wSum, lng: lngSum / wSum };
    let next: LatLng;
    if (atPoint === 0) {
      next = t;
    } else {
      // VARDI-ZHANG, rather than the original's fixed 0.1-degree nudge north-east.
      // The step is shortened toward the coincident point by exactly the fraction
      // its weight represents, which is the analytic answer instead of a jolt in a
      // direction the data did not choose.
      coincidences++;
      const rLat = (t.lat - y.lat) * wSum, rLng = (t.lng - y.lng) * wSum;
      const r = Math.hypot(rLat, rLng);
      const gamma = r === 0 ? 0 : Math.min(1, atPoint / r);
      const c = coincident as WeightedPoint;
      next = {
        lat: (1 - gamma) * t.lat + gamma * c.lat,
        lng: (1 - gamma) * t.lng + gamma * c.lng,
      };
    }

    // THE CONVERGENCE TEST IS IN METRES, in the same units as the objective.
    const step = distanceMetres(y, next, basis);
    lastStep = step ?? Infinity;
    y = next;
    if (step !== null && step < tol) { iterations++; break; }
  }

  const obj = objective(y);
  const run: MedianRun = {
    point: y, iterations,
    objectiveKm: obj ?? NaN,
    lastStepMetres: lastStep,
    basis, n: points.length, totalWeight, coincidences,
  };

  if (lastStep > tol) {
    return {
      status: 'refused', reason: 'not_converged', run,
      detail: `stopped at the ${maxIter}-iteration cap with the last step still ` +
        `${lastStep.toFixed(1)} m, above the ${tol} m tolerance`,
      remedy: 'Raise maxIterations, or loosen the tolerance deliberately. The iterate is ' +
        'returned so it can be inspected, but it is NOT the median and must not be quoted ' +
        'as one.',
      renderedClaim:
        `NO SITING POINT — Weiszfeld did not converge in ${maxIter} iterations (last step ` +
        `${lastStep.toFixed(1)} m). The best iterate is attached and is not an answer.`,
    };
  }

  return {
    status: 'converged', run,
    renderedClaim:
      `Site at ${y.lat.toFixed(5)}, ${y.lng.toFixed(5)} — the weighted geodesic median of ` +
      `${points.length} facilities (total weight ${totalWeight}), on the ` +
      `${basis === 'wgs84_ellipsoid' ? 'WGS-84 ellipsoid' : 'sphere'}. Converged in ` +
      `${iterations} iterations, last step ${lastStep.toFixed(2)} m. Total weighted distance ` +
      `${(obj ?? NaN).toFixed(0)} km` +
      (coincidences ? `; the iterate met a facility ${coincidences} time(s), handled by the ` +
        'Vardi-Zhang term rather than nudged off it' : '') +
      '. Minimises distance, not squared distance — one outlier facility does not drag it.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. The centroid, for comparison — and why it is the wrong answer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The weighted mean. Provided so the difference can be MEASURED rather than
 * asserted: the centroid minimises SQUARED distance, so a single distant
 * facility pulls it much further than it pulls the median.
 */
export function weightedCentroid(points: readonly WeightedPoint[]): LatLng | null {
  const w = points.reduce((s, p) => s + p.weight, 0);
  if (!(w > 0)) return null;
  return {
    lat: points.reduce((s, p) => s + p.lat * p.weight, 0) / w,
    lng: points.reduce((s, p) => s + p.lng * p.weight, 0) / w,
  };
}

/** Total weighted distance from a candidate site to every facility, in km. */
export function totalWeightedKm(
  points: readonly WeightedPoint[], at: LatLng, basis: DistanceBasis = 'wgs84_ellipsoid',
): number | null {
  let sum = 0;
  for (const p of points) {
    const d = distanceMetres(p, at, basis);
    if (d === null) return null;
    sum += p.weight * d;
  }
  return sum / 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. The siting decision
// ─────────────────────────────────────────────────────────────────────────────

export interface SitingReport {
  median: MedianResult;
  /** What the centroid would have chosen, and what that costs. */
  centroid: LatLng | null;
  centroidKm: number | null;
  medianKm: number | null;
  /** Positive = the median is better, in weighted km per period. */
  savedKm: number | null;
  /** The basis both figures rest on. Comparing across bases would be meaningless. */
  basis: DistanceBasis;
  evaluatedAt: ISODateTime;
  renderedClaim: string;
}

/**
 * Where to site, what the naive answer would have been, and the difference —
 * because "use the median" is an assertion until the gap is a number.
 */
export function siteFacility(
  points: readonly WeightedPoint[], evaluatedAt: ISODateTime, opts: MedianOptions = {},
): SitingReport {
  const basis = opts.basis ?? 'wgs84_ellipsoid';
  const median = geodesicMedian(points, opts);
  const centroid = weightedCentroid(points);
  const centroidKm = centroid ? totalWeightedKm(points, centroid, basis) : null;
  const medianKm = median.status === 'converged' ? median.run.objectiveKm : null;
  const savedKm = centroidKm !== null && medianKm !== null ? centroidKm - medianKm : null;

  return {
    median, centroid, centroidKm, medianKm, savedKm, basis, evaluatedAt,
    renderedClaim: median.status !== 'converged'
      ? median.renderedClaim
      : `${median.renderedClaim} The weighted centroid would have chosen ` +
        `${centroid!.lat.toFixed(5)}, ${centroid!.lng.toFixed(5)}, costing ` +
        `${(centroidKm ?? NaN).toFixed(0)} km against the median's ` +
        `${(medianKm ?? NaN).toFixed(0)} km — a difference of ` +
        `${(savedKm ?? NaN).toFixed(0)} weighted km per period.`,
  };
}
