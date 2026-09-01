/**
 * Payload — the Model/Claim Registry, and computation identity.
 *
 * TWO FINDINGS, ONE MECHANISM.
 *
 * (1) "The system computes and verifies" smuggles a solver's assumptions in
 * as ground truth. When an optimizer checks a model's "$700 saving", the
 * optimizer is ITSELF a model of the world with assumptions and an evidence
 * boundary. Their disagreement is two models disagreeing, not the system
 * correcting the model. So the route solver, the ETA model and the cost
 * optimizer register exactly as an LLM does, and a prediction earns
 * admissibility the same way regardless of what produced it. The
 * deterministic layer keeps its authority over OBSERVED FACT and POLICY —
 * `get_vehicle_state(217)` returning `verified, knownAt, source` — and has
 * no authority over prediction.
 *
 * (2) THE HINDSIGHT REPLAY ANSWERS A DIFFERENT QUESTION THAN IT APPEARS TO.
 * `AS KNOWN` filters records by knownAt, but the analytics consuming them
 * are TODAY'S. So the panel shows what today's engine concludes from what
 * was knowable then — not what we concluded then. A revised bottleneck
 * threshold or a changed margin rule makes the replay reconstruct a number
 * nobody ever saw, under a banner implying it is the number they saw. That
 * is directly against the thesis that eighteen months later you can say
 * what a bid rested on.
 *
 * The fix for both is the same: A RESULT CARRIES THE IDENTITY OF THE
 * COMPUTATION THAT PRODUCED IT, not just of its inputs. Then a replay
 * either re-runs the pinned version or DECLARES ITSELF a recomputation.
 * Silently doing the second while implying the first is the failure, and
 * `replayVerdict()` below is what makes the declaration mandatory.
 *
 * THE REGISTRY ENTRY HAS ITS OWN knownAt. A model is a claim about how the
 * world works, and it became knowable on a date like any other claim. Two
 * versions of the ETA model are two claims, and asking "what did we
 * believe on the fifth" has to select among them the same way it selects
 * among observations.
 *
 * COMPLETENESS IS THE POINT, and the failure mode is not the route solver
 * — that is obviously a model and will get registered. It is the hard-coded
 * `+2 days` buffer in a quoting path: a predictive model with assumptions,
 * an evidence boundary and no id. When it is wrong, the residual attributes
 * the error to nothing. Accounting for every drop, applied to predictions.
 */

import { processSingleton } from './processSingleton';
import type { Attestation } from './attestation';

export type ModelKind =
  /** A language model's judgement. */
  | 'llm'
  /** An optimizer or route engine — a model, not an oracle. */
  | 'solver'
  /** Fitted from data: a residual model, a seasonal factor. */
  | 'statistical'
  /** A rule someone chose. The `+2 days` buffer lives here, and naming it
   *  is the whole point — an unregistered heuristic is the invisible half
   *  of the generative model. */
  | 'heuristic'
  /** A deterministic analytic over recorded state: an index, a score. It is
   *  registered because its PARAMETERS are doctrine — a changed threshold
   *  changes the number, and a replay must know which threshold ran. */
  | 'analytic';

export interface UncertaintySpec {
  /** How the interval is produced. `none` is a valid answer and an
   *  important one: a model that cannot state its uncertainty must say so
   *  rather than implying a point estimate is exact. */
  readonly kind: 'stddev' | 'interval' | 'quantiles' | 'none';
  readonly note?: string;
}

export interface RegisteredModel {
  readonly modelId: string;
  readonly version: string;
  readonly kind: ModelKind;
  /** What quantity it predicts: 'eta' | 'cost' | 'bottleneck_score' | … */
  readonly predicts: string;
  readonly inputs: readonly string[];
  /** What it was fit on, or what it assumes. The boundary outside which its
   *  output is extrapolation rather than prediction. */
  readonly evidenceBoundary: string;
  readonly uncertainty: UncertaintySpec;
  readonly knownLimitations: readonly string[];
  /** When THIS VERSION became knowable. A model is a claim about how the
   *  world works and it has a date like any other claim. */
  readonly knownAt: string;
}

export const UNREGISTERED_PREDICTOR = 'UNREGISTERED_PREDICTOR';
export const PREDICTION_WITHOUT_INTERVAL = 'PREDICTION_WITHOUT_INTERVAL';

export class ModelRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ModelRegistryError';
  }
}

type Key = string;
const keyOf = (modelId: string, version: string): Key => `${modelId}@${version}`;

/** Process-wide: a registry that severed across module contexts would
 *  resolve a model in one and refuse it in the other. */
function registry(): Map<Key, RegisteredModel> {
  return processSingleton<Map<Key, RegisteredModel>>('payload.models.registry', () => new Map());
}

export function registerModel(model: RegisteredModel): RegisteredModel {
  registry().set(keyOf(model.modelId, model.version), Object.freeze(model));
  return model;
}

export function lookupModel(modelId: string, version: string): RegisteredModel | undefined {
  return registry().get(keyOf(modelId, version));
}

/** Every registered version of a model, newest knownAt first. */
export function versionsOf(modelId: string): RegisteredModel[] {
  return [...registry().values()]
    .filter((m) => m.modelId === modelId)
    .sort((a, b) => (a.knownAt < b.knownAt ? 1 : -1));
}

