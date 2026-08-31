/**
 * Payload — the Markov blanket: a typed, enforced boundary per agent.
 *
 * A Markov blanket is the set of variables that renders a system
 * conditionally independent of everything outside it. Payload's blanket is
 * the model-facing interface: Claude and Mistral see an authorized
 * projection of state and nothing else, and return typed proposals and
 * nothing else. The substitutability property — "Payload can replace
 * either model tomorrow without touching Evidence → State → Decision →
 * Execution → Outcome → Verification" — holds exactly as far as that
 * boundary is complete.
 *
 * NAMING IT A BLANKET RATHER THAN AN INTERFACE IS THE POINT. An interface
 * can have a side door and still typecheck. A blanket asserts there is no
 * side door, which makes COMPLETENESS the property under test and forces
 * the test to enumerate the doors.
 *
 * A BLANKET HAS TWO SIDES AND BOTH LEAK.
 *
 *   active  (internal → external): what the agent may propose. A leak here
 *           is a model writing state. It is the loud half: writes leave
 *           traces, and a store write whose call stack passes through a
 *           model provider is findable after the fact.
 *
 *   sensory (external → internal): what the agent may read. A leak here is
 *           a model seeing state outside its authorization, and it is the
 *           SILENT half — nothing is written, nothing is logged, and
 *           afterwards there is no evidence the leak happened at all.
 *
 * So the sensory side gets the heavier machinery. `project()` is the only
 * construction site for an `AuthorizedView` (enforced by a module-private
 * brand, the same shape as the single-construction-site invariant on
 * CarrierTender), and every projection emits a `ProjectionRecord` naming
 * what was shown. Without that record, "did this agent see something it
 * should not have" is unanswerable, and an unanswerable question about a
 * boundary is a boundary that is not enforced.
 */

import type { Provenance } from './types';
import { processSingleton } from './processSingleton';

/**
 * A named, addressable region of canonical state. Coarse deliberately: a
 * selector an agent cannot enumerate is a selector it cannot request, and
 * the blanket is declared in terms an operator can read and audit.
 */
export type StateSelector =
  | 'loads.open'
  | 'loads.settled'
  | 'lanes.residuals'
  | 'carriers.vetting'
  | 'carriers.identity'
  | 'commitments.open'
  | 'outcomes.recent'
  | 'opportunities.priced'
  | 'opportunities.blocked'
  | 'facilities.register'
  | 'markets.benchmark'
  | 'economy.state';

/** What an agent is permitted to hand back across the boundary. */
export type ProposalKind =
  | 'inference'
  | 'decision_proposal'
  | 'action_proposal'
  | 'critique'
  | 'rationale';

export interface Blanket {
  readonly agentId: string;
  /** What the agent may READ. Everything unnamed is invisible to it. */
  readonly sensory: ReadonlySet<StateSelector>;
  /** What the agent may PROPOSE. Everything unnamed is refused at the boundary. */
  readonly active: ReadonlySet<ProposalKind>;
}

export const BLANKET_SENSORY_LEAK = 'BLANKET_SENSORY_LEAK';
export const BLANKET_ACTIVE_LEAK = 'BLANKET_ACTIVE_LEAK';
export const BLANKET_VIEW_NOT_PROJECTED = 'BLANKET_VIEW_NOT_PROJECTED';

export class BlanketViolation extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'BlanketViolation';
  }
}

/**
 * Module-private brand. An `AuthorizedView` cannot be written as an object
 * literal from outside this file, so `project()` is the only way to obtain
 * one — the single construction site. A caller that could hand-build a view
 * could hand-build an unauthorized one, and the boundary would be a naming
 * convention rather than a boundary.
 */
const PROJECTED = Symbol('payload.blanket.projected');

export interface AuthorizedView {
  readonly [PROJECTED]: true;
  readonly viewId: string;
  readonly agentId: string;
  /** The snapshot this view was taken from. Immutable by reference. */
  readonly stateSnapshotId: string;
  /** Exactly the selectors this agent was authorized for AND that existed. */
  readonly shown: ReadonlySet<StateSelector>;
  /**
   * Authorized selectors that the snapshot did not carry. Reported rather
   * than silently omitted: an agent reasoning over a view is entitled to
   * know the difference between "this region is empty" and "this region
   * was not in the snapshot".
   */
  readonly absent: ReadonlySet<StateSelector>;
  readonly at: string;
  get(selector: StateSelector): ProjectedRegion;
}

export interface ProjectedRegion {
  readonly selector: StateSelector;
  readonly value: unknown;
  readonly provenance: Provenance;
}

/** What was shown, recorded. The sensory side's only trace. */
export interface ProjectionRecord {
  readonly viewId: string;
  readonly agentId: string;
  readonly stateSnapshotId: string;
  readonly selectors: readonly StateSelector[];
  readonly absent: readonly StateSelector[];
  readonly at: string;
}

/**
 * The projection log. Process-wide by construction: Next duplicates modules
 * across contexts, and a projection log that severed would answer "what did
 * this agent see" correctly about one copy and wrongly about the other —
 * which is the context-severance defect this codebase has already paid for
 * three times.
 */
