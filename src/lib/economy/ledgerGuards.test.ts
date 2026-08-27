import { describe, it, expect } from 'vitest';
import {
  DEFERRED_DECISIONS, EXTRAPOLATION_BOUND_DAYS, dailyPhysicalStreamCount,
  evaluateDeferredDecisions, evaluateAllDeferredDecisions, guardEvaluationScope,
  noEventAdapterBuilt,
} from './ledgerGuards';
import { SOURCE_REGISTRY } from './sourceRegistry';
import { registerAdapter, unregisterAdapter } from './adapters';
import { syntheticState, FIXTURE_PROV } from './fixtures';
import type { EntityKind } from './types';

describe('validWhile guards on deferred ledger decisions', () => {
  it('every deferred decision still stands on the ground it was taken on — over the DERIVED scope', async () => {
    // Work order 3.1: the runner's scope is derived from the adapter
    // register, never hand-listed — a hand list is the copper-only blindness
    // waiting to recur on the next axis value.
    const now = new Date().toISOString().slice(0, 10);
    const { scope, failures } = await evaluateAllDeferredDecisions(now);
    expect(scope).toContain('copper');
    expect(scope).toContain('aluminium');
    // A failure here is NOT a broken build: it says a recorded decision
    // needs re-taking, and the message carries why — with the partition it
    // failed in.
    expect(
      failures,
      failures.map(f => `[${f.commodity}] [${f.id}] (${f.ledgerRef}) condition no longer holds: ${f.condition}\n  decision was taken because: ${f.reason}`).join('\n'),
    ).toEqual([]);
  });

  it('certification: the runner covers the full cross-product of register partitions × predicates', async () => {
    const now = new Date().toISOString().slice(0, 10);
    const { scope, evaluatedCells } = await evaluateAllDeferredDecisions(now);
    const uncovered: string[] = [];
    for (const commodity of scope) {
      const cell = evaluatedCells.find(c => c.commodity === commodity);
      if (!cell) { uncovered.push(`${commodity}: NO predicates evaluated`); continue; }
      for (const d of DEFERRED_DECISIONS) {
        if (!cell.predicates.includes(d.id)) uncovered.push(`${commodity}: ${d.id} not evaluated`);
      }
    }
    expect(uncovered, `uncovered cells:\n${uncovered.join('\n')}`).toEqual([]);
  });

  it('the scope is derived from the register: a planted commodity enters it with no guard-code change', async () => {
    // The trap the pre-registration names: a literal partition list is
    // subject to the defect it certifies. Plant a novel partition value in
    // the register and assert the scope notices.
    registerAdapter({
      providerId: 'test-planted-commodity',
      providerName: 'Planted partition (test)',
      commodities: ['testium-planted'],
      async load() {
        return {
          commodity: 'testium-planted', commodityName: 'Testium (planted)',
          entities: [{ id: 'ent:commodity:testium-planted', kind: 'commodity', name: 'Testium (planted)' }],
          observations: [], flows: [], capacities: [], dependencies: [], events: [], sources: [],
        };
      },
    });
    try {
      expect(guardEvaluationScope()).toContain('testium-planted');
      const { evaluatedCells } = await evaluateAllDeferredDecisions('2026-08-27');
      const cell = evaluatedCells.find(c => c.commodity === 'testium-planted');
      expect(cell).toBeDefined();
      expect(cell!.predicates.length).toBe(DEFERRED_DECISIONS.length);
    } finally {
      unregisterAdapter('test-planted-commodity');
    }
  });

  it('every entry carries a ledger reference, a reason, and an executable condition', () => {
    for (const d of DEFERRED_DECISIONS) {
      expect(d.ledgerRef.length, d.id).toBeGreaterThan(0);
      expect(d.reason.length, d.id).toBeGreaterThan(20);
      expect(d.validWhile.description.length, d.id).toBeGreaterThan(20);
    }
    const ids = DEFERRED_DECISIONS.map(d => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // ── Vacuity: a guard designed never to fire in its shipping state must be
  // shown able to fire. Each predicate fails against the planted condition
  // it exists to catch. ──

  it('a sanctions-class event BEYOND the acknowledged counterexample trips the attribution-basis deferral', () => {
    const s = syntheticState();
    s.events.push({
      id: 'evt:test-sanction', entityId: 'ent:mine:alpha', type: 'sanction',
      title: 'Sanction (planted)', start: '2024-06-01', severity: 'high', provenance: FIXTURE_PROV,
    });
    const failures = evaluateDeferredDecisions(s, '2024-07-01');
    expect(failures.map(f => f.id)).toContain('event-class-attribution-basis-unbuilt');
  });

  it('a second facility-scoped regulatory acknowledgment trips the scope-schema deferral', () => {
    const s = syntheticState();
    // The acknowledged Alunorte counterexample passes; a NEW event modeled
    // around the same gap is accumulated demand, not another acknowledgment.
    s.events.push({
      id: 'evt:planted-facility-order', entityId: 'ent:port:gate', type: 'disruption',
      title: 'Court-ordered curtailment (planted)', start: '2024-06-01', severity: 'high',
      schemaLimitation: 'facility_scoped_regulation', provenance: FIXTURE_PROV,
    });
    const failures = evaluateDeferredDecisions(s, '2024-07-01');
    expect(failures.map(f => f.id)).toContain('facility-scoped-regulation-unbuilt');
  });

  it('a mixed-granularity flow trips the allocation-model deferral', () => {
    // The predecessor guard (flow-vintages-deferred: "exactly one distinct
    // flow period exists") FIRED when work order 3.2 landed the country
    // vintages — exactly as designed — and was re-taken as this narrower
    // deferral: the allocation model stays unbuilt while no source
    // attributes facility-level shares of country trade. The planted firing
    // condition is that arrival: a flow with exactly one country endpoint.
    const s = syntheticState();
    s.flows.push({
      ...s.flows[0], id: 'flow:planted-facility-attributed',
      fromEntityId: 'ent:mine:alpha', toEntityId: 'ent:country:planted',
    });
    const failures = evaluateDeferredDecisions(s, '2025-06-01');
    expect(failures.map(f => f.id)).toContain('allocation-model-deferred');
  });

  it('a person-shaped entity kind trips the person-name-policy surface guard', () => {
    const s = syntheticState();
    // The compile-time union is the first line of defense; the guard is the
    // runtime line for exactly the day someone widens the union.
    s.entities.push({
      id: 'ent:person:planted', name: 'Planted Person', kind: 'person' as EntityKind,
      commodity: 'testium',
    });
    const failures = evaluateDeferredDecisions(s, '2024-07-01');
    expect(failures.map(f => f.id)).toContain('person-name-policy-surface');
  });

  it('an event-yielding adapter would trip the modality freeze', () => {
    expect(noEventAdapterBuilt(SOURCE_REGISTRY)).toBe(true);
    const mutated = SOURCE_REGISTRY.map(s =>
      s.sourceId === 'news-events' ? { ...s, adapter: 'news-events-live' } : s);
    expect(noEventAdapterBuilt(mutated)).toBe(false);
  });

  it('a second daily physical stream would trip the Westmetall singularity note', () => {
    expect(dailyPhysicalStreamCount(SOURCE_REGISTRY)).toBe(1);
    const mutated = SOURCE_REGISTRY.map(s =>
      s.sourceId === 'lme-licensed' ? { ...s, adapter: 'lme-licensed-live' } : s);
    expect(dailyPhysicalStreamCount(mutated)).toBe(2);
  });

  it('extrapolation past two snapshot cadences trips the forward-extrapolation bound', () => {
    const s = syntheticState(); // flows end 2024-12-31
    const withinBound = evaluateDeferredDecisions(s, '2026-06-01');
    expect(withinBound.map(f => f.id)).not.toContain('forward-extrapolation-defensible');
    const beyondBound = evaluateDeferredDecisions(s, '2027-02-01'); // > 730 days past
    expect(beyondBound.map(f => f.id)).toContain('forward-extrapolation-defensible');
    expect(EXTRAPOLATION_BOUND_DAYS).toBe(730);
  });
});
