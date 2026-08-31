// src/lib/economy/claimable.test.ts
//
// Claimable artifacts, carrier trust, claim economics, transparency log.
// Each pin names the measurement that produced it.

import { describe, it, expect } from 'vitest';
import {
  emitClaimable, verifyClaimable, claimableHash, checkSelfContained,
  claimLatency, resolveExpiry, COMMON_SELF_ID_FIELDS, type Claimable,
} from './claimable';
import {
  assessTrust, detectBolMismatch, weakestClass, MIN_OBSERVATIONS,
  DEFAULT_TRUST_POLICY, type CarrierTrustProfile, type ComponentValue,
} from './carrierTrust';
import {
  rateAtClaim, computeCoverCost, tonuOwed, assessResponse, headStartFor,
  DEFAULT_TONU, type ClaimIncentive, type ResponseProfile,
} from './claimEconomics';
import {
  TransparencyLog, verifyInclusion, verifyConsistency, issueReceipt, verifyReceipt,
  trustNoteFor, leafHash, nodeHash, merkleTreeHash, encodeRecord, RECORD_VERSION,
  EMPTY_ROOT, type LogRecord,
} from './transparencyLog';

/** A log record, in the versioned shape the merged design uses. */
const rec = (id: string, owner = 'SH-1', payload = `rate:2400`): LogRecord => ({
  subject: { kind: 'load', id, ownerParty: owner }, payload,
  recordedAt: '2026-09-01T00:00:00.000Z',
});

const NOW = '2026-09-05T00:00:00.000Z';
const sign = (h: string) => `sig:${h.slice(0, 16)}`;

// ═══════════════════════════════════════════════════════════════════════════
describe('claimable - self-containment is enforced, not asserted', () => {
  const good = { loadId: 'L-1', origin: 'Toronto ON', dest: 'Detroit MI', rate: 2400, currency: 'CAD' };

  it('emits a self-contained payload', () => {
    const r = emitClaimable({
      claimableId: 'C-1', kind: 'carrier_tender',
      offeredTo: { partyId: 'CX-1', partyName: 'Northbridge' }, offeredBy: 'payload',
      payload: good, sign, offeredAt: NOW, validForSeconds: 3600,
      onExpiry: { kind: 're_offer', toPartyId: 'CX-2', reason: 'first offer lapsed' },
    });
    expect(r.status).toBe('offered');
  });

  it('does NOT flag self-identity as an unresolved reference', () => {
    // THE DEFECT THE SUPPLIED DESIGN FOUND BY RUNNING IT: the check looked for a
    // sibling `load` beside `loadId`, found none, and refused EVERY valid
    // artifact. A check that refuses everything is as useless as one that
    // refuses nothing.
    expect(checkSelfContained(good).ok).toBe(true);
    expect(COMMON_SELF_ID_FIELDS).toContain('loadId');
  });

  it('still catches a REAL unresolved reference - so the fix is not just a mute', () => {
    const bad = { loadId: 'L-1', rate: 2400, shipperRef: 'SH-77' };
    const c = checkSelfContained(bad);
    expect(c.ok).toBe(false);
    expect(c.violations[0].path).toBe('$.shipperRef');
    expect(c.violations[0].remedy).toContain('shipper');
  });

  it('accepts a reference that carries its resolved value alongside', () => {
    expect(checkSelfContained({ loadId: 'L-1', shipperRef: 'SH-77', shipper: 'Halcyon Foods' }).ok).toBe(true);
  });

  it('refuses a callback phrase', () => {
    const r = emitClaimable({
      claimableId: 'C-2', kind: 'invoice',
      offeredTo: { partyId: 'CX-1', partyName: 'N' }, offeredBy: 'payload',
      payload: { invoiceId: 'I-1', terms: 'See attached schedule B' },
      sign, offeredAt: NOW, validForSeconds: 60,
      onExpiry: { kind: 'lapse', consequence: 'none' },
    });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.reason).toBe('not_self_contained');
  });

  it('refuses an EMPTY payload rather than calling it self-contained', () => {
    // A check that examined nothing did not pass, it did not run. An empty
    // payload is self-contained the way an empty promise is kept.
    const r = emitClaimable({
      claimableId: 'C-3', kind: 'invoice',
      offeredTo: { partyId: 'CX-1', partyName: 'N' }, offeredBy: 'payload',
      payload: {}, sign, offeredAt: NOW, validForSeconds: 60,
      onExpiry: { kind: 'lapse', consequence: 'none' },
    });
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.reason).toBe('empty_payload');
  });
});

