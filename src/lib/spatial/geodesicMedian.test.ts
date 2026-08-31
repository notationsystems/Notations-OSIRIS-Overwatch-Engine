import { describe, it, expect } from 'vitest';
import {
  geodesicMedian, siteFacility, weightedCentroid, totalWeightedKm,
  ellipsoidMetres, sphereMetres, distanceMetres,
  DEFAULT_TOLERANCE_METRES, type WeightedPoint,
} from './geodesicMedian';

const NOW = '2026-09-05T00:00:00.000Z';
const p = (id: string, lat: number, lng: number, weight = 1): WeightedPoint => ({ id, lat, lng, weight });

// The freight spine, with a far outlier.
const TOR = p('TOR', 43.653, -79.383, 40);
const MIS = p('MIS', 43.589, -79.658, 30);
const HAM = p('HAM', 43.256, -79.866, 20);
const DET = p('DET', 42.331, -83.046, 25);
const YZF = p('YELLOWKNIFE', 62.454, -114.372, 1);   // one load a year

describe('distance basis', () => {
  it('the ellipsoid and the sphere disagree, which is why the basis travels', () => {
    const a = { lat: 43.653, lng: -79.383 }, b = { lat: 42.331, lng: -83.046 };
    const e = ellipsoidMetres(a, b)!, s = sphereMetres(a, b);
    expect(e).toBeGreaterThan(300_000);
    expect(Math.abs(e - s)).toBeGreaterThan(100);          // they differ by >100 m
    expect(Math.abs(e - s) / e).toBeLessThan(0.006);       // ...but under 0.6%
  });

  it('is zero for coincident points and symmetric', () => {
    const a = { lat: 43.653, lng: -79.383 };
    expect(ellipsoidMetres(a, a)).toBe(0);
    expect(ellipsoidMetres(a, { lat: 1, lng: 1 })).toBeCloseTo(ellipsoidMetres({ lat: 1, lng: 1 }, a)!, 6);
  });

  it('REFUSES the antipodal case rather than substituting the sphere', () => {
    // Vincenty is known not to converge here. Returning the spherical figure
    // would report an ellipsoid answer that is not one.
    const d = ellipsoidMetres({ lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 });
    expect(d).toBeNull();
    expect(sphereMetres({ lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 })).toBeGreaterThan(0);
    expect(distanceMetres({ lat: 0, lng: 0 }, { lat: 0.5, lng: 179.7 }, 'sphere')).not.toBeNull();
  });
});

describe('geodesicMedian - refusals come before any point is returned', () => {
  it('refuses an empty set rather than returning the origin', () => {
    const r = geodesicMedian([]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('no_points');
    expect(r.remedy).toContain('Gulf of Guinea');
  });

  it('refuses a non-positive weight rather than treating it as absent', () => {
    const r = geodesicMedian([TOR, { ...DET, weight: 0 }]);
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('non_positive_weight');
  });

  it('refuses a non-convergent run and does NOT pass off the iterate as an answer', () => {
    const r = geodesicMedian([TOR, MIS, HAM, DET], { maxIterations: 1, toleranceMetres: 0.001 });
    expect(r.status).toBe('refused');
    if (r.status !== 'refused') return;
    expect(r.reason).toBe('not_converged');
    expect(r.run).toBeDefined();
    expect(r.renderedClaim).toContain('is not an answer');
  });
});

describe('geodesicMedian - it minimises what it says it minimises', () => {
  const pts = [TOR, MIS, HAM, DET];
  const r = geodesicMedian(pts);

  it('converges, and reports how', () => {
    expect(r.status).toBe('converged');
    if (r.status !== 'converged') return;
    expect(r.run.iterations).toBeGreaterThan(0);
    expect(r.run.lastStepMetres).toBeLessThan(DEFAULT_TOLERANCE_METRES);
    expect(r.run.basis).toBe('wgs84_ellipsoid');
    expect(r.run.n).toBe(4);
    expect(r.run.totalWeight).toBe(115);
  });

  it('beats the centroid on the objective, and every nearby perturbation', () => {
    // THE LOAD-BEARING PIN. Without it "it computes the median" is an assertion.
    if (r.status !== 'converged') throw new Error('expected convergence');
    const best = r.run.objectiveKm;
    const centroidKm = totalWeightedKm(pts, weightedCentroid(pts)!)!;
    expect(best).toBeLessThanOrEqual(centroidKm);
    for (const [dLat, dLng] of [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2], [0.15, 0.15], [-0.15, -0.15]]) {
      const km = totalWeightedKm(pts, { lat: r.run.point.lat + dLat, lng: r.run.point.lng + dLng })!;
      expect(km, `perturbation ${dLat},${dLng}`).toBeGreaterThanOrEqual(best - 1e-6);
    }
  });

  it('is ROBUST to the outlier the centroid is dragged by', () => {
    // One load a year to Yellowknife should not move the cross-dock.
    const withOutlier = [...pts, YZF];
    const m2 = geodesicMedian(withOutlier);
    if (r.status !== 'converged' || m2.status !== 'converged') throw new Error('expected convergence');
    const medianShift = totalWeightedKm([{ ...r.run.point, id: 'a', weight: 1 }], m2.run.point)!;
    const c1 = weightedCentroid(pts)!, c2 = weightedCentroid(withOutlier)!;
    const centroidShift = totalWeightedKm([{ ...c1, id: 'b', weight: 1 }], c2)!;
    expect(centroidShift).toBeGreaterThan(medianShift);
  });
});

