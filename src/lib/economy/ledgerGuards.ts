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

import type { EconomyState, EntityKind, Provenance } from './types';
import { SOURCE_REGISTRY, type RegisteredSource } from './sourceRegistry';
import { propagateEvents, topologyValidity } from './propagation';
import { buildGraph } from './graph';
import { classifyRefusalExplanation } from './evidenceSearch';
import { listAdapters } from './adapters';
import { getEconomyState } from './store';

/* Registry-shaped conditions are factored out so the vacuity tests can show
 * each one failing against a mutated registry — a guard designed never to
 * fire in its shipping state must still be shown able to fire. */
export const noEventAdapterBuilt = (registry: RegisteredSource[]): boolean =>
  registry.every(s => s.adapter === null || !s.yields.includes('event'));

export const dailyPhysicalStreamCount = (registry: RegisteredSource[]): number =>
  registry.filter(s =>
    s.adapter !== null && s.category === 'stocks' && (s.cadence === 'daily' || s.cadence === 'continuous')).length;

/**
 * The prose→type coupling check behind `typed-refusal-emission-unbuilt`.
 *
 * The refusal queue's type is derived by PARSING the refusal's explanation
 * (classifyRefusalExplanation) — diagnosis coupled to prose. The durable
 * fix is typed emission (each mechanism emits its type; text rendered from
 * it), deferred as a build item. The deferral is safe only while a planted
 * instance of EVERY refusal mechanism, run through the real propagation
 * pipeline, still classifies into its own bucket — a wording change that
 * would silently retype the queue fails here instead of shipping.
 *
 * Parameterized on the classifier so the vacuity test can show the check
 * failing under a broken one — a guard designed never to fire in its
 * shipping state must still be shown able to fire.
 */
