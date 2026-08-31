//
// The notary engine. Deterministic, prover-agnostic, and honest about what it cannot
// evaluate. The SP1 program (notary.program.md) computes exactly the predicate
// evaluated here — this implementation is the reference the circuit must match, and
// the equivalence is asserted by test.

import { createHash } from 'crypto';
import type {
  Commitment, ConditionPredicate, CustodyPredicate, NotaryVerdict,
  IntervalCoverage, DeviceTrust, ProofRef, Anchor, ConditionChannel,
  Milli, PostingWindow, VerdictContext, Excursion,
} from './notary.types';
import { ANCHOR_STRENGTH, DEFAULT_POSTING_WINDOW, assertMilli, toMilli, renderExcursion } from './notary.types';

export interface Reading {
  at: string;
  channel: ConditionChannel;
  /** INTEGER thousandths. Convert once at ingest with `toMilli`. */
  valueMilli: Milli;
  deviceId: string;
}

/** Build a Reading from a human-scale value, refusing what the circuit cannot encode. */
export function reading(
  at: string, channel: ConditionChannel, value: number, deviceId: string,
): Reading {
  return { at, channel, valueMilli: toMilli(value), deviceId };
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
  assertMilli(r.valueMilli, `leafHash(${r.channel}@${r.at})`);
  return sha(`${LEAF_VERSION}|${canonicalAt(r.at)}|${r.channel}|${r.valueMilli}|${r.deviceId}`);
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

/** Retained for the existing call sites; the window below is the real policy. */
export const POST_GRACE_SECONDS = DEFAULT_POSTING_WINDOW.lateGraceSeconds;

export type PostingCheck =
  | { ok: true; offsetSeconds: number }
  | { ok: false; offsetSeconds: number; side: 'late' | 'early' };

/**
 * SUBJECT KINDS THAT MAY LEGITIMATELY COMMIT BEFORE THEIR INTERVAL.
 *
 * A `decision_expectation` is a PRE-REGISTRATION: the whole point is to state
 * what you expect before you observe it, so an early commitment is the honest
 * pattern rather than the suspicious one. Every other subject commits to a root
 * over data that must already exist.
 *
 * Enumerated rather than special-cased inline, so adding a subject kind forces
 * the question "can this one be posted early?" instead of inheriting an answer.
 */
const MAY_PRECEDE_INTERVAL: ReadonlySet<Commitment['subject']['kind']> =
  new Set(['decision_expectation']);

/**
 * The posting window is SYMMETRIC and fails closed in both directions.
 *
 * LATE is a story told afterwards. EARLY is worse, and the one-sided v1 check
 * let it through: measured, a commitment posted 2025-08-30 for readings covering
 * 2026-08-30 returned true and the pipeline returned `held`.
 *
 * BOTH EDGES ARE MEASURED FROM `coversTo`, and that is a correction to an
 * earlier revision here which anchored the early edge to `coversFrom`, reasoning
 * that posting at the start of an interval is a legitimate pre-commitment. For a
 * `load_condition` root that is exactly backwards:
 *
 *     root = merkleRoot(readings over [coversFrom, coversTo])
 *
 * Every reading in the interval must EXIST for the root to be computable, so the
 * earliest honest `postedAt` is `coversTo` plus upload skew. A commitment posted
 * at `coversFrom` claims a root over readings the period had not yet produced —
 * which is the fabrication case, not the honest one. The permissive anchor would
 * have admitted a whole interval's worth of it.
 *
 * The genuine pre-registration case is a different SUBJECT, handled above.
 */
export function checkPosting(
  c: Commitment, w: PostingWindow = DEFAULT_POSTING_WINDOW,
): PostingCheck {
  const offsetSeconds = (Date.parse(c.postedAt) - Date.parse(c.coversTo)) / 1000;
  if (offsetSeconds > w.lateGraceSeconds) return { ok: false, offsetSeconds, side: 'late' };
  if (MAY_PRECEDE_INTERVAL.has(c.subject.kind)) return { ok: true, offsetSeconds };
  if (offsetSeconds < -w.earlyGraceSeconds) return { ok: false, offsetSeconds, side: 'early' };
  return { ok: true, offsetSeconds };
}

export function postedInTime(
  c: Commitment, window: PostingWindow = DEFAULT_POSTING_WINDOW,
): boolean {
  return checkPosting(c, window).ok;
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
  let open: { start: number; extremumMilli: Milli } | null = null;

  const { minMilli, maxMilli } = p.bounds;
  if (minMilli !== undefined) assertMilli(minMilli, `${p.predicateId}.bounds.minMilli`);
  if (maxMilli !== undefined) assertMilli(maxMilli, `${p.predicateId}.bounds.maxMilli`);

  // `boundaryIsBreach` is a CONTRACT TERM carried in the predicate's identity.
  // Written as one comparison per end, in the same direction, so the two ends
  // cannot drift apart — the asymmetry this function exists to prevent.
  const overMax = (v: Milli) =>
    maxMilli !== undefined && (p.boundaryIsBreach ? v >= maxMilli : v > maxMilli);
  const underMin = (v: Milli) =>
    minMilli !== undefined && (p.boundaryIsBreach ? v <= minMilli : v < minMilli);
  const outside = (v: Milli) => overMax(v) || underMin(v);

  for (const r of rs) {
    const at = Date.parse(r.at);
    assertMilli(r.valueMilli, `evaluateCondition(${r.channel}@${r.at})`);
    if (outside(r.valueMilli)) {
      if (!open) open = { start: at, extremumMilli: r.valueMilli };
      else {
        // The extremum is the worst reading IN THE DIRECTION IT BREACHED.
        const worseHigh = overMax(r.valueMilli) && r.valueMilli > open.extremumMilli;
        const worseLow = underMin(r.valueMilli) && r.valueMilli < open.extremumMilli;
        if (worseHigh || worseLow) open.extremumMilli = r.valueMilli;
      }
    } else if (open) {
      if ((at - open.start) / 1000 > p.toleranceSeconds) {
        out.push({ from: new Date(open.start).toISOString(), to: r.at, extremumMilli: open.extremumMilli, unit: 'channel_base' });
      }
      open = null;
    }
  }
  if (open && (t - open.start) / 1000 > p.toleranceSeconds) {
    out.push({ from: new Date(open.start).toISOString(), to, extremumMilli: open.extremumMilli, unit: 'channel_base' });
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
    const worst = exc && exc.length ? ` worst excursion ${renderExcursion(exc[0], p.channel)}` : '';
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
  /** Policy, not a constant. Recorded on the verdict. */
  postingWindow?: PostingWindow;
  prove?: (args: {
    root: string; predicateId: string; from: string; to: string;
    verdictBit: 'held' | 'breached';
  }) => ProofRef;
}

export function notarizeCondition(inp: NotarizeInput): NotaryVerdict {
  const { readings, commitment, predicate: p, from, to, device } = inp;
  const window = inp.postingWindow ?? DEFAULT_POSTING_WINDOW;
  const coverage = computeCoverage(readings, from, to, p.maxGapSeconds);
  // The applied window travels ON the verdict. A counterparty reading a refusal
  // can see which threshold produced it instead of trusting a hidden default.
  const ctx = (offsetSeconds: number): VerdictContext => ({
    postingWindow: window, postingOffsetSeconds: offsetSeconds, coverage,
  });

  if (!commitment) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: null,
      reason: 'no_commitment_for_interval',
      remedy: 'Post a commitment covering this interval at the time readings are taken. A commitment created now cannot evidence the past.',
      context: ctx(NaN), renderedClaim: renderCondition('unproven', p, coverage, 'internal', device),
    };
  }

  const posting = checkPosting(commitment, window);
  if (!posting.ok) {
    const late = posting.side === 'late';
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: late ? 'commitment_posted_after_the_fact' : 'commitment_predates_its_interval',
      remedy: late
        ? `Commitment posted ${commitment.postedAt} for an interval ending ${commitment.coversTo} — ${Math.round(posting.offsetSeconds / 60)} min late, beyond the ${window.lateGraceSeconds / 60} min window. Only commitments posted within the window can yield a held verdict.`
        : `Commitment posted ${commitment.postedAt} claims a root over an interval ending ${commitment.coversTo} — ${Math.round(-posting.offsetSeconds / 60)} min BEFORE the data it commits to existed, beyond the ${window.earlyGraceSeconds / 60} min allowance. The root is computable only once every reading in the interval exists, so a commitment cannot precede its own readings.`,
      context: ctx(posting.offsetSeconds), renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
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
      context: ctx(posting.offsetSeconds), renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  if (coverage.gaps.length > 0) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
      reason: 'telemetry_gap_exceeds_max',
      remedy: `${coverage.gaps.length} gap(s) exceed the ${p.maxGapSeconds}s maximum. Narrow the requested interval to a covered window, or accept a verdict scoped to the covered sub-intervals.`,
      context: ctx(posting.offsetSeconds), renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
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
      context: ctx(posting.offsetSeconds), renderedClaim: renderCondition('unproven', p, coverage, commitment.anchor.kind, device),
    };
  }

  const anchorStrength = commitment.anchor.kind;
  return breached
    ? {
        status: 'breached', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof, anchorStrength, excursions, context: ctx(posting.offsetSeconds), deviceTrust: device,
        renderedClaim: renderCondition('breached', p, coverage, anchorStrength, device, excursions),
      }
    : {
        status: 'held', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof, anchorStrength, context: ctx(posting.offsetSeconds), deviceTrust: device,
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
  window: PostingWindow = DEFAULT_POSTING_WINDOW,
): NotaryVerdict {
  // Custody coverage is not an interval-density question, so it is NOT reported
  // as a fraction that would read as "100% covered" off one handoff.
  const coverage: IntervalCoverage = {
    requestedFrom: from, requestedTo: to, covered: 0, gaps: [],
  };
  const ctx = (c: Commitment | null): VerdictContext => ({
    postingWindow: window,
    postingOffsetSeconds: c ? checkPosting(c, window).offsetSeconds : NaN,
    coverage,
  });

  if (!commitment) {
    return {
      status: 'unproven', predicateId: p.predicateId, commitmentId: null,
      reason: 'no_commitment_for_interval',
      remedy: 'Commit each handoff at the moment it occurs.',
      context: ctx(null), renderedClaim: `${p.statement} — no commitment for this interval.`,
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
        context: ctx(commitment), renderedClaim: `${p.statement} — unsigned handoff at ${unsigned.at}.`,
      };
    }
  }

  // A custody break's magnitude is a GAP IN SECONDS, not a channel reading. The
  // slot is shared with condition excursions, so the UNIT travels with the
  // number rather than being inferred from which function produced it.
  const breaks: Excursion[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapS = (Date.parse(sorted[i].at) - Date.parse(sorted[i - 1].at)) / 1000;
    if (sorted[i - 1].toParty !== sorted[i].fromParty || gapS > p.maxHandoffGapSeconds) {
      breaks.push({
        from: sorted[i - 1].at, to: sorted[i].at,
        extremumMilli: Math.round(gapS * 1000), unit: 'seconds',
      });
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
        proof: stub('held'), anchorStrength: commitment.anchor.kind, context: ctx(commitment), deviceTrust: device,
        renderedClaim:
          `${p.statement} — held across ${sorted.length} RECORDED handoff(s). This does not ` +
          'establish that every handoff was recorded.',
      }
    : {
        status: 'breached', predicateId: p.predicateId, commitmentId: commitment.commitmentId,
        proof: stub('breached'), anchorStrength: commitment.anchor.kind,
        excursions: breaks, context: ctx(commitment), deviceTrust: device,
        renderedClaim: `${p.statement} — BROKEN at ${breaks.length} point(s).`,
      };
}

export { ANCHOR_STRENGTH };
