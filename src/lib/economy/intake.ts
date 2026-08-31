// src/lib/economy/intake.ts
//
// INBOUND EMAIL → STRUCTURED OPPORTUNITY.
//
// A shipper emails "need a reefer TOR–DET Thursday, ~38k lbs, pickup after 2pm"
// and it becomes an Opportunity with the missing fields NAMED, landing in the
// operations queue as blocked on a delivery window.
//
// Two theses in one workflow: the compression thesis (the document channel is
// where most of the eleven days live) and the model-under-authority thesis (a
// model does the language task and owns none of the resulting state).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT AN EMAIL-EXTRACTED FACT ACTUALLY IS
// ─────────────────────────────────────────────────────────────────────────────
//
// Not `reported`. Two things degrade it, on two different axes, and both are
// already in the lattice:
//
//   INTEREST   a shipper's stated weight is a `negotiating_position`. It is
//              said to move a negotiation, and treating it as a measurement is
//              how an anchor becomes a number.
//   EVIDENCE   the extraction is OUR derivation from their text, so it is
//              `derived` — the model can misread, and the misreading is ours.
//
// `combineAttestations` then does the rest: weakest class and most-interested
// stake both win, so nothing downstream can mistake this for an instrument
// reading. The value of the channel is that the documents ARE there, not that
// they are authoritative.

import type { ISODateTime } from './types';
import type { Attestation } from './attestation';
import { attestationOf, combineAttestations } from './attestation';

// ─────────────────────────────────────────────────────────────────────────────
// 1. The model as a REPLACEABLE ACTOR
// ─────────────────────────────────────────────────────────────────────────────

/**
 * No model owns canonical state. A provider is an actor behind the authority
 * blanket, identified by INSTANCE and by VENDOR — both, because the
 * self-validation rule needs the instance and the concentration question needs
 * the vendor.
 */
export interface ModelProvider {
  /** The specific instance that produced a claim. */
  readonly id: string;
  /** Who operates it. Cross-vendor validation is stronger than cross-instance. */
  readonly vendor: string;
  extract(email: RawEmail): ExtractedFields;
}

