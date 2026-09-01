import { describe, it, expect } from 'vitest';
import {
  createSimulatedEngine, createSimulatedOptimizer, SIMULATED_CAPABILITIES,
  SIM_CLEARANCE_MM, greatCircleM, SIMULATED_BACKEND_ID,
} from './simulated';
import { SpatialRegistry, arbitrate, shortfallOf, spatialAvailability } from './registry';
import { isDiscriminating, type VehicleProfile, type Position } from './engine.types';

const NOW = '2026-08-31T12:00:00.000Z';
const TO_CITY: Position = [-79.3832, 43.6532];
const MTL: Position = [-73.5673, 45.5019];

const TALL: VehicleProfile = {
  profileId: 'tall@1', mode: 'truck', heightMm: SIM_CLEARANCE_MM + 120, grossWeightKg: 34_500,
};
const SHORT: VehicleProfile = {
  profileId: 'short@1', mode: 'truck', heightMm: SIM_CLEARANCE_MM - 50, grossWeightKg: 34_500,
};

const engine = () => createSimulatedEngine({ now: NOW });

describe('a simulated backend is a REGISTERED actor, not a fallback', () => {
  it('it is not the null backend — operations are actually available', () => {
    const avail = spatialAvailability(engine());
    expect(avail.filter(a => a.available).length).toBeGreaterThan(0);
    expect(avail.find(a => a.operation === 'route')!.available).toBe(true);
  });

  it('every claim it produces says SIMULATED, in the sentence a person reads', async () => {
    const r = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: [] });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.claim.renderedClaim.startsWith('SIMULATED —')).toBe(true);
      expect(r.claim.renderedClaim).toContain('Not a measurement of any real road network');
      expect(r.claim.provenance.backendId).toBe(SIMULATED_BACKEND_ID);
    }
  });

  it('the network vintage is stated as synthetic, not left blank', () => {
    expect(SIMULATED_CAPABILITIES.coverage.note).toContain('synthetic');
    expect(SIMULATED_CAPABILITIES.coverage.regions).toEqual(['SIMULATED']);
  });
});

describe('the restriction genuinely binds — otherwise the probe would refute it', () => {
  it('a tall vehicle is routed onto a slower path', async () => {
    const tall = await engine().route({ from: TO_CITY, to: MTL, profile: TALL, require: ['height'] });
    const short = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: ['height'] });
    expect(tall.status).toBe('ok'); expect(short.status).toBe('ok');
    if (tall.status !== 'ok' || short.status !== 'ok') return;
    expect(tall.claim.value.durationS).toBeGreaterThan(short.claim.value.durationS);
  });

  it('and it reproduces the MEASURED signature: duration moves, distance barely does', async () => {
    const tall = await engine().route({ from: TO_CITY, to: MTL, profile: TALL, require: ['height'] });
    const short = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: ['height'] });
    if (tall.status !== 'ok' || short.status !== 'ok') throw new Error('expected ok');
    const dDur = (tall.claim.value.durationS - short.claim.value.durationS) / short.claim.value.durationS;
    const dDist = Math.abs(tall.claim.value.distanceM - short.claim.value.distanceM) / short.claim.value.distanceM;
    // The real finding: +68% duration, -0.3% distance. A backend whose detour
    // moved DISTANCE would be caught by the arbiter as non-discriminating.
    expect(dDur).toBeGreaterThan(0.5);
    expect(dDist).toBeLessThan(0.02);
  });

  it('THE SELF-TEST: this backend passes its own discriminating probe', () => {
    // A simulated backend that accepted a height and applied nothing would be
    // `refuted` by the arbiter this codebase built — and would deserve to be.
    for (const v of SIMULATED_CAPABILITIES.verification) {
      expect(isDiscriminating(v), `${v.restriction}/${v.operation} probe is not discriminating`).toBe(true);
    }
    const a = arbitrate(SIMULATED_CAPABILITIES, 'route', ['height', 'weight']);
    expect(a.assured.sort()).toEqual(['height', 'weight']);
    expect(shortfallOf(a)).toEqual([]);
  });
});

