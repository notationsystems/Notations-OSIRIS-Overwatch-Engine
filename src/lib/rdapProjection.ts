/**
 * Payload — projecting RDAP registrant entities under the conditional licence.
 *
 * WHY THIS IS A MODULE AND NOT SIX LINES INSIDE THE ROUTE (ledger phase 71).
 *
 * `osint/whois` is permitted to exist on one condition, written in its own
 * header: its subject is a DOMAIN and the ORGANISATION that registered it, and
 * it must never be used to identify a natural person. The header goes further
 * than most, and names the exact hazard:
 *
 *   "a domain registered by an individual has a natural person in the
 *    registrant field. RDAP redacts most of it; where a registry does not,
 *    the redaction is the registry's choice and NOT THIS ROUTE'S LICENCE TO
 *    USE WHAT COMES BACK."
 *
 * Directly beneath that paragraph, the route read the vCard `fn` into its
 * response and kept entities that carried nothing else. The prose and the code
 * were written by the same hand and never checked against each other, and the
 * gate that existed asserted only that the paragraph was PRESENT.
 *
 * The logic lives here so it can be exercised against a planted individual
 * registrant. A rule enforced by reading the source can only ask whether the
 * field is TOUCHED — and touching it is exactly what screening requires, so
 * that check must either forbid the permitted use or permit the forbidden one.
 * Asking what comes OUT is the only form of the question that separates them.
 */

/** One RDAP entity as the registry returns it. */
export interface RdapEntity {
  handle?: string;
  roles?: string[];
  vcardArray?: unknown;
}

/** What a caller receives. Never carries a formatted name. */
export interface ProjectedEntity {
  handle?: string;
  roles?: string[];
  org?: string;
  formatted_name?: null;
  formatted_name_withheld?: string;
}

/** A value screened against the SDN. Never returned as itself. */
export interface ScreeningCandidate {
  value: string;
  source: 'org' | 'formatted_name';
}

export const FORMATTED_NAME_WITHHELD =
  'RDAP does not distinguish an organisation name from a natural person name in vCard `fn`; ' +
  'this route is permitted for organisational attribution only, so an undetermined name is not returned.';

function vcardValue(entity: RdapEntity, key: string): string | undefined {
  const card = Array.isArray(entity.vcardArray) ? entity.vcardArray[1] : undefined;
  if (!Array.isArray(card)) return undefined;
  const row = card.find((v: unknown) => Array.isArray(v) && v[0] === key);
  const value = Array.isArray(row) ? row[3] : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Split RDAP entities into what may be returned and what may only be screened.
 *
 * THE THIRD VALUE. `org` is an organisation and `fn` is the entity's FORMATTED
 * NAME — the organisation for a legal entity, a natural person for an
 * individual, with nothing in RDAP to tell them apart. So `fn` is not
 * "a name we have" or "a name we lack"; it is UNDETERMINED, and the licence
 * decides undetermined against disclosure.
 *
 * The withholding is COUNTED, never silent. An entity whose only identifier
 * was a formatted name still appears, carrying the reason its name is missing.
 * Dropping it would narrow the population without saying so — the silent-
 * filtering defect wearing the newer one's clothes — and a caller cannot tell
 * "this registrant is an organisation we could not name" from "there was no
 * registrant" unless the row survives to say which.
 */
export function projectRdapEntities(
  entities: readonly RdapEntity[] | undefined,
): { entities: ProjectedEntity[]; screening: ScreeningCandidate[] } {
  const projected: ProjectedEntity[] = [];
  const screening: ScreeningCandidate[] = [];

  for (const entity of entities ?? []) {
    const org = vcardValue(entity, 'org');
    const formattedName = vcardValue(entity, 'fn');

    // Screening is a use the condition ALLOWS; returning is one it forbids.
    // The raw value goes only into this list, which the route keeps local.
    if (org) screening.push({ value: org, source: 'org' });
    if (formattedName) screening.push({ value: formattedName, source: 'formatted_name' });

    if (!org && !formattedName) continue;

    projected.push({
      handle: entity.handle,
      roles: entity.roles,
      ...(org ? { org } : {}),
      ...(formattedName
        ? { formatted_name: null, formatted_name_withheld: FORMATTED_NAME_WITHHELD }
        : {}),
    });
  }

  return { entities: projected, screening };
}
