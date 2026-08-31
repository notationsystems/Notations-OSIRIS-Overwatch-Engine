/**
 * Payload Terminal — the identity this instrument presents to other people's
 * servers, in one place.
 *
 * THE FINDING THAT PRODUCED IT. The Phase 47 branding sweep replaced the
 * single token `OSIRIS` with the two-word display name `Payload Terminal`,
 * and it did so inside User-Agent product tokens, where a space is a
 * DELIMITER and not a character. `Payload Terminal/4.2` does not name a
 * product at version 4.2; it names a product `Payload` of unstated version,
 * followed by a second product `Terminal/4.2`. Fourteen outbound identities
 * were malformed that way and nothing failed, because no upstream we call
 * today parses the field strictly — and the one that will is the SEC, whose
 * document tier this project has already recorded as rejecting generic and
 * malformed agents with a 403 that lengthens if you retry it.
 *
 * That sweep stated the right principle — *identifiers stay stable so
 * chains keep resolving, display names follow the instrument* — and then
 * applied the display name in the place where the string is an identifier.
 * It is the same defect the sweep itself was written to catch, one level in.
 *
 * The versions were the second half: 1.0, 3.0, 3.5, 4.2, 4.3 and 0.1 across
 * twelve files, corresponding to nothing. One product tells one upstream one
 * version, so it comes from `package.json` and a pin holds it there.
 *
 * `stealthFetch`'s rotating browser agents are deliberately NOT this. That
 * module impersonates a browser to a republisher that blocks scripted
 * clients; it is a separate, deliberate mechanism with its own justification,
 * and giving it this identity would defeat it.
 */

/**
 * One token. No spaces — that is the whole point of the module.
 *
 * `identity.test.ts` asserts this against every outbound header in the tree,
 * so a future rename cannot reintroduce the space without a red test.
 */
export const PRODUCT = 'PayloadTerminal';

/** Pinned against `package.json` by `identity.test.ts`. */
export const VERSION = '0.1.0';

/**
 * Where the source actually lives.
 *
 * The previous value, `github.com/simplifaisoul/osiris`, is a DIFFERENT
 * repository under a different owner. It was reaching upstream operators in
 * two User-Agent comments and, worse, readers of the public docs page in
 * four places — including the clone command and the "Report an issue" link.
 * Phase 47 left repository URLs alone on the reasoning that the repository
 * genuinely still carried the old name; that reasoning was sound and the URL
 * it protected was not this project's.
 *
 * The first correction then inherited a premise that had itself gone stale.
 * `Notations-OSIRIS-Overwatch-Engine` is the name the git remote still uses
 * and GitHub still redirects, so it resolves and nothing fails — but the
 * organisation's repository list does not contain it. The repository was
 * renamed to `Payload-Terminal-V0`, and a redirect is not a name. For a URL
 * handed to a regulator in a User-Agent, and printed in a clone command a
 * reader will run, the canonical one is the only correct one.
 *
 * What a test can actually check offline is the part that stays checkable:
 * that this is neither of the two values already known to be wrong, and that
 * the clone command in the docs names the directory this URL produces. The
 * canonical name itself is only knowable from GitHub, so it is not pinned —
 * saying so is better than a test that appears to hold it and does not.
 */
export const REPO_URL = 'https://github.com/notationsystems/Payload-Terminal-V0';

/**
 * The User-Agent for an outbound request.
 *
 * `role` distinguishes what part of the instrument is calling, for an
 * operator reading their own access log. It is a comment, so a space in it
 * is legal — unlike in the product token.
 */
export function userAgent(role?: string): string {
  const comment = role ? `${role}; +${REPO_URL}` : `+${REPO_URL}`;
  return `${PRODUCT}/${VERSION} (${comment})`;
}

/**
 * Whether a string is a well-formed User-Agent naming this product.
 *
 * Deliberately strict about the one thing that was wrong: the product token
 * runs to the `/`, and it may not contain a space. A comment in parentheses
 * may contain anything.
 */
export function isWellFormedUserAgent(ua: string): boolean {
  const first = ua.split('(')[0].trim();
  if (!first) return false;
  return first.split(/\s+/).every(token => {
    const slash = token.indexOf('/');
    if (slash <= 0) return false;              // a product needs a name and a version
    const name = token.slice(0, slash);
    const version = token.slice(slash + 1);
    return name.length > 0 && version.length > 0 && !/\s/.test(name);
  });
}
