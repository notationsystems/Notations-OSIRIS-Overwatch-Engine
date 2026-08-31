/**
 * Payload — attestation, closed under computation.
 *
 * THE FINDING THIS ADDRESSES. `admissible`/`weakestInputClass` is computed
 * correctly on the read side, but as a FIELD BESIDE the number rather than
 * a property INSIDE its identity. A field beside the number is stripped at
 * exactly the point the number becomes persuasive — the MCP export, the
 * figure copied into a bid, the bottleneck score painted as a red dot.
 * Measured in this very tree: `bottleneckCandidates`, `flowCentrality`,
 * `concentrationTrajectory` and `detectAnomalies` produced numbers with no
 * attestation field at all, standing on 23 representative-class flow rows,
 * and one of them drove a map layer.
 *
 * THE DEMAND. A concentration index over nine measured inputs and one
 * representative one must come out marked representative AUTOMATICALLY,
 * without anyone remembering to mark it. That is what "closed under
 * computation" means: attestation is an algebra, the combine happens at the
 * point of computation, and the result cannot be obtained without it.
 *
 * WHY IT IS A DEADLINE. This is an IDENTITY property, and an identity
 * property cannot be retrofitted onto data that already exists. Every
 * freight primitive carries attestation from birth or never carries it
 * honestly.
 *
 * THE LATTICE IS DIRECTIONAL, AND IT IS THE CONTAMINATION DIRECTION. For a
 * DERIVED quantity, one representative input taints the whole — the weakest
 * input wins. (The opposite direction, "one good witness is enough" for
 * entity EXISTENCE, is `strongestAttestingClass` in analytics.ts and must
 * never be unified with this one. See the lattice note there.)
 */

/** The evidence class of a value — the source's own label, or the curation
 *  class of a value the source never emitted. Mirrors Observation.valueKind
 *  exactly; kept as its own name so this module does not depend on the
 *  observation shape. */
export type EvidenceClass = 'reported' | 'estimated' | 'representative' | 'derived';
export type AttConfidence = 'high' | 'medium' | 'low';

/** Contamination lattice: reported is hardest, derived is weakest. Weakest
 *  wins when inputs combine, because a derived quantity is only as sound as
 *  its softest input. */
export const EVIDENCE_RANK: Record<EvidenceClass, number> = {
  reported: 3, estimated: 2, representative: 1, derived: 0,
};
const CONF_RANK: Record<AttConfidence, number> = { high: 2, medium: 1, low: 0 };

/**
 * THE INTEREST AXIS — what stake the source had in saying it.
 *
 * A SECOND DIMENSION, not a position on the evidence lattice. Provenance
 * answers where a number came from; source class answers how hard the
 * evidence is. Neither answers whether the party stating it had a reason to
 * state it that way, and in freight almost every operational number is
 * stated by someone with a stake: a quote is a negotiating position, a
 * carrier's self-reported on-time rate flatters the carrier, a shipper's
 * stated volume is a bargaining anchor. A commodity corpus can mostly
 * ignore this because a regulator's tonnage figure has no counterparty; a
 * freight corpus cannot.
 *
 * MEASURE THE GAP, DO NOT TRUST THE FLAG. This axis does NOT discount a
 * number. Discounting an interested figure by a fixed factor invents a
 * correction nobody measured — the same fabrication as defaulting a missing
 * value. What the axis does is ROUTE TO MEASUREMENT: a carrier whose
 * self-reported reliability persistently exceeds its observed outcome is
 * the interest axis made computable, and that residual is the finding. The
 * flag says where to look; the residual says what is true.
 *
 * So `restsOnInterested` deliberately does NOT feed `isAdmissible()`. An
 * interested claim is admissible evidence about the world — it is simply
 * evidence whose bias is measurable, and measuring it is the whole point.
 */