export interface RawEmail {
  messageId: string;
  /** The channel it arrived through. Recorded, because the channel is evidence. */
  channel: 'gmail' | 'imap' | 'forwarded' | 'manual_paste';
  receivedAt: ISODateTime;
  subject: string;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. A field is present, missing, or unparsed — never quietly a value
// ─────────────────────────────────────────────────────────────────────────────

export type Field<T> =
  | { state: 'present'; value: T; stated: string }
  | { state: 'missing'; whoKnows: string; askable: boolean }
  | { state: 'unparsed'; stated: string; why: string };

export const present = <T>(value: T, stated: string): Field<T> =>
  ({ state: 'present', value, stated });
export const missing = <T>(whoKnows: string, askable: boolean): Field<T> =>
  ({ state: 'missing', whoKnows, askable });
export const unparsed = <T>(stated: string, why: string): Field<T> =>
  ({ state: 'unparsed', stated, why });

/**
 * HEDGES, matched BEFORE any digit is extracted, so a hedged value never
 * becomes a value.
 *
 * "~38k lbs" parsed to 38000 is indistinguishable downstream from a figure
 * someone weighed. The hedge is the sender telling you the precision they are
 * offering, and discarding it is discarding the only honest thing in the number.
 */
const HEDGE = new RegExp(
  '(\\babout\\b|\\bapprox\\w*|\\baround\\b|\\broughly\\b|\\bcirca\\b|\\bballpark\\b|' +
  '\\bor so\\b|\\bish\\b|\\bup to\\b|\\bat least\\b|\\bmin\\.?\\b|\\bmax\\.?\\b|~|\\+/-|±)',
  'i');

/** Two numbers are not one number. */
const RANGE = /\d[\d,.]*\s*(?:-|–|—|to)\s*\d[\d,.]*/;
const NUMBER = /(?<![\d.])(\d[\d,]*(?:\.\d+)?)/;

/** `k` and `lbs` are the units a freight email actually uses. */
const THOUSANDS = /(\d[\d,.]*)\s*k\b/i;

export function readValue(text: string, opts: { numeric: boolean; whoKnows: string; askable: boolean }): Field<string | number> {
  const stated = text.trim();
  if (!stated) return missing(opts.whoKnows, opts.askable);
  if (!opts.numeric) return present(stated, stated);

  const hedge = HEDGE.exec(stated);
  if (hedge) {
    return unparsed(stated,
      `hedged: contains ${JSON.stringify(hedge[0])}. A hedged number is a statement ABOUT a ` +
      'number and is not one. Parsed, it would be indistinguishable downstream from a figure ' +
      'someone actually measured.');
  }
  if (RANGE.test(stated)) {
    return unparsed(stated,
      'a range. Two numbers are not one number, and picking an end or a midpoint invents a ' +
      'precision the sender did not offer.');
  }
  const k = THOUSANDS.exec(stated);
  if (k) return present(Number(k[1].replace(/,/g, '')) * 1000, stated);
  const found = NUMBER.exec(stated);
  if (!found) return unparsed(stated, 'no number in the stated text.');
  return present(Number(found[1].replace(/,/g, '')), stated);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. The opportunity, and who to ask about each gap
// ─────────────────────────────────────────────────────────────────────────────

export type OpportunityFieldName =
  | 'origin' | 'destination' | 'commodity' | 'weightLbs'
  | 'equipment' | 'pickupWindow' | 'deliveryWindow' | 'targetRate';

/**
 * WHO TO ASK, PER FIELD — because "ask the shipper" is useless advice on a
 * market rate and exactly right on a weight. A single generic remedy on every
 * gap is a remedy nobody acts on.
 */
export const WHO_KNOWS: Readonly<Record<OpportunityFieldName, { who: string; askable: boolean }>> =
  Object.freeze({
    origin: { who: 'the shipper', askable: true },
    destination: { who: 'the shipper', askable: true },
    commodity: { who: 'the shipper', askable: true },
    weightLbs: { who: 'the shipper', askable: true },
    equipment: { who: 'the shipper', askable: true },
    pickupWindow: { who: 'the shipper', askable: true },
    deliveryWindow: { who: 'the shipper', askable: true },
    targetRate: { who: 'the market — no counterparty to ask', askable: false },
  });

export const ALL_OPPORTUNITY_FIELDS: readonly OpportunityFieldName[] =
  Object.keys(WHO_KNOWS) as OpportunityFieldName[];

/** Fields without which no quote can be attempted at all. */
export const REQUIRED_TO_QUOTE: readonly OpportunityFieldName[] =
  ['origin', 'destination', 'equipment', 'pickupWindow'];

export type ExtractedFields = Partial<Record<OpportunityFieldName, string>>;

export interface Opportunity {
  opportunityId: string;
  sourceMessageId: string;
  channel: RawEmail['channel'];
  receivedAt: ISODateTime;
  fields: Record<OpportunityFieldName, Field<string | number>>;
  /** Named, never only counted. */
  missingFields: OpportunityFieldName[];
  unparsedFields: OpportunityFieldName[];
  /** Present of total. A number an operator can sort by; the names are the work. */
  completeness: { present: number; of: number };
  /** Whether a quote can be attempted at all. */
  quotable: boolean;
  blockedOn: OpportunityFieldName[];
  attestation: Attestation;
  /** Which instance read the email, and under whose vendor. */
  extractedBy: { id: string; vendor: string };
  renderedClaim: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Refusals — before any state is created
// ─────────────────────────────────────────────────────────────────────────────

export const INTAKE_CARRIES_A_PERSON = 'INTAKE_CARRIES_A_PERSON';
export const INTAKE_SELF_VALIDATION = 'INTAKE_SELF_VALIDATION';

export class IntakeRefusal extends Error {
  constructor(readonly code: string, readonly detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'IntakeRefusal';
  }
}

/**
 * A freight opportunity is about a LOAD, not about a person. An email body
 * carries names, phone numbers and signatures, and none of it belongs in a
 * persisted opportunity record — the same policy the search layer enforces on
 * person-directed queries.
 *
 * Deliberately narrow: it refuses a value that LOOKS like contact detail in a
 * field that should hold a place, a commodity or a time. It is not a general
 * PII scrubber and does not pretend to be one.
 */
const EMAIL_ADDRESS = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/;
/** Title plus a capitalised surname. The capital is load-bearing: it is what
 *  separates "Mr Smith" from "ms of freight" in ordinary prose. */
const TITLED_NAME = /\b(?:[Mm]r|[Mm]rs|[Mm]s|[Dd]r)\.?\s+[A-Z][a-z]+/;
const PHONE_SHAPED = /(?:\+?\d[\d\s().-]{7,}\d)/;

/**
 * A DATE IS NOT A PHONE NUMBER, and the phone shape cannot tell them apart.
 *
 * Found by probing the guard rather than by it failing: `PHONE_SHAPED` matches
 * inside `pickup 2026-09-05 14:00`, because a run of digits, spaces and dashes
 * is exactly what both look like. Left alone, the person guard would have
 * refused every opportunity carrying an ISO pickup window — a check that
 * refuses the ordinary case, which is the shape this codebase keeps finding in
 * its own guards.
 *
 * So a date-shaped or time-shaped run is excluded BEFORE the phone test. The
 * cost is that a phone number written as `2026-09-05` gets through, which is
 * not a way anyone writes a phone number.
 */
const DATE_OR_TIME_SHAPED = /\d{4}-\d{2}-\d{2}|\b\d{1,2}:\d{2}\b/;

export function assertNoContactDetail(field: OpportunityFieldName, stated: string): void {
  const refuse = (what: string) => {
    throw new IntakeRefusal(
      INTAKE_CARRIES_A_PERSON,
      `the ${field} field carries ${what}. An opportunity is about a load, not a person; the ` +
      'reply address stays on the message and does not enter the record.');
  };
  if (EMAIL_ADDRESS.test(stated)) refuse('an email address');
  if (TITLED_NAME.test(stated)) refuse('a titled personal name');
  if (!DATE_OR_TIME_SHAPED.test(stated) && PHONE_SHAPED.test(stated)) refuse('something shaped like a phone number');
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Intake
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC_FIELDS: ReadonlySet<OpportunityFieldName> = new Set(['weightLbs', 'targetRate']);

export function intakeEmail(
  email: RawEmail, provider: ModelProvider, opportunityId: string,
): Opportunity {
  const raw = provider.extract(email);

  const fields = {} as Record<OpportunityFieldName, Field<string | number>>;
  const missingFields: OpportunityFieldName[] = [];
  const unparsedFields: OpportunityFieldName[] = [];

  for (const name of ALL_OPPORTUNITY_FIELDS) {
    const spec = WHO_KNOWS[name];
    const stated = raw[name];
    if (stated !== undefined) assertNoContactDetail(name, stated);
    const f = readValue(stated ?? '', {
      numeric: NUMERIC_FIELDS.has(name), whoKnows: spec.who, askable: spec.askable,
    });
    fields[name] = f;
    if (f.state === 'missing') missingFields.push(name);
    if (f.state === 'unparsed') unparsedFields.push(name);
  }

  const presentCount = ALL_OPPORTUNITY_FIELDS.filter(n => fields[n].state === 'present').length;
  const blockedOn = REQUIRED_TO_QUOTE.filter(n => fields[n].state !== 'present');

  // TWO DEGRADATIONS, ON TWO AXES. The shipper's statement is a negotiating
  // position; our reading of it is a derivation. Weakest wins on both.
  const attestation = combineAttestations([
    attestationOf('reported', 'medium', 'negotiating_position',
      `stated by the sender in ${email.channel} message ${email.messageId}`),
    attestationOf('derived', 'medium', 'unknown',
      `extracted by ${provider.id} (${provider.vendor}); the misreading, if any, is ours`),
  ]);

  const render = () => {
    const head = `${opportunityId}: ${presentCount}/${ALL_OPPORTUNITY_FIELDS.length} fields present`;
    const block = blockedOn.length
      ? ` — BLOCKED, needs ${blockedOn.map(n => `${n} (ask ${WHO_KNOWS[n].who})`).join(', ')}`
      : ' — quotable';
    const unp = unparsedFields.length
      ? ` Unparsed: ${unparsedFields.map(n => {
          const f = fields[n];
          return `${n} (${f.state === 'unparsed' ? f.why.split('.')[0] : ''})`;
        }).join('; ')}.`
      : '';
    return `${head}${block}.${unp} Extracted by ${provider.id}; nothing here is asserted that ` +
      'the message did not say.';
  };

  return {
    opportunityId, sourceMessageId: email.messageId, channel: email.channel,
    receivedAt: email.receivedAt,
    fields, missingFields, unparsedFields,
    completeness: { present: presentCount, of: ALL_OPPORTUNITY_FIELDS.length },
    quotable: blockedOn.length === 0,
    blockedOn,
    attestation,
    extractedBy: { id: provider.id, vendor: provider.vendor },
    renderedClaim: render(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. The self-validation gate — enforced here, not in configuration
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationStrength = 'cross_vendor' | 'cross_instance_same_vendor';

export interface ExtractionReview {
  opportunityId: string;
  reviewedBy: { id: string; vendor: string };
  strength: ValidationStrength;
  agreedFields: OpportunityFieldName[];
  disagreedFields: Array<{ field: OpportunityFieldName; extracted: string; review: string }>;
  note: string;
}

/**
 * THE INSTANCE THAT PRODUCED A CLAIM CANNOT VALIDATE IT.
 *
 * Enforced by the gate rather than by configuration, because a config is a
 * second place the fact lives and the two drift. A reviewer with the same `id`
 * throws; a reviewer from the same VENDOR is allowed but the review records
 * itself as the weaker kind, since cross-vendor disagreement is the thing that
 * actually catches a shared prior.
 */
export function reviewExtraction(
  opp: Opportunity, email: RawEmail, reviewer: ModelProvider,
): ExtractionReview {
  if (reviewer.id === opp.extractedBy.id) {
    throw new IntakeRefusal(
      INTAKE_SELF_VALIDATION,
      `${reviewer.id} produced this extraction and cannot review it. An instance checking its ` +
      'own output agrees with itself by construction, and the agreement reads as corroboration.');
  }
  const second = reviewer.extract(email);
  const agreedFields: OpportunityFieldName[] = [];
  const disagreedFields: ExtractionReview['disagreedFields'] = [];
  for (const name of ALL_OPPORTUNITY_FIELDS) {
    const f = opp.fields[name];
    const a = f.state === 'present' ? f.stated : f.state === 'unparsed' ? f.stated : '';
    const b = second[name] ?? '';
    if (a.trim() === b.trim()) agreedFields.push(name);
    else disagreedFields.push({ field: name, extracted: a, review: b });
  }
  const strength: ValidationStrength =
    reviewer.vendor === opp.extractedBy.vendor ? 'cross_instance_same_vendor' : 'cross_vendor';
  return {
    opportunityId: opp.opportunityId,
    reviewedBy: { id: reviewer.id, vendor: reviewer.vendor },
    strength, agreedFields, disagreedFields,
    note: strength === 'cross_vendor'
      ? `Reviewed by ${reviewer.vendor}, a different vendor from ${opp.extractedBy.vendor}. ` +
        'Cross-vendor disagreement is what catches a shared prior.'
      : `Reviewed by a different instance of ${reviewer.vendor}, the SAME vendor that extracted. ` +
        'Weaker: two instances of one model share their priors, so agreement here is less ' +
        'informative than agreement across vendors.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The boundary — decided, not drifted into
// ─────────────────────────────────────────────────────────────────────────────

export interface BoundaryDecision {
  /** Where the document arrived from. */
  channelVendor: string;
  /** Who read it. */
  modelVendor: string;
  /** True when both are the same trust boundary. */
  concentrated: boolean;
  /** Whether this record may be exposed through an outward-facing surface. */
  onwardExposure: 'permitted' | 'refused';
  note: string;
}

/**
 * Two boundary questions the channel raises, answered explicitly rather than by
 * default.
 *
 * CONCENTRATION — documents that arrive through one vendor's mail and are read
 * by the same vendor's model never leave that trust boundary. That is
 * convenient and it is a concentration, and it should be a decision.
 *
 * ONWARD EXPOSURE — a shipper's document processed internally is one thing;
 * the same content re-exposed through an outward MCP surface is a
 * redistribution with terms attached. Default REFUSED, because the safe
 * direction for a default is the one that does not publish someone else's
 * document.
 */
export function boundaryFor(
  channelVendor: string, modelVendor: string, exposeOnward = false,
): BoundaryDecision {
  const concentrated = channelVendor === modelVendor;
  return {
    channelVendor, modelVendor, concentrated,
    onwardExposure: exposeOnward ? 'permitted' : 'refused',
    note:
      (concentrated
        ? `Channel and model are both ${channelVendor}: the document never leaves that trust ` +
          'boundary. Convenient, and a concentration — recorded so it is a decision rather than ' +
          'a drift.'
        : `Channel ${channelVendor}, model ${modelVendor}: the document crosses a vendor ` +
          'boundary. Two boundaries to reason about instead of one.') +
      (exposeOnward
        ? ' Onward exposure PERMITTED — a counterparty document leaving through our outward ' +
          'surface is a redistribution, and the terms it travels under are the operator\'s to answer.'
        : ' Onward exposure REFUSED by default. Internal use is one question; re-publishing ' +
          'someone else\'s document through our own surface is another.'),
  };
}