export function refusalTypeCouplingIntact(
  classify: (text: string) => string = classifyRefusalExplanation,
): boolean {
  const prov: Provenance = { sourceId: 'guard-fixture', sourceName: 'guard fixture', retrievedAt: '2026-01-01T00:00:00Z' };
  const s: EconomyState = {
    commodity: 'guardium', commodityName: 'Guardium',
    entities: [
      { id: 'ent:country:ga', kind: 'country', name: 'Guardia', countryCode: 'GA', commodity: 'guardium' },
      { id: 'ent:country:gb2', kind: 'country', name: 'Guardborough', countryCode: 'GB2', commodity: 'guardium' },
      { id: 'ent:mine:g-mine', kind: 'mine', name: 'Guard Mine', countryCode: 'GA', commodity: 'guardium', stage: 'production' },
      { id: 'ent:smelter:g-smelter', kind: 'smelter', name: 'Guard Smelter', countryCode: 'GB2', commodity: 'guardium', stage: 'smelting' },
    ],
    observations: [], capacities: [], dependencies: [],
    flows: [
      // Facility-period gross crossing corridor, no grade, no stage
      // constant → the basis mechanism.
      { id: 'flow:g-cross', fromEntityId: 'ent:mine:g-mine', toEntityId: 'ent:smelter:g-smelter', commodity: 'guardium', form: 'concentrate', quantity: 100, unit: 'kt gross/y', basis: 'gross_weight', period: { start: '2024-01-01', end: '2024-12-31' }, mode: 'sea', valueKind: 'representative', confidence: 'medium', provenance: prov },
      // A country vintage → the country-granularity (allocation) mechanism.
      { id: 'flow:g-vintage', fromEntityId: 'ent:country:ga', toEntityId: 'ent:country:gb2', commodity: 'guardium', form: 'concentrate', quantity: 80, unit: 'kt gross/y', basis: 'gross_weight', period: { start: '2017-01-01', end: '2017-12-31' }, mode: 'sea', valueKind: 'reported', confidence: 'medium', provenance: prov },
    ],
    events: [
      { id: 'evt:g-unscoped', entityId: 'ent:mine:g-mine', type: 'policy', title: 'Unscoped decree (guard)', start: '2024-02-01', severity: 'medium', provenance: prov },
      { id: 'evt:g-export', entityId: 'ent:mine:g-mine', type: 'policy', title: 'Export ban (guard)', start: '2024-02-01', severity: 'high', regulatoryScope: { jurisdictionCountryCode: 'GA', direction: 'export' }, provenance: prov },
      { id: 'evt:g-outage', entityId: 'ent:mine:g-mine', type: 'outage', title: 'Outage (guard)', start: '2017-02-01', severity: 'high', provenance: prov },
    ],
    sources: [],
  };
  const textOf = (r: ReturnType<typeof propagateEvents>, id: string): string =>
    r.result.find(i => i.eventId === id)!.explanation.join(' ');
  // Mechanism 1+2 — scope refusal and all-gross basis refusal, within the
  // facility period.
  const within = propagateEvents(s, buildGraph(s, '2024-06-15'), { asOf: '2024-06-15' });
  if (classify(textOf(within, 'evt:g-unscoped')) !== 'scope') return false;
  if (classify(textOf(within, 'evt:g-export')) !== 'basis') return false;
  // Mechanism 3 — facility event under a country vintage: allocation
  // refusal, typed topology.
  const country = propagateEvents(s, buildGraph(s, '2017-06-15'), { asOf: '2017-06-15' });
  if (classify(textOf(country, 'evt:g-outage')) !== 'topology') return false;
  // Mechanism 4 — predates: every refusal is topology-typed, INCLUDING the
  // export ban whose corridors are gross (the phase-33 wrong-attribution
  // fix, held here as a condition rather than remembered).
  const predates = propagateEvents(s, buildGraph(s), { asOf: '2015-01-01' });
  if (classify(textOf(predates, 'evt:g-outage')) !== 'topology') return false;
  if (classify(textOf(predates, 'evt:g-export')) !== 'topology') return false;
  return true;
}

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
    // RE-TAKEN under work order 3.2 (the original deferral's predicate —
    // "exactly one distinct flow period exists" — fired the day the country
    // vintages landed, exactly as designed). Country-level flow vintages
    // are BUILT; what remains deferred is the country↔facility ALLOCATION
    // MODEL: attributing a single facility's share of its country's
    // reporter-declared trade. Facility events at vintage dates refuse
    // with the model named (propagation.ts).
    id: 'allocation-model-deferred',
    ledgerRef: 'Phase 13 §3 / work order 2026-08-27 item 3.2',
    reason: 'The country↔facility allocation model is deferred: country vintages carry reporter-declared corridors only, and splitting a corridor across the facilities inside the reporter is a derivation with no source — any split would be fabricated precision. The refusal (facility tonnage null at country granularity, model named as remedy) is the honest boundary while no source attributes facility-level trade.',
    validWhile: {
      description: 'no flow record mixes granularities (exactly one endpoint a country) — a facility-attributed country corridor arriving means a source now provides what the allocation model was deferred for lacking, and the deferral must be re-taken against it',
      predicate: (state) => !state.flows.some(f =>
        f.fromEntityId.startsWith('ent:country:') !== f.toEntityId.startsWith('ent:country:')),
    },
  },
  {
    id: 'typed-refusal-emission-unbuilt',
    ledgerRef: 'Phase 33 / Phase 34 (wrong-attribution class)',
    reason: 'The refusal queue derives each propagation refusal\'s TYPE by parsing its explanation prose (classifyRefusalExplanation) — diagnosis coupled to wording, so a reworded explanation would silently retype the queue the researcher session exports. The durable fix (each mechanism emits its type; text rendered FROM it) is deferred as a build item; the per-site !predates guard holds meanwhile.',
    validWhile: {
      description: 'a planted instance of every refusal mechanism, run through the real propagation pipeline, still classifies into its own bucket — a wording change that would silently retype the queue fails this predicate instead of shipping',
      predicate: () => refusalTypeCouplingIntact(),
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

/* ── Evaluation-scope certification (work order 3.1) ──
 *
 * Three instances of one blindness were each found by a human, one to
 * twenty rounds late: a check evaluated correctly somewhere is silent about
 * everywhere else its condition holds. The certification: the guard
 * evaluation scope is DERIVED from the adapter register — never a literal,
 * because a literal partition list is subject to the exact defect it
 * certifies — and the standing runner reports the full cross-product of
 * partitions × predicates it actually evaluated, so an uncovered cell is
 * nameable, not invisible. */

export interface ScopedGuardFailure extends GuardFailure {
  /** The partition (commodity) the condition failed in — evaluation scope
   *  travels with every failure. */
  commodity: string;
}

export interface GuardEvaluation {
  /** Partition values derived from the register at evaluation time. */
  scope: string[];
  /** Every (partition × predicate) cell actually evaluated. */
  evaluatedCells: Array<{ commodity: string; predicates: string[] }>;
  failures: ScopedGuardFailure[];
}

/** The evaluation scope, derived from the adapter register. A commodity
 *  registered tomorrow enters this scope with no code change here. */
export function guardEvaluationScope(): string[] {
  return [...new Set(listAdapters().flatMap(a => a.commodities))].sort();
}

/** Evaluate every deferred decision over every partition the register
 *  contains. This is THE runner — a hand-listed subset elsewhere is the
 *  defect the certification test exists to name. */
export async function evaluateAllDeferredDecisions(now: string): Promise<GuardEvaluation> {
  const scope = guardEvaluationScope();
  const evaluatedCells: GuardEvaluation['evaluatedCells'] = [];
  const failures: ScopedGuardFailure[] = [];
  for (const commodity of scope) {
    const { state } = await getEconomyState(commodity);
    evaluatedCells.push({ commodity, predicates: DEFERRED_DECISIONS.map(d => d.id) });
    for (const f of evaluateDeferredDecisions(state, now)) failures.push({ ...f, commodity });
  }
  return { scope, evaluatedCells, failures };
}

/** Evaluate every deferred decision's condition; returns the entries whose
 *  condition no longer holds. Empty means every deferral is still standing
 *  on the ground it was taken on. */
export function evaluateDeferredDecisions(state: EconomyState, now: string): GuardFailure[] {
  return DEFERRED_DECISIONS
    .filter(d => !d.validWhile.predicate(state, now))
    .map(d => ({ id: d.id, ledgerRef: d.ledgerRef, reason: d.reason, condition: d.validWhile.description }));
}
