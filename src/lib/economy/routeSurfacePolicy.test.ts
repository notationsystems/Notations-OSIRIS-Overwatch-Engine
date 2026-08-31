import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
// Single source of truth: the disposition map lives in production
// (src/lib/routeGate.ts) so classifying a route and deciding whether it
// is live are the same act. This test asserts it stays complete.
import { ROUTE_DISPOSITION } from '../routeGate';

/**
 * THE COLLECTION POLICY, ENFORCED AT THE ROUTE SURFACE (ledger phase 39).
 *
 * The contradiction this test exists to prevent, stated plainly: the
 * source registry refused to REGISTER a source that yields natural-person
 * data, and `src/app/api/` served four such categories directly —
 * username enumeration, breach lookup by email address, an infostealer
 * credential corpus, and phone research — bypassing the registry
 * entirely. The policy was correct about what it examined and silent
 * about what it handed on.
 *
 * That is the context-severance class again (a mechanism whose EFFECTIVE
 * scope is narrower than its APPARENT scope, with nothing failing), and
 * it is the eighth recorded instance. It is also the largest: the prior
 * instances cost a partition of a measurement, this one shipped a
 * person-targeting capability publicly under the firm's name.
 *
 * REGISTRATION WAS NEVER THE ONLY DOOR. This is the gate at the other
 * one. It has three parts, and the third is the one that matters:
 *
 *   1. EVERY route is classified. An unclassified route fails — a new
 *      route cannot reach the surface without someone writing down what
 *      its subject is. Accounting for every drop, applied to routes.
 *   2. Every CONDITIONAL route states its condition in its own source.
 *      A conditional permission with the condition left implicit is an
 *      unconditional permission.
 *   3. A CONTENT SCAN that runs regardless of classification. Part 1
 *      trusts the author's label; a reintroduced breach lookup filed
 *      under `permitted` would pass it. The scan does not care what the
 *      route is called or how it is classified — it looks for the
 *      capability itself. Both are needed: the classification catches
 *      the honest omission, the scan catches the wrong label.
 */

const API_ROOT = join(process.cwd(), 'src/app/api');

/**
 * The capabilities the collection policy prohibits, detected in source
 * rather than in a label. Each marker names an OBSERVABLE — an upstream
 * host, a person-shaped request parameter, a scanning tool — not an
 * inferred intent.
 *
 * `\b` boundaries throughout: an early draft matched `nmap` inside
 * `unmapped` and failed a routing test, which is the reminder that a
 * substring is not a word.
 */
const PROHIBITED_MARKERS: ReadonlyArray<{ pattern: RegExp; capability: string }> = [
  // Person-shaped request parameters — the subject is a natural person.
  { pattern: /searchParams\.get\(\s*['"](?:email|username|phone|person|ssn|dob)['"]/i,
    capability: 'person-shaped request parameter (the subject is a natural person)' },
  // Breach / infostealer corpora — unlawfully obtained data.
  { pattern: /\b(?:xposedornot|hudsonrock|cavalier\.hudsonrock|haveibeenpwned|dehashed|snusbase|leakcheck)\b/i,
    capability: 'breach or infostealer corpus (unlawfully obtained data)' },
  // Username enumeration across platforms.
  { pattern: /\b(?:sherlock|whatsmyname|maigret|socialscan)\b/i,
    capability: 'username enumeration across platforms' },
  // Host and port scanning.
  { pattern: /\b(?:shodan|censys|zoomeye|internetdb|masscan|nmap|SCANNER_URL|SCANNER_KEY)\b/,
    capability: 'host or port scanning' },
  // People-search aggregators.
  { pattern: /\b(?:pipl|truecaller|spokeo|whitepages|fullcontact|clearbit)\b/i,
    capability: 'people-search aggregator' },
  /**
   * Telegram channel post scraping (phase 73). `t.me/s/<channel>` is the web
   * PREVIEW endpoint — the one that returns rendered posts to a client that is
   * not a Telegram client, which is why the scraper wore a desktop-Chrome
   * User-Agent it does not have.
   *
   * The description gate has forbidden ADVERTISING this since phase 46, on the
   * strength of a record saying the capability "was advertised and never
   * built". It was built, and it was live in `api/news` the whole time. The
   * prohibition existed and only the doing of it was unchecked.
   */
  { pattern: /\bt\.me\/s\//,
    capability: 'Telegram channel post scraping' },
];

function routeIds(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, prefix ? `${prefix}/${entry}` : entry);
      } else if (entry === 'route.ts') {
        out.push(prefix);
      }
    }
  };
  walk(API_ROOT, '');
  return out.sort();
}