function log(): ProjectionRecord[] {
  return processSingleton<ProjectionRecord[]>('payload.blanket.projections', () => []);
}

export function projectionLog(): readonly ProjectionRecord[] {
  return log();
}

/** Test seam. */
export function clearProjectionLog(): void {
  log().length = 0;
}

export interface StateSnapshot {
  readonly snapshotId: string;
  readonly regions: ReadonlyMap<StateSelector, { value: unknown; provenance: Provenance }>;
}

/**
 * Project canonical state through a blanket.
 *
 * The returned view contains ONLY selectors in `blanket.sensory`. A caller
 * asking the view for anything else gets a refusal rather than `undefined`,
 * because an unauthorized read that returns undefined is indistinguishable
 * from an authorized read of an empty region — and those are different
 * facts about the world.
 */
export function project(
  snapshot: StateSnapshot,
  blanket: Blanket,
  at: string,
  viewId: string,
): AuthorizedView {
  const shown = new Set<StateSelector>();
  const absent = new Set<StateSelector>();
  const regions = new Map<StateSelector, ProjectedRegion>();

  for (const selector of blanket.sensory) {
    const region = snapshot.regions.get(selector);
    if (region === undefined) {
      absent.add(selector);
      continue;
    }
    shown.add(selector);
    regions.set(selector, {
      selector,
      value: region.value,
      provenance: region.provenance,
    });
  }

  const record: ProjectionRecord = Object.freeze({
    viewId,
    agentId: blanket.agentId,
    stateSnapshotId: snapshot.snapshotId,
    selectors: Object.freeze([...shown]),
    absent: Object.freeze([...absent]),
    at,
  });
  log().push(record);

  const view: AuthorizedView = {
    [PROJECTED]: true,
    viewId,
    agentId: blanket.agentId,
    stateSnapshotId: snapshot.snapshotId,
    shown,
    absent,
    at,
    get(selector: StateSelector): ProjectedRegion {
      const region = regions.get(selector);
      if (region !== undefined) return region;
      if (absent.has(selector)) {
        throw new BlanketViolation(
          BLANKET_SENSORY_LEAK,
          `${blanket.agentId} is authorized for ${selector} but the snapshot did not carry it. ` +
            'This is a fact about the snapshot, not about the world: the region is not empty, ' +
            'it is unobserved.',
        );
      }
      throw new BlanketViolation(
        BLANKET_SENSORY_LEAK,
        `${blanket.agentId} read ${selector}, which is outside its blanket. Authorized: ` +
          `${[...blanket.sensory].join(', ') || '(nothing)'}.`,
      );
    },
  };
  return Object.freeze(view);
}

/** A view obtained any way other than `project()` is not a view. */
export function assertProjected(view: AuthorizedView): void {
  if (!view || view[PROJECTED] !== true) {
    throw new BlanketViolation(
      BLANKET_VIEW_NOT_PROJECTED,
      'this AuthorizedView was not produced by project(). A hand-built view carries no ' +
        'projection record, so what the agent saw is unknowable and the boundary is a naming ' +
        'convention rather than a boundary.',
    );
  }
}

export interface Proposal {
  readonly kind: ProposalKind;
  readonly agentId: string;
  /** The view this proposal was reasoned from — so a decision can name it. */
  readonly fromViewId: string;
  readonly body: unknown;
}

export interface Accepted {
  readonly proposal: Proposal;
  readonly acceptedAt: string;
}

/**
 * Receive a proposal across the blanket.
 *
 * Refused AT THE BOUNDARY, never downstream. A proposal of an unauthorized
 * kind that is rejected by a later validator has already been inside; the
 * whole value of a blanket is that the refusal happens where the boundary
 * is, so that "what can this agent do" is answerable from the blanket
 * declaration alone rather than from an audit of everything downstream.
 */
export function receive(proposal: Proposal, blanket: Blanket, at: string): Accepted {
  if (proposal.agentId !== blanket.agentId) {
    throw new BlanketViolation(
      BLANKET_ACTIVE_LEAK,
      `proposal claims agent ${proposal.agentId} but was received through ${blanket.agentId}'s ` +
        'blanket. An agent proposing through another agent\'s boundary defeats the per-agent ' +
        'authorization the blanket exists to carry.',
    );
  }
  if (!blanket.active.has(proposal.kind)) {
    throw new BlanketViolation(
      BLANKET_ACTIVE_LEAK,
      `${blanket.agentId} proposed ${proposal.kind}, which is outside its blanket. Permitted: ` +
        `${[...blanket.active].join(', ') || '(nothing)'}.`,
    );
  }
  return Object.freeze({ proposal, acceptedAt: at });
}

/**
 * Models propose, code disposes. Nothing here writes state, and that
 * absence is the point — this module has no store import and no mutation
 * path, so a write cannot pass through the blanket by construction. The
 * standing test asserts that property over the source rather than trusting
 * this comment.
 */
export const BLANKET_WRITES_NOTHING = true;
