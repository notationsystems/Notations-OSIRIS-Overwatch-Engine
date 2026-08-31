import { describe, it, expect } from 'vitest';
import { projectRdapEntities, FORMATTED_NAME_WITHHELD, type RdapEntity } from './rdapProjection';

/**
 * THE CONDITION, CHECKED BY WHAT COMES OUT (ledger phase 71).
 *
 * `osint/whois` states its condition in its own header — organisational
 * attribution only, never a natural person — and for twenty-five phases it
 * returned the vCard `fn`, which for an individually registered domain IS a
 * natural person's name. The policy test of the day asserted that the
 * paragraph existed. It did exist. It was not kept.
 *
 * A source scan cannot close this. Screening the registrant against the SDN is
 * a use the condition explicitly allows, and screening requires READING the
 * field, so any check keyed on "does this file touch `fn`" must either forbid
 * the permitted use or permit the forbidden one. The question that separates
 * them is what the caller receives, so it is asked here, against a planted
 * individual registrant.
 */

/** A domain registered by a natural person, with nothing else on the vCard. */
const INDIVIDUAL: RdapEntity = {
  handle: 'REG-001',
  roles: ['registrant'],
  vcardArray: ['vcard', [
    ['version', {}, 'text', '4.0'],
    ['fn', {}, 'text', 'Jane Q. Registrant'],
    ['email', {}, 'text', 'jane@example.com'],
  ]],
};

/** A domain registered by a company: `org` present, `fn` a contact person. */
const COMPANY_WITH_CONTACT: RdapEntity = {
  handle: 'REG-002',
  roles: ['registrant', 'technical'],
  vcardArray: ['vcard', [
    ['version', {}, 'text', '4.0'],
    ['fn', {}, 'text', 'Robert Tables'],
    ['org', {}, 'text', 'Maersk Line A/S'],
  ]],
};

/** A registry that redacted everything — the common, compliant case. */
const REDACTED: RdapEntity = {
  handle: 'REG-003',
  roles: ['registrant'],
  vcardArray: ['vcard', [['version', {}, 'text', '4.0']]],
};

describe('an undetermined name never reaches the caller', () => {
  it('withholds the formatted name of an individual registrant', () => {
    const { entities } = projectRdapEntities([INDIVIDUAL]);
    const serialised = JSON.stringify(entities);
    expect(serialised, 'the registrant name must not appear anywhere in the projection')
      .not.toContain('Jane Q. Registrant');
    expect(entities).toHaveLength(1);
    expect(entities[0].formatted_name).toBeNull();
    expect(entities[0].formatted_name_withheld).toBe(FORMATTED_NAME_WITHHELD);
  });

  /**
   * The contact person on a COMPANY registration is the case a coarser rule
   * gets wrong: `org` is present and legitimate, so a fix that only guarded
   * "entities without an org" would hand back the human's name beside it.
   */
  it('withholds a contact person even when the organisation is returnable', () => {
    const { entities } = projectRdapEntities([COMPANY_WITH_CONTACT]);
    expect(JSON.stringify(entities)).not.toContain('Robert Tables');
    expect(entities[0].org).toBe('Maersk Line A/S');
    expect(entities[0].formatted_name_withheld).toBe(FORMATTED_NAME_WITHHELD);
  });

  /**
   * WHICH KIND OF NOTHING. An entity carrying only a person's name must not
   * silently vanish: the caller has to be able to tell "a registrant exists
   * and cannot be named here" from "no registrant was returned". The old code
   * dropped these rows, so the population narrowed without a counter.
   */
  it('keeps the row and states why the name is missing, rather than dropping it', () => {
    const { entities } = projectRdapEntities([INDIVIDUAL]);
    expect(entities, 'an individual registrant must still be counted').toHaveLength(1);
    expect(entities[0].handle).toBe('REG-001');
    expect(entities[0].formatted_name_withheld).toMatch(/organisational attribution only/);
  });

  it('returns an organisation name, which is what the route is for', () => {
    const { entities } = projectRdapEntities([COMPANY_WITH_CONTACT]);
    expect(entities[0].org).toBe('Maersk Line A/S');
  });

  it('emits nothing for a fully redacted entity', () => {
    expect(projectRdapEntities([REDACTED]).entities).toEqual([]);
  });
});

describe('screening keeps the use the condition allows', () => {
  /**
   * The route exists partly to surface a sanctioned registrant, so the name
   * must still be SCREENED. Withholding it from the response and refusing to
   * look at it are different things, and collapsing them would quietly delete
   * the reason the route is permitted at all.
   */
  it('still screens the withheld name against the sanctions list', () => {
    const { screening } = projectRdapEntities([INDIVIDUAL]);
    expect(screening).toEqual([{ value: 'Jane Q. Registrant', source: 'formatted_name' }]);
  });

  it('screens the organisation and the contact separately, each labelled', () => {
    const { screening } = projectRdapEntities([COMPANY_WITH_CONTACT]);
    expect(screening).toEqual([
      { value: 'Maersk Line A/S', source: 'org' },
      { value: 'Robert Tables', source: 'formatted_name' },
    ]);
  });

  /**
   * THE DISCRIMINATING PAIR. The two halves must be able to disagree, or the
   * test proves nothing: the screening list carries a value that the projected
   * entities do not. Asserting that is asserting the whole design.
   */
  it('screens a value the projection does not return', () => {
    const { entities, screening } = projectRdapEntities([INDIVIDUAL]);
    const screened = screening.map((s) => s.value);
    expect(screened).toContain('Jane Q. Registrant');
    expect(JSON.stringify(entities)).not.toContain('Jane Q. Registrant');
  });
});

describe('the projection does not fall over on what a registry actually sends', () => {
  it('handles a missing, empty or malformed vcard', () => {
    expect(projectRdapEntities(undefined).entities).toEqual([]);
    expect(projectRdapEntities([]).entities).toEqual([]);
    expect(projectRdapEntities([{ handle: 'X' }]).entities).toEqual([]);
    expect(projectRdapEntities([{ handle: 'X', vcardArray: 'nonsense' }]).entities).toEqual([]);
    expect(projectRdapEntities([{ handle: 'X', vcardArray: ['vcard', 'nope'] }]).entities).toEqual([]);
  });

  it('treats a blank formatted name as absent rather than as a withheld one', () => {
    const blank: RdapEntity = {
      handle: 'REG-004',
      vcardArray: ['vcard', [['fn', {}, 'text', '   ']]],
    };
    expect(projectRdapEntities([blank]).entities).toEqual([]);
    expect(projectRdapEntities([blank]).screening).toEqual([]);
  });
});
