// src/lib/economy/claimable.ts
//
// ONE-DIRECTIONAL LATENCY BOUNDING
//
// Contractual compression is bounded by the slowest counterparty: your rate con
// renders in a second, their dispatcher answers in an hour. A round-trip handoff
// means your state machine waits on their queue.
//
// The inversion: complete YOUR side fully, emit a self-contained verifiable
// artifact, and advance to `offered` immediately. Only `accepted` waits on them.
// Their latency stops blocking your state and starts being MEASURED.
//
// WHAT THIS COMPRESSES AND WHAT IT DOES NOT — stated so it is not oversold:
//
//   ✓ document steps      rate cons, PODs, claim packets, entry packets, invoices
//   ✓ information steps   anything computable from what you already hold
//   ✗ decision steps      an offer is not a contract until accepted; you cannot
//                         pre-accept on their behalf
//   ✗ dependent steps     no customs entry without the shipper's invoice values
//   ✗ physical steps      the truck still has to move
//
// The constraint that makes it work for a counterparty who adopted nothing: the
// artifact must be COMPLETE AND VERIFIABLE STANDALONE. No callback, no login, no
// "contact us for details". A claimable requiring a round trip to interpret has
// reintroduced the round trip it exists to remove.

import { createHash } from 'crypto';
import type { ISODateTime, Hash } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The artifact
// ─────────────────────────────────────────────────────────────────────────────

export type ClaimableKind =
  | 'carrier_tender'
  | 'rate_confirmation'
  | 'proof_of_delivery'
  | 'claim_packet'
  | 'customs_packet'
  | 'invoice'
  | 'settlement_statement';

export interface Claimable<T> {
  claimableId: string;
  kind: ClaimableKind;
  /** Who may claim it. A claimable nobody is named on is a publication, not an offer. */
  offeredTo: { partyId: string; partyName: string };
  offeredBy: string;
  payload: T;
  /** Verified structurally at construction — see `checkSelfContained`. */
  selfContained: boolean;
  /**
   * COMPUTED FROM THE PAYLOAD, never accepted from the caller.
   *
   * The supplied design took `contentHash` and `issuerSignature` as inputs and
   * stored them unchecked, while the artifact's whole claim is "verifiable
   * without trusting us". A hash nobody derives is a decoration: a caller could
   * pass any string, the field would read as integrity, and the first party to
   * check it would be the counterparty in a dispute. `verifyClaimable` re-derives
   * it, and `emitClaimable` refuses a payload it cannot hash.
   */
  contentHash: Hash;
  issuerSignature: string;
  proofRef?: string;
  offeredAt: ISODateTime;
  expiresAt: ISODateTime;
  claimedAt: ISODateTime | null;
  claimOutcome: 'accepted' | 'declined' | 'expired' | null;
  claimedBy: string | null;
  /** What happens if it expires unclaimed. Never silence. */
  onExpiry: ExpiryAction;
}

export type ExpiryAction =
  | { kind: 're_offer'; toPartyId: string; reason: string }
  | { kind: 'escalate_to_operator'; reason: string }
  | { kind: 'lapse'; consequence: string };

export type OurSide = 'offered' | 'closed_accepted' | 'closed_declined' | 'closed_expired';

// ─────────────────────────────────────────────────────────────────────────────
// 2. Their latency becomes a measured property, not our blocked state
// ─────────────────────────────────────────────────────────────────────────────

export interface ClaimLatency {
  claimableId: string;
  kind: ClaimableKind;
  counterparty: string;
  /** offeredAt → claimedAt. THE number that says who is actually slow. */
  latencySeconds: number | null;
  outcome: 'accepted' | 'declined' | 'expired' | 'open';
}

/**
 * A carrier averaging 90 minutes to accept is a fact you can price, route around,
 * or raise with them. A carrier who blocks your state machine is friction you
 * absorb and cannot name.
 */
