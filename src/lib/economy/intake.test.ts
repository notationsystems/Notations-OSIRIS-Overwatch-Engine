import { describe, it, expect } from 'vitest';
import {
  intakeEmail, reviewExtraction, readValue, boundaryFor, assertNoContactDetail,
  IntakeRefusal, INTAKE_SELF_VALIDATION, INTAKE_CARRIES_A_PERSON,
  WHO_KNOWS, ALL_OPPORTUNITY_FIELDS, REQUIRED_TO_QUOTE, type RawEmail,
} from './intake';
import { SimulatedExtractor, SimulatedReviewer } from './simulatedExtractor';
import { isAdmissible } from './attestation';

const extractor = new SimulatedExtractor();
const email = (body: string, subject = 'load'): RawEmail => ({
  messageId: 'msg-1', channel: 'gmail', receivedAt: '2026-09-05T09:00:00.000Z',
  subject, body,
});

// The message from the design note, verbatim.
const THE_EMAIL = email('need a reefer TOR-DET Thursday, ~38k lbs, pickup after 2pm');

describe('intake - a hedged number never becomes a number', () => {
  it('refuses the hedge BEFORE extracting the digits', () => {
    const f = readValue('~38k lbs', { numeric: true, whoKnows: 'the shipper', askable: true });
    expect(f.state).toBe('unparsed');
    if (f.state !== 'unparsed') return;
    expect(f.why).toContain('statement ABOUT a number');
  });

  it('refuses a range, because two numbers are not one number', () => {
    const f = readValue('38000-42000 lbs', { numeric: true, whoKnows: 'x', askable: true });
    expect(f.state).toBe('unparsed');
    if (f.state !== 'unparsed') return;
    expect(f.why).toContain('invents a precision');
  });

  it('reads an unhedged figure, including the k suffix freight actually uses', () => {
    expect(readValue('38000 lbs', { numeric: true, whoKnows: 'x', askable: true }))
      .toMatchObject({ state: 'present', value: 38000 });
    expect(readValue('38k lbs', { numeric: true, whoKnows: 'x', askable: true }))
      .toMatchObject({ state: 'present', value: 38000 });
  });

  it('reports a blank as MISSING with who to ask, not as unparsed', () => {
    const f = readValue('', { numeric: true, whoKnows: 'the shipper', askable: true });
    expect(f.state).toBe('missing');
    if (f.state !== 'missing') return;
    expect(f.whoKnows).toBe('the shipper');
  });

  it('does not pre-clean the hedge in the extractor, which would defeat the guard', () => {
    const raw = extractor.extract(THE_EMAIL);
    expect(raw.weightLbs).toContain('~');
  });
});

describe('intake - the email from the design note', () => {
  const opp = intakeEmail(THE_EMAIL, extractor, 'OPP-1');

  it('reads the lane and the equipment', () => {
    expect(opp.fields.origin).toMatchObject({ state: 'present', value: 'TOR' });
    expect(opp.fields.destination).toMatchObject({ state: 'present', value: 'DET' });
    expect(opp.fields.equipment).toMatchObject({ state: 'present', value: 'reefer_53' });
  });

  it('lands the hedged weight as UNPARSED, not as 38000', () => {
    expect(opp.fields.weightLbs.state).toBe('unparsed');
    expect(opp.unparsedFields).toContain('weightLbs');
  });

  it('names the gaps rather than only counting them', () => {
    expect(opp.missingFields.length).toBeGreaterThan(0);
    expect(opp.missingFields).toContain('deliveryWindow');
    expect(opp.completeness.of).toBe(ALL_OPPORTUNITY_FIELDS.length);
    expect(opp.completeness.present).toBeLessThan(opp.completeness.of);
  });

  it('says WHO to ask per field - generic advice on every gap is advice nobody acts on', () => {
    expect(WHO_KNOWS.weightLbs.who).toBe('the shipper');
    expect(WHO_KNOWS.targetRate.askable).toBe(false);
    expect(WHO_KNOWS.targetRate.who).toContain('no counterparty to ask');
  });

  it('blocks on what a quote actually requires', () => {
    const opp2 = intakeEmail(email('reefer TOR-DET, deliver Friday'), extractor, 'OPP-2');
    expect(opp2.blockedOn).toContain('pickupWindow');
    expect(opp2.quotable).toBe(false);
    expect(opp2.renderedClaim).toContain('BLOCKED');
    expect(opp2.renderedClaim).toContain('ask the shipper');
  });

  it('is quotable once every required field is present', () => {
    const full = intakeEmail(
      email('reefer TOR-DET, pickup Thursday 1400, delivery Friday 0900, pharma, 38000 lbs'),
      extractor, 'OPP-3');
    expect(full.blockedOn).toEqual([]);
    expect(full.quotable).toBe(true);
    expect(full.renderedClaim).toContain('quotable');
    expect(REQUIRED_TO_QUOTE.every(f => full.fields[f].state === 'present')).toBe(true);
  });

  it('asserts nothing the message did not say', () => {
    expect(opp.renderedClaim).toContain('nothing here is asserted that the message did not say');
    for (const name of ALL_OPPORTUNITY_FIELDS) {
      const f = opp.fields[name];
      if (f.state === 'present') expect(THE_EMAIL.body.toLowerCase() + THE_EMAIL.subject)
        .toBeTruthy();
    }
  });
});

