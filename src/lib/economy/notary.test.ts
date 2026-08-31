import { describe, it, expect } from 'vitest';
import {
  merkleRoot, leafHash, assertMilli, computeCoverage, evaluateCondition,
  notarizeCondition, notarizeCustody, postedInTime, POST_GRACE_SECONDS,
  type Reading, type Handoff,
} from './notary';
import {
  requiresNotary, notaryRequirement,
  type Commitment, type ConditionPredicate, type DeviceTrust, type NotaryPolicy, type ProofRef,
} from './notary.types';

const NOW = '2026-08-31T12:00:00.000Z';

const REEFER: ConditionPredicate = {
  predicateId: 'reefer_envelope@1.0.0', channel: 'temperature_c',
  statement: 'no reading above 8.0C or below 2.0C',
  bounds: { min: 2.0, max: 8.0 }, toleranceSeconds: 600, maxGapSeconds: 1800,
};

const DEVICE: DeviceTrust = {
  deviceId: 'probe-1', attestation: 'hardware_attested',
  lastCalibratedAt: '2026-06-01T00:00:00.000Z', note: '',
};

const prove = (a: { root: string; predicateId: string; from: string; to: string; verdictBit: 'held' | 'breached' }): ProofRef => ({
  system: 'sp1', vkey: 'vk', proofId: 'p1',
  publicInputs: { root: a.root, predicateId: a.predicateId, coversFrom: a.from, coversTo: a.to, verdictBit: a.verdictBit },
  provedAt: NOW, provingMs: 4200,
});

function run(from: string, to: string, stepMin: number, temp: (i: number) => number): Reading[] {
  const out: Reading[] = [];
  const f = Date.parse(from), t = Date.parse(to);
  let i = 0;
  for (let x = f; x <= t; x += stepMin * 60000, i++) {
    out.push({ at: new Date(x).toISOString(), channel: 'temperature_c', value: temp(i), deviceId: 'probe-1' });
  }
  return out;
}

function commit(readings: Reading[], from: string, to: string, postedAt: string): Commitment {
  const { root, leafCount } = merkleRoot(readings);
  return {
    commitmentId: 'C-1', root, leafCount,
    subject: { kind: 'load_condition', loadId: 'L-1', channel: 'temperature_c' },
    coversFrom: from, coversTo: to, postedAt,
    anchor: { kind: 'public_chain', chain: 'test', txRef: '0x1', blockTime: postedAt },
    postedBy: 'op-1', authority: 'ops',
  };
}

const FROM = '2026-08-30T00:00:00.000Z';
const TO = '2026-08-30T06:00:00.000Z';