export type Interest =
  /** A party with no stake in the value: a regulator's record, an
   *  instrument reading, a third-party observation. */
  | 'disinterested'
  /** The party describes itself — a carrier's own on-time rate. */
  | 'self_reported'
  /** Stated to move a negotiation: a quote, a stated volume, an anchor. */
  | 'negotiating_position'
  /** Not established. NOT the same as disinterested, and never defaulted to
   *  it: assuming no stake because nobody recorded one is exactly how an
   *  interested number gets treated as a measurement. */
  | 'unknown';

/** Most-interested wins when claims combine, the same contamination
 *  direction as the evidence lattice: a result standing on one negotiating
 *  position rests on a negotiating position. `unknown` ranks BELOW
 *  disinterested — an unrecorded stake is not an absent stake. */
export const INTEREST_RANK: Record<Interest, number> = {
  disinterested: 3, unknown: 2, self_reported: 1, negotiating_position: 0,
};

/**
 * The evidential standing of a value, as part of its identity.
 *
 * `restsOnRepresentative` is called out as its own flag rather than left
 * implicit in `evidenceClass`, because it is the single question a
 * downstream consumer most needs answered — is this admissible for a
 * real-world claim — and a flag is harder to drop than a rank to
 * misinterpret. A value that rests on even one representative or fabricated
 * input is INADMISSIBLE by construction, whatever else is true of it.
 */
export interface Attestation {
  readonly evidenceClass: EvidenceClass;
  readonly confidence: AttConfidence;
  /** How many source values this stands on. Zero is not clean — it is
   *  vacuous, and `combineAttestations([])` refuses rather than inventing a
   *  class for a computation with no inputs. */
  readonly inputCount: number;
  /** True if any input was representative or fabricated. Once true, always
   *  true downstream — contamination does not wash out. */
  readonly restsOnRepresentative: boolean;
  /** The most-interested input's stake. Second axis; see Interest. */
  readonly interest: Interest;
  /** True if any input was self-reported or a negotiating position. Routes
   *  to residual measurement; deliberately does NOT affect admissibility. */
  readonly restsOnInterested: boolean;
  readonly note?: string;
}

export const ATTESTATION_HAS_NO_INPUTS = 'ATTESTATION_HAS_NO_INPUTS';

export class AttestationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'AttestationError';
  }
}

/** The attestation of a single source value. */
export function attestationOf(
  evidenceClass: EvidenceClass,
  confidence: AttConfidence,
  interest: Interest = 'unknown',
  note?: string,
): Attestation {
  return Object.freeze({
    evidenceClass,
    confidence,
    inputCount: 1,
    restsOnRepresentative: evidenceClass === 'representative',
    interest,
    restsOnInterested: interest === 'self_reported' || interest === 'negotiating_position',
    note,
  });
}

/**
 * The monoid. Combine the attestations of a derived quantity's inputs into
 * the attestation of the result: weakest evidence class, weakest
 * confidence, summed input count, representative-contamination OR-ed.
 *
 * CLOSED: combine(measured, representative) is representative, always,
 * with no branch a caller can forget to take. Combining is associative and
 * commutative, so it does not matter what order the inputs arrive in.
 *
 * REFUSES on an empty input set. A derived quantity with no inputs is not a
 * clean quantity; it is a computation over nothing, and inventing an
 * evidence class for it is the vacuity the empty-warrant guard exists to
 * catch.
 */