/**
 * The version that was current at `asof` — the model-registry analogue of
 * as-known-then over observations. A replay that filters records by knownAt
 * and then runs today's model is answering a mixed question; this is how it
 * selects the model it should have run.
 */
export function modelAsKnownAt(modelId: string, asof: string): RegisteredModel | undefined {
  return versionsOf(modelId).find((m) => m.knownAt <= asof);
}

/** Test seam. */
export function clearRegistry(): void {
  registry().clear();
}

/** The identity of the computation that produced a value. */
export interface ComputedBy {
  readonly modelId: string;
  readonly version: string;
  readonly computedAt: string;
}

export interface Prediction<T = number> {
  readonly predictionId: string;
  readonly computedBy: ComputedBy;
  /** The immutable state this was computed from. */
  readonly stateSnapshotId: string;
  readonly value: T;
  /**
   * Never a point estimate without one. A bare number implies an exactness
   * no model has, and the decision that consumes it cannot weigh what it
   * was not told. A model whose UncertaintySpec is 'none' must still supply
   * the interval it is prepared to stand behind, even if that is the whole
   * plausible range — stating a wide interval is honest; omitting it is not.
   */
  readonly interval: readonly [number, number];
  readonly attestation: Attestation;
}

/**
 * Construct a prediction, refusing an unregistered predictor.
 *
 * This is the gate that stops "the system computes" from being an appeal to
 * authority: a solver's forecast entering a decision must name a registered
 * model exactly as a language model's must.
 */
export function predict<T>(input: {
  predictionId: string;
  modelId: string;
  version: string;
  computedAt: string;
  stateSnapshotId: string;
  value: T;
  interval: readonly [number, number];
  attestation: Attestation;
}): Prediction<T> {
  const model = lookupModel(input.modelId, input.version);
  if (!model) {
    throw new ModelRegistryError(
      UNREGISTERED_PREDICTOR,
      `${input.modelId}@${input.version} is not registered. Every prediction entering a decision ` +
        'names a registered model or is refused — including a solver\'s, and including a rule ' +
        'someone hard-coded. An unregistered predictor is still part of the generative model; it ' +
        'is just the part whose errors the residual can attribute to nothing.',
    );
  }
  if (!Array.isArray(input.interval) || input.interval.length !== 2) {
    throw new ModelRegistryError(
      PREDICTION_WITHOUT_INTERVAL,
      `${input.modelId} produced a point estimate with no interval. A bare number implies an ` +
        'exactness no model has, and the decision consuming it cannot weigh what it was not told.',
    );
  }
  return Object.freeze({
    predictionId: input.predictionId,
    computedBy: Object.freeze({
      modelId: input.modelId, version: input.version, computedAt: input.computedAt,
    }),
    stateSnapshotId: input.stateSnapshotId,
    value: input.value,
    interval: Object.freeze([input.interval[0], input.interval[1]] as const),
    attestation: input.attestation,
  });
}

export type ReplayVerdict =
  /** The pinned version was re-run. This IS what we concluded then. */
  | { readonly kind: 'faithful'; readonly modelId: string; readonly version: string }
  /**
   * The pinned version is not what would run now. The result is what
   * TODAY's model concludes from what was knowable then — a different
   * question, and one nobody was ever shown. Must be declared, never
   * implied.
   */
  | {
      readonly kind: 'recomputation';
      readonly modelId: string;
      readonly pinnedVersion: string;
      readonly currentVersion: string;
      readonly banner: string;
    }
  /** The pinned version is no longer in the registry at all, so the replay
   *  cannot even say how it differs. */
  | {
      readonly kind: 'unreplayable';
      readonly modelId: string;
      readonly pinnedVersion: string;
      readonly reason: string;
    };

/**
 * What kind of answer a replay is about to give.
 *
 * Called BEFORE rendering a replayed number, so the surface can say which
 * question it answered. Silently recomputing under an AS KNOWN banner is
 * the failure: it implies "this is what you saw" while showing "this is
 * what today's engine makes of what you knew".
 */
export function replayVerdict(pinned: ComputedBy, asof: string): ReplayVerdict {
  const pinnedModel = lookupModel(pinned.modelId, pinned.version);
  if (!pinnedModel) {
    return {
      kind: 'unreplayable',
      modelId: pinned.modelId,
      pinnedVersion: pinned.version,
      reason:
        `${pinned.modelId}@${pinned.version} produced this result and is no longer registered. ` +
        'The number cannot be reproduced and cannot be honestly recomputed either — what ran is ' +
        'unknown. Retaining superseded model versions is what makes a replay possible at all.',
    };
  }
  const current = modelAsKnownAt(pinned.modelId, asof);
  if (current && current.version === pinned.version) {
    return { kind: 'faithful', modelId: pinned.modelId, version: pinned.version };
  }
  return {
    kind: 'recomputation',
    modelId: pinned.modelId,
    pinnedVersion: pinned.version,
    currentVersion: current?.version ?? '(none at this date)',
    banner:
      `RECOMPUTED — ${pinned.modelId} has changed since this result was produced ` +
      `(${pinned.version} then, ${current?.version ?? 'none'} now). This shows what today's ` +
      'model concludes from what was knowable then, which is not what was concluded then. ' +
      'Re-run the pinned version for that.',
  };
}

/** A replay may be presented as history only when it is faithful. */
export function isFaithfulReplay(v: ReplayVerdict): boolean {
  return v.kind === 'faithful';
}
