// src/lib/economy/authorization.ts
//
// THE AUTHORIZATION GATE — deterministic, blocking, always, and cheap.
//
// This exists because the architecture had one VERIFICATION box sitting on the
// critical path between decision and execution, and two different things were
// collapsed into it:
//
//   AUTHORIZATION  deterministic, microseconds, ON the critical path. Does this
//                  proposal satisfy the constraints; is the carrier cleared; is
//                  the authority present. Nothing executes without it.
//   NOTARIZATION   cryptographic, seconds to minutes, threshold-gated, and it
//                  produces evidence ABOUT an execution rather than gating one.
//                  OFF the critical path. That is `notary.ts`.
//
// Collapsed, a prover sits between a dispatcher and a booking: proving costs
// seconds, dispatch costs a phone call, and every action waits on cryptography
// it does not need. Separated, the blocking check is a table lookup and the
// expensive one runs behind the execution it describes.
//
// ─────────────────────────────────────────────────────────────────────────────
// RECOMMENDATION != AUTHORIZATION != EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
//
// The invariant that keeps an agent from binding the firm, made explicit here
// rather than left implicit in a diagram:
//
//   an agent may RECOMMEND freely;
//   AUTHORIZATION is a decision by this gate against recorded policy;
//   EXECUTION requires an authorization that named this exact proposal.
//
// `authorize()` returns a decision. It does not perform one. A caller that
// executes without checking has bypassed the gate, and `assertExecutable()`
// exists so that bypass is a thrown error rather than a missing branch.
//
// ─────────────────────────────────────────────────────────────────────────────
// THREE-VALUED, BECAUSE "NO RECORD" IS NOT "NO PROBLEM"
// ─────────────────────────────────────────────────────────────────────────────
//
// A carrier with no insurance record on file is NOT cleared and is NOT refused.
// Treating absence as clearance is how an uninsured load moves; treating it as
// refusal is how a working carrier is dropped over a data gap. It is
// `undetermined`, it names what would settle it, and it blocks execution just
// as a refusal does — the difference is the remedy, not the outcome.

import type { ISODateTime } from './types';
import type { Attestation } from './attestation';
import { isAdmissible } from './attestation';

export type AuthorizationDecision = 'authorized' | 'refused' | 'undetermined';

export type CheckId =
  | 'insurance_valid_at_pickup'
  | 'operating_authority_active'
  | 'bol_matches_tendered_carrier'
  | 'value_within_cargo_cover'
  | 'authority_to_bind_present';

export interface CheckResult {
  check: CheckId;
  outcome: AuthorizationDecision;
  /** What was compared, in the units it was compared in. */
  detail: string;
  /** For `undetermined` only: what record would settle it. */
  remedy?: string;
}

export interface AuthorizationRequest {
  loadId: string;
  tenderedCarrierId: string;
  /** The carrier named on the bill of lading, when one exists yet. */
  bolCarrierId: string | null;
  pickupAt: ISODateTime;
  bookedAt: ISODateTime;
  declaredValue: { amount: number; currency: string } | null;
  carrier: {
    carrierId: string;
    /** null = no record on file. Absence is `undetermined`, never clearance. */
    insuranceExpiresAt: ISODateTime | null;
    cargoCoverAmount: { amount: number; currency: string } | null;
    authorityGrantedAt: ISODateTime | null;
    authorityRevokedAt: ISODateTime | null;
  };
  /**
   * The scope the acting principal actually holds. An agent with no binding
   * authority may produce a recommendation and nothing else.
   */
  actingAuthority: { principal: string; mayBind: boolean; note?: string };
}

export interface Authorization {
  loadId: string;
  decision: AuthorizationDecision;
  checks: CheckResult[];
  /** The checks that produced the decision. Empty when authorized. */
  blockedBy: CheckResult[];
  /** Injected. This gate holds no clock. */
  decidedAt: ISODateTime;
  /**
   * A one-line statement an operator can act on without reading the array.
   * Refusals say what failed; undetermined says what is missing.
   */
  statement: string;
}

const cmp = (a: string, b: string) => Date.parse(a) - Date.parse(b);

/**
 * The whole gate. No I/O, no clock, no crypto — a pure function of the request,
 * so it is reproducible, testable, and fast enough to sit in front of every
 * execution without anyone noticing it is there.
 */
