/**
 * Payload — how two claims about the same subject relate.
 *
 * THREE OUTCOMES, THREE EDGE TYPES, AND COLLAPSING ANY TWO IS A CATEGORY
 * ERROR. This is an identity property: the edges must be distinct from the
 * moment the store is written, because a status field bolted on later
 * cannot recover a distinction the writer never made.
 *
 * The commodity substrate inherited a merge topology built for a MONOTONIC
 * corpus — one where a later record is a correction and a disagreement is a
 * bug to go find. Freight is not that world, and copying the topology
 * uncritically would encode a chemist's epistemics as a freight one:
 *
 *   SUPERSEDES          One claimant, one subject, later knowledge.
 *                       A carrier requoting the same lane at a new price on
 *                       a new day. Keyed on knownAt. NOT a disagreement —
 *                       nobody is wrong, the world moved and the claimant
 *                       said so. Landing this in a conflicts table is the
 *                       error this module exists to prevent.
 *
 *   CONTRADICTS         One subject, incompatible claims, and they cannot
 *                       both hold. Carries its RESOLVABILITY (below),
 *                       because "go find the bug" and "the world is under-
 *                       determined" license completely different actions.
 *
 *   UNDER_DETERMINED    Different claimants, and the disagreement is not
 *                       about one fact at all. Two carriers quoting the same
 *                       lane differently are not contradicting each other:
 *                       they are two prices, both true, and the market has
 *                       no single value. Recording this as a conflict
 *                       manufactures a dispute out of ordinary commerce and
 *                       sends someone to resolve what is not broken.
 */

import type { Attestation } from './attestation';

/**
 * When claims DO contradict, which kind of contradiction it is. The edge
 * carries this because escalating the second kind as though it were the
 * first is the quiet-period alert-rate failure, one layer in.
 */
export type Resolvability =
  /**
   * One of them is wrong and finding out which is possible in principle.
   * A carrier's certificate saying insured through December while the
   * insurer says the policy lapsed in August: somebody is mistaken, there
   * is a fact of the matter, and the action is go and establish it.
   */
  | 'resolvable'
  /**
   * Both observers are competent and the world does not have a single
   * value at this resolution. Two rate indices disagreeing on a lane's
   * market rate is this: neither is the bug, the disagreement IS the
   * finding, and "resolving" it manufactures a precision the evidence
   * does not support. The honest output is the spread, not a winner.
   */
  | 'world_under_determined';

export const RELATION_UNDECIDABLE = 'RELATION_UNDECIDABLE';

export class ClaimRelationError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ClaimRelationError';
  }
}

/** The minimum a claim must carry for its relation to another to be decided. */
export interface Claim {
  readonly claimId: string;
  /** WHO said it. Two claims from one claimant about one subject can
   *  supersede; two claimants' claims never can. */
  readonly claimantId: string;
  /** WHAT it is about — the subject key. Claims about different subjects
   *  have no relation, and asking for one is a bug in the caller. */
  readonly subjectKey: string;
  /** WHEN it became knowable. Supersession is keyed on this and on nothing
   *  else: a claim recorded later about an earlier state does not supersede. */
  readonly knownAt: string;
  readonly value: number | string | null;
  readonly attestation: Attestation;
}

export type ClaimRelation =
  | {
      readonly kind: 'supersedes';
      readonly laterClaimId: string;
      readonly earlierClaimId: string;
      readonly claimantId: string;
      readonly subjectKey: string;
      /** The knownAt that decided it — supersession has no other basis. */
      readonly byKnownAt: string;
    }
  | {
      readonly kind: 'contradicts';
      readonly claimIds: readonly [string, string];
      readonly subjectKey: string;
      readonly resolvability: Resolvability;
      /** What a reader should do about it, following from resolvability. */
      readonly remedy: string;
    }
  | {
      readonly kind: 'under_determined';
      readonly claimIds: readonly [string, string];
      readonly subjectKey: string;
      readonly claimantIds: readonly [string, string];
      readonly note: string;
    };

