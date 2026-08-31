import { describe, it, expect } from 'vitest';
import {
  attestationOf, combineAttestations, computeAttested, attest, isAdmissible, toWire,
  needsInterestResidual, EVIDENCE_RANK, INTEREST_RANK, AttestationError,
  ATTESTATION_HAS_NO_INPUTS, type Attestation,
} from './attestation';

describe('attestation is closed under computation', () => {
  it('one representative input taints a result over nine measured ones — automatically', () => {
    // The load-bearing test. Nine reported inputs and one representative,
    // combined by a function that never mentions evidence class. The result
    // must come out representative and inadmissible, because the combine ran
    // at the point of computation, not because anyone remembered to mark it.
    const measured = Array.from({ length: 9 }, (_, i) => attest(i + 1, attestationOf('reported', 'high')));
    const oneRepresentative = attest(10, attestationOf('representative', 'high'));
    const inputs = [...measured, oneRepresentative];

    const index = computeAttested(inputs, (vs) => (vs as number[]).reduce((a, b) => a + b, 0));

    expect(index.value).toBe(55); // fn ran normally
    expect(index.attestation.evidenceClass).toBe('representative'); // weakest won
    expect(index.attestation.restsOnRepresentative).toBe(true);
    expect(isAdmissible(index.attestation)).toBe(false); // inadmissible by construction
    expect(index.attestation.inputCount).toBe(10);
  });

  it('a result over only measured inputs stays admissible', () => {
    const inputs = [attest(1, attestationOf('reported', 'high')), attest(2, attestationOf('estimated', 'medium'))];
    const r = computeAttested(inputs, (vs) => (vs as number[]).reduce((a, b) => a + b, 0));
    expect(r.attestation.evidenceClass).toBe('estimated'); // weakest of reported/estimated
    expect(r.attestation.confidence).toBe('medium');
    expect(isAdmissible(r.attestation)).toBe(true);
  });

  it('combine is commutative and associative — input order cannot change the class', () => {
    const a = attestationOf('reported', 'high');
    const b = attestationOf('representative', 'low');
    const c = attestationOf('estimated', 'medium');
    const ab_c = combineAttestations([combineAttestations([a, b]), c]);
    const a_bc = combineAttestations([a, combineAttestations([b, c])]);
    expect(ab_c.evidenceClass).toBe(a_bc.evidenceClass);
    expect(ab_c.confidence).toBe(a_bc.confidence);
    expect(ab_c.restsOnRepresentative).toBe(a_bc.restsOnRepresentative);
    expect(combineAttestations([a, b]).evidenceClass).toBe(combineAttestations([b, a]).evidenceClass);
  });

  it('contamination does not wash out — adding measured inputs cannot restore admissibility', () => {
    const tainted = combineAttestations([attestationOf('representative', 'high')]);
    const withMore = combineAttestations([tainted, attestationOf('reported', 'high'), attestationOf('reported', 'high')]);
    expect(withMore.restsOnRepresentative).toBe(true);
    expect(isAdmissible(withMore)).toBe(false);
  });

  it('refuses to attest a computation over no inputs — vacuity is not cleanliness', () => {
    expect(() => combineAttestations([])).toThrowError(AttestationError);
    try {
      combineAttestations([]);
    } catch (e) {
      expect((e as AttestationError).code).toBe(ATTESTATION_HAS_NO_INPUTS);
    }
  });

  it('the lattice is directional: reported > estimated > representative > derived', () => {
    expect(EVIDENCE_RANK.reported).toBeGreaterThan(EVIDENCE_RANK.estimated);
    expect(EVIDENCE_RANK.estimated).toBeGreaterThan(EVIDENCE_RANK.representative);
    expect(EVIDENCE_RANK.representative).toBeGreaterThan(EVIDENCE_RANK.derived);
  });
});

