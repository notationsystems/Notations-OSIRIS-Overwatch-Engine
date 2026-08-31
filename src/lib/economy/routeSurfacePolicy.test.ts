import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

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

/** Every route's subject, declared. There is no default. */
type Disposition =
  /** Freight, commerce, or the physical-economy substrate. The instrument. */
  | 'freight'
  /** Infrastructure attributed to an ORGANISATION. Conditional: the route
   *  must state the constraint in its own source. */
  | 'infrastructure-conditional'
  /** Inert general-purpose feeds inherited from the base. No person
   *  subject, no scanning. Slated for retirement behind a flag (A-1);
   *  permitted meanwhile, and never in the operator's default shell. */
  | 'general-purpose'
  /** Operations: health, stats, tiles, webhooks, the app's own plumbing. */
  | 'ops';

const ROUTE_DISPOSITION: Readonly<Record<string, Disposition>> = {
  'ai/analyze': 'general-purpose',
  'ai/briefing': 'general-purpose',
  'ai/overview': 'general-purpose',
  'air-quality': 'general-purpose',
  aircraft: 'general-purpose',
  arcgis: 'ops',
  astra: 'general-purpose',
  cctv: 'general-purpose',
  'cctv/proxy': 'general-purpose',
  'cctv/resolve': 'general-purpose',
  'cctv/stream-status': 'general-purpose',
  'chain/daily': 'freight',
  'cloudflare-radar': 'general-purpose',
  conflicts: 'general-purpose',
  'country-risk': 'general-purpose',
  crypto: 'general-purpose',
  'cyber-attacks': 'general-purpose',
  'cyber-threats': 'general-purpose',
  directions: 'freight',
  earthquakes: 'general-purpose',
  economy: 'freight',
  'economy/entity': 'freight',
  'economy/guards': 'freight',
  'economy/refusals': 'freight',
  'economy/scenario': 'freight',
  'economy/search': 'freight',
  'economy/table': 'freight',
  'economy/validate': 'freight',
  'entity/expand': 'freight',
  fires: 'general-purpose',
  'flight-route': 'general-purpose',
  flights: 'general-purpose',
  frontlines: 'general-purpose',
  gdelt: 'general-purpose',
  'gdelt-events': 'general-purpose',
  geo: 'freight',
  geosearch: 'freight',
  'github-webhook': 'ops',
  health: 'ops',
  infrastructure: 'freight',
  'live-news': 'general-purpose',
  malware: 'general-purpose',
  maritime: 'freight',
  markets: 'freight',
  'markets/history': 'freight',
  news: 'general-purpose',
  'osint/bgp': 'infrastructure-conditional',
  'osint/certs': 'infrastructure-conditional',
  'osint/dns': 'infrastructure-conditional',
  'osint/ip': 'infrastructure-conditional',
  'osint/mac': 'infrastructure-conditional',
  'osint/sanctions': 'infrastructure-conditional',
  'osint/threats': 'infrastructure-conditional',
  'osint/whois': 'infrastructure-conditional',
  'proxy-tiles': 'ops',
  radar: 'general-purpose',
  'region-dossier': 'general-purpose',
  satellites: 'general-purpose',
  'satellites/orbit': 'general-purpose',
  'scm-suppliers': 'general-purpose',
  'sdk/ingest': 'ops',
  'sdk/stream': 'ops',
  sentinel: 'general-purpose',
  'space-weather': 'general-purpose',
  stats: 'ops',
  weather: 'freight',
};

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