/**
 * Classify the relation between two claims.
 *
 * REFUSES rather than defaults. The failure this guards is not a missing
 * reason — it is someone picking the nearest available relation to make a
 * row ingestible. Every branch below is entered on a POSITIVE structural
 * fact (same claimant, or a declared resolvability), and anything else
 * throws. A classifier that returns a plausible relation when it cannot
 * tell writes a category error into the store silently, and the store is
 * where these must be right.
 *
 * `resolvability` is REQUIRED from the caller for the contradiction case
 * and is not inferred, because whether a disagreement is a bug or the
 * world's own under-determination is a claim about the domain that no
 * amount of looking at two numbers can settle.
 */
export function classifyRelation(
  a: Claim,
  b: Claim,
  opts: { sameFact: boolean; resolvability?: Resolvability },
): ClaimRelation {
  if (a.subjectKey !== b.subjectKey) {
    throw new ClaimRelationError(
      RELATION_UNDECIDABLE,
      `claims are about different subjects (${a.subjectKey} vs ${b.subjectKey}); they have no ` +
        'relation, and asking for one is a bug in the caller rather than a fact about the world.',
    );
  }
  if (a.claimId === b.claimId) {
    throw new ClaimRelationError(RELATION_UNDECIDABLE, 'a claim has no relation to itself.');
  }

  // SUPERSESSION: one claimant, later knowledge. Decided on knownAt alone.
  if (a.claimantId === b.claimantId) {
    if (a.knownAt === b.knownAt) {
      throw new ClaimRelationError(
        RELATION_UNDECIDABLE,
        `${a.claimantId} made two claims about ${a.subjectKey} at the same knownAt ` +
          `(${a.knownAt}). Neither supersedes the other, and one claimant contradicting itself ` +
          'at a single instant is a defect in the record rather than a relation to store. ' +
          'Establish the ordering before writing an edge.',
      );
    }
    const [later, earlier] = a.knownAt > b.knownAt ? [a, b] : [b, a];
    return Object.freeze({
      kind: 'supersedes',
      laterClaimId: later.claimId,
      earlierClaimId: earlier.claimId,
      claimantId: a.claimantId,
      subjectKey: a.subjectKey,
      byKnownAt: later.knownAt,
    });
  }

  // Two claimants. Are they even claiming the same fact?
  if (!opts.sameFact) {
    return Object.freeze({
      kind: 'under_determined',
      claimIds: [a.claimId, b.claimId] as const,
      subjectKey: a.subjectKey,
      claimantIds: [a.claimantId, b.claimantId] as const,
      note:
        `${a.claimantId} and ${b.claimantId} state different values for ${a.subjectKey} and are ` +
        'not claiming the same fact — two prices are two prices. This is the market being ' +
        'under-determined, not a disagreement to resolve; recording it as a conflict would ' +
        'manufacture a dispute out of ordinary commerce.',
    });
  }

  if (!opts.resolvability) {
    throw new ClaimRelationError(
      RELATION_UNDECIDABLE,
      `${a.claimantId} and ${b.claimantId} make incompatible claims about ${a.subjectKey}, and ` +
        'no resolvability was declared. Whether one of them is simply wrong (go and establish ' +
        'which) or the world has no single value at this resolution (the spread IS the answer) ' +
        'is a claim about the domain that two numbers cannot settle. Declare it; do not let the ' +
        'classifier guess, because guessing writes the wrong edge type into the store.',
    );
  }

  return Object.freeze({
    kind: 'contradicts',
    claimIds: [a.claimId, b.claimId] as const,
    subjectKey: a.subjectKey,
    resolvability: opts.resolvability,
    remedy:
      opts.resolvability === 'resolvable'
        ? `establish which of ${a.claimantId} and ${b.claimantId} is correct about ` +
          `${a.subjectKey}; there is a fact of the matter and one of them is wrong.`
        : `report the spread between ${a.claimantId} and ${b.claimantId} on ${a.subjectKey}. ` +
          'Both observers are competent and the world does not carry a single value at this ' +
          'resolution — picking a winner would manufacture precision the evidence lacks.',
  });
}

/** Only a resolvable contradiction is someone's to go and fix. Escalating a
 *  world-under-determined one trains the reader to approve past alerts. */
export function isEscalatable(relation: ClaimRelation): boolean {
  return relation.kind === 'contradicts' && relation.resolvability === 'resolvable';
}