const ROUTES = routeIds();

describe('the collection policy holds at the route surface, not only at registration', () => {
  it('finds routes to check (the gate must not pass by being empty)', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it('classifies every route — an unclassified route is a door nobody looked at', () => {
    const unclassified = ROUTES.filter((r) => !(r in ROUTE_DISPOSITION));
    expect(unclassified, [
      'These routes have no declared disposition. Every route on this surface must say',
      'what its subject is before it ships. If the subject is a natural person or the',
      'function is host scanning, it does not ship at all — it is deleted, not flagged,',
      'because a feature-flagged breach lookup is still a breach lookup in the tree and',
      'still in the image.',
    ].join(' ')).toEqual([]);
  });

  it('has no stale classification (a deleted route must leave the register)', () => {
    const present = new Set(ROUTES);
    const stale = Object.keys(ROUTE_DISPOSITION).filter((r) => !present.has(r));
    expect(stale, 'classified routes that no longer exist').toEqual([]);
  });

  it('serves no route whose subject is a natural person or whose function is scanning', () => {
    const findings: string[] = [];
    for (const route of ROUTES) {
      const source = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      for (const { pattern, capability } of PROHIBITED_MARKERS) {
        if (pattern.test(source)) findings.push(`${route}: ${capability}`);
      }
    }
    expect(findings, [
      'A prohibited capability is present in the served route surface. This is the',
      'contradiction the gate exists to prevent, and the classification map above will',
      'not save it: the scan runs regardless of how a route is labelled.',
    ].join(' ')).toEqual([]);
  });

  it('states the condition inside every conditional route', () => {
    const silent: string[] = [];
    for (const [route, disposition] of Object.entries(ROUTE_DISPOSITION)) {
      if (disposition !== 'infrastructure-conditional') continue;
      const source = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      const states =
        /ORGANISATIONAL INFRASTRUCTURE ATTRIBUTION ONLY/.test(source) ||
        /ORGANISATIONAL SCREENING ONLY/.test(source);
      if (!states) silent.push(route);
    }
    expect(silent, [
      'These routes are permitted only conditionally and do not state the condition in',
      'their own source. A conditional permission with the condition left implicit is an',
      'unconditional permission.',
    ].join(' ')).toEqual([]);
  });

  /**
   * A CONDITION THE CODE DOES NOT HONOUR IS A SENTENCE, NOT A CONSTRAINT
   * (ledger phase 71).
   *
   * The test above checks that a conditional route STATES its condition. That
   * is all it checks, and `osint/whois` passed it for twenty-five phases while
   * doing the opposite of what its own paragraph says. Its header is not
   * careless — it is the most careful one in the tree:
   *
   *   "WHOIS carries the sharpest edge of the conditional category, because a
   *    domain registered by an individual has a natural person in the
   *    registrant field. RDAP redacts most of it; where a registry does not,
   *    the redaction is the registry's choice and NOT THIS ROUTE'S LICENCE TO
   *    USE WHAT COMES BACK."
   *
   * Directly beneath it, the route read the vCard `fn` — the registrant's
   * formatted name — into its response, and RETAINED entities that carried
   * nothing else (`.filter((e) => e.name || e.org)`). It used what came back.
   *
   * So the prose was not wrong and the code was not unconsidered; they were
   * written by the same hand and never checked against each other. A gate that
   * verifies a promise is present, and never that it is kept, is the
   * documentation-shaped form of this codebase's oldest class.
   *
   * Scoped to `infrastructure-conditional` deliberately. A freight route may
   * hold a driver's or a broker contact's name — those are the firm's own
   * business records. These eight routes are the ones whose licence to exist
   * is a promise that their subject is never a natural person.
   */
  const PERSON_NAME_EXTRACTION: ReadonlyArray<{ pattern: RegExp; field: string }> = [
    /**
     * Keyed on a person name being PLACED INTO an emitted object — `name:`
     * assigned from a vCard `fn` lookup, which is the exact shape the defect
     * had — and NOT on the field being read. Screening a registrant against
     * the SDN is a use the condition allows and it requires reading `fn`, so a
     * marker that fired on the read would forbid the permitted use. What the
     * route RETURNS is checked behaviourally in `rdapProjection.test.ts`,
     * against a planted individual registrant; this is the cheap net over the
     * seven sibling routes that have no such projection of their own.
     */
    { pattern: /\bname\s*:\s*[^,;\n]*['"]fn['"]/, field: "the vCard `fn` formatted name into its response" },
    { pattern: /\b(?:firstName|lastName|givenName|familyName|given_name|family_name)\b/, field: 'a given/family name field' },
    { pattern: /\b(?:full_?name|personName|contact_?name|registrant_?name)\b/i, field: 'a personal-name field' },
  ];

  it('honours the condition in code, not only in the comment', () => {
    const findings: string[] = [];
    for (const [route, disposition] of Object.entries(ROUTE_DISPOSITION)) {
      if (disposition !== 'infrastructure-conditional') continue;
      const source = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      for (const { pattern, field } of PERSON_NAME_EXTRACTION) {
        if (pattern.test(source)) findings.push(`${route}: extracts ${field}`);
      }
    }
    expect(findings, [
      'A route permitted only on the condition that its subject is never a natural person',
      'extracts a natural-person name field. The condition is written in its own source and',
      'the test above confirms the sentence is there — which is exactly how this survived:',
      "a promise checked for presence and never for being kept. Screening a name against a",
      'sanctions list is a use the condition allows; RETURNING it is not.',
    ].join(' ')).toEqual([]);
  });

  it('never serves a natural person from the sanctions route', () => {
    const source = readFileSync(join(API_ROOT, 'osint/sanctions/route.ts'), 'utf8');
    // The allowlist alone fails open for callers who name no schema, so the
    // filter must reach the RESULTS.
    expect(source).toMatch(/PERSON_SCHEMAS/);
    expect(source).toMatch(/\.filter\(\s*\(m\)\s*=>\s*!PERSON_SCHEMAS\.has\(m\.schema\)\s*\)/);
    const allowBlock = source.slice(
      source.indexOf('const ALLOWED_SCHEMAS'),
      source.indexOf('];', source.indexOf('const ALLOWED_SCHEMAS')),
    );
    expect(allowBlock).not.toMatch(/'Person'/);
  });
});

/**
 * THE SHIPPED DESCRIPTION IS AN ARTIFACT AND IT DRIFTS FROM POLICY LIKE
 * ANY OTHER.
 *
 * This reads odd until you remember the doc-count drift was caught twice
 * by exactly this kind of check. The repository is public: the README is
 * the firm's shipped identity, and a README advertising username
 * enumeration is a due-diligence finding whether or not the route still
 * exists.
 */
/**
 * THE SHIPPED DESCRIPTION IS MORE THAN ONE FILE (ledger phase 48, the
 * ninth instance of the phase-38 class).
 *
 * The first version of this gate read README.md and nothing else, and
 * went green while `src/app/layout.tsx` advertised `nmap online`,
 * `port scanner online` and `penetration testing tools` as SEO keywords
 * with browser-based port scanning first in its schema.org featureList —
 * the surface a search engine actually indexes. A gate against
 * advertising a prohibited capability, itself narrower than its claim.
 *
 * The door there was an ENUMERATION: the check named its members and the
 * world had more. An enumeration is silent about what it omits and the
 * test goes green either way, so the only defence is to make the list
 * itself checkable. Hence the shape below, which is the phase-46 route
 * classification applied to documents: every description-bearing artifact
 * is CLASSIFIED, an unclassified one fails, and the scan runs over every
 * artifact classified as outward-facing.
 */

/** How an artifact relates to what the product claims to be. */
type ArtifactRole =
  /** Describes the product to people outside the firm. Scanned. */
  | 'outward-facing'
  /** Internal to contributors; names capabilities only to discuss them. */
  | 'internal';

const DESCRIPTION_ARTIFACTS: Readonly<Record<string, ArtifactRole>> = {
  'README.md': 'outward-facing',
  'DOCKER.md': 'outward-facing',
  'SECURITY.md': 'outward-facing',
  'src/app/layout.tsx': 'outward-facing',
  'docker-compose.yml': 'outward-facing',
  'public/manifest.json': 'outward-facing',
  'public/site.webmanifest': 'outward-facing',
  'src/app/docs/DocsClient.tsx': 'outward-facing',
  'src/app/docs/apiCatalog.ts': 'outward-facing',
  // The environment template is read by anyone standing the system up, and it
  // is the most operational description there is: it does not describe a
  // capability, it CONFIGURES one. It advertised `SCANNER_URL`/`SCANNER_KEY`
  // for a RECON port-scanning backend, and wallet-forensics keys, for
  // twenty-four phases after A-0 deleted both — while README.md said in plain
  // text that those keys were gone. Two documents, one fact, and no check
  // reading either (ledger phase 70).
  '.env.example': 'outward-facing',
};

/**
 * Where a new description-bearing artifact is likely to appear. Anything
 * matching and not classified above fails the gate — which is the whole
 * point: the list cannot silently fall behind the tree.
 */
function candidateArtifacts(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(process.cwd())) {
    if (entry.endsWith('.md') && entry === entry.toUpperCase().replace('.MD', '.md')) out.push(entry);
  }
  for (const entry of readdirSync(join(process.cwd(), 'public'))) {
    if (entry.endsWith('.webmanifest') || entry === 'manifest.json') out.push(`public/${entry}`);
  }
  // Environment TEMPLATES only — never `.env` itself, which is gitignored,
  // holds real secrets, and is not a description of anything shipped.
  for (const entry of readdirSync(process.cwd())) {
    if (/^\.env\.(example|template|sample)$/.test(entry)) out.push(entry);
  }
  return out.sort();
}

/**
 * Strip a delimited collection-policy region from an artifact.
 *
 * ANY outward-facing artifact may NAME a prohibited capability in order to
 * say it is prohibited — a policy nobody can read is not a policy, and the
 * /docs page states the same policy the README does. So the exemption is a
 * property of the delimited REGION, not a property of being README.md.
 * The markers differ only by comment syntax: HTML in Markdown, JSX in TSX.
 */
function withoutPolicyBlock(source: string): { advertised: string; policy: string } {
  const MARKERS = [
    ['<!-- collection-policy:begin -->', '<!-- collection-policy:end -->'],
    ['{/* collection-policy:begin */}', '{/* collection-policy:end */}'],
  ];
  for (const [begin, end] of MARKERS) {
    const start = source.indexOf(begin);
    const stop = source.indexOf(end);
    if (start >= 0 && stop > start) {
      const policy = source.slice(start, stop + end.length);
      return { advertised: source.replace(policy, ''), policy };
    }
  }
  return { advertised: source, policy: '' };
}

describe('the shipped description advertises no prohibited capability', () => {
  const README = readFileSync(join(process.cwd(), 'README.md'), 'utf8');

  const POLICY_BEGIN = '<!-- collection-policy:begin -->';
  const POLICY_END = '<!-- collection-policy:end -->';

  /**
   * The README must be able to NAME a prohibited capability in order to say
   * it is prohibited — a policy section that cannot say the word is a policy
   * nobody can read. So the scan runs over everything OUTSIDE the delimited
   * policy block.
   *
   * The exemption is bounded, because an exemption that can grow to cover
   * the document is not an exemption: the block must exist, and it must stay
   * a section rather than becoming the file. Wrapping the whole README in
   * the marker to silence this test would fail the size assertion below.
   */
  const policyStart = README.indexOf(POLICY_BEGIN);
  const policyEnd = README.indexOf(POLICY_END);
  const policyBlock = policyStart >= 0 && policyEnd > policyStart
    ? README.slice(policyStart, policyEnd + POLICY_END.length)
    : '';
  const advertised = policyBlock ? README.replace(policyBlock, '') : README;

  it('delimits the collection-policy section so the scan can exclude it', () => {
    expect(policyStart, `README must contain ${POLICY_BEGIN}`).toBeGreaterThanOrEqual(0);
    expect(policyEnd, `README must contain ${POLICY_END}`).toBeGreaterThan(policyStart);
  });

  it('keeps that exemption a section, not the document', () => {
    expect(policyBlock.length / README.length).toBeLessThan(0.35);
  });

  const ADVERTISED_PROHIBITIONS: ReadonlyArray<{ pattern: RegExp; capability: string }> = [
    { pattern: /username enumerat|handle .{0,12}hunt|hunt a handle/i, capability: 'username enumeration' },
    { pattern: /breach lookup|breach exposure|data leaks?\b|infostealer/i, capability: 'breach / infostealer lookup' },
    { pattern: /phone (?:intel|research|lookup)/i, capability: 'phone research' },
    { pattern: /port scann|vulnerability scann|\bshodan\b/i, capability: 'port / vulnerability scanning' },
    { pattern: /telegram osint|scrap\w* .{0,20}telegram|telegram .{0,20}scrap/i, capability: 'Telegram person-post scraping' },
    /**
     * CONFIGURING a capability is a stronger claim than describing one, and it
     * is the form the drift actually took: `.env.example` did not say the
     * scanner existed, it SET the variables, under a heading calling them
     * "the ONLY keys the current code consumes" — of a route deleted in
     * phase 46 that no source file has read since.
     *
     * Keyed on the assignment rather than the word, so a document may still
     * say a scanning backend was REMOVED. DOCKER.md and README.md both do,
     * and a prohibition nobody can state is not a prohibition.
     */
    { pattern: /^\s*SCANNER_(?:URL|KEY)\s*=/m, capability: 'port-scanning backend configuration' },
    { pattern: /RECON (?:toolkit|scanner backend)|scanner backend base URL/i, capability: 'a RECON scanning toolkit as a product feature' },
  ];

  it('does not name a prohibited capability as a feature', () => {
    const named = ADVERTISED_PROHIBITIONS
      .filter(({ pattern }) => pattern.test(advertised))
      .map(({ capability }) => capability);
    expect(named, [
      'The README advertises a capability the collection policy prohibits. The shipped',
      'description is part of the shipped identity: a public repository that describes',
      'itself as offering these is a finding a customer, an insurer or a regulator makes',
      'for you.',
    ].join(' ')).toEqual([]);
  });

  /**
   * The page metadata is MORE public than the README: it is what a search
   * engine indexes and what a link preview shows. It advertised
   * `nmap online`, `port scanner online` and `penetration testing tools`
   * as SEO keywords, and listed browser-based port scanning first in its
   * schema.org featureList — found only when the rename swept through the
   * file, because the first version of this gate read README.md and
   * nothing else. A gate on "the shipped description" that checks one
   * artifact is the same defect it was written to catch.
   */
  it('does not advertise a prohibited capability in the page metadata', () => {
    const layout = readFileSync(join(process.cwd(), 'src/app/layout.tsx'), 'utf8');
    const named = ADVERTISED_PROHIBITIONS
      .filter(({ pattern }) => pattern.test(layout))
      .map(({ capability }) => capability);
    expect(named, 'src/app/layout.tsx advertises a prohibited capability').toEqual([]);
    // The scanning keywords had no other spelling in the file, so they are
    // asserted directly rather than through the shared patterns.
    for (const term of ['nmap', 'penetration testing', 'port scanner', 'palantir']) {
      expect(layout.toLowerCase(), `metadata must not advertise ${term}`).not.toContain(term);
    }
  });

  it('classifies every description-bearing artifact it can find', () => {
    const unclassified = candidateArtifacts().filter((f) => !(f in DESCRIPTION_ARTIFACTS));
    expect(unclassified, [
      'These files describe the product and carry no declared role. Classify each as',
      "'outward-facing' (scanned for prohibited capabilities) or 'internal'. A gate that",
      'enumerates its members is silent about the ones it omits — which is exactly how',
      'layout.tsx advertised port scanning while this gate reported the README clean.',
    ].join(' ')).toEqual([]);
  });

  it('scans every outward-facing artifact, not just the README', () => {
    const findings: string[] = [];
    for (const [file, role] of Object.entries(DESCRIPTION_ARTIFACTS)) {
      if (role !== 'outward-facing') continue;
      let source: string;
      try {
        source = readFileSync(join(process.cwd(), file), 'utf8');
      } catch {
        findings.push(`${file}: classified but missing — remove it from the list or restore it`);
        continue;
      }
      const body = withoutPolicyBlock(source).advertised;
      for (const { pattern, capability } of ADVERTISED_PROHIBITIONS) {
        if (pattern.test(body)) findings.push(`${file}: advertises ${capability}`);
      }
    }
    expect(findings, [
      'An outward-facing artifact advertises a capability the collection policy',
      'prohibits. The shipped description is what a customer, an insurer or a regulator',
      'reads — it is an artifact and drifts from policy like any other.',
    ].join(' ')).toEqual([]);
  });

  it('names no scanning tool in any outward-facing artifact', () => {
    const findings: string[] = [];
    for (const [file, role] of Object.entries(DESCRIPTION_ARTIFACTS)) {
      if (role !== 'outward-facing') continue;
      let source: string;
      try {
        source = readFileSync(join(process.cwd(), file), 'utf8');
      } catch {
        continue;
      }
      const body = withoutPolicyBlock(source).advertised.toLowerCase();
      for (const term of ['nmap', 'penetration testing', 'port scanner', 'palantir']) {
        if (body.includes(term)) findings.push(`${file}: names "${term}"`);
      }
    }
    expect(findings).toEqual([]);
  });

  it('states the prohibition it is exempted for (the section cannot be emptied)', () => {
    // Markdown wraps, so the assertions run over whitespace-collapsed text:
    // a sentence broken across two lines is the same sentence.
    const flat = policyBlock.replace(/\s+/g, ' ');
    expect(flat).toMatch(/prohibited/i);
    expect(flat).toMatch(/username enumerat/i);
    expect(flat).toMatch(/breach/i);
    expect(flat).toMatch(/scanning/i);
    expect(flat).toMatch(/never used to profile a person/i);
  });
});