describe('geodesicMedian - the coincident-point case is handled, not nudged', () => {
  it('lands ON the dominant facility when its weight dominates', () => {
    // With one facility far heavier than the rest, the median IS that facility —
    // exactly where Weiszfeld divides by zero. The original nudges 0.1 degrees
    // north-east (~11 km) in a direction the data did not choose.
    const dominant = [p('HUB', 43.653, -79.383, 1000), p('A', 45.5, -73.5, 1), p('B', 42.3, -83.0, 1)];
    const r = geodesicMedian(dominant);
    expect(r.status).toBe('converged');
    if (r.status !== 'converged') return;
    const offHub = ellipsoidMetres(r.run.point, { lat: 43.653, lng: -79.383 })!;
    expect(offHub).toBeLessThan(11_000);   // nowhere near a 0.1-degree jolt
    expect(r.run.objectiveKm).toBeLessThan(
      totalWeightedKm(dominant, { lat: 43.753, lng: -79.283 })!);
  });

  it('returns the point itself when every facility is one place', () => {
    const same = [p('A', 43.653, -79.383, 3), p('B', 43.653, -79.383, 2)];
    const r = geodesicMedian(same);
    expect(r.status).toBe('converged');
    if (r.status !== 'converged') return;
    expect(r.run.objectiveKm).toBeCloseTo(0, 3);
  });
});

describe('geodesicMedian - the tolerance is in metres, not degrees', () => {
  it('means the same distance at the equator and near the pole', () => {
    // The original tests `euclidean(y, y1) < 1e-6` on a degree pair, so the same
    // tolerance is 0.11 m of longitude at the equator and ~0 at the pole.
    const equator = geodesicMedian(
      [p('a', 0, 0, 1), p('b', 0, 2, 1), p('c', 1, 1, 1)], { toleranceMetres: 5 });
    const polar = geodesicMedian(
      [p('a', 78, 0, 1), p('b', 78, 2, 1), p('c', 79, 1, 1)], { toleranceMetres: 5 });
    for (const r of [equator, polar]) {
      expect(r.status).toBe('converged');
      if (r.status === 'converged') expect(r.run.lastStepMetres).toBeLessThan(5);
    }
  });
});

describe('siteFacility - the gap is a number, not an assertion', () => {
  const rep = siteFacility([TOR, MIS, HAM, DET, YZF], NOW);

  it('reports what the centroid would have cost', () => {
    expect(rep.median.status).toBe('converged');
    expect(rep.centroidKm).not.toBeNull();
    expect(rep.medianKm).not.toBeNull();
    expect(rep.savedKm!).toBeGreaterThan(0);
    expect(rep.renderedClaim).toContain('weighted km per period');
    expect(rep.renderedClaim).toContain('Minimises distance, not squared distance');
  });

  it('carries the basis, because comparing across bases is meaningless', () => {
    expect(rep.basis).toBe('wgs84_ellipsoid');
    const onSphere = siteFacility([TOR, MIS, HAM, DET, YZF], NOW, { basis: 'sphere' });
    expect(onSphere.basis).toBe('sphere');
    expect(onSphere.renderedClaim).toContain('sphere');
  });

  it('holds no clock', () => {
    expect(rep.evaluatedAt).toBe(NOW);
  });
});