describe('claimable - the hash is DERIVED, so verification means something', () => {
  const mk = (payload: object) => {
    const r = emitClaimable({
      claimableId: 'C-9', kind: 'rate_confirmation',
      offeredTo: { partyId: 'CX-1', partyName: 'N' }, offeredBy: 'payload',
      payload, sign, offeredAt: NOW, validForSeconds: 3600,
      onExpiry: { kind: 'escalate_to_operator', reason: 'no response' },
    });
    if (r.status !== 'offered') throw new Error('expected offered');
    return r.claimable;
  };

  it('verifies an untouched artifact', () => {
    expect(verifyClaimable(mk({ loadId: 'L-1', rate: 2400 })).ok).toBe(true);
  });

  it('catches a tampered payload', () => {
    // THE SUPPLIED DESIGN TOOK `contentHash` AS AN INPUT and stored it unchecked,
    // while the artifact's whole claim is "verifiable without trusting us". A
    // hash nobody derives is a decoration, and the first party to check it would
    // have been the counterparty in a dispute.
    const c = mk({ loadId: 'L-1', rate: 2400 }) as Claimable<{ loadId: string; rate: number }>;
    const tampered = { ...c, payload: { ...c.payload, rate: 2100 } };
    const v = verifyClaimable(tampered);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('hash_mismatch');
  });

  it('hashes deterministically regardless of key order', () => {
    expect(claimableHash({ a: 1, b: 2 })).toBe(claimableHash({ b: 2, a: 1 }));
    expect(claimableHash({ a: 1 })).not.toBe(claimableHash({ a: 2 }));
  });
});

