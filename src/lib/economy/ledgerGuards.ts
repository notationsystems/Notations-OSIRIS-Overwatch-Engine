/**
 * OSIRIS — validWhile guards on deferred ledger decisions.
 *
 * The pattern: a deferred decision is safe only while the condition that
 * made it safe still holds — and that condition should be EXECUTABLE rather
 * than remembered. Same category as the topology-validity guard: not a new
 * capability, a guard converting documented assumptions into enforced
 * invariants.
 *
 * Each entry mirrors a decision recorded in docs/ARCHITECTURE_LEDGER.md and
 * carries the condition under which the decision remains the right one. One
 * test iterates every entry and fails with the entry id, the original
 * reason, and the condition that stopped holding — the failure means "a
 * decision needs re-taking, and here is why it was taken", which is a
 * different and more useful thing than a broken build.
 *
 * What this does NOT do:
 *   - it does not re-decide anything: a failing predicate raises the
 *     decision; a human takes it;
 *   - it does not replace the ledger's prose — `reason` is what makes the
 *     failure legible a year later;
 *   - it does not cover verified/built work, which has its own tests. This
 *     is for the entries with no test because nothing was built.
 */

import type { EconomyState, EntityKind } from './types';
import { SOURCE_REGISTRY, type RegisteredSource } from './sourceRegistry';
import { topologyValidity } from './propagation';

/* Registry-shaped conditions are factored out so the vacuity tests can show
 * each one failing against a mutated registry — a guard designed never to
 * fire in its shipping state must still be shown able to fire. */
export const noEventAdapterBuilt = (registry: RegisteredSource[]): boolean =>
  registry.every(s => s.adapter === null || !s.yields.includes('event'));

export const dailyPhysicalStreamCount = (registry: RegisteredSource[]): number =>
  registry.filter(s =>
    s.adapter !== null && s.category === 'stocks' && (s.cadence === 'daily' || s.cadence === 'continuous')).length;

export interface DeferredDecision {
  id: string;
  /** Where the decision is recorded in the architecture ledger. */
  ledgerRef: string;
  /** Why the decision was taken — quoted in the failure message. */
  reason: string;
  validWhile: {
    /** The condition, in prose, for the failure message. */
    description: string;
    predicate: (state: EconomyState, now: string) => boolean;
  };
}

/** The canonical identity kinds. The person-name policy's three pins cover
 *  the search surface only while every register kind stays in this set. */
const CANONICAL_ENTITY_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  'mine', 'smelter', 'refinery', 'port', 'manufacturer', 'region', 'country',
  'commodity', 'infrastructure', 'company',
]);

/** Extrapolation bound: two full snapshot cadences. The flow topology is an
 *  annual snapshot; the next vintage is producible within one cadence, so
 *  two cadences past the period end means at least one expected vintage has
 *  been skipped and "latest-known structure" stops being a defensible label.
 *  The basis is the cadence, not a taste constant. */
export const EXTRAPOLATION_BOUND_DAYS = 2 * 365;

