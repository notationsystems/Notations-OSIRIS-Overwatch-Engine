//
// The notary engine. Deterministic, prover-agnostic, and honest about what it cannot
// evaluate. The SP1 program (notary.program.md) computes exactly the predicate
// evaluated here — this implementation is the reference the circuit must match, and
// the equivalence is asserted by test.

import { createHash } from 'crypto';
import type {
  Commitment, ConditionPredicate, CustodyPredicate, NotaryVerdict,
  IntervalCoverage, DeviceTrust, ProofRef, Anchor, ConditionChannel,
} from './notary.types';
import { ANCHOR_STRENGTH } from './notary.types';

export interface Reading {
  at: string;
  channel: ConditionChannel;
  value: number;
  deviceId: string;
}

export interface Handoff {
  at: string;
  fromParty: string;
  toParty: string;
  fromSignature: string | null;
  toSignature: string | null;
  location?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export const LEAF_VERSION = 'payload.notary.leaf.v1';
/** Internal nodes are domain-separated from leaves. Without this, a value whose
 *  encoding happened to look like a concatenated hash pair could be presented as
 *  an internal node — a second-preimage shape that costs nothing to close. */
export const NODE_VERSION = 'payload.notary.node.v1';

export const MILLI_SCALE = 1000;

/**
 * The circuit works in INTEGER MILLIDEGREES (`i32`), because it has no floats.
 * Hashing `21.35` here while the circuit hashes `21350` produces a root that
 * verifies against nothing, and it would do so silently — a stable-looking
 * commitment over a value the circuit cannot reproduce. Refuse at the boundary
 * instead.
 */
export function assertMilli(value: number): number {
  const milli = value * MILLI_SCALE;
  if (!Number.isFinite(milli) || Math.abs(milli - Math.round(milli)) > 1e-9) {
    throw new Error(
      `notary: ${value} is not representable in integer millidegrees. The circuit has no ` +
      'floats, so a reading it cannot encode must be refused here rather than committed to a ' +
      'root that will verify against nothing.',
    );
  }
  return Math.round(milli);
}

/**
 * Canonical instant, in unix SECONDS, matching the circuit's `at: u64`.
 *
 * Found by test: hashing the raw ISO string makes
 * `2026-08-30T01:00:00.000Z` and `2026-08-30T02:00:00+01:00` — the SAME
 * INSTANT — produce different leaves and therefore different roots, while the
 * circuit, which parses to u64 seconds, produces one root for both. A
 * reference and a circuit that disagree on the encoding disagree on every
 * root, and the divergence is silent: both look internally consistent.
 */
export function canonicalAt(at: string): number {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) throw new Error(`notary: ${at} is not a parseable instant`);
  if (ms % 1000 !== 0) {
    throw new Error(
      `notary: ${at} carries sub-second precision the circuit's u64 seconds cannot represent. ` +
      'Round at the source rather than committing a root the circuit cannot reproduce.',
    );
  }
  return ms / 1000;
}

export function leafHash(r: Reading): string {
  return sha(`${LEAF_VERSION}|${canonicalAt(r.at)}|${r.channel}|${assertMilli(r.value)}|${r.deviceId}`);
}

/**
 * Canonical ordering, then a Merkle root. Odd nodes carry up unchanged.
 *
 * Ordering is by (epoch millis, channel) rather than by ISO string. The circuit
 * sorts on `u64` unix seconds; a lexical sort agrees with that only while every
 * timestamp shares one format and offset, so `2026-01-01T00:00:00Z` and
 * `2026-01-01T01:00:00+01:00` — the same instant — would sort differently in the
 * reference and the circuit and produce different roots.
 */
export function merkleRoot(readings: Reading[]): { root: string; leafCount: number } {
  if (readings.length === 0) return { root: sha(`${LEAF_VERSION}|empty`), leafCount: 0 };
  const sorted = [...readings].sort((a, b) => {
    const ta = Date.parse(a.at), tb = Date.parse(b.at);
    return ta === tb ? a.channel.localeCompare(b.channel) : ta - tb;
  });
  let level = sorted.map(leafHash);
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? sha(`${NODE_VERSION}|${level[i]}|${level[i + 1]}`) : level[i]);
    }
    level = next;
  }
  return { root: level[0], leafCount: sorted.length };
}