describe('the per-operation asymmetry is reproduced deliberately', () => {
  it('height is assured on route and NOT honoured on matrix', () => {
    expect(shortfallOf(arbitrate(SIMULATED_CAPABILITIES, 'route', ['height']))).toEqual([]);
    expect(shortfallOf(arbitrate(SIMULATED_CAPABILITIES, 'matrix', ['height']))).toEqual(['height']);
  });

  it('so a strict caller is refused on matrix by a backend that routes fine', async () => {
    const reg = new SpatialRegistry().register(engine());
    const route = await reg.route(
      { from: TO_CITY, to: MTL, profile: TALL, require: ['height'] }, { strict: true });
    expect(route.status).toBe('ok');
    expect(shortfallOf(reg.select('matrix', ['height']).arbitration!)).toEqual(['height']);
  });
});

describe('it refuses where it cannot answer, rather than returning a plausible shape', () => {
  it('mapMatch refuses instead of echoing the trace back as matched', async () => {
    const r = await engine().mapMatch({ trace: [{ at: NOW, position: TO_CITY }], profile: SHORT });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.remedy).toContain('indistinguishable from a real match');
  });

  it('a matrix beyond the declared dimension refuses with the limit named', async () => {
    const many: Position[] = Array.from({ length: 11 }, (_, i) => [-79 + i * 0.1, 43] as const);
    const r = await engine().matrix({
      origins: many, destinations: many, profile: SHORT, require: [], metrics: ['duration'] });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.reason).toBe('matrix_too_large');
  });

  it('a fractional dimension is refused at the boundary', async () => {
    await expect(engine().route({
      from: TO_CITY, to: MTL, require: [],
      profile: { profileId: 'bad@1', mode: 'truck', heightMm: 4110.5 },
    })).rejects.toThrow(/NON_INTEGER_DIMENSION/);
  });
});

describe('it is deterministic, because a simulated answer that drifts is useless', () => {
  it('the same lane returns byte-identical results', async () => {
    const a = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: [] });
    const b = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('different lanes differ — the jitter is seeded, not constant', async () => {
    const a = await engine().route({ from: TO_CITY, to: MTL, profile: SHORT, require: [] });
    const b = await engine().route({ from: MTL, to: TO_CITY, profile: SHORT, require: [] });
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('expected ok');
    expect(a.claim.value.distanceM).not.toBe(b.claim.value.distanceM);
  });

  it('great-circle distance is sane against a known pair', () => {
    // Toronto–Montreal is ~505 km straight line. A model that got this wrong
    // would make every downstream number wrong in a way that still looks fine.
    const km = greatCircleM(TO_CITY, MTL) / 1000;
    expect(km).toBeGreaterThan(490);
    expect(km).toBeLessThan(520);
  });
});

describe('the optimizer never claims what it did not prove', () => {
  const veh = (id: string, cap: number) => ({
    vehicleId: id, start: TO_CITY, capacity: [cap], profile: SHORT,
  });
  const job = (id: string, at: Position, amt: number) => ({
    jobId: id, at, serviceS: 600, amount: [amt],
  });
  const matrixClaim = {
    value: { durationsS: [], distancesM: [], unreachablePairs: [] },
    provenance: {
      backendId: 'simulated', backendVersion: '1', operation: 'matrix' as const, mode: 'truck' as const,
      restrictionsRequested: [], restrictionsHonoured: [], legalityAssured: false,
      networkVintage: null, computedAt: NOW, computeMs: 0,
    },
    sourceClass: 'modeled' as const, renderedClaim: 'x',
  };

  it('a greedy walk reports feasible_not_proven, never proven_optimal', async () => {
    const r = await createSimulatedOptimizer({ now: NOW }).vrp({
      vehicles: [veh('V1', 10)], jobs: [job('J1', MTL, 4), job('J2', TO_CITY, 4)],
      matrix: matrixClaim, objective: 'min_duration', timeLimitMs: 1000,
    });
    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.claim.value.optimality).toBe('feasible_not_proven');
  });

  it('a job that exceeds capacity is UNASSIGNED with the constraint named', async () => {
    const r = await createSimulatedOptimizer({ now: NOW }).vrp({
      vehicles: [veh('V1', 5)], jobs: [job('J1', MTL, 4), job('J2', TO_CITY, 4)],
      matrix: matrixClaim, objective: 'min_duration', timeLimitMs: 1000,
    });
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.claim.value.unassigned).toHaveLength(1);
    expect(r.claim.value.unassigned[0].reason).toContain('capacity');
  });

  it('time windows are REFUSED, not silently ignored', async () => {
    const r = await createSimulatedOptimizer({ now: NOW }).timeWindows({
      vehicles: [], matrix: matrixClaim, objective: 'min_duration', timeLimitMs: 1,
    });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.remedy).toContain('silently ignores');
  });
});