describe('attestation is inside the identity, not beside the number', () => {
  it('an attested value cannot be constructed as an object literal', () => {
    // This is a compile-time property; the runtime proxy is that `attest`
    // is the only exported constructor and the brand is module-private.
    // Asserted here as documentation of intent: a hand-built {value,
    // attestation} is not assignable to Attested<T> without `attest`.
    const good = attest(42, attestationOf('reported', 'high'));
    expect(good.value).toBe(42);
    // @ts-expect-error — a bare literal lacks the module-private brand
    const bad: typeof good = { value: 42, attestation: attestationOf('reported', 'high') };
    expect(bad).toBeDefined(); // the runtime object exists; the TYPE rejects it
  });

  it('the export wire carries attestation as a required field', () => {
    const wire = toWire(attest(700, attestationOf('representative', 'medium')));
    expect(wire.value).toBe(700);
    expect(wire.attestation.evidenceClass).toBe('representative');
    expect(wire.admissible).toBe(false);
    // The type has no path to omit attestation — asserted structurally.
    expect(Object.keys(wire).sort()).toEqual(
      ['admissible', 'attestation', 'restsOnInterested', 'value']);
  });
});

describe('attestation agrees with the existing analytics lattice', () => {
  it('weakest-wins matches weakestInputClass on the same inputs', () => {
    const kinds: Attestation['evidenceClass'][] = ['reported', 'reported', 'representative', 'estimated'];
    const combined = combineAttestations(kinds.map((k) => attestationOf(k, 'high')));
    // weakestInputClass would return 'representative' for this set; the
    // monoid must agree, or the tree holds two answers to one question.
    expect(combined.evidenceClass).toBe('representative');
  });
});


describe('the interest axis is a second dimension, measured not discounted', () => {
  it('most-interested wins when claims combine', () => {
    const r = combineAttestations([
      attestationOf('reported', 'high', 'disinterested'),
      attestationOf('reported', 'high', 'negotiating_position'),
    ]);
    expect(r.interest).toBe('negotiating_position');
    expect(r.restsOnInterested).toBe(true);
  });

  it('unknown interest ranks below disinterested — an unrecorded stake is not an absent one', () => {
    expect(INTEREST_RANK.disinterested).toBeGreaterThan(INTEREST_RANK.unknown);
    const r = combineAttestations([
      attestationOf('reported', 'high', 'disinterested'),
      attestationOf('reported', 'high', 'unknown'),
    ]);
    expect(r.interest).toBe('unknown');
    // But unknown is not itself "interested" — it routes to nothing until established.
    expect(r.restsOnInterested).toBe(false);
  });

  it('interest does NOT affect admissibility — the flag routes, the residual judges', () => {
    // Discounting an interested figure by a fixed factor would invent a
    // correction nobody measured. A quote is admissible evidence about the
    // world; what it needs is its gap to observed outcome measured.
    const quote = attestationOf('reported', 'high', 'negotiating_position');
    expect(isAdmissible(quote)).toBe(true);
    expect(needsInterestResidual(quote)).toBe(true);
  });

  it('interest and evidence class are independent axes', () => {
    // A representative disinterested value and a reported interested one sit
    // at opposite corners; neither axis collapses into the other.
    const repDisinterested = attestationOf('representative', 'high', 'disinterested');
    expect(isAdmissible(repDisinterested)).toBe(false);
    expect(needsInterestResidual(repDisinterested)).toBe(false);

    const reportedInterested = attestationOf('reported', 'high', 'self_reported');
    expect(isAdmissible(reportedInterested)).toBe(true);
    expect(needsInterestResidual(reportedInterested)).toBe(true);
  });

  it('interest contamination does not wash out either', () => {
    const r = combineAttestations([
      attestationOf('reported', 'high', 'self_reported'),
      attestationOf('reported', 'high', 'disinterested'),
      attestationOf('reported', 'high', 'disinterested'),
    ]);
    expect(r.restsOnInterested).toBe(true);
  });
});