/** Grace for clock skew and upload latency. Beyond this, the commitment is retroactive. */
export const POST_GRACE_SECONDS = 15 * 60;

export function postedInTime(c: Commitment): boolean {
  return Date.parse(c.postedAt) - Date.parse(c.coversTo) <= POST_GRACE_SECONDS * 1000;
}

export function computeCoverage(
  readings: Reading[], from: string, to: string, maxGapSeconds: number,
): IntervalCoverage {
  const f = Date.parse(from), t = Date.parse(to);
  const span = Math.max(t - f, 1);
  const inWindow = readings.filter(r => {
    const x = Date.parse(r.at); return x >= f && x <= t;
  }).map(r => Date.parse(r.at));

  // Out-of-order arrival is a signal about the sensor or the upload path, not
  // noise to sort away silently. Detected before sorting, then reported.
  const outOfOrder = inWindow.some((x, i) => i > 0 && x < inWindow[i - 1]);
  const pts = [...inWindow].sort((a, b) => a - b);

  const gaps: Array<{ from: string; to: string }> = [];
  let covered = 0;
  let cursor = f;
  for (const p of pts) {
    const gap = p - cursor;
    if (gap > maxGapSeconds * 1000) {
      gaps.push({ from: new Date(cursor).toISOString(), to: new Date(p).toISOString() });
    } else {
      covered += gap;
    }
    cursor = p;
  }
  const tail = t - cursor;
  if (tail > maxGapSeconds * 1000) {
    gaps.push({ from: new Date(cursor).toISOString(), to: new Date(t).toISOString() });
  } else {
    covered += tail;
  }

  // NOT capped at 1. A ratio above 1 means the arithmetic saw more covered time
  // than the interval holds, which is a real defect signal; clamping it to a
  // reassuring 1.000 would hide exactly the case worth seeing.
  return { requestedFrom: from, requestedTo: to, covered: covered / span, gaps, outOfOrder };
}

export interface Excursion { from: string; to: string; extremum: number }

/**
 * Pure predicate evaluation. No I/O, no clock — so the circuit can mirror it.
 *
 * The bound test is SYMMETRIC: a reading is outside the envelope if it is above
 * `max` or below `min`, with the same strictness at both ends. An asymmetric
 * rule would make one end of a single envelope stricter than the other, in the
 * function whose whole purpose is deciding the disputed boundary case.
 */
export function evaluateCondition(
  readings: Reading[], p: ConditionPredicate, from: string, to: string,
): { breached: boolean; excursions: Excursion[] } {
  const f = Date.parse(from), t = Date.parse(to);
  const rs = readings
    .filter(r => r.channel === p.channel)
    .filter(r => { const x = Date.parse(r.at); return x >= f && x <= t; })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const out: Excursion[] = [];
  let open: { start: number; extremum: number } | null = null;

  const outside = (v: number) =>
    (p.bounds.max !== undefined && v > p.bounds.max) ||
    (p.bounds.min !== undefined && v < p.bounds.min);

  for (const r of rs) {
    const at = Date.parse(r.at);
    if (outside(r.value)) {
      if (!open) open = { start: at, extremum: r.value };
      else {
        const worseHigh = p.bounds.max !== undefined && r.value > open.extremum;
        const worseLow = p.bounds.min !== undefined && r.value < open.extremum;
        if (worseHigh || worseLow) open.extremum = r.value;
      }
    } else if (open) {
      if ((at - open.start) / 1000 > p.toleranceSeconds) {
        out.push({ from: new Date(open.start).toISOString(), to: r.at, extremum: open.extremum });
      }
      open = null;
    }
  }
  if (open && (t - open.start) / 1000 > p.toleranceSeconds) {
    out.push({ from: new Date(open.start).toISOString(), to, extremum: open.extremum });
  }
  return { breached: out.length > 0, excursions: out };
}