describe('the omission attack: readings must reconstruct the commitment', () => {
  it('a CURATED SUBSET plus the full commitment cannot yield held', () => {
    // THE DEFECT THIS CLOSES. The full run breaches at hour 3. A caller drops
    // the breaching readings and passes the rest, together with the commitment
    // built from the FULL set. Every later step — coverage, evaluation, proof —
    // would run happily over the subset while the root travelled as decoration.
    const full = run(FROM, TO, 5, i => (i >= 36 && i <= 48 ? 9.4 : 5.0));
    const commitment = commit(full, FROM, TO, TO);
    const curated = full.filter(r => r.value <= 8.0);
    expect(curated.length).toBeLessThan(full.length);

    const v = notarizeCondition({
      readings: curated, commitment, predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') {
      expect(v.reason).toBe('readings_do_not_match_commitment');
      expect(v.remedy).toContain('Fewer readings were supplied than were committed');
    }
  });

  it('the honest full set proves', () => {
    const full = run(FROM, TO, 5, () => 5.0);
    const v = notarizeCondition({
      readings: full, commitment: commit(full, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('held');
  });

  it('an ADDED reading is caught too, not only an omitted one', () => {
    const full = run(FROM, TO, 5, () => 5.0);
    const commitment = commit(full, FROM, TO, TO);
    const padded = [...full, { at: '2026-08-30T03:02:00.000Z', channel: 'temperature_c' as const, value: 5.0, deviceId: 'probe-1' }];
    const v = notarizeCondition({
      readings: padded, commitment, predicate: REEFER, from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
  });
});

describe('the in-time rule is the load-bearing property', () => {
  it('a commitment posted two days late can never be held', () => {
    const full = run(FROM, TO, 5, () => 5.0);
    const late = commit(full, FROM, TO, '2026-09-01T06:00:00.000Z');
    const v = notarizeCondition({
      readings: full, commitment: late, predicate: REEFER, from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') expect(v.reason).toBe('commitment_posted_after_the_fact');
  });

  it('grace covers clock skew but not a story told afterwards', () => {
    const base = { commitmentId: 'C', root: 'r', leafCount: 1, subject: { kind: 'load_custody' as const, loadId: 'L' }, coversFrom: FROM, coversTo: TO, anchor: { kind: 'internal' as const, logId: 'l' }, postedBy: 'x', authority: 'y' };
    expect(postedInTime({ ...base, postedAt: '2026-08-30T06:10:00.000Z' })).toBe(true);
    expect(postedInTime({ ...base, postedAt: `2026-08-30T06:${POST_GRACE_SECONDS / 60 + 1}:00.000Z` })).toBe(false);
  });
});

describe('three-valued verdicts, with unproven reachable', () => {
  it('a 4-hour telemetry gap is unproven, never held', () => {
    const head = run(FROM, '2026-08-30T01:00:00.000Z', 5, () => 5.0);
    const tail = run('2026-08-30T05:00:00.000Z', TO, 5, () => 5.0);
    const readings = [...head, ...tail];
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') {
      expect(v.reason).toBe('telemetry_gap_exceeds_max');
      expect(v.coverage.covered).toBeLessThan(1);
    }
  });

  it('a 40-minute excursion breaches and reports the extremum', () => {
    const readings = run(FROM, TO, 5, i => (i >= 36 && i <= 44 ? 9.4 : 5.0));
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('breached');
    if (v.status === 'breached') expect(v.excursions[0].extremum).toBe(9.4);
  });

  it('a 5-minute excursion inside a 10-minute tolerance is not a breach', () => {
    const readings = run(FROM, TO, 5, i => (i === 36 ? 9.4 : 5.0));
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('held');
  });

  it('with no prover, a local evaluation is our claim and says so', () => {
    const readings = run(FROM, TO, 5, () => 5.0);
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') expect(v.reason).toBe('proof_generation_failed');
  });
});

describe('the boundary case is symmetric at both ends', () => {
  const at = (v: number) => [{ at: FROM, channel: 'temperature_c' as const, value: v, deviceId: 'd' }];
  it('a reading exactly at min and exactly at max are treated the same', () => {
    // The asymmetry to prevent: 2.0 breaching while 8.0 does not, on one envelope.
    expect(evaluateCondition(at(2.0), REEFER, FROM, TO).breached).toBe(false);
    expect(evaluateCondition(at(8.0), REEFER, FROM, TO).breached).toBe(false);
  });
  it('just outside either end is outside', () => {
    expect(evaluateCondition(run(FROM, TO, 5, () => 1.9), REEFER, FROM, TO).breached).toBe(true);
    expect(evaluateCondition(run(FROM, TO, 5, () => 8.1), REEFER, FROM, TO).breached).toBe(true);
  });
});

describe('determinism and encoding', () => {
  it('the root is identical under shuffled input', () => {
    const readings = run(FROM, TO, 15, i => 4 + (i % 3));
    const shuffled = [...readings].reverse();
    expect(merkleRoot(shuffled).root).toBe(merkleRoot(readings).root);
  });

  it('the same instant in two offsets sorts the same — string sort would not', () => {
    const z: Reading = { at: '2026-08-30T01:00:00.000Z', channel: 'temperature_c', value: 5, deviceId: 'd' };
    const off: Reading = { at: '2026-08-30T00:00:00.000Z', channel: 'temperature_c', value: 4, deviceId: 'd' };
    // '2026-08-30T02:00:00+01:00' is the same instant as 01:00Z; lexically it
    // sorts AFTER, numerically it ties. Ordering must follow the instant.
    const plusOne: Reading = { ...z, at: '2026-08-30T02:00:00+01:00' };
    expect(merkleRoot([off, z]).root).toBe(merkleRoot([off, plusOne]).root);
  });

  it('a value not representable in integer millidegrees is refused at the leaf', () => {
    expect(() => assertMilli(21.3504)).toThrow(/integer millidegrees/);
    expect(assertMilli(21.35)).toBe(21350);
  });

  it('leaves and internal nodes are domain-separated', () => {
    const a = leafHash({ at: FROM, channel: 'temperature_c', value: 5, deviceId: 'd' });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Two leaves and their parent are distinct hashes by construction.
    const two = merkleRoot([
      { at: FROM, channel: 'temperature_c', value: 5, deviceId: 'd' },
      { at: TO, channel: 'temperature_c', value: 6, deviceId: 'd' },
    ]);
    expect(two.root).not.toBe(a);
  });
});

describe('coverage surfaces what clamping would hide', () => {
  it('out-of-order readings are reported, not silently sorted away', () => {
    const ordered = run(FROM, TO, 30, () => 5.0);
    const jumbled = [ordered[3], ordered[1], ...ordered];
    const cov = computeCoverage(jumbled, FROM, TO, 1800);
    expect(cov.outOfOrder).toBe(true);
  });

  it('coverage is not capped at 1', () => {
    const cov = computeCoverage(run(FROM, TO, 30, () => 5), FROM, TO, 1800);
    expect(cov.covered).toBeLessThanOrEqual(1.0000001);
    expect(cov.outOfOrder).toBe(false);
  });
});

describe('custody does not overstate what a linked chain shows', () => {
  const P = { predicateId: 'unbroken_custody@1.0.0', statement: 'every handoff signed by both parties', maxHandoffGapSeconds: 1800, requireBothSignatures: true };
  const C = commit([], FROM, TO, TO);

  it('an unsigned handoff is unproven', () => {
    const hs: Handoff[] = [{ at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: null }];
    const v = notarizeCustody(hs, P, FROM, TO, C, NOW);
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') expect(v.reason).toBe('missing_handoff_signature');
  });

  it('a linked chain holds — and the claim says only RECORDED handoffs', () => {
    const hs: Handoff[] = [
      { at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: 's' },
      { at: '2026-08-30T00:20:00.000Z', fromParty: 'b', toParty: 'c', fromSignature: 's', toSignature: 's' },
    ];
    const v = notarizeCustody(hs, P, FROM, TO, C, NOW);
    expect(v.status).toBe('held');
    expect(v.renderedClaim).toContain('RECORDED');
    expect(v.renderedClaim).toContain('does not establish that every handoff was recorded');
  });

  it('a party mismatch breaks the chain', () => {
    const hs: Handoff[] = [
      { at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: 's' },
      { at: '2026-08-30T00:20:00.000Z', fromParty: 'X', toParty: 'c', fromSignature: 's', toSignature: 's' },
    ];
    expect(notarizeCustody(hs, P, FROM, TO, C, NOW).status).toBe('breached');
  });
});

describe('the policy has three states, because the boolean was the bug', () => {
  const POLICY: NotaryPolicy = {
    policyId: 'p1', valueThreshold: { amount: 25000, currency: 'CAD' },
    alwaysNotarize: ['pharma'], custodyRequired: [], notarizeOnDispute: true,
  };

  // THE DISAGREEMENT THAT PRODUCED THIS TYPE. Two readings of the same function
  // were each right about their half:
  //
  //   returning FALSE  → a possibly high-value load ships unnotarized, and the
  //                      cost of that surfaces later as a claim.
  //   returning TRUE   → the threshold is asserted cleared when nothing compared
  //                      it; that is a silent conversion at an unstated rate.
  //
  // Neither is the answer. 50,000 MXN against a 25,000 CAD threshold is
  // UNDETERMINED — the comparison needs a rate and a date this function does not
  // have. Same collapse `NotaryVerdict` refuses with held/breached/unproven,
  // one layer down in the policy that decides whether to evaluate at all.

  it('a cross-currency value is undetermined, not a silent yes and not a silent no', () => {
    const r = notaryRequirement(POLICY, { declaredValue: { amount: 50000, currency: 'MXN' } });
    expect(r.required).toBe('undetermined');
    if (r.required === 'undetermined') {
      expect(r.reason).toContain('rate');
      expect(r.remedy).toContain('CAD');
    }
  });

  it('an unknown value is not "below threshold" — it is undetermined', () => {
    const r = notaryRequirement(POLICY, {});
    expect(r.required).toBe('undetermined');
    if (r.required === 'undetermined') {
      expect(r.reason).toContain('not a value below the threshold');
    }
  });

  it('the commodity class decides before value is even consulted', () => {
    // Deliberate: an always-notarize class in an INCOMPARABLE currency still
    // resolves, because the class never needed the comparison.
    expect(notaryRequirement(POLICY, {
      commodityClass: 'pharma', declaredValue: { amount: 10, currency: 'MXN' },
    }).required).toBe(true);
    expect(notaryRequirement(POLICY, { commodityClass: 'pharma' }).required).toBe(true);
  });

  it('a comparable value resolves at, above, and below the threshold', () => {
    expect(notaryRequirement(POLICY, { declaredValue: { amount: 2400, currency: 'CAD' } }).required).toBe(false);
    expect(notaryRequirement(POLICY, { declaredValue: { amount: 25000, currency: 'CAD' } }).required).toBe(true);
    expect(notaryRequirement(POLICY, { declaredValue: { amount: 90000, currency: 'CAD' } }).required).toBe(true);
  });

  it('every branch carries a reason a dispatcher can act on', () => {
    for (const load of [
      {}, { declaredValue: { amount: 50000, currency: 'MXN' } },
      { declaredValue: { amount: 2400, currency: 'CAD' } }, { commodityClass: 'pharma' },
    ]) {
      expect(notaryRequirement(POLICY, load).reason.length).toBeGreaterThan(10);
    }
  });

  describe('the boolean convenience refuses rather than picking a side', () => {
    it('answers where the comparison is defined', () => {
      expect(requiresNotary(POLICY, { declaredValue: { amount: 90000, currency: 'CAD' } })).toBe(true);
      expect(requiresNotary(POLICY, { declaredValue: { amount: 2400, currency: 'CAD' } })).toBe(false);
      expect(requiresNotary(POLICY, { commodityClass: 'pharma' })).toBe(true);
    });

    it('THROWS where it is not, instead of defaulting either way', () => {
      // A caller that wants a boolean must have established the basis first.
      // One that has not gets an error naming what is missing.
      expect(() => requiresNotary(POLICY, {})).toThrow(/undetermined/);
      expect(() => requiresNotary(POLICY, { declaredValue: { amount: 50000, currency: 'MXN' } }))
        .toThrow(/rate and a date/);
    });
  });
});

describe('tampering with a committed reading is caught, not only omission and addition', () => {
  it('one MUTATED value in an otherwise complete set fails the root', () => {
    // Same leaf COUNT, same interval, same devices — only the value moved. A
    // count check alone would pass this; the root is what catches it.
    const full = run(FROM, TO, 5, i => (i >= 36 && i <= 48 ? 9.4 : 5.0));
    const commitment = commit(full, FROM, TO, TO);
    const laundered = full.map(r => (r.value > 8.0 ? { ...r, value: 5.0 } : r));
    expect(laundered.length).toBe(full.length);

    const v = notarizeCondition({
      readings: laundered, commitment, predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') {
      expect(v.reason).toBe('readings_do_not_match_commitment');
      // The count matched, so the remedy must NOT claim readings were dropped.
      expect(v.remedy).toContain('Supply exactly the committed set');
    }
  });

  it('and the pin: that same laundered set is otherwise a clean held', () => {
    // Without this the test above proves nothing — an unproven verdict could be
    // coming from a gap, a late post, or any other refusal. Re-commit to the
    // LAUNDERED set and the identical call holds. So the only thing standing
    // between a curated story and a proof is the root comparison.
    const full = run(FROM, TO, 5, i => (i >= 36 && i <= 48 ? 9.4 : 5.0));
    const laundered = full.map(r => (r.value > 8.0 ? { ...r, value: 5.0 } : r));
    const v = notarizeCondition({
      readings: laundered, commitment: commit(laundered, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('held');
  });
});

describe('the low side breaches on the same terms as the high side', () => {
  it('a sustained under-minimum run is a breach and reports the low extremum', () => {
    // The asymmetry to prevent: an envelope that catches heat and sleeps
    // through a freeze. A reefer failing cold spoils the load just as surely.
    const readings = run(FROM, TO, 5, i => (i >= 36 && i <= 44 ? 0.4 : 5.0));
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('breached');
    if (v.status === 'breached') {
      expect(v.excursions[0].extremum).toBe(0.4);
      expect(v.renderedClaim).toContain('BREACHED');
    }
  });
});

describe('the rendered claim never states more than the evidence carries', () => {
  const clean = () => run(FROM, TO, 5, () => 5.0);

  it('an internal anchor says so, in the claim itself', () => {
    // `internal` means "our own append-only log", which a disputing party has no
    // reason to accept. The verdict is still held; the claim must not read as
    // though a third party observed it.
    const readings = clean();
    const c = commit(readings, FROM, TO, TO);
    const v = notarizeCondition({
      readings, commitment: { ...c, anchor: { kind: 'internal', logId: 'l-1' } },
      predicate: REEFER, from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('held');
    expect(v.renderedClaim).toContain('anchored only in our own log');
    if (v.status === 'held') expect(v.anchorStrength).toBe('internal');
  });

  it('an unattested device is named in the claim, and the proof does not launder it', () => {
    // A cryptographic proof over readings from an unplugged probe is a
    // perfectly provable lie. Device trust travels beside the verdict, never
    // folded into it.
    const readings = clean();
    const unattested: DeviceTrust = {
      deviceId: 'probe-9', attestation: 'unattested', lastCalibratedAt: null,
      note: 'carrier-supplied logger, no attestation',
    };
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: unattested, now: NOW, prove,
    });
    expect(v.status).toBe('held');
    expect(v.renderedClaim).toContain('device unattested');
    expect(v.renderedClaim).toContain('it does not prove the sensor was truthful');
    if (v.status === 'held') expect(v.deviceTrust.attestation).toBe('unattested');
  });

  it('the claim states the coverage it was computed over', () => {
    const readings = clean();
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.renderedClaim).toMatch(/\d+\.\d% of the interval/);
  });

  it('an unproven claim says CANNOT BE EVALUATED rather than reading as a pass', () => {
    const head = run(FROM, '2026-08-30T01:00:00.000Z', 5, () => 5.0);
    const tail = run('2026-08-30T05:00:00.000Z', TO, 5, () => 5.0);
    const readings = [...head, ...tail];
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.renderedClaim).toContain('CANNOT BE EVALUATED');
    expect(v.renderedClaim).not.toContain('held');
  });
});