export function claimLatency<T>(c: Claimable<T>, now: string): ClaimLatency {
  const outcome: ClaimLatency['outcome'] =
    c.claimOutcome === 'accepted' ? 'accepted'
    : c.claimOutcome === 'declined' ? 'declined'
    : Date.parse(now) > Date.parse(c.expiresAt) ? 'expired'
    : 'open';
  return {
    claimableId: c.claimableId, kind: c.kind, counterparty: c.offeredTo.partyId,
    latencySeconds: c.claimedAt ? (Date.parse(c.claimedAt) - Date.parse(c.offeredAt)) / 1000 : null,
    outcome,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Self-containment, enforced structurally
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfContainmentCheck {
  ok: boolean;
  violations: Array<{ path: string; problem: string; remedy: string }>;
  /** How many values were actually examined. A check over nothing is not a pass. */
  examined: number;
}

const CALLBACK_PHRASES = [
  /\bsee attached\b/i, /\blog ?in\b/i, /\bcontact us\b/i, /\bportal\b/i,
  /\bavailable on request\b/i, /\brefer to\b/i, /\bTBD\b/, /\bTBC\b/,
];

/**
 * SELF-IDENTITY IS NOT AN UNRESOLVED REFERENCE.
 *
 * The supplied design found this by running it: the reference check flagged
 * `loadId` on every payload, because it looked for a sibling `load` and found
 * none, and so REFUSED EVERY VALID ARTIFACT. A check that refuses everything is
 * as useless as one that refuses nothing.
 *
 * The fix there was a hardcoded allowlist of id fields, which closes the case
 * and leaves the door: the tenth artifact kind arrives with `bolId` or
 * `entryId`, the allowlist does not name it, and the check silently refuses that
 * kind alone. The list is kept — it is the right mechanism — but the check now
 * takes the artifact's OWN identity fields as an argument, so a caller declares
 * what is self-identity for the thing being emitted rather than inheriting a
 * guess made when the sixth kind was written.
 */
export const COMMON_SELF_ID_FIELDS: readonly string[] = [
  'loadId', 'claimableId', 'tenderId', 'invoiceId', 'shipmentId',
  'bolId', 'entryId', 'claimId', 'orderId', 'commitmentId',
];

export function checkSelfContained(
  payload: unknown,
  selfIdFields: readonly string[] = COMMON_SELF_ID_FIELDS,
  path = '$',
): SelfContainmentCheck {
  const violations: SelfContainmentCheck['violations'] = [];
  const selfIds = new Set(selfIdFields);
  let examined = 0;

  const walk = (v: unknown, p: string) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      examined++;
      for (const re of CALLBACK_PHRASES) {
        if (re.test(v)) {
          violations.push({
            path: p, problem: `contains a callback phrase (${re.source})`,
            remedy: 'Inline the referenced content. A counterparty who has adopted nothing cannot follow a reference.',
          });
        }
      }
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, `${p}[${i}]`)); return; }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        examined++;
        const base = k.replace(/(Ref|Id)$/, '');
        if (/(Ref|Id)$/.test(k) && !selfIds.has(k) && typeof x === 'string'
            && !(base in (v as object))) {
          violations.push({
            path: `${p}.${k}`, problem: 'bare reference with no inlined value',
            remedy: `Inline the resolved value alongside ${k} (as \`${base}\`), or the recipient must query us to interpret it.`,
          });
        }
        walk(x, `${p}.${k}`);
      }
    }
  };

  walk(payload, path);
  return { ok: violations.length === 0, violations, examined };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Emission — refuses a non-self-contained or unhashable payload
// ─────────────────────────────────────────────────────────────────────────────

export const CLAIMABLE_HASH_DOMAIN = 'payload.claimable.v1';

/** Deterministic: keys sorted, so two equal payloads hash equal. */
export function claimableHash(payload: unknown): Hash {
  const canon = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(canon);
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canon(x)]));
  };
  return createHash('sha256')
    .update(`${CLAIMABLE_HASH_DOMAIN}|${JSON.stringify(canon(payload))}`)
    .digest('hex');
}

export type EmitResult<T> =
  | { status: 'offered'; claimable: Claimable<T>; ourSide: OurSide }
  | { status: 'refused'; reason: 'not_self_contained'; violations: SelfContainmentCheck['violations'] }
  | { status: 'refused'; reason: 'empty_payload'; violations: [] };

export function emitClaimable<T>(args: {
  claimableId: string; kind: ClaimableKind;
  offeredTo: { partyId: string; partyName: string }; offeredBy: string;
  payload: T;
  /** How the issuer signs. Injected so this module holds no key material. */
  sign: (contentHash: Hash) => string;
  proofRef?: string;
  offeredAt: string; validForSeconds: number; onExpiry: ExpiryAction;
  selfIdFields?: readonly string[];
}): EmitResult<T> {
  const check = checkSelfContained(args.payload, args.selfIdFields);
  // A check that examined nothing did not pass — it did not run. An empty
  // payload is self-contained in exactly the way an empty promise is kept.
  if (check.examined === 0) {
    return { status: 'refused', reason: 'empty_payload', violations: [] };
  }
  if (!check.ok) {
    return { status: 'refused', reason: 'not_self_contained', violations: check.violations };
  }
  const contentHash = claimableHash(args.payload);
  return {
    status: 'offered',
    ourSide: 'offered',
    claimable: {
      claimableId: args.claimableId, kind: args.kind,
      offeredTo: args.offeredTo, offeredBy: args.offeredBy,
      payload: args.payload, selfContained: true,
      contentHash, issuerSignature: args.sign(contentHash), proofRef: args.proofRef,
      offeredAt: args.offeredAt,
      expiresAt: new Date(Date.parse(args.offeredAt) + args.validForSeconds * 1000).toISOString(),
      claimedAt: null, claimOutcome: null, claimedBy: null,
      onExpiry: args.onExpiry,
    },
  };
}

/**
 * What a counterparty runs. The artifact claims to be verifiable without
 * trusting us; this is the thing that makes that true rather than asserted.
 */
export function verifyClaimable<T>(c: Claimable<T>): {
  ok: boolean; reason: 'ok' | 'hash_mismatch' | 'not_self_contained'; expected: Hash; actual: Hash;
} {
  const actual = claimableHash(c.payload);
  if (actual !== c.contentHash) {
    return { ok: false, reason: 'hash_mismatch', expected: c.contentHash, actual };
  }
  const check = checkSelfContained(c.payload);
  if (!check.ok) return { ok: false, reason: 'not_self_contained', expected: c.contentHash, actual };
  return { ok: true, reason: 'ok', expected: c.contentHash, actual };
}

/**
 * Expiry is an EVENT, not a silence. An offer that lapses must do something —
 * re-offer, escalate, or lapse with a stated consequence. A claimable that
 * expires into nothing has reintroduced the blocking wait as a stall.
 */
export function resolveExpiry<T>(c: Claimable<T>, now: string): {
  expired: boolean; action: ExpiryAction | null;
} {
  if (c.claimOutcome !== null) return { expired: false, action: null };
  const expired = Date.parse(now) > Date.parse(c.expiresAt);
  return { expired, action: expired ? c.onExpiry : null };
}