function renderCondition(
  status: string, p: ConditionPredicate, cov: IntervalCoverage,
  anchor: Anchor['kind'], dev: DeviceTrust, exc?: Excursion[],
): string {
  const pct = `${(cov.covered * 100).toFixed(1)}%`;
  const anchorNote = anchor === 'internal' ? 'anchored only in our own log' : `anchored: ${anchor}`;
  const devNote = dev.attestation === 'unattested' ? 'device unattested' : `device ${dev.attestation}`;
  if (status === 'held') {
    return `${p.statement} — held across ${pct} of the interval (${anchorNote}; ${devNote}). ` +
      'This proves the committed readings satisfy the predicate; it does not prove the sensor was truthful.';
  }
  if (status === 'breached') {
    const worst = exc && exc.length ? ` worst excursion ${exc[0].extremum}` : '';
    return `${p.statement} — BREACHED, ${exc?.length ?? 0} excursion(s)${worst}, over ${pct} coverage (${anchorNote}; ${devNote}).`;
  }
  return `${p.statement} — CANNOT BE EVALUATED over the requested interval (${pct} covered).`;
}

export interface NotarizeInput {
  readings: Reading[];
  commitment: Commitment | null;
  predicate: ConditionPredicate;
  from: string;
  to: string;
  device: DeviceTrust;
  /** Injected so the engine holds no clock — a verdict must be reproducible. */
  now: string;
  prove?: (args: {
    root: string; predicateId: string; from: string; to: string;
    verdictBit: 'held' | 'breached';
  }) => ProofRef;
}

export function notarizeCondition(inp: NotarizeInput): NotaryVerdict {
  const { readings, commitment, predicate: p, from, to, device } = inp;
  const coverage = computeCoverage(readings, from, to, p.maxGapSeconds);

  if (!commitment) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: null,
      reason: 'no_commitment_for_interval',
      remedy: 'Post a commitment covering this interval at the time readings are taken. A commitment created now cannot evidence the past.',
      coverage, renderedClaim: renderCondition('unproven', p, coverage, 'internal', device),
    };
  }

  if (!postedInTime(commitment)) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: 'commitment_posted_after_the_fact',
      remedy: `Commitment posted ${commitment.postedAt} for an interval ending ${commitment.coversTo}. Only commitments posted within ${POST_GRACE_SECONDS / 60} minutes of the covered interval can yield a held verdict.`,
      coverage, renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  // ── THE READINGS MUST RECONSTRUCT THE COMMITMENT ──────────────────────────
  //
  // Without this the whole layer is defeated by omission. A caller can hand in a
  // CURATED SUBSET of readings together with a commitment built from the full
  // set, and every later step — coverage, evaluation, proof — runs happily over
  // the subset while the root travels along as decoration. The verdict comes
  // back `held`, and the reading that would have breached it was simply not
  // passed in.
  //
  // The circuit spec makes this obligation #2 ("the count of verified leaves
  // equals the committed leafCount, so a prover cannot omit the inconvenient
  // readings"). The reference implementation is the spec, so it enforces the
  // same thing: recompute the root and compare, and compare the leaf count so a
  // mismatch names which way it went.
  const recomputed = merkleRoot(readings);
  if (recomputed.root !== commitment.root || recomputed.leafCount !== commitment.leafCount) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: 'readings_do_not_match_commitment',
      remedy:
        `The readings supplied reconstruct root ${recomputed.root.slice(0, 12)}… over ` +
        `${recomputed.leafCount} leaves; the commitment states ${commitment.root.slice(0, 12)}… ` +
        `over ${commitment.leafCount}. ` +
        (recomputed.leafCount < commitment.leafCount
          ? 'Fewer readings were supplied than were committed — the set is incomplete, and a verdict over a subset is not a verdict over what was committed.'
          : 'Supply exactly the committed set. A verdict may only be computed over the readings the commitment covers.'),
      coverage, renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  if (coverage.gaps.length > 0) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: 'telemetry_gap_exceeds_max',
      remedy: `${coverage.gaps.length} gap(s) exceed the ${p.maxGapSeconds}s maximum. Narrow the requested interval to a covered window, or accept a verdict scoped to the covered sub-intervals.`,
      coverage, renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  const { breached, excursions } = evaluateCondition(readings, p, from, to);
  const verdictBit = breached ? 'breached' : 'held';
  const proof = inp.prove
    ? inp.prove({ root: commitment.root, predicateId: p.predicateId, from, to, verdictBit })
    : ({
        system: 'none', vkey: '', proofId: '',
        publicInputs: { root: commitment.root, predicateId: p.predicateId, coversFrom: from, coversTo: to, verdictBit },
        provedAt: inp.now, provingMs: 0,
      } as ProofRef);

  if (proof.system === 'none') {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: 'proof_generation_failed',
      remedy: 'No prover configured. The predicate evaluated locally, but an unproven evaluation is our claim, not verifiable evidence.',
      coverage, renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  const anchorStrength = commitment.anchor.kind;
  return breached
    ? {
        status: 'breached', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof, anchorStrength, excursions, coverage, deviceTrust: device,
        renderedClaim: renderCondition('breached', p, coverage, anchorStrength, device, excursions),
      }
    : {
        status: 'held', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof, anchorStrength, coverage, deviceTrust: device,
        renderedClaim: renderCondition('held', p, coverage, anchorStrength, device),
      };
}

