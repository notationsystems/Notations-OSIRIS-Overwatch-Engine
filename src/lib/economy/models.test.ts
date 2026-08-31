import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerModel, lookupModel, modelAsKnownAt, versionsOf, clearRegistry,
  predict, replayVerdict, isFaithfulReplay, ModelRegistryError,
  UNREGISTERED_PREDICTOR, type RegisteredModel,
} from './models';
import { attestationOf } from './attestation';

const ATT = attestationOf('reported', 'high', 'disinterested');

function model(over: Partial<RegisteredModel> = {}): RegisteredModel {
  return {
    modelId: 'M-42', version: '1.0.0', kind: 'solver', predicts: 'eta',
    inputs: ['lanes.residuals'], evidenceBoundary: 'fit on 2025 Ontario lanes',
    uncertainty: { kind: 'interval' }, knownLimitations: ['no winter data'],
    knownAt: '2026-01-01', ...over,
  };
}

describe('the Model/Claim Registry refuses an unregistered predictor', () => {
  beforeEach(() => clearRegistry());

  it('refuses a prediction whose model is not registered', () => {
    expect(() => predict({
      predictionId: 'P-1', modelId: 'M-99', version: '1.0.0', computedAt: '2026-08-31',
      stateSnapshotId: 'S-1', value: 480, interval: [420, 540], attestation: ATT,
    })).toThrowError(ModelRegistryError);
    try {
      predict({
        predictionId: 'P-1', modelId: 'M-99', version: '1.0.0', computedAt: '2026-08-31',
        stateSnapshotId: 'S-1', value: 480, interval: [420, 540], attestation: ATT,
      });
    } catch (e) {
      expect((e as ModelRegistryError).code).toBe(UNREGISTERED_PREDICTOR);
      // The failure mode named: the hard-coded buffer, not the route solver.
      expect((e as Error).message).toContain('rule someone hard-coded');
    }
  });

  it('a SOLVER registers exactly as a language model does', () => {
    // "The system computes and verifies" is an appeal to authority unless
    // the solver earns admissibility like anything else.
    registerModel(model({ modelId: 'M-43', kind: 'solver', predicts: 'cost' }));
    registerModel(model({ modelId: 'M-44', kind: 'llm', predicts: 'cost' }));
    expect(lookupModel('M-43', '1.0.0')?.kind).toBe('solver');
    expect(lookupModel('M-44', '1.0.0')?.kind).toBe('llm');
  });

  it('a hard-coded heuristic is registrable, which is the point', () => {
    registerModel(model({ modelId: 'M-45', kind: 'heuristic', predicts: 'transit_buffer',
      evidenceBoundary: 'chosen by a dispatcher in 2025; never fit to data' }));
    const p = predict({
      predictionId: 'P-2', modelId: 'M-45', version: '1.0.0', computedAt: '2026-08-31',
      stateSnapshotId: 'S-1', value: 2, interval: [1, 3], attestation: ATT,
    });
    expect(p.computedBy.modelId).toBe('M-45');
  });

  it('a prediction carries the computation identity, not just its inputs', () => {
    registerModel(model());
    const p = predict({
      predictionId: 'P-3', modelId: 'M-42', version: '1.0.0', computedAt: '2026-08-31',
      stateSnapshotId: 'S-7', value: 480, interval: [420, 540], attestation: ATT,
    });
    expect(p.computedBy).toEqual({ modelId: 'M-42', version: '1.0.0', computedAt: '2026-08-31' });
    expect(p.stateSnapshotId).toBe('S-7');
    expect(p.interval).toEqual([420, 540]);
  });
});

describe('the registry entry has its own knownAt', () => {
  beforeEach(() => clearRegistry());

  it('selects the model version current at a past date', () => {
    registerModel(model({ version: '1.0.0', knownAt: '2026-01-01' }));
    registerModel(model({ version: '2.0.0', knownAt: '2026-06-01' }));
    expect(modelAsKnownAt('M-42', '2026-03-01')?.version).toBe('1.0.0');
    expect(modelAsKnownAt('M-42', '2026-08-01')?.version).toBe('2.0.0');
    expect(versionsOf('M-42')).toHaveLength(2);
  });

  it('has no version before the first was knowable', () => {
    registerModel(model({ version: '1.0.0', knownAt: '2026-06-01' }));
    expect(modelAsKnownAt('M-42', '2026-01-01')).toBeUndefined();
  });
});

describe('a replay declares itself, and never implies history it cannot deliver', () => {
  beforeEach(() => clearRegistry());

  it('FAITHFUL when the pinned version is what would run', () => {
    registerModel(model({ version: '1.0.0', knownAt: '2026-01-01' }));
    const v = replayVerdict({ modelId: 'M-42', version: '1.0.0', computedAt: '2026-03-01' }, '2026-03-01');
    expect(v.kind).toBe('faithful');
    expect(isFaithfulReplay(v)).toBe(true);
  });

  it('RECOMPUTATION when the model changed — the failure this exists to prevent', () => {
    // A revised threshold makes the replay reconstruct a number nobody ever
    // saw. Silently doing that under an AS KNOWN banner is the failure.
    registerModel(model({ version: '1.0.0', knownAt: '2026-01-01' }));
    registerModel(model({ version: '2.0.0', knownAt: '2026-06-01' }));
    const v = replayVerdict({ modelId: 'M-42', version: '1.0.0', computedAt: '2026-03-01' }, '2026-08-01');
    expect(v.kind).toBe('recomputation');
    expect(isFaithfulReplay(v)).toBe(false);
    if (v.kind === 'recomputation') {
      expect(v.pinnedVersion).toBe('1.0.0');
      expect(v.currentVersion).toBe('2.0.0');
      expect(v.banner).toContain('RECOMPUTED');
      expect(v.banner).toContain('not what was concluded then');
    }
  });

  it('UNREPLAYABLE when the pinned version was dropped from the registry', () => {
    registerModel(model({ version: '2.0.0', knownAt: '2026-06-01' }));
    const v = replayVerdict({ modelId: 'M-42', version: '1.0.0', computedAt: '2026-03-01' }, '2026-08-01');
    expect(v.kind).toBe('unreplayable');
    if (v.kind === 'unreplayable') {
      expect(v.reason).toContain('no longer registered');
      // Names the remedy: retention is what makes replay possible at all.
      expect(v.reason).toContain('Retaining superseded model versions');
    }
  });

  it('only a faithful replay may be presented as history', () => {
    registerModel(model({ version: '1.0.0', knownAt: '2026-01-01' }));
    registerModel(model({ version: '2.0.0', knownAt: '2026-06-01' }));
    const recomputed = replayVerdict({ modelId: 'M-42', version: '1.0.0', computedAt: '2026-03-01' }, '2026-08-01');
    const faithful = replayVerdict({ modelId: 'M-42', version: '2.0.0', computedAt: '2026-08-01' }, '2026-08-01');
    expect([recomputed, faithful].filter(isFaithfulReplay)).toHaveLength(1);
  });
});