export function combineAttestations(inputs: readonly Attestation[]): Attestation {
  if (inputs.length === 0) {
    throw new AttestationError(
      ATTESTATION_HAS_NO_INPUTS,
      'combineAttestations([]) — a derived quantity computed from no inputs has no evidential ' +
        'standing to inherit. This is vacuity, not cleanliness: the result rests on nothing and ' +
        'must not be handed a class as if it rested on something.',
    );
  }
  let evidenceClass: EvidenceClass = 'reported';
  let confidence: AttConfidence = 'high';
  let interest: Interest = 'disinterested';
  let inputCount = 0;
  let restsOnRepresentative = false;
  let restsOnInterested = false;
  for (const a of inputs) {
    if (EVIDENCE_RANK[a.evidenceClass] < EVIDENCE_RANK[evidenceClass]) evidenceClass = a.evidenceClass;
    if (CONF_RANK[a.confidence] < CONF_RANK[confidence]) confidence = a.confidence;
    if (INTEREST_RANK[a.interest] < INTEREST_RANK[interest]) interest = a.interest;
    inputCount += a.inputCount;
    restsOnRepresentative = restsOnRepresentative || a.restsOnRepresentative;
    restsOnInterested = restsOnInterested || a.restsOnInterested;
  }
  return Object.freeze({
    evidenceClass, confidence, interest, inputCount, restsOnRepresentative, restsOnInterested,
  });
}

/** Is this value admissible for a claim about the real world? One
 *  representative input anywhere in its history answers no. */
export function isAdmissible(a: Attestation): boolean {
  // Interest deliberately absent from this test. An interested claim is
  // admissible evidence whose bias is MEASURABLE; discounting it here would
  // invent a correction nobody measured. See the Interest note.
  return !a.restsOnRepresentative;
}

/** Values whose stated figure should be checked against observed outcome.
 *  This is a routing question, not a verdict — the residual is the verdict. */
export function needsInterestResidual(a: Attestation): boolean {
  return a.restsOnInterested;
}

/**
 * A value carrying its attestation as part of its identity.
 *
 * The brand is module-private, so an `Attested<T>` cannot be written as an
 * object literal from outside this file. That is the enforcement: a caller
 * cannot fabricate an attested value with a stronger attestation than its
 * inputs earned, because the only way to get one is `attest()` (a leaf
 * value) or `computeAttested()` (which combines). "Inside the identity"
 * means precisely this: the number and its standing cannot be separated
 * without going through code that keeps them together.
 */
declare const ATTESTED: unique symbol;
export interface Attested<T> {
  readonly [ATTESTED]: true;
  readonly value: T;
  readonly attestation: Attestation;
}

/** Lift a leaf value into an attested one. The construction site. */
export function attest<T>(value: T, attestation: Attestation): Attested<T> {
  return Object.freeze({ value, attestation } as Attested<T>);
}

/**
 * Compute over attested inputs, and carry the combined attestation onto the
 * result automatically.
 *
 * This is the point of the whole module: `fn` sees only the raw values and
 * cannot touch the attestation, and the attestation of the result is
 * `combineAttestations(inputs)` whether or not `fn`'s author thought about
 * evidence class at all. A mean over nine measured and one representative
 * comes out representative because the combine ran, not because someone
 * remembered.
 */
export function computeAttested<T>(
  inputs: ReadonlyArray<Attested<unknown>>,
  fn: (values: unknown[]) => T,
): Attested<T> {
  const attestation = combineAttestations(inputs.map((i) => i.attestation));
  return attest(fn(inputs.map((i) => i.value)), attestation);
}

/**
 * The wire shape for an attested value at an export boundary (MCP, API).
 *
 * The attestation is NOT optional here. An export that could omit it would
 * strip the honest label at the most persuasive moment — a machine
 * consumer reading the number as ground truth — which is the exact failure
 * this module exists to prevent. The boundary test asserts every exported
 * number is this shape.
 */
export interface AttestedWire<T> {
  readonly value: T;
  readonly attestation: Attestation;
  readonly admissible: boolean;
  /** Surfaced separately from `admissible`: a consumer must be able to see
   *  "this rests on a negotiating position" without that being confused for
   *  "this is inadmissible". */
  readonly restsOnInterested: boolean;
}

export function toWire<T>(a: Attested<T>): AttestedWire<T> {
  return {
    value: a.value,
    attestation: a.attestation,
    admissible: isAdmissible(a.attestation),
    restsOnInterested: a.attestation.restsOnInterested,
  };
}