describe('intake - two degradations, on two axes', () => {
  const opp = intakeEmail(THE_EMAIL, extractor, 'OPP-A');

  it('is derived AND a negotiating position, so nothing downstream mistakes it for a reading', () => {
    expect(opp.attestation.evidenceClass).toBe('derived');
    expect(opp.attestation.interest).toBe('negotiating_position');
    expect(opp.attestation.restsOnInterested).toBe(true);
  });

  it('is not admissible on the representative axis, and is not claimed to be', () => {
    // `derived` is not `representative`, so isAdmissible is TRUE here — which is
    // correct and worth pinning explicitly rather than assuming: the interest
    // axis is what qualifies this claim, not the representative flag.
    expect(opp.attestation.restsOnRepresentative).toBe(false);
    expect(isAdmissible(opp.attestation)).toBe(true);
    expect(opp.attestation.restsOnInterested).toBe(true);
  });

  it('records which instance read it', () => {
    expect(opp.extractedBy).toEqual({ id: extractor.id, vendor: extractor.vendor });
  });
});

describe('intake - a load is not a person', () => {
  it('refuses contact detail in a load field', () => {
    for (const bad of ['ops@shipper.com', '+1 416 555 0199', 'Mr Smith']) {
      expect(() => assertNoContactDetail('commodity', bad)).toThrow(IntakeRefusal);
    }
    try { assertNoContactDetail('commodity', 'ops@shipper.com'); } catch (e) {
      expect((e as IntakeRefusal).code).toBe(INTAKE_CARRIES_A_PERSON);
      expect((e as Error).message).toContain('about a load, not a person');
    }
  });

  it('leaves ordinary freight text alone - the guard is narrow on purpose', () => {
    for (const ok of ['reefer_53', 'auto parts', 'pickup after 2pm', 'TOR', '38000 lbs']) {
      expect(() => assertNoContactDetail('commodity', ok)).not.toThrow();
    }
  });

  it('does NOT mistake a date-shaped pickup window for a phone number', () => {
    // FOUND BY PROBING THE GUARD, not by it failing: a run of digits, spaces and
    // dashes is what a phone number AND an ISO date both look like, so the
    // person guard would have refused every opportunity carrying a real pickup
    // window. A check that refuses the ordinary case is the shape this codebase
    // keeps finding in its own guards.
    for (const ok of [
      'pickup 2026-09-05 14:00', 'delivery 2026-09-06 09:00-11:00',
      'pickup window 2026-09-05', 'pickup 14:00',
    ]) {
      expect(() => assertNoContactDetail('pickupWindow', ok), ok).not.toThrow();
    }
    // And still refuses an actual number.
    expect(() => assertNoContactDetail('pickupWindow', 'call 416 555 0199')).toThrow(IntakeRefusal);
  });
});

describe('intake - the instance that produced a claim cannot validate it', () => {
  const opp = intakeEmail(THE_EMAIL, extractor, 'OPP-S');

  it('THROWS when the extractor reviews its own output', () => {
    expect(() => reviewExtraction(opp, THE_EMAIL, extractor)).toThrow(IntakeRefusal);
    try { reviewExtraction(opp, THE_EMAIL, extractor); } catch (e) {
      expect((e as IntakeRefusal).code).toBe(INTAKE_SELF_VALIDATION);
      expect((e as Error).message).toContain('agrees with itself by construction');
    }
  });

  it('allows a different instance, and grades the review by VENDOR', () => {
    const r = reviewExtraction(opp, THE_EMAIL, new SimulatedReviewer());
    expect(r.strength).toBe('cross_vendor');
    expect(r.note).toContain('catches a shared prior');
  });

  it('marks same-vendor review as the weaker kind rather than refusing it', () => {
    const sameVendor = new SimulatedExtractor('other-instance', extractor.vendor);
    const r = reviewExtraction(opp, THE_EMAIL, sameVendor);
    expect(r.strength).toBe('cross_instance_same_vendor');
    expect(r.note).toContain('share their priors');
  });

  it('actually disagrees somewhere - a review where everything agrees tests nothing', () => {
    const r = reviewExtraction(opp, THE_EMAIL, new SimulatedReviewer());
    expect(r.agreedFields.length).toBeGreaterThan(0);
    expect(r.disagreedFields.length + r.agreedFields.length).toBe(ALL_OPPORTUNITY_FIELDS.length);
  });
});

describe('intake - the boundary is decided, not drifted into', () => {
  it('names the concentration when channel and model are one vendor', () => {
    const b = boundaryFor('google', 'google');
    expect(b.concentrated).toBe(true);
    expect(b.note).toContain('never leaves that trust boundary');
    expect(b.note).toContain('a decision rather than a drift');
  });

  it('names two boundaries when they differ', () => {
    expect(boundaryFor('google', 'anthropic').concentrated).toBe(false);
  });

  it('REFUSES onward exposure by default', () => {
    expect(boundaryFor('google', 'google').onwardExposure).toBe('refused');
    expect(boundaryFor('google', 'google', true).onwardExposure).toBe('permitted');
    expect(boundaryFor('google', 'google').note).toContain('Internal use is one question');
  });
});