describe('claimable - their latency is measured, not waited on', () => {
  const base: Claimable<{ loadId: string }> = {
    claimableId: 'C-1', kind: 'carrier_tender',
    offeredTo: { partyId: 'CX-1', partyName: 'N' }, offeredBy: 'payload',
    payload: { loadId: 'L-1' }, selfContained: true,
    contentHash: claimableHash({ loadId: 'L-1' }), issuerSignature: 'sig',
    offeredAt: '2026-09-05T00:00:00.000Z', expiresAt: '2026-09-05T01:00:00.000Z',
    claimedAt: null, claimOutcome: null, claimedBy: null,
    onExpiry: { kind: 're_offer', toPartyId: 'CX-2', reason: 'lapsed' },
  };

  it('measures 94 minutes as 94 minutes', () => {
    const c = { ...base, claimedAt: '2026-09-05T01:34:00.000Z', claimOutcome: 'accepted' as const };
    expect(claimLatency(c, NOW).latencySeconds).toBe(94 * 60);
    expect(claimLatency(c, NOW).outcome).toBe('accepted');
  });

  it('distinguishes open from expired', () => {
    expect(claimLatency(base, '2026-09-05T00:30:00.000Z').outcome).toBe('open');
    expect(claimLatency(base, '2026-09-05T02:00:00.000Z').outcome).toBe('expired');
  });

  it('makes expiry an EVENT, never a silence', () => {
    const r = resolveExpiry(base, '2026-09-05T02:00:00.000Z');
    expect(r.expired).toBe(true);
    expect(r.action).toEqual({ kind: 're_offer', toPartyId: 'CX-2', reason: 'lapsed' });
    // A claimed artifact does not expire out from under its outcome.
    expect(resolveExpiry({ ...base, claimOutcome: 'accepted' }, '2027-01-01T00:00:00.000Z').expired).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
const present = <T,>(value: T, attestation: Parameters<typeof weakestClass>[0][number], source: string): ComponentValue<T> =>
  ({ status: 'present', value, attestation, asOf: '2026-09-01T00:00:00.000Z', source });

const cleanProfile = (over: Partial<CarrierTrustProfile> = {}): CarrierTrustProfile => ({
  carrierId: 'CX-1', assessedAt: NOW,
  authorityActive: present(true, 'regulator_reported', 'FMCSA'),
  authorityGrantedAt: present('2018-01-01T00:00:00.000Z', 'regulator_reported', 'FMCSA'),
  insuranceValidUntil: present('2027-01-01T00:00:00.000Z', 'insurer_confirmed', 'insurer'),
  insuranceCoverageAmount: present(100_000, 'insurer_confirmed', 'insurer'),
  safetyRating: present('satisfactory' as const, 'regulator_reported', 'FMCSA'),
  outOfServiceOpen: present(false, 'regulator_reported', 'FMCSA'),
  loadsRun: 40,
  onTimePickupRate: present(0.95, 'our_observation', 'our records'),
  onTimeDeliveryRate: present(0.93, 'our_observation', 'our records'),
  rateVariancePct: present(0.01, 'our_observation', 'our records'),
  claimsFiled: present(0, 'our_observation', 'our records'),
  fraudSignals: [],
  ...over,
});

describe('carrierTrust - a profile, not a score', () => {
  it('clears a clean carrier and carries the weakest class in the basis', () => {
    const v = assessTrust(cleanProfile(), '2026-09-10T00:00:00.000Z');
    expect(v.status).toBe('cleared');
    if (v.status !== 'cleared') return;
    // Behavioural data is `our_observation`, weaker than regulator/insurer.
    expect(v.weakestAttestation).toBe('our_observation');
    expect(v.behaviourUsed).toBe(true);
  });

  it('BLOCKS on insurance valid today but not at pickup', () => {
    const v = assessTrust(
      cleanProfile({ insuranceValidUntil: present('2026-09-01T00:00:00.000Z', 'insurer_confirmed', 'insurer') }),
      '2026-09-02T00:00:00.000Z');
    expect(v.status).toBe('blocked');
    expect(v.renderedClaim).toContain('Valid now is not valid then');
  });

  it('returns UNDETERMINED for an absent component, never a low score', () => {
    const v = assessTrust(
      cleanProfile({ safetyRating: { status: 'absent', reason: 'not fetched', remedy: 'query FMCSA' } }),
      '2026-09-10T00:00:00.000Z');
    expect(v.status).toBe('undetermined');
    if (v.status !== 'undetermined') return;
    expect(v.missing).toEqual(['safetyRating']);
    expect(v.remedy).toContain('NOT a low value');
  });

  it('withholds behavioural components below the observation floor', () => {
    const v = assessTrust(cleanProfile({ loadsRun: 3 }), '2026-09-10T00:00:00.000Z');
    expect(v.status).toBe('cleared');
    if (v.status !== 'cleared') return;
    expect(v.behaviourUsed).toBe(false);
    expect(v.renderedClaim).toContain('noise');
  });

  it('HOLDS NO CLOCK - the same profile assessed twice gives the same verdict', () => {
    // The supplied design injected `atPickup` and then read Date.now() for the
    // new-authority window. Two verdicts on one profile minutes apart could
    // differ, and neither would be reproducible in the dispute this exists for.
    const p = cleanProfile({
      assessedAt: '2020-01-01T00:00:00.000Z',
      authorityGrantedAt: present('2019-12-01T00:00:00.000Z', 'regulator_reported', 'FMCSA'),
    });
    const a = assessTrust(p, '2020-02-01T00:00:00.000Z');
    const b = assessTrust(p, '2020-02-01T00:00:00.000Z');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Authority granted 31 days before assessment is inside the 180-day window,
    // measured against assessedAt in 2020 rather than against today.
    if (a.status === 'cleared') {
      expect(a.notes.some(n => n.includes('reincarnation risk'))).toBe(true);
    }
  });

  it('blocks on the strongest signal we own, and dates it from an injected instant', () => {
    const signals = detectBolMismatch(
      [{ loadId: 'L-1', carrierId: 'CX-1', bolCarrierId: 'CX-3' }], NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0].detectedAt).toBe(NOW);
    const v = assessTrust(cleanProfile({ fraudSignals: signals }), '2026-09-10T00:00:00.000Z');
    expect(v.status).toBe('blocked');
    expect(v.renderedClaim).toContain('not a score');
  });

  it('refuses to name a weakest class over an empty basis', () => {
    expect(() => weakestClass([])).toThrow(/empty basis/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
const INC: ClaimIncentive = {
  baseRate: 2400, currency: 'CAD',
  decay: [
    { afterSeconds: 30 * 60, rate: 2350 },
    { afterSeconds: 60 * 60, rate: 2300 },
    { afterSeconds: 120 * 60, rate: 2200 },
  ],
  tierHeadStartSeconds: 15 * 60, raceToClaim: true,
};

describe('claimEconomics - decay needs no enforcement', () => {
  const at = (mins: number) => rateAtClaim(INC, NOW, new Date(Date.parse(NOW) + mins * 60_000).toISOString());

  it('reprices down the schedule', () => {
    expect(at(0)).toMatchObject({ status: 'priced', rate: 2400, stepApplied: null });
    expect(at(35)).toMatchObject({ status: 'priced', rate: 2350 });
    expect(at(70)).toMatchObject({ status: 'priced', rate: 2300 });
    expect(at(180)).toMatchObject({ status: 'priced', rate: 2200 });
  });

  it('REFUSES a claim that predates its own offer', () => {
    // Falling through to base would price a backwards clock at the BEST rate on
    // the schedule — the cheapest possible attack on a decay curve.
    const r = at(-10);
    expect(r.status).toBe('refused');
    if (r.status === 'refused') expect(r.detail).toContain('backwards clock');
  });
});

describe('claimEconomics - cover cost is the only enforceable damage', () => {
  const cad = (amount: number) => ({ amount, currency: 'CAD' as const });

  it('computes a real loss from two records we hold', () => {
    const c = computeCoverCost({
      original: cad(2400),
      recovery: { rate: cad(2700), carrierId: 'CX-9', evidenceIds: ['e1', 'e2'] },
      loadWasMoved: true,
    });
    expect(c).toMatchObject({ status: 'incurred', amount: { amount: 300, currency: 'CAD' } });
  });

  it('reports NONE when re-covered at or below the original', () => {
    expect(computeCoverCost({
      original: cad(2400), recovery: { rate: cad(2300), carrierId: 'CX-9', evidenceIds: [] }, loadWasMoved: true,
    }).status).toBe('none');
  });

  it('is UNDETERMINED when the load never moved - the case that decides enforceability', () => {
    const c = computeCoverCost({ original: cad(2400), recovery: null, loadWasMoved: false });
    expect(c.status).toBe('undetermined');
    if (c.status !== 'undetermined') return;
    expect(c.reason).toBe('load_not_recovered');
    expect(c.remedy).toContain('penalty');
  });

  it('REFUSES to subtract across currencies', () => {
    // The supplied design took bare numbers here, while ClaimIncentive and
    // TonuSchedule each carried a currency — so the one figure that ends on an
    // invoice was the one with no unit. `downstreamImpact` already throws
    // MIXED_CURRENCY on this shape.
    const c = computeCoverCost({
      original: cad(2400),
      recovery: { rate: { amount: 2700, currency: 'USD' }, carrierId: 'CX-9', evidenceIds: [] },
      loadWasMoved: true,
    });
    expect(c.status).toBe('refused');
    if (c.status !== 'refused') return;
    expect(c.remedy).toContain('no unit wearing the label of one');
  });
});

describe('claimEconomics - symmetry and the n-floor', () => {
  it('owes TONU on short notice, and nothing beyond the bands', () => {
    expect(tonuOwed(1 * 3600).owed).toEqual({ amount: 250, currency: 'CAD' });
    expect(tonuOwed(6 * 3600).owed.amount).toBe(150);
    expect(tonuOwed(18 * 3600).owed.amount).toBe(75);
    expect(tonuOwed(40 * 3600).owed.amount).toBe(0);
    expect(tonuOwed(40 * 3600, DEFAULT_TONU).band).toBeNull();
  });

  const profile = (over: Partial<ResponseProfile> = {}): ResponseProfile => ({
    party: 'CX-4', offersMade: 64, claimed: 51, accepted: 47, declined: 4, lapsed: 13,
    noShows: 0, lateCancels: 0, medianClaimSeconds: 18 * 60,
    coverCostIncurred: { amount: 0, currency: 'CAD' }, ...over,
  });

  it('withholds a profile below the floor rather than reporting a caveat', () => {
    const v = assessResponse(profile({ offersMade: 3, claimed: 1, accepted: 1, noShows: 1 }));
    expect(v.status).toBe('insufficient_observations');
    expect(v.renderedClaim).toContain('WITHHELD');
  });

  it('uses ONE floor, shared with the trust policy', () => {
    // The supplied design had 10 here and 8 in the trust policy, and quoted both
    // in one report — so a carrier with 9 loads had behavioural components
    // admitted to the trust basis and its response profile withheld, at once.
    expect(DEFAULT_TRUST_POLICY.minObservationsForBehaviour).toBe(MIN_OBSERVATIONS);
    const nine = assessResponse(profile({ offersMade: 9 }));
    expect(nine.status).toBe('insufficient_observations');
    const trust = assessTrust(cleanProfile({ loadsRun: 9 }), '2026-09-10T00:00:00.000Z');
    expect(trust.status).toBe('cleared');
    if (trust.status === 'cleared') expect(trust.behaviourUsed).toBe(false);
  });

  it('returns a NULL no-show rate over an empty denominator, not 0%', () => {
    // The supplied design divided by Math.max(accepted, 1), so 15 offers and 0
    // accepted reported "No-show 0.0% (0/0)" — a clean record computed over an
    // empty population, which reads as evidence of reliability.
    const v = assessResponse(profile({ offersMade: 15, claimed: 0, accepted: 0, lapsed: 15, noShows: 0 }));
    expect(v.status).toBe('assessed');
    if (v.status !== 'assessed') return;
    expect(v.noShowRate).toBeNull();
    expect(v.renderedClaim).toContain('UNDETERMINED');
    expect(v.renderedClaim).toContain('no denominator');
  });

  it('gates access, never exclusion', () => {
    const restricted = assessResponse(profile({
      offersMade: 58, claimed: 33, accepted: 29, lapsed: 25, noShows: 4, medianClaimSeconds: 155 * 60,
      coverCostIncurred: { amount: 1180, currency: 'CAD' },
    }));
    expect(restricted.status).toBe('assessed');
    if (restricted.status !== 'assessed') return;
    expect(restricted.tier).toBe('restricted');
    // A restricted carrier still RECEIVES offers, just later.
    expect(headStartFor('restricted', INC)).toBe(45 * 60);
    expect(headStartFor('priority', INC)).toBe(0);
    expect(Number.isFinite(headStartFor('restricted', INC))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('transparencyLog - the positive case FIRST', () => {
  const log = new TransparencyLog();
  const recs: LogRecord[] = [];
  for (let i = 0; i < 64; i++) {
    const r = rec(`L-${i}`, `SH-${(i % 3) + 1}`, `rate:${2400 + i}`);
    recs.push(r); log.append(r);
  }

  it('VERIFIES a valid inclusion proof', () => {
    // THE ORDER MATTERS. The first build emitted the audit path bottom-up and
    // verified it top-down, so every valid proof failed — and the tamper test
    // beside it PASSED, rejecting the altered record because verification was
    // broken for everything. A passing negative next to a failing positive is
    // vacuous and reads as coverage.
    const proof = log.inclusionProof(17);
    expect(proof.path).toHaveLength(6);   // log2(64)
    expect(verifyInclusion(recs[17], proof)).toBe(true);
  });

  it('verifies EVERY leaf, not just the convenient one', () => {
    for (let i = 0; i < 64; i++) {
      expect(verifyInclusion(recs[i], log.inclusionProof(i)), `leaf ${i}`).toBe(true);
    }
  });

  it('THEN rejects a tampered payload - and the pair together is the evidence', () => {
    const proof = log.inclusionProof(17);
    expect(verifyInclusion({ ...recs[17], payload: 'rate:2100' }, proof)).toBe(false);
    // Every field is in the hashed bytes, not just the payload.
    expect(verifyInclusion({ ...recs[17], subject: { ...recs[17].subject, ownerParty: 'SH-9' } }, proof)).toBe(false);
    expect(verifyInclusion({ ...recs[17], recordedAt: '2020-01-01T00:00:00.000Z' }, proof)).toBe(false);
  });

  it('versions the encoding, so changing it is loud rather than silent', () => {
    expect(encodeRecord(recs[0]).startsWith(RECORD_VERSION)).toBe(true);
    expect(leafHash(encodeRecord(recs[0]))).not.toBe(leafHash(recs[0].payload));
  });

  it('rejects a padded proof rather than accepting a longer path', () => {
    const p = log.inclusionProof(17);
    expect(verifyInclusion(recs[17], { ...p, path: [...p.path, leafHash('junk')] })).toBe(false);
    expect(verifyInclusion(recs[17], { ...p, path: p.path.slice(0, -1) })).toBe(false);
  });

  it('handles an odd tree size', () => {
    const odd = new TransparencyLog();
    const or: LogRecord[] = [];
    for (let i = 0; i < 7; i++) { const r = rec(`r${i}`); or.push(r); odd.append(r); }
    for (let i = 0; i < 7; i++) {
      expect(verifyInclusion(or[i], odd.inclusionProof(i)), `leaf ${i} of 7`).toBe(true);
    }
  });

  it('the subtree cache agrees with the uncached tree hash, at every size', () => {
    // A cache is a second implementation of the same fact. Measured before it
    // existed: one inclusion proof over 20,000 records cost 64-69 ms while the
    // append rate quoted beside it was ~300,000/s — the number measured the
    // operation nobody waits on. This pin stops the cache making a proof
    // sub-millisecond AND WRONG.
    const l = new TransparencyLog();
    const hashes: string[] = [];
    for (let i = 0; i < 33; i++) {
      const r = rec(`c${i}`);
      hashes.push(leafHash(encodeRecord(r)));
      l.append(r);
      expect(l.root(i + 1), `size ${i + 1}`).toBe(merkleTreeHash(hashes));
    }
  });

  it('domain-separates leaves from nodes and defines the empty root', () => {
    expect(leafHash('x')).not.toBe(nodeHash(leafHash('x'), leafHash('x')));
    expect(merkleTreeHash([])).toBe(EMPTY_ROOT);
    expect(merkleTreeHash([leafHash('a')])).toBe(leafHash('a'));
  });
});

describe('transparencyLog - consistency: the property a private chain cannot give', () => {
  const build = (n: number, alter?: number) => {
    const l = new TransparencyLog();
    for (let i = 0; i < n; i++) l.append(rec(`r${i}`, 'SH-1', i === alter ? 'ALTERED' : `p${i}`));
    return l;
  };

  it('proves an append-only extension', () => {
    const log = build(100);
    expect(verifyConsistency(log.consistencyProof(64, 100))).toBe(true);
  });

  it('CATCHES a rewrite against a root the customer already holds', () => {
    // We control every node, so "the chain says so" means "we say so". A
    // consistency proof against THEIR held root does not.
    const honest = build(64);
    const customerHolds = honest.root(64);
    const rewritten = build(100, 12);
    expect(rewritten.root(64)).not.toBe(customerHolds);
    const p = rewritten.consistencyProof(64, 100);
    expect(verifyConsistency({ ...p, fromRoot: customerHolds })).toBe(false);
  });

  it('verifies EVERY size pair, and catches EVERY rewrite - neither alone is evidence', () => {
    // 819/819 passing is exactly the shape that can be vacuous. The negative
    // sweep beside it is what makes the positive one mean something.
    const log = build(40);
    let ok = 0;
    for (let a = 1; a <= 39; a++) for (let b = a; b <= 40; b++) {
      expect(verifyConsistency(log.consistencyProof(a, b)), `${a} -> ${b}`).toBe(true);
      ok++;
    }
    expect(ok).toBe(819);

    const honest = build(40);
    let caught = 0;
    for (let a = 13; a <= 39; a++) for (let b = a + 1; b <= 40; b++) {
      const rw = build(40, 12);
      const p = rw.consistencyProof(a, b);
      expect(verifyConsistency({ ...p, fromRoot: honest.root(a) }), `rewrite ${a} -> ${b}`).toBe(false);
      caught++;
    }
    expect(caught).toBeGreaterThan(300);
  });

  it('rejects a truncated or padded consistency path', () => {
    const log = build(40);
    const p = log.consistencyProof(11, 29);
    expect(p.path.length).toBeGreaterThan(1);
    expect(verifyConsistency({ ...p, path: p.path.slice(0, -1) })).toBe(false);
    expect(verifyConsistency({ ...p, path: [...p.path, leafHash('junk')] })).toBe(false);
  });

  it('refuses a root for a size the log never had', () => {
    const log = build(1);
    expect(() => log.root(5)).toThrow(/fabricated/);
    expect(() => log.inclusionProof(3, 1)).toThrow(/verifies against nothing/);
  });
});

describe('transparencyLog - scoped serving and an honest receipt', () => {
  const log = new TransparencyLog();
  for (let i = 0; i < 100; i++) log.append(rec(`L-${i}`, `SH-${(i % 3) + 1}`));
  const sth = log.signedTreeHead({
    sign: (root, size) => `sig:${size}:${root.slice(0, 8)}`,
    publishedAt: NOW,
  });

  it('holds no clock - the head carries the instant it was given', () => {
    expect(sth.publishedAt).toBe(NOW);
    const again = log.signedTreeHead({ sign: () => 'sig', publishedAt: '1999-01-01T00:00:00.000Z' });
    expect(again.publishedAt).toBe('1999-01-01T00:00:00.000Z');
    expect(again.root).toBe(sth.root);
  });

  it('serves one party their own records', () => {
    const mine = log.recordsFor('SH-3');
    expect(mine.length).toBeGreaterThan(20);
    expect(mine.every(x => x.record.subject.ownerParty === 'SH-3')).toBe(true);
  });

  it('issues a receipt that verifies and states its own limit', () => {
    const r = issueReceipt(log, 12, sth);
    expect(verifyReceipt(r)).toBe(true);
    expect(r.ownerParty).toBe('SH-1');
    expect(r.trustNote).toContain('AS WE PUBLISHED IT');
    expect(r.trustNote).toContain('does not prove');
  });

  it('says something DIFFERENT once externally anchored', () => {
    const note = trustNoteFor({ kind: 'public_chain', ref: '0xabc', anchoredAt: NOW });
    expect(note).toContain('independently of Payload');
    expect(note).not.toContain('does not prove');
  });
});