export function authorize(req: AuthorizationRequest, decidedAt: ISODateTime): Authorization {
  const checks: CheckResult[] = [];
  const c = req.carrier;

  // 1. Insurance valid AT PICKUP, not at decision time. A policy that expires
  //    between booking and pickup covers the booking and not the load.
  if (c.insuranceExpiresAt === null) {
    checks.push({
      check: 'insurance_valid_at_pickup', outcome: 'undetermined',
      detail: `no cargo insurance record on file for ${c.carrierId}`,
      remedy: 'a certificate of insurance with an expiry date, from the insurer or the broker',
    });
  } else if (cmp(c.insuranceExpiresAt, req.pickupAt) <= 0) {
    checks.push({
      check: 'insurance_valid_at_pickup', outcome: 'refused',
      detail: `cover expires ${c.insuranceExpiresAt}, pickup is ${req.pickupAt}`,
    });
  } else {
    checks.push({
      check: 'insurance_valid_at_pickup', outcome: 'authorized',
      detail: `cover to ${c.insuranceExpiresAt}, pickup ${req.pickupAt}`,
    });
  }

  // 2. Operating authority active over the whole booking-to-pickup span.
  if (c.authorityGrantedAt === null) {
    checks.push({
      check: 'operating_authority_active', outcome: 'undetermined',
      detail: `no operating authority record for ${c.carrierId}`,
      remedy: 'the carrier DOT/MC authority grant date from the regulator of record',
    });
  } else if (cmp(c.authorityGrantedAt, req.bookedAt) > 0) {
    checks.push({
      check: 'operating_authority_active', outcome: 'refused',
      detail: `authority granted ${c.authorityGrantedAt}, after this load was booked ${req.bookedAt}`,
    });
  } else if (c.authorityRevokedAt !== null && cmp(c.authorityRevokedAt, req.pickupAt) <= 0) {
    checks.push({
      check: 'operating_authority_active', outcome: 'refused',
      detail: `authority revoked ${c.authorityRevokedAt}, before pickup ${req.pickupAt}`,
    });
  } else {
    checks.push({
      check: 'operating_authority_active', outcome: 'authorized',
      detail: `authority since ${c.authorityGrantedAt}, not revoked`,
    });
  }

  // 3. The bill of lading names the carrier we tendered to. A mismatch is
  //    double-brokering: the load is moving under someone we did not vet, whose
  //    insurance we have not seen, and whose liability we cannot reach.
  if (req.bolCarrierId === null) {
    checks.push({
      check: 'bol_matches_tendered_carrier', outcome: 'undetermined',
      detail: 'no bill of lading yet',
      remedy: 'the signed BOL, once issued at pickup',
    });
  } else if (req.bolCarrierId !== req.tenderedCarrierId) {
    checks.push({
      check: 'bol_matches_tendered_carrier', outcome: 'refused',
      detail: `tendered to ${req.tenderedCarrierId}, BOL names ${req.bolCarrierId}`,
    });
  } else {
    checks.push({
      check: 'bol_matches_tendered_carrier', outcome: 'authorized',
      detail: `BOL names ${req.bolCarrierId}, as tendered`,
    });
  }

  // 4. Declared value within cargo cover. COMMENSURABILITY: two amounts in
  //    different currencies are not comparable, and converting silently here
  //    would produce a defensible-looking clearance over a real exposure.
  const dv = req.declaredValue, cover = c.cargoCoverAmount;
  if (dv === null) {
    checks.push({
      check: 'value_within_cargo_cover', outcome: 'authorized',
      detail: 'no declared value, so no cover threshold applies',
    });
  } else if (cover === null) {
    checks.push({
      check: 'value_within_cargo_cover', outcome: 'undetermined',
      detail: `declared ${dv.amount} ${dv.currency}, cargo cover limit unknown`,
      remedy: 'the cargo cover limit and currency from the certificate of insurance',
    });
  } else if (cover.currency !== dv.currency) {
    checks.push({
      check: 'value_within_cargo_cover', outcome: 'undetermined',
      detail: `declared ${dv.amount} ${dv.currency}, cover ${cover.amount} ${cover.currency}`,
      remedy:
        `a rate for ${dv.currency}/${cover.currency} on ${req.pickupAt.slice(0, 10)}, or a cover ` +
        'limit restated in the declared currency. Comparing them without one is a number ' +
        'with no unit wearing the label of one.',
    });
  } else if (dv.amount > cover.amount) {
    checks.push({
      check: 'value_within_cargo_cover', outcome: 'refused',
      detail: `declared ${dv.amount} ${dv.currency} exceeds cover ${cover.amount} ${cover.currency}`,
    });
  } else {
    checks.push({
      check: 'value_within_cargo_cover', outcome: 'authorized',
      detail: `declared ${dv.amount} ${dv.currency} within cover ${cover.amount} ${cover.currency}`,
    });
  }

  // 5. THE INVARIANT. A principal without binding authority may recommend this
  //    and nothing further, however clean every other check comes back.
  if (!req.actingAuthority.mayBind) {
    checks.push({
      check: 'authority_to_bind_present', outcome: 'refused',
      detail:
        `${req.actingAuthority.principal} holds no authority to bind the firm` +
        (req.actingAuthority.note ? ` (${req.actingAuthority.note})` : '') +
        '. This is a recommendation, not an authorization.',
    });
  } else {
    checks.push({
      check: 'authority_to_bind_present', outcome: 'authorized',
      detail: `${req.actingAuthority.principal} may bind`,
    });
  }

  const refused = checks.filter(x => x.outcome === 'refused');
  const undet = checks.filter(x => x.outcome === 'undetermined');
  // REFUSED DOMINATES. A known failure is not softened by an unknown beside it.
  const decision: AuthorizationDecision =
    refused.length ? 'refused' : undet.length ? 'undetermined' : 'authorized';
  const blockedBy = refused.length ? refused : undet;

  const statement =
    decision === 'authorized'
      ? `${req.loadId}: authorized — ${checks.length} checks, all cleared.`
      : decision === 'refused'
        ? `${req.loadId}: REFUSED — ${refused.map(x => x.detail).join('; ')}.`
        : `${req.loadId}: UNDETERMINED — ${undet.map(x => `${x.check} (${x.remedy})`).join('; ')}. ` +
          'Not cleared and not refused: absence of a record is not evidence of compliance.';

  return { loadId: req.loadId, decision, checks, blockedBy, decidedAt, statement };
}