export const DEFERRED_DECISIONS: DeferredDecision[] = [
  {
    id: 'event-class-attribution-basis-unbuilt',
    ledgerRef: 'Phase 12 §3 / Phase 25',
    reason: 'A sanction\'s exposure is operator-of-record ∪ material shareholding — neither pure control nor pure economic interest (Glencore the named test case). Originally deferred while no sanctions-class event existed; the aluminium register BROKE that condition (evt:rusal-sanctions-2018 is a curated sanction) and the breach went unnoticed for a round because the guards only ever ran on the copper state. Re-taken (phase 25): the deferral is KNOWINGLY held against the acknowledged counterexample — the Rusal sanction propagates reach through owner edges but no combined-basis exposure figure is quoted anywhere, so the missing basis is still not load-bearing. The NEXT sanctions-class curation forces the build, not another acknowledgment.',
    validWhile: {
      description: 'every sanction/insolvency event in the register is in the acknowledged-counterexample list [evt:rusal-sanctions-2018] — a second one forces the build, never a third acknowledgment',
      predicate: (state) => state.events
        .filter(ev => ev.type === 'sanction' || ev.type === 'insolvency')
        .every(ev => ev.id === 'evt:rusal-sanctions-2018'),
    },
  },
  {
    id: 'facility-scoped-regulation-unbuilt',
    ledgerRef: 'Phase 24 / Phase 25',
    reason: 'RegulatoryScope is jurisdiction-shaped (country + commodity + direction) and cannot express a regulatory act scoped to ONE FACILITY — the real Alunorte court embargo (2018–19) is modeled as an operational disruption, with the acknowledgment TYPED on the event (schemaLimitation) rather than remembered in prose. The deferral is knowingly held against that one live counterexample.',
    validWhile: {
      description: 'every event modeled around the facility-scoped-regulation gap is in the acknowledged list [evt:alunorte-embargo-2018] — a second one is accumulated demand and forces the scope schema to gain an entity dimension',
      predicate: (state) => state.events
        .filter(ev => ev.schemaLimitation === 'facility_scoped_regulation')
        .every(ev => ev.id === 'evt:alunorte-embargo-2018'),
    },
  },
  {
    id: 'flow-vintages-deferred',
    ledgerRef: 'Phase 13 §3 / capability table',
    reason: 'Flow vintages (several flow periods coexisting, asOf selecting among them) are deferred below the two search items because exactly one snapshot exists: "latest at or before asOf" has nothing to select among, and the topology guard covers the mismatch honestly.',
    validWhile: {
      description: 'exactly one distinct flow period exists — a second vintage makes the guard\'s selection rule live and the deferral unsound',
      predicate: (state) => new Set(state.flows.map(f => `${f.period.start}..${f.period.end}`)).size <= 1,
    },
  },
  {
    id: 'person-name-policy-surface',
    ledgerRef: 'Phase 12 §4 / Phase 13 §4',
    reason: 'The person-name policy is pinned at three surfaces (SearchHit fields, registry yields, miss-log vocabulary gate) on the assumption that no register kind is person-shaped — the pins cover the whole surface only while that holds.',
    validWhile: {
      description: 'every entity kind in the register is in the canonical identity set — a person-shaped kind would open a surface none of the three pins covers',
      predicate: (state) => state.entities.every(e => CANONICAL_ENTITY_KINDS.has(e.kind)),
    },
  },
  {
    id: 'modality-programme-not-started',
    ledgerRef: 'Phase 8 / Phase 12 §4',
    reason: 'The numeric detector is frozen because its recall bound is structural: the missing acquisition modality (events from language, AIS) is a separately funded programme, deliberately not started. The freeze is uncontested only while no event-yielding adapter is ingesting.',
    validWhile: {
      description: 'no registered source with a built adapter yields events — an event-extraction adapter landing means the freeze must be re-taken against a corpus whose recall bound has moved',
      predicate: () => noEventAdapterBuilt(SOURCE_REGISTRY),
    },
  },
  {
    id: 'westmetall-singular-dependency',
    ledgerRef: 'Phase 7–8 (corpus health, horizon table)',
    reason: 'The Westmetall fragility note (single republisher scrape, plausibility-gated, licensed feed as remedy) describes a SINGULAR dependency: it is the corpus\'s only daily physical stream, hence the only source capable of non-negative lead. The day a second lands, the note understates the corpus and the corpus-health loadBearing logic needs re-reading.',
    validWhile: {
      description: 'exactly one built adapter serves a daily physical (stocks) stream — a second positive-lead source ends the singularity the note describes',
      predicate: () => dailyPhysicalStreamCount(SOURCE_REGISTRY) === 1,
    },
  },
  {
    id: 'forward-extrapolation-defensible',
    ledgerRef: 'Phase 13 §1 / Phase 15',
    reason: 'Forward extrapolation keeps figures because the snapshot is the latest claim under the standard selection rule. Two axes bound that: a CLOCK ceiling (two annual cadences answers "should a new vintage exist by now?" — a question about the curator) and an EVIDENCE trigger ("is the old topology still true?" — a question about the world; elapsed time is a proxy, the event register holds the thing itself). The evidence trigger FIRED on its first evaluation — evt:grasberg-mud-rush-2025, open-ended force majeure postdating the snapshot, four months ahead of the clock — and the decision was re-taken (Phase 15): extrapolation continues as the only modeled structure, with the contradiction CARRIED on every projection (TopologyValidity.structuralEvidence + escalated note), so the evidence axis is enforced in the product and pinned in propagation tests, not remembered here. The clock ceiling remains this guard\'s condition.',
    validWhile: {
      description: `extrapolation distance stays under ${EXTRAPOLATION_BOUND_DAYS} days (two annual snapshot cadences) — beyond it, at least one expected vintage has been skipped and even evidence-carried extrapolation must be re-argued or the vintage refreshed`,
      predicate: (state, now) => {
        const v = topologyValidity(state, now);
        return v.status !== 'extrapolated' || (v.extrapolationDays ?? 0) < EXTRAPOLATION_BOUND_DAYS;
      },
    },
  },
];

export interface GuardFailure {
  id: string;
  ledgerRef: string;
  reason: string;
  condition: string;
}

/** Evaluate every deferred decision's condition; returns the entries whose
 *  condition no longer holds. Empty means every deferral is still standing
 *  on the ground it was taken on. */
export function evaluateDeferredDecisions(state: EconomyState, now: string): GuardFailure[] {
  return DEFERRED_DECISIONS
    .filter(d => !d.validWhile.predicate(state, now))
    .map(d => ({ id: d.id, ledgerRef: d.ledgerRef, reason: d.reason, condition: d.validWhile.description }));
}
