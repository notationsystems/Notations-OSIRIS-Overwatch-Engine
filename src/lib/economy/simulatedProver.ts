// src/lib/economy/simulatedProver.ts
//
// A SIMULATED PROVER, so the notary can reach `held` and `breached`.
//
// Measured before this existed: over 243 notarizable loads the run returned
// held 0, breached 0, unproven 243 — and 241 of those were
// `unproven/proof_generation_failed`, which is not a fact about any load. It
// means no prover was configured. The reefer-excursion plant read MISS for that
// reason, and the two plants whose detector was "appears in the unproven set"
// read OK for that same reason, because the unproven set was everything.
//
// This is the same shape as the spatial backend: the refusal was a MISSING
// ACTOR, not a policy. `notarizeCondition` refuses to call an evaluation
// evidence when nothing proved it, which is correct; supplying a prover is what
// the abstraction was built to accept.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT MAKES THIS A PROVER AND NOT AN ECHO
// ─────────────────────────────────────────────────────────────────────────────
//
// A prover that stamps whatever verdict it is handed proves nothing and is
// indistinguishable from one that works — until the day the caller is wrong.
// So this one RE-DERIVES the verdict from the committed readings and REFUSES
// when its own result disagrees with the bit it was asked to attest. That
// disagreement is the only thing a prover is actually for.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND IT NEVER PASSES FOR REAL
// ─────────────────────────────────────────────────────────────────────────────
//
// `ProofRef.system` must read `'sp1'` for the notary to treat the verdict as
// proven, so the honesty cannot live in that field. It lives in the vkey and
// the proofId, both of which carry `SIMULATED` literally, and in
// `isSimulatedProof()`, which any surface that reports evidence to a
// counterparty must call. A verdict resting on this is a rehearsal.

import { createHash } from 'crypto';
import type { ProofRef, ConditionPredicate } from './notary.types';
import type { Reading } from './notary';
import { evaluateCondition } from './notary';

/** Domain-separated so it cannot collide with any real verifying key. */
export const SIMULATED_VKEY_DOMAIN = 'payload.notary.SIMULATED.vkey.v1';

export const SIMULATED_VKEY = createHash('sha256').update(SIMULATED_VKEY_DOMAIN).digest('hex');

export const SIMULATED_PROOF_PREFIX = 'SIMULATED-';

/**
 * True for a proof this module produced. A surface that shows evidence to a
 * counterparty MUST call this: `system: 'sp1'` alone does not distinguish a
 * real proof from a rehearsal, and the whole value of the notary is that a
 * counterparty can tell the difference.
 */
export function isSimulatedProof(p: ProofRef | null | undefined): boolean {
  return !!p && (p.vkey === SIMULATED_VKEY || p.proofId.startsWith(SIMULATED_PROOF_PREFIX));
}

export const PROVER_DISAGREES = 'PROVER_DISAGREES';

export class ProverDisagrees extends Error {
  readonly code = PROVER_DISAGREES;
  constructor(asked: string, derived: string, predicateId: string) {
    super(
      `${PROVER_DISAGREES}: asked to attest "${asked}" for ${predicateId}, but re-deriving from ` +
      `the committed readings gives "${derived}". A prover that signs the bit it is handed is ` +
      'an echo, and an echo is indistinguishable from a working prover until the caller is ' +
      'wrong. Refusing here is the only thing the prover is for.',
    );
    this.name = 'ProverDisagrees';
  }
}

/**
 * How long a real SP1 proof of this circuit would take, as a function of leaf
 * count. Not a measurement of any prover — it exists so the architecture claim
 * ("notarization is off the critical path") stays quantitative rather than
 * asserted. A dispatcher waiting this long per booking is the thing the
 * separation avoids.
 */
export function simulatedProvingMs(leafCount: number): number {
  // Merkle membership dominates: ~log2(n) hashes per leaf, each ~40us in-circuit.
  const depth = Math.max(1, Math.ceil(Math.log2(Math.max(2, leafCount))));
  return Math.round(1_800 + leafCount * depth * 0.04 * 1000 / 1000 * 12);
}

export interface SimulatedProverOptions {
  /** The readings the commitment was built over. The prover re-derives from these. */
  readings: readonly Reading[];
  predicate: ConditionPredicate;
  /** Injected. A prover holds no clock either. */
  now: string;
}

/**
 * Build the `prove` callback `notarizeCondition` accepts.
 *
 * Usage is deliberately awkward — you must hand it the same readings and
 * predicate the notary is evaluating — because a prover that could be called
 * without them would be a prover that cannot check anything.
 */
export function simulatedProver(opts: SimulatedProverOptions) {
  return (args: {
    root: string; predicateId: string; from: string; to: string;
    verdictBit: 'held' | 'breached';
  }): ProofRef => {
    if (args.predicateId !== opts.predicate.predicateId) {
      throw new ProverDisagrees(args.verdictBit, 'different-predicate', args.predicateId);
    }
    // RE-DERIVE. This is the whole point.
    const own = evaluateCondition(opts.readings as Reading[], opts.predicate, args.from, args.to);
    const derived = own.breached ? 'breached' : 'held';
    if (derived !== args.verdictBit) {
      throw new ProverDisagrees(args.verdictBit, derived, args.predicateId);
    }
    return {
      system: 'sp1',
      vkey: SIMULATED_VKEY,
      proofId: `${SIMULATED_PROOF_PREFIX}${createHash('sha256')
        .update(`${args.root}|${args.predicateId}|${args.from}|${args.to}|${args.verdictBit}`)
        .digest('hex').slice(0, 32)}`,
      publicInputs: {
        root: args.root, predicateId: args.predicateId,
        coversFrom: args.from, coversTo: args.to, verdictBit: args.verdictBit,
      },
      provedAt: opts.now,
      provingMs: simulatedProvingMs(opts.readings.length),
    };
  };
}
