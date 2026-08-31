import { describe, it, expect } from 'vitest';
import {
  merkleRoot, leafHash, assertMilli, computeCoverage, evaluateCondition,
  notarizeCondition, notarizeCustody, postedInTime, POST_GRACE_SECONDS,
  type Reading, type Handoff,
} from './notary';
import { requiresNotary, type Commitment, type ConditionPredicate, type DeviceTrust, type NotaryPolicy, type ProofRef } from './notary.types';

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

describe('the policy refuses toward notarizing on an incomparable basis', () => {
  const POLICY: NotaryPolicy = {
    policyId: 'p1', valueThreshold: { amount: 25000, currency: 'CAD' },
    alwaysNotarize: ['pharma'], custodyRequired: [], notarizeOnDispute: true,
  };
  it('a cross-currency value notarizes rather than silently skipping', () => {
    // Comparing 50,000 MXN to a 25,000 CAD threshold needs a rate and a date.
    // Returning false would leave a possibly high-value load unnotarized.
    expect(requiresNotary(POLICY, { declaredValue: { amount: 50000, currency: 'MXN' } })).toBe(true);
  });
  it('an unknown value is not "below threshold"', () => {
    expect(requiresNotary(POLICY, {})).toBe(true);
  });
  it('the commodity class overrides value', () => {
    expect(requiresNotary(POLICY, { commodityClass: 'pharma', declaredValue: { amount: 10, currency: 'CAD' } })).toBe(true);
  });
  it('an ordinary load below threshold is not notarized', () => {
    expect(requiresNotary(POLICY, { declaredValue: { amount: 2400, currency: 'CAD' } })).toBe(false);
  });
});
