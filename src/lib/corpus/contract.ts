/**
 * Payload Terminal's conformance to the Notation Systems corpus contract.
 *
 * WHAT THE CONTRACT IS FOR. Notation Systems operates more than one
 * provenance-bearing corpus. Two of them had independently built a lattice,
 * both called it the evidence class, and neither knew the other existed —
 * measured 2026-08-31. They are not duplicates: the acquisition fabric
 * classifies HOW A VALUE CAME TO EXIST (measured, asserted, computed,
 * derived) and this instrument classifies HOW HARD THE EVIDENCE IS
 * (reported, estimated, representative, derived). Two axes of one property,
 * each named after the whole.
 *
 * `attestation.ts` states the distinction in its own header and implements
 * one side of it. That was correct and it is still correct; what was
 * missing is anywhere for the OTHER side to be declared, so its absence
 * here could be a decision rather than an oversight nobody had noticed.
 *
 * WHAT THIS MODULE IS, AND IS NOT. It is a conformance declaration: the
 * axes this corpus implements, the axes it does not, and the digest of the
 * contract copy it was written against. It is NOT a second definition of
 * the vocabulary — `attestation.ts` owns that, and `contract.test.ts`
 * asserts the two agree rather than letting them drift. Two normative lists
 * of one fact is the defect this whole contract exists to close, and
 * reintroducing it here would be the joke telling itself.
 */

/**
 * sha256 of `contract.json` as vendored beside this file.
 *
 * Pinned so that editing the local copy fails a test instead of silently
 * redefining what this corpus claims to conform to. It does NOT prove the
 * copy matches the canonical one in the archive — see `CONFORMANCE_LIMIT`.
 */
export const CONTRACT_DIGEST = '0622f794e1eb08f13eba3eee341043a8a3833aa1449d618954c41963c460bf7d';

export const CONTRACT_ID = 'notation-systems.corpus.provenance';
export const CONTRACT_VERSION = '1.0.0';

/** The axes this corpus implements, and where each one lives. */
export const AXES_IMPLEMENTED = {
  claim_strength: 'src/lib/economy/attestation.ts:EvidenceClass',
  interest: 'src/lib/economy/attestation.ts:Interest',
} as const;

/**
 * The axis this corpus does NOT implement, recorded as an open gap.
 *
 * This is not a deliberate omission the way the acquisition fabric's
 * missing claim_strength is deliberate. Payload Terminal genuinely cannot
 * say today whether an upstream figure was measured or asserted; it knows
 * only how hard it judges the resulting claim. Writing that down is the
 * difference between a gap and a blind spot.
 */
export const AXES_ABSENT = {
  production_class: 'OPEN GAP — arrives with the value when an acquisition corpus feeds this one.',
} as const;

/**
 * What passing the conformance test does and does not establish.
 *
 * Stated in production rather than only in the test, because the limit is a
 * property of the arrangement and a reader of this module is exactly who
 * needs to know it.
 */
export const CONFORMANCE_LIMIT =
  'Each corpus verifies its own vendored copy against its own pin. Two equally stale copies pass every check either side has. Byte identity across corpora is coverage for divergence, not currency.';
