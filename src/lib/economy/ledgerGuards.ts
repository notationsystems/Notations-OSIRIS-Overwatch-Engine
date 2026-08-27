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
    ledgerRef: 'Phase 12 §3',
    reason: 'A sanction\'s exposure is operator-of-record ∪ material shareholding — neither pure control nor pure economic interest (Glencore the named test case). Deferred behind the instrument backlog because no sanctions-class analysis is being run, so the combined basis has no consumer.',
    validWhile: {
      description: 'no sanction or insolvency event exists in the curated register — the moment one is curated, the missing attribution basis becomes load-bearing',
      predicate: (state) => state.events.every(ev => ev.type !== 'sanction' && ev.type !== 'insolvency'),
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
    ledgerRef: 'Phase 13 §1',
    reason: 'The topology guard is asymmetric: forward extrapolation keeps figures because the snapshot is the latest claim under the standard selection rule. That is defensible while the snapshot is recent enough that no expected successor vintage has been skipped; the distance is quantified (TopologyValidity.extrapolationDays), and the bound is two annual cadences.',
    validWhile: {
      description: `extrapolation distance stays under ${EXTRAPOLATION_BOUND_DAYS} days (two annual snapshot cadences) — beyond it, at least one expected vintage has been skipped and "latest-known structure" must be re-argued or the vintage refreshed`,
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
