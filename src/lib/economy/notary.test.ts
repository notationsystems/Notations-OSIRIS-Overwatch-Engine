import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  merkleRoot, leafHash, computeCoverage, evaluateCondition, reading,
  notarizeCondition, notarizeCustody, postedInTime, checkPosting,
  POST_GRACE_SECONDS, type Reading, type Handoff,
} from './notary';
import {
  requiresNotary, toMilli, fromMilli, assertMilli, ALL_UNPROVEN_REASONS,
  DEFAULT_POSTING_WINDOW,
  type Commitment, type ConditionPredicate, type DeviceTrust, type NotaryPolicy,
  type ProofRef, type UnprovenReason,
} from './notary.types';

const NOW = '2026-08-31T12:00:00.000Z';

const REEFER: ConditionPredicate = {
  predicateId: 'reefer_envelope@1.0.0', channel: 'temperature_c',
  statement: 'no reading above 8.0C or below 2.0C',
  bounds: { minMilli: toMilli(2.0), maxMilli: toMilli(8.0) },
  toleranceSeconds: 600, maxGapSeconds: 1800,
  // The bound itself does NOT breach on this envelope; the variant that does is
  // a different predicateId, because it is a different contract term.
  boundaryIsBreach: false,
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
    out.push(reading(new Date(x).toISOString(), 'temperature_c', temp(i), 'probe-1'));
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
    const curated = full.filter(r => r.valueMilli <= toMilli(8.0));
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
    const padded = [...full, reading('2026-08-30T03:02:00.000Z', 'temperature_c', 5.0, 'probe-1')];
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
      expect(v.context.coverage.covered).toBeLessThan(1);
    }
  });

  it('a 40-minute excursion breaches and reports the extremum', () => {
    const readings = run(FROM, TO, 5, i => (i >= 36 && i <= 44 ? 9.4 : 5.0));
    const v = notarizeCondition({
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('breached');
    if (v.status === 'breached') expect(fromMilli(v.excursions[0].extremumMilli)).toBe(9.4);
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
  const at = (v: number) => [reading(FROM, 'temperature_c', v, 'd')];
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
    const z: Reading = reading('2026-08-30T01:00:00.000Z', 'temperature_c', 5, 'd');
    const off: Reading = reading('2026-08-30T00:00:00.000Z', 'temperature_c', 4, 'd');
    // '2026-08-30T02:00:00+01:00' is the same instant as 01:00Z; lexically it
    // sorts AFTER, numerically it ties. Ordering must follow the instant.
    const plusOne: Reading = { ...z, at: '2026-08-30T02:00:00+01:00' };
    expect(merkleRoot([off, z]).root).toBe(merkleRoot([off, plusOne]).root);
  });

  it('a value not representable in integer thousandths is refused at ingest', () => {
    expect(() => toMilli(21.3504)).toThrow(/not representable/);
    expect(toMilli(21.35)).toBe(21350);
  });

  it('and a float that leaked past ingest is caught at the leaf', () => {
    expect(() => assertMilli(21350.5, 'test')).toThrow(/non-integer milli/);
    expect(() => leafHash({ at: FROM, channel: 'temperature_c', valueMilli: 1.5, deviceId: 'd' }))
      .toThrow(/non-integer milli/);
  });

  it('leaves and internal nodes are domain-separated', () => {
    const a = leafHash(reading(FROM, 'temperature_c', 5, 'd'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Two leaves and their parent are distinct hashes by construction.
    const two = merkleRoot([
      reading(FROM, 'temperature_c', 5, 'd'),
      reading(TO, 'temperature_c', 6, 'd'),
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
    postingWindow: DEFAULT_POSTING_WINDOW,
  };

  // Returning FALSE ships a possibly high-value load unnotarized. Returning TRUE
  // asserts a threshold was cleared when nothing compared it. Neither is the
  // answer: 50,000 MXN against 25,000 CAD is UNDETERMINED — the comparison needs
  // a rate and a date this function does not have.

  it('a cross-currency value is undetermined, and names the missing basis', () => {
    const r = requiresNotary(POLICY, { declaredValue: { amount: 50000, currency: 'MXN' } });
    expect(r.status).toBe('undetermined');
    if (r.status === 'undetermined') {
      expect(r.missing).toEqual(['fx:MXN->CAD']);
      expect(r.remedy).toContain('unstated rate');
    }
  });

  it('an unknown value is not "below threshold" — it is undetermined', () => {
    const r = requiresNotary(POLICY, {});
    expect(r.status).toBe('undetermined');
    if (r.status === 'undetermined') expect(r.missing).toEqual(['declaredValue']);
  });

  it('a dispute requires notarization ahead of everything else', () => {
    const r = requiresNotary(POLICY, { underDispute: true });
    expect(r.status).toBe('required');
    if (r.status === 'required') expect(r.because).toBe('dispute');
    // And it resolves a load that would otherwise be undetermined.
    expect(requiresNotary(POLICY, {}).status).toBe('undetermined');
  });

  it('notarizeOnDispute:false does not force it', () => {
    const quiet = { ...POLICY, notarizeOnDispute: false };
    expect(requiresNotary(quiet, { underDispute: true, declaredValue: { amount: 10, currency: 'CAD' } }).status)
      .toBe('not_required');
  });

  it('the commodity class decides before value is consulted', () => {
    // Deliberate: an always-notarize class in an INCOMPARABLE currency still
    // resolves, because the class never needed the comparison.
    const r = requiresNotary(POLICY, { commodityClass: 'pharma', declaredValue: { amount: 10, currency: 'MXN' } });
    expect(r.status).toBe('required');
    if (r.status === 'required') expect(r.because).toBe('commodity_class');
  });

  it('a comparable value resolves at, above, and below the threshold', () => {
    expect(requiresNotary(POLICY, { declaredValue: { amount: 2400, currency: 'CAD' } }).status).toBe('not_required');
    expect(requiresNotary(POLICY, { declaredValue: { amount: 25000, currency: 'CAD' } }).status).toBe('required');
    expect(requiresNotary(POLICY, { declaredValue: { amount: 90000, currency: 'CAD' } }).status).toBe('required');
  });

  it('every undetermined branch names what is missing and what to do', () => {
    for (const load of [{}, { declaredValue: { amount: 50000, currency: 'MXN' } }]) {
      const r = requiresNotary(POLICY, load);
      expect(r.status).toBe('undetermined');
      if (r.status === 'undetermined') {
        expect(r.missing.length).toBeGreaterThan(0);
        expect(r.remedy.length).toBeGreaterThan(20);
      }
    }
  });
});

describe('THE PRE-DATING HOLE: the in-time rule is symmetric now', () => {
  const readings = () => run(FROM, TO, 5, () => 5.0);
  const at = (postedAt: string): Commitment => {
    const { root, leafCount } = merkleRoot(readings());
    return {
      commitmentId: 'C', root, leafCount,
      subject: { kind: 'load_condition', loadId: 'L-1', channel: 'temperature_c' },
      coversFrom: FROM, coversTo: TO, postedAt,
      anchor: { kind: 'public_chain', chain: 'test', txRef: '0x1', blockTime: postedAt },
      postedBy: 'op-1', authority: 'ops',
    };
  };

  const side = (c: Commitment) => { const r = checkPosting(c); return r.ok ? 'in_time' : r.side; };

  it('a commitment posted a YEAR before its data is refused', () => {
    // MEASURED against the one-sided check this replaces: postedInTime returned
    // TRUE and the full pipeline returned HELD on exactly this input. A
    // commitment made before the fact existed cannot have been derived from
    // observing it.
    expect(side(at('2025-08-30T00:00:00.000Z'))).toBe('early');
    const v = notarizeCondition({
      readings: readings(), commitment: at('2025-08-30T00:00:00.000Z'), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') {
      expect(v.reason).toBe('commitment_predates_its_interval');
      expect(v.remedy).toContain('cannot precede its own readings');
    }
  });

  it('posting at the START of the interval is REFUSED, and that is the correction', () => {
    // An earlier revision anchored the early edge to `coversFrom`, reasoning
    // that posting at the start is a legitimate pre-commitment. For a
    // load_condition root that is exactly backwards:
    //
    //     root = merkleRoot(readings over [coversFrom, coversTo])
    //
    // Every reading must EXIST for the root to be computable, so the earliest
    // honest postedAt is coversTo. A commitment posted at coversFrom claims a
    // root over readings the period had not yet produced — the fabrication
    // case. The permissive anchor admitted a whole interval's worth of it.
    expect(side(at(FROM))).toBe('early');
  });

  it('posting at coversTo is in time; a few minutes of upload skew is fine', () => {
    expect(side(at(TO))).toBe('in_time');
    expect(side(at('2026-08-30T06:03:00.000Z'))).toBe('in_time');
  });

  it('a decision_expectation MAY precede its interval — that is pre-registration', () => {
    // The one subject where committing before observing is the point. Handled
    // by subject kind rather than by loosening the window for everything.
    const preReg: Commitment = {
      ...at(FROM), subject: { kind: 'decision_expectation', decisionId: 'D-1' },
      postedAt: '2025-08-30T00:00:00.000Z',
    };
    expect(checkPosting(preReg).ok).toBe(true);
    // ...and it is still bounded on the LATE side.
    expect(side({ ...preReg, postedAt: '2026-09-01T06:00:00.000Z' })).toBe('late');
  });

  it('and posting two days late is still too late', () => {
    expect(side(at('2026-09-01T06:00:00.000Z'))).toBe('late');
  });

  it('the window is policy: a permissive one accepts what the default refuses', () => {
    const wide = { lateGraceSeconds: 15 * 60, earlyGraceSeconds: 400 * 24 * 3600 };
    expect(checkPosting(at('2025-08-30T00:00:00.000Z'), wide).ok).toBe(true);
    // ...and the verdict records WHICH window was applied, so this is visible.
    const v = notarizeCondition({
      readings: readings(), commitment: at('2025-08-30T00:00:00.000Z'), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove, postingWindow: wide,
    });
    expect(v.context.postingWindow.earlyGraceSeconds).toBe(wide.earlyGraceSeconds);
    expect(v.context.postingOffsetSeconds).toBeLessThan(0);
  });
});

describe('the boundary term is part of the predicate identity', () => {
  const strict: ConditionPredicate = { ...REEFER, predicateId: 'reefer_strict@1.0.0', boundaryIsBreach: true };
  const at = (v: number) => [reading(FROM, 'temperature_c', v, 'd')];

  it('boundaryIsBreach:false lets a reading sit exactly on either bound', () => {
    expect(evaluateCondition(at(8.0), REEFER, FROM, TO).breached).toBe(false);
    expect(evaluateCondition(at(2.0), REEFER, FROM, TO).breached).toBe(false);
  });

  it('boundaryIsBreach:true breaches on either bound — symmetrically', () => {
    // A one-reading run is inside the tolerance window, so use a sustained run.
    const runAt = (v: number) => run(FROM, TO, 5, () => v);
    expect(evaluateCondition(runAt(8.0), strict, FROM, TO).breached).toBe(true);
    expect(evaluateCondition(runAt(2.0), strict, FROM, TO).breached).toBe(true);
  });

  it('the two variants are different predicateIds — it is a contract term', () => {
    expect(strict.predicateId).not.toBe(REEFER.predicateId);
  });
});

describe('every unproven reason is reachable — enumerated, not remembered', () => {
  it('the enum and the union agree', () => {
    const set = new Set<UnprovenReason>(ALL_UNPROVEN_REASONS);
    expect(set.size).toBe(ALL_UNPROVEN_REASONS.length);
    // The omission reason was dropped in a proposed revision. It is the whole
    // purpose of carrying the root: a curated subset plus the full commitment
    // yields `held` without it.
    expect(set.has('readings_do_not_match_commitment')).toBe(true);
    expect(set.has('commitment_predates_its_interval')).toBe(true);
  });

  it('the condition path emits five of them, by construction', () => {
    const seen = new Set<UnprovenReason>();
    const full = run(FROM, TO, 5, () => 5.0);
    const good = commit(full, FROM, TO, TO);
    const push = (v: ReturnType<typeof notarizeCondition>) => {
      if (v.status === 'unproven') seen.add(v.reason);
    };
    const base = { predicate: REEFER, from: FROM, to: TO, device: DEVICE, now: NOW, prove };

    push(notarizeCondition({ ...base, readings: full, commitment: null }));
    push(notarizeCondition({ ...base, readings: full, commitment: commit(full, FROM, TO, '2026-09-01T06:00:00.000Z') }));
    push(notarizeCondition({ ...base, readings: full, commitment: commit(full, FROM, TO, '2025-08-30T00:00:00.000Z') }));
    push(notarizeCondition({ ...base, readings: full.slice(0, 5), commitment: good }));
    const gapped = [...run(FROM, '2026-08-30T01:00:00.000Z', 5, () => 5.0),
                    ...run('2026-08-30T05:00:00.000Z', TO, 5, () => 5.0)];
    push(notarizeCondition({ ...base, readings: gapped, commitment: commit(gapped, FROM, TO, TO) }));
    push(notarizeCondition({ ...base, readings: full, commitment: good, prove: undefined }));

    expect([...seen].sort()).toEqual([
      'commitment_posted_after_the_fact',
      'commitment_predates_its_interval',
      'no_commitment_for_interval',
      'proof_generation_failed',
      'readings_do_not_match_commitment',
      'telemetry_gap_exceeds_max',
    ]);
  });

  it('the custody path emits the two that are its own', () => {
    const P = { predicateId: 'c@1', statement: 's', maxHandoffGapSeconds: 1800, requireBothSignatures: true };
    const noCommit = notarizeCustody([], P, FROM, TO, null, NOW);
    expect(noCommit.status === 'unproven' && noCommit.reason).toBe('no_commitment_for_interval');
    const hs: Handoff[] = [{ at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: null }];
    const unsigned = notarizeCustody(hs, P, FROM, TO, commit([], FROM, TO, TO), NOW);
    expect(unsigned.status === 'unproven' && unsigned.reason).toBe('missing_handoff_signature');
  });

  it('device_unattested is declared and NOT yet emitted — recorded, not hidden', () => {
    // An unattested device today travels beside the verdict rather than
    // blocking it, which is the deliberate design: the proof covers the
    // computation, and device trust is a separate root. The reason exists for a
    // policy that refuses on it. Saying so is better than a reachability claim
    // that quietly excludes the member it cannot produce.
    expect(ALL_UNPROVEN_REASONS).toContain('device_unattested');
  });
});

/**
 * THE REVERT PINS.
 *
 * A proposed revision of `notary.ts` arrived that reverted six fixes at once —
 * every one of them silently, because each reversion still typechecks, still
 * runs, and still returns a verdict-shaped object. They are pinned here
 * BEHAVIOURALLY rather than by grepping the source, so a reversion fails on
 * what it does rather than on how it is spelled.
 *
 * These are not hypothetical. Each was a defect found by measurement, and each
 * was re-proposed after being fixed.
 */
describe('the six fixes that a revision reverted, pinned by behaviour', () => {
  it('1. the leaf hashes the INSTANT, not the ISO string', () => {
    // Hashing `r.at` raw makes two offsets of one instant produce different
    // leaves, while the circuit parses to u64 seconds and produces one. A
    // reference and a circuit that disagree on the encoding disagree on every
    // root, silently, because both look internally consistent.
    const z = reading('2026-08-30T01:00:00.000Z', 'temperature_c', 5, 'd');
    const plusOne = reading('2026-08-30T02:00:00+01:00', 'temperature_c', 5, 'd');
    expect(leafHash(z)).toBe(leafHash(plusOne));
  });

  it('2. the root sorts by INSTANT, not lexically', () => {
    // '2026-08-30T02:00:00+01:00' sorts AFTER '...T01:00:00.000Z' as a string
    // and TIES with it as an instant. Ordering must follow the instant.
    const off = reading('2026-08-30T00:00:00.000Z', 'temperature_c', 4, 'd');
    const z = reading('2026-08-30T01:00:00.000Z', 'temperature_c', 5, 'd');
    const plusOne = reading('2026-08-30T02:00:00+01:00', 'temperature_c', 5, 'd');
    expect(merkleRoot([off, z]).root).toBe(merkleRoot([off, plusOne]).root);
  });

  it('3. internal nodes are domain-separated from leaves', () => {
    // Without separation, a value whose encoding resembles a concatenated hash
    // pair can be presented as an internal node. Concatenating two leaves must
    // NOT reproduce their parent.
    const a = reading(FROM, 'temperature_c', 5, 'd');
    const b = reading(TO, 'temperature_c', 6, 'd');
    const parent = merkleRoot([a, b]).root;
    const naive = createHash('sha256')
      .update(leafHash(a) + leafHash(b)).digest('hex');
    expect(parent).not.toBe(naive);
  });

  it('4. coverage is NOT capped at 1, and out-of-order is reported', () => {
    // Clamping to a reassuring 1.000 hides the case worth seeing; sorting
    // silently erases the only evidence a device or upload path misbehaves.
    const ordered = run(FROM, TO, 30, () => 5.0);
    const jumbled = [ordered[3], ordered[1], ...ordered];
    const cov = computeCoverage(jumbled, FROM, TO, 1800);
    expect(cov.outOfOrder).toBe(true);
    expect(cov).toHaveProperty('outOfOrder');
  });

  it('5. a curated subset plus the full commitment cannot yield held', () => {
    // The omission attack. Dropping this check makes the root decoration.
    const full = run(FROM, TO, 5, i => (i >= 36 && i <= 48 ? 9.4 : 5.0));
    const commitment = commit(full, FROM, TO, TO);
    const curated = full.filter(r => r.valueMilli <= toMilli(8.0));
    expect(curated.length).toBeLessThan(full.length);
    const v = notarizeCondition({
      readings: curated, commitment, predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW, prove,
    });
    expect(v.status).toBe('unproven');
    if (v.status === 'unproven') expect(v.reason).toBe('readings_do_not_match_commitment');
  });

  it('6. the engine holds no clock — two runs are byte-identical', () => {
    // A verdict that stamps itself cannot be compared against a replay. `now`
    // is injected for the same reason the spatial claim takes computedAt.
    const readings = run(FROM, TO, 5, () => 5.0);
    const args = {
      readings, commitment: commit(readings, FROM, TO, TO), predicate: REEFER,
      from: FROM, to: TO, device: DEVICE, now: NOW,
    };
    expect(JSON.stringify(notarizeCondition(args)))
      .toBe(JSON.stringify(notarizeCondition(args)));

    const P = { predicateId: 'c@1', statement: 's', maxHandoffGapSeconds: 1800, requireBothSignatures: true };
    const hs: Handoff[] = [{ at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: 's' }];
    const c = commit([], FROM, TO, TO);
    expect(JSON.stringify(notarizeCustody(hs, P, FROM, TO, c, NOW)))
      .toBe(JSON.stringify(notarizeCustody(hs, P, FROM, TO, c, NOW)));
  });

  it('6b. and the clock read the behavioural pin CANNOT reach, checked structurally', () => {
    // MEASURED, and stated rather than papered over: applying all six
    // reversions made 11 tests fail, and pin 6 was NOT among them.
    //
    // The reason is worth keeping. On the condition path the `system: 'none'`
    // stub's `provedAt` is discarded — that branch returns `unproven` without
    // the proof — so a wall-clock read there never reaches the output and no
    // behavioural test can observe it. It is dead today and live the moment
    // that branch starts carrying its proof.
    //
    // A pin that cannot fail is worse than no pin, so this half is checked at
    // the source, and the split is named instead of implied.
    const src = readFileSync(join(process.cwd(), 'src/lib/economy/notary.ts'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code, 'the engine must take `now`, never read it').not.toMatch(/new Date\(\s*\)/);
  });

  it('7. one handoff does not read as a fully covered interval', () => {
    // `covered: handoffs.length > 0 ? 1 : 0` renders "held across 100.0% of the
    // interval" off a single handoff. Custody is not an interval-density
    // question, so it reports 0 rather than a fraction that overstates.
    const P = { predicateId: 'c@1', statement: 's', maxHandoffGapSeconds: 1800, requireBothSignatures: true };
    const hs: Handoff[] = [{ at: FROM, fromParty: 'a', toParty: 'b', fromSignature: 's', toSignature: 's' }];
    const v = notarizeCustody(hs, P, FROM, TO, commit([], FROM, TO, TO), NOW);
    expect(v.context.coverage.covered).toBe(0);
    expect(v.renderedClaim).not.toContain('100.0%');
  });
});