export const NOT_AUTHORIZED = 'NOT_AUTHORIZED';

export class NotAuthorized extends Error {
  readonly code = NOT_AUTHORIZED;
  constructor(readonly authorization: Authorization) {
    super(`${NOT_AUTHORIZED}: ${authorization.statement}`);
    this.name = 'NotAuthorized';
  }
}

/**
 * The execution boundary. Call this and pass the authorization you actually
 * obtained — not a fresh one, and not one for a different load.
 *
 * The `loadId` re-check is the point: an authorization is for A PROPOSAL, and a
 * caller holding a clearance for one load and executing another has satisfied
 * the letter of a gate while defeating it entirely.
 */
export function assertExecutable(auth: Authorization, loadId: string): void {
  if (auth.loadId !== loadId) {
    throw new NotAuthorized({
      ...auth,
      decision: 'refused',
      statement:
        `${NOT_AUTHORIZED}: authorization is for ${auth.loadId}, execution is for ${loadId}. ` +
        'A clearance is for one proposal; reusing it across loads is a bypass with a receipt.',
    });
  }
  if (auth.decision !== 'authorized') throw new NotAuthorized(auth);
}

/**
 * Whether a load crosses the threshold where cryptographic notarization is
 * worth its cost. THIS IS NOT ON THE CRITICAL PATH — it decides whether to
 * produce evidence about an execution that has already been authorized.
 *
 * Deliberately separate from `authorize()`: if the two ever merged, a proving
 * cost would enter the dispatch loop and no test would show it, because
 * everything would still be correct — only slow.
 */
export interface NotarizationTrigger {
  required: boolean;
  reason: string;
}

export function notarizationRequired(
  declaredValue: { amount: number; currency: string } | null,
  equipment: string,
  thresholdAmount: number,
  thresholdCurrency: string,
): NotarizationTrigger {
  if (equipment.startsWith('reefer')) {
    return { required: true, reason: 'temperature-controlled: the condition IS the contract term' };
  }
  if (declaredValue === null) {
    return { required: false, reason: 'no declared value, so no value threshold is crossed' };
  }
  if (declaredValue.currency !== thresholdCurrency) {
    return {
      required: true,
      reason:
        `declared ${declaredValue.currency}, threshold ${thresholdCurrency} — not comparable ` +
        'without a rate, so the trigger fires rather than silently passing. Over-notarizing ' +
        'costs proving time; under-notarizing costs the evidence itself.',
    };
  }
  return declaredValue.amount >= thresholdAmount
    ? { required: true, reason: `declared ${declaredValue.amount} >= ${thresholdAmount} ${thresholdCurrency}` }
    : { required: false, reason: `declared ${declaredValue.amount} < ${thresholdAmount} ${thresholdCurrency}` };
}

/**
 * An authorization computed from representative records authorizes NOTHING in
 * the world. It is a rehearsal, and saying so is the difference between a demo
 * and a booking.
 */
export function isBindingAuthorization(auth: Authorization, inputs: Attestation): boolean {
  return auth.decision === 'authorized' && isAdmissible(inputs);
}