/**
 * Custody across parties who share no database.
 *
 * WHAT THIS CANNOT ESTABLISH, stated because the claim is easy to overread: a
 * chain that links is not proof of unbroken custody. This checks that the
 * handoffs RECORDED form an unbroken sequence. It cannot show a handoff that was
 * never recorded — absence of a gap in the record is not absence of a gap in
 * custody. The mitigation is that both parties sign each handoff, so a missing
 * link is a party who did not sign rather than a silence.
 */
export function notarizeCustody(
  handoffs: Handoff[], p: CustodyPredicate, from: string, to: string,
  commitment: Commitment | null, now: string,
): NotaryVerdict {
  // Custody coverage is not an interval-density question, so it is NOT reported
  // as a fraction that would read as "100% covered" off one handoff.
  const coverage: IntervalCoverage = {
    requestedFrom: from, requestedTo: to, covered: 0, gaps: [],
  };

  if (!commitment) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: null,
      reason: 'no_commitment_for_interval',
      remedy: 'Commit each handoff at the moment it occurs.',
      coverage, renderedClaim: `${p.statement} — no commitment for this interval.`,
    };
  }

  const sorted = [...handoffs].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (p.requireBothSignatures) {
    const unsigned = sorted.find(h => !h.fromSignature || !h.toSignature);
    if (unsigned) {
      return {
        status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        reason: 'missing_handoff_signature',
        remedy: `Handoff at ${unsigned.at} between ${unsigned.fromParty} and ${unsigned.toParty} lacks a signature from ${!unsigned.fromSignature ? unsigned.fromParty : unsigned.toParty}. Custody cannot be evidenced across an unsigned transfer.`,
        coverage, renderedClaim: `${p.statement} — unsigned handoff at ${unsigned.at}.`,
      };
    }
  }

  const breaks: Array<{ from: string; to: string; extremum: number }> = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapS = (Date.parse(sorted[i].at) - Date.parse(sorted[i - 1].at)) / 1000;
    if (sorted[i - 1].toParty !== sorted[i].fromParty || gapS > p.maxHandoffGapSeconds) {
      breaks.push({ from: sorted[i - 1].at, to: sorted[i].at, extremum: gapS });
    }
  }

  const stub = (bit: 'held' | 'breached'): ProofRef => ({
    system: 'none', vkey: '', proofId: '',
    publicInputs: { root: commitment.root, predicateId: p.predicateId, coversFrom: from, coversTo: to, verdictBit: bit },
    provedAt: now, provingMs: 0,
  });
  const device: DeviceTrust = {
    deviceId: 'n/a', attestation: 'carrier_asserted', lastCalibratedAt: null,
    note: 'custody is signature-based, not sensor-based',
  };

  return breaks.length === 0
    ? {
        status: 'held', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof: stub('held'), anchorStrength: commitment.anchor.kind, coverage, deviceTrust: device,
        renderedClaim:
          `${p.statement} — held across ${sorted.length} RECORDED handoff(s). This does not ` +
          'establish that every handoff was recorded.',
      }
    : {
        status: 'breached', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof: stub('breached'), anchorStrength: commitment.anchor.kind,
        excursions: breaks, coverage, deviceTrust: device,
        renderedClaim: `${p.statement} — BROKEN at ${breaks.length} point(s).`,
      };
}

export { ANCHOR_STRENGTH };
