import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  project, receive, assertProjected, projectionLog, clearProjectionLog,
  BlanketViolation, BLANKET_SENSORY_LEAK, BLANKET_ACTIVE_LEAK, BLANKET_VIEW_NOT_PROJECTED,
  type Blanket, type StateSnapshot, type Proposal,
} from './blanket';
import type { Provenance } from './types';

const PROV: Provenance = { sourceId: 'fixture', sourceName: 'fixture', retrievedAt: '2026-08-31' };

function snapshot(): StateSnapshot {
  return {
    snapshotId: 'S-1',
    regions: new Map([
      ['loads.open', { value: [{ id: 'L-1' }], provenance: PROV }],
      ['carriers.vetting', { value: [{ id: 'c-1', verdict: 'cleared' }], provenance: PROV }],
      ['carriers.identity', { value: [{ id: 'c-1', name: 'Acme' }], provenance: PROV }],
    ]),
  };
}

const DISPATCHER: Blanket = {
  agentId: 'claude:dispatch',
  sensory: new Set(['loads.open', 'carriers.vetting']),
  active: new Set(['decision_proposal', 'rationale']),
};

describe('the Markov blanket is a boundary with two sides, both enforced', () => {
  beforeEach(() => clearProjectionLog());

  it('projects only the authorized selectors', () => {
    const view = project(snapshot(), DISPATCHER, '2026-08-31', 'V-1');
    expect([...view.shown].sort()).toEqual(['carriers.vetting', 'loads.open']);
    expect(view.get('loads.open').value).toEqual([{ id: 'L-1' }]);
  });

  it('SENSORY LEAK: reading a selector outside the blanket is refused, not undefined', () => {
    // carriers.identity IS in the snapshot but NOT in this agent's blanket.
    // The silent-leak failure would be to return it, or to return undefined
    // (indistinguishable from an authorized empty region). It must throw.
    const view = project(snapshot(), DISPATCHER, '2026-08-31', 'V-1');
    expect(() => view.get('carriers.identity' as any)).toThrowError(BlanketViolation);
    try {
      view.get('carriers.identity' as any);
    } catch (e) {
      expect((e as BlanketViolation).code).toBe(BLANKET_SENSORY_LEAK);
    }
  });

  it('distinguishes "outside the blanket" from "authorized but absent from the snapshot"', () => {
    const partial: StateSnapshot = { snapshotId: 'S-2', regions: new Map([['loads.open', { value: [], provenance: PROV }]]) };
    const view = project(partial, DISPATCHER, '2026-08-31', 'V-2');
    expect(view.shown.has('loads.open')).toBe(true);
    expect(view.absent.has('carriers.vetting')).toBe(true);
    // Reading the absent-but-authorized region names it unobserved, not out-of-bounds.
    try {
      view.get('carriers.vetting');
    } catch (e) {
      expect((e as BlanketViolation).message).toContain('not empty');
    }
  });

  it('records what was shown — the sensory side\'s only trace', () => {
    project(snapshot(), DISPATCHER, '2026-08-31', 'V-1');
    const log = projectionLog();
    expect(log).toHaveLength(1);
    expect(log[0].agentId).toBe('claude:dispatch');
    expect(log[0].stateSnapshotId).toBe('S-1');
    expect([...log[0].selectors].sort()).toEqual(['carriers.vetting', 'loads.open']);
  });

  it('ACTIVE LEAK: proposing a kind outside the blanket is refused at the boundary', () => {
    const p: Proposal = { kind: 'action_proposal', agentId: 'claude:dispatch', fromViewId: 'V-1', body: {} };
    expect(() => receive(p, DISPATCHER, '2026-08-31')).toThrowError(BlanketViolation);
    try {
      receive(p, DISPATCHER, '2026-08-31');
    } catch (e) {
      expect((e as BlanketViolation).code).toBe(BLANKET_ACTIVE_LEAK);
    }
  });

  it('accepts an authorized proposal kind', () => {
    const p: Proposal = { kind: 'decision_proposal', agentId: 'claude:dispatch', fromViewId: 'V-1', body: {} };
    expect(receive(p, DISPATCHER, '2026-08-31').proposal).toBe(p);
  });

  it('refuses a proposal that claims another agent through this blanket', () => {
    const p: Proposal = { kind: 'decision_proposal', agentId: 'mistral:extract', fromViewId: 'V-1', body: {} };
    expect(() => receive(p, DISPATCHER, '2026-08-31')).toThrowError(BlanketViolation);
  });

  it('a view not produced by project() is not a view', () => {
    const fake = { viewId: 'X', agentId: 'claude:dispatch', shown: new Set(), absent: new Set() } as any;
    expect(() => assertProjected(fake)).toThrowError(BlanketViolation);
    try {
      assertProjected(fake);
    } catch (e) {
      expect((e as BlanketViolation).code).toBe(BLANKET_VIEW_NOT_PROJECTED);
    }
  });
});

describe('the blanket writes nothing — the boundary has no side door', () => {
  it('the module imports no store and contains no mutation path', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/economy/blanket.ts'), 'utf8');
    // A blanket that could write state would let a model dispose as well as
    // propose, which is the whole thing it exists to prevent. Asserted over
    // the source: no store import, and the projection log is the only
    // mutable thing, reached through the process singleton.
    expect(src).not.toMatch(/from '\.\/(ledger|register|stores|engine)'/);
    expect(src).not.toMatch(/\.append\(|\.write\(|\.set\(.*store/i);
  });
});
