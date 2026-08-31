import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * THE COLLECTION POLICY HOLDS ON THE EXECUTION SURFACE, NOT ONLY IN THE
 * ROUTE FILES (ledger phase 68).
 *
 * `routeSurfacePolicy.test.ts` was built at A-0 to close the door the
 * source registry could not see: `src/app/api/` served four prohibited
 * categories while the registry truthfully refused to REGISTER them. It
 * works. It is also, itself, an instance of the class it was written to
 * catch — and this file is the gate at the door IT could not see.
 *
 * WHAT IT COULD NOT SEE. Two gaps, and the remnant used both:
 *
 *   1. IT READS `src/app/api/**\/route.ts` AND NOTHING ELSE. `intel/server.js`
 *      — "OSIRIS Intelligence Layer", a separate Express process wired into
 *      `docker-compose.yml` as service `payload-intel:4000` — resolved a
 *      NATURAL PERSON by name (Wikidata `?item wdt:P31 wd:Q5`, returning
 *      nationality, employer and positions held), emitted CEOs and heads of
 *      state as `person:` nodes, harvested RIPEstat abuse-contact EMAILS as
 *      `person:` nodes, and geolocated an IP through `ip-api.com` to
 *      city/zip/lat/lon plus RIPEstat WHOIS and network-info. A whole
 *      process, deployed beside the app, outside the scanned directory.
 *
 *   2. ITS PERSON MARKERS MATCH PARAMETER NAMES. The marker is
 *      `searchParams.get('person')`. `src/app/api/entity/expand/route.ts`
 *      forwarded the prohibited subject as a VALUE —
 *      `new Set([... 'person', 'ip' ...])` — reading its own params as the
 *      innocuous `type` and `id`. A route classified `'freight'` whose whole
 *      function was proxying the person-and-IP resolver.
 *
 * So the gate's EFFECTIVE scope was route source files and parameter names,
 * while its APPARENT scope was "the collection policy at the route surface".
 * That is the phase-38 class again, arriving in the apparatus built to catch
 * it — which is where the roster in DEFECT_CLASSES.md says this class has
 * been moving for twelve instances.
 *
 * THREE PARTS, EACH PROVEN TO BITE ON THE REAL DEFECT BEFORE IT WAS TRUSTED
 * (the remnant was still in the tree when this file was first run: Part A
 * named `intel/server.js`, Part B named `payload-intel`, Part C named
 * `entity/expand`). Synthetic plants for each are recorded in the ledger.
 *
 * WHAT THIS DOES NOT COVER, said here so it is a decision rather than an
 * omission: routes UNDER `src/app/api` keep their own gate and their own
 * recorded dispositions. `osint/ip` genuinely geolocates an address block
 * and is deliberately KEPT as `infrastructure-conditional` with the
 * organisational-attribution constraint written into its source. Scanning it
 * here would re-litigate A-0 rather than extend it, so Part A stops at the
 * route boundary and Part C checks only what the route ADMITS as a subject.
 */

const ROOT = process.cwd();

/** Directories that are not this project's own executable surface. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'out', 'build', 'coverage',
  // Archived evidence and the historical record — immutable by construction,
  // and the ledger NAMES the prohibited capabilities in order to record their
  // removal. Scanning the account of the deletion as though it were the
  // capability is the mistake the README policy-block exemption already
  // taught us.
  'docs', 'data-archive', 'runs', 'scratch', '__pycache__',
]);

const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|tsx|py)$/;

/**
 * The capabilities the collection policy prohibits, detected in source
 * rather than in a label — the same principle as the route gate's scan, with
 * the markers the remnant would have needed.
 *
 * Every marker names an OBSERVABLE: an upstream host, a query that selects
 * humans, a corpus, a tool. `\b` boundaries throughout, because a substring
 * is not a word — the lesson `nmap` inside `unmapped` already cost once.
 */
const PROHIBITED_CAPABILITIES: ReadonlyArray<{ pattern: RegExp; capability: string }> = [
  // Selecting natural persons out of a knowledge graph. `wd:Q5` is Wikidata
  // "human"; a query filtering on it is asking for people by construction.
  { pattern: /wdt:P31\s+wd:Q5|\bwd:Q5\b/,
    capability: 'a query that selects natural persons (Wikidata Q5 "human")' },
  { pattern: /\bresolvePerson\b|\blookupPerson\b|\bprofilePerson\b/,
    capability: 'a person resolver' },
  // IP geolocation and network attribution of a host.
  { pattern: /\bip-api\.com\b|\bipapi\.co\b|\bipinfo\.io\b|\bipgeolocation\.io\b/,
    capability: 'IP geolocation of a host' },
  { pattern: /\bstat\.ripe\.net\b|\babuse-contact-finder\b|\babuse_contacts\b/,
    capability: 'network attribution / abuse-contact harvesting' },
  // Breach and infostealer corpora — unlawfully obtained data.
  { pattern: /\b(?:xposedornot|hudsonrock|haveibeenpwned|dehashed|snusbase|leakcheck)\b/i,
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
   * THE BROWSER IS AN EXECUTION SURFACE TOO (phase 69).
   *
   * Every marker above names an upstream OSINT host or tool, so all of them
   * ask the same question: *what is this server calling?* `WorldRemote.tsx`
   * called nothing. It scanned from inside the viewer's own browser, out of
   * `fetch`, a timer and two Web APIs — and Part A, one phase old and written
   * to close exactly this class, went green over it.
   *
   * The recon was: `fetch('http://127.0.0.1:${port}/')` timed against an abort
   * to infer open ports; `navigator.bluetooth` to harvest nearby devices down
   * to their SERIAL NUMBERS, bound to a high-accuracy GPS fix, persisted and
   * exported as CSV; and RTCPeerConnection ICE candidates read for the
   * viewer's private addresses. A capability does not become permitted by
   * running on the client.
   */
  { pattern: /navigator\.bluetooth\b/,
    capability: 'browser Bluetooth device capture' },
  { pattern: /(?:127\.0\.0\.1|localhost):\$\{/,
    capability: 'localhost port probing' },
  { pattern: /\bonicecandidate\b|\bcreateDataChannel\b/,
    capability: 'WebRTC local-address enumeration' },
];

/**
 * Exemptions, each carrying its argument — because an exemption someone can
 * read is a decision and an exemption nobody wrote down is the defect
 * returning (the rule `emptyWarrant` already established for class 7).
 *
 * A file may NAME a prohibited capability in order to REASON about it. That is
 * the same exemption the README's delimited collection-policy block carries,
 * for the same reason: a policy nobody can read is not a policy.
 *
 * TWO PROPERTIES KEEP THIS FROM BECOMING A HOLE.
 *
 *   - It is keyed on FILE **AND** CAPABILITY, never on the file alone. An
 *     exempted file that acquires a DIFFERENT prohibited capability still
 *     fails, so an exemption cannot be used to make a file unscannable.
 *   - A stale exemption FAILS (see the test below). The list cannot quietly
 *     rot into a set of permissions for capabilities nobody re-checked, which
 *     is how every enumeration in this codebase has previously gone wrong.
 *
 * NOT DONE BY STRIPPING COMMENTS, and the reason is worth recording: a
 * comment cannot execute, so stripping them looks obviously right. But the
 * capability markers include URLs, and `'http://ip-api.com/json/'` contains
 * `//` — a line-comment stripper deletes the rest of that line and takes the
 * marker with it. The naive fix would have blinded the scan to the exact
 * capability it exists to find, while going green.
 */
const EXEMPT: ReadonlyArray<{ file: string; capability: string; argument: string }> = [
  {
    file: 'src/lib/audit/protocol.ts',
    capability: 'host or port scanning',
    argument:
      'Prose about a marker, not a capability. The file discusses the `nmap`-matched-inside-`unmapped` ' +
      'false positive as its worked example of a word-boundary failure. The word occurs once, in a ' +
      'comment, as the NAME of a historical marker bug; nothing scans, and nothing reaches a scanner. ' +
      'Found by this check on its first run — a marker about prose matching prose, matching prose.',
  },
];

function isExempt(file: string, capability: string): boolean {
  return EXEMPT.some((e) => e.file === file && e.capability === capability);
}

/** Every source file on the execution surface OUTSIDE the route gate's scope. */
function executionSurface(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXT.test(entry)) continue;
      const rel = relative(ROOT, full).split(sep).join('/');
      // Tests state the prohibitions in order to check them, and the route
      // files have their own gate (routeSurfacePolicy) plus their own
      // recorded dispositions (routeGate).
      if (/\.test\.tsx?$/.test(rel)) continue;
      if (/^src\/app\/api\/.*\/route\.ts$/.test(rel)) continue;
      out.push(rel);
    }
  };
  walk(ROOT);
  return out.sort();
}

const SURFACE = executionSurface();

describe('the collection policy holds beyond the route files', () => {
  /**
   * The vacuity guard. After the remnant was deleted there is no sibling
   * service left in the tree, so a check shaped as "scan every service
   * directory" would iterate an empty set and pass while proving nothing —
   * defect class 3, in the gate written to close class 5. The population is
   * therefore the whole execution surface, which cannot become empty while
   * the application exists.
   */
  it('finds an execution surface to check (the gate must not pass by being empty)', () => {
    expect(SURFACE.length).toBeGreaterThan(100);
  });

  it('runs no prohibited capability anywhere outside the route files', () => {
    const findings: string[] = [];
    for (const file of SURFACE) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const { pattern, capability } of PROHIBITED_CAPABILITIES) {
        if (pattern.test(source) && !isExempt(file, capability)) {
          findings.push(`${file}: ${capability}`);
        }
      }
    }
    expect(findings, [
      'A prohibited capability is present on the execution surface. The route gate',
      'cannot see this: it reads src/app/api/**/route.ts and nothing else, which is how',
      'a person-and-IP resolver ran for 68 phases as a separate process deployed beside',
      'the app. A capability does not become permitted by living in another container.',
    ].join(' ')).toEqual([]);
  });

  /**
   * A stale exemption is a permission nobody re-checked. If the prose that
   * earned an exemption is gone, the exemption goes with it — otherwise the
   * list rots into a standing allowance for a capability that could later be
   * added back under cover of it.
   */
  it('keeps every exemption live, and every exemption carries its argument', () => {
    const stale: string[] = [];
    for (const e of EXEMPT) {
      expect(e.argument.length, `exemption for ${e.file} must state its argument`)
        .toBeGreaterThan(80);
      const marker = PROHIBITED_CAPABILITIES.find((p) => p.capability === e.capability);
      expect(marker, `exemption names a capability no marker detects: ${e.capability}`)
        .toBeDefined();
      if (!existsSync(join(ROOT, e.file))) {
        stale.push(`${e.file}: exempted file no longer exists`);
        continue;
      }
      const source = readFileSync(join(ROOT, e.file), 'utf8');
      if (!marker!.pattern.test(source)) {
        stale.push(`${e.file}: no longer matches '${e.capability}' — remove the exemption`);
      }
    }
    expect(stale, [
      'An exemption no longer describes anything in the tree. An exemption that outlives',
      'its reason is a permission nobody re-checked, and it is exactly the cover a',
      'reintroduced capability would arrive under.',
    ].join(' ')).toEqual([]);
  });
});

/**
 * PART B — the deployment manifest.
 *
 * The remnant was not hidden. It was declared, in the compose file, as
 * `payload-intel`, built from `./intel`, published on port 4000 — and no
 * check read that file as a list of things that RUN. `docker-compose.yml`
 * was already classified `outward-facing` and scanned for what it
 * ADVERTISES; nothing asked what it STARTS.
 *
 * WHY THE CLASSIFICATION LIVES HERE AND NOT IN PRODUCTION, which is the
 * opposite of the call `routeGate.ts` made for routes. There, enablement is
 * DERIVED from the disposition at runtime, so classifying a route and
 * deciding whether it is live are the same act and the map belongs in
 * production. Nothing in the application reads the compose file, so a
 * production module here would export a list with no runtime consumer — a
 * second enumeration whose only reader is this test. The compose file itself
 * is the population, the map below is only its classification, and the
 * conservation check runs BOTH ways so neither can drift.
 */
type ServiceDisposition =
  /** The freight instrument itself, or plumbing that serves it. */
  | 'instrument'
  /** Caching, proxying, and other deployment plumbing. */
  | 'ops';

const SERVICE_DISPOSITION: Readonly<Record<string, ServiceDisposition>> = {
  payload: 'instrument',
  'payload-cache': 'ops',
};

/** Top-level service keys under `services:` in the compose file. */
function composeServices(): string[] {
  const source = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
  const lines = source.split('\n');
  const out: string[] = [];
  let inServices = false;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    // A non-indented, non-comment, non-blank line ends the services block.
    if (/^\S/.test(line)) break;
    const m = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out.sort();
}

const SERVICES = composeServices();

describe('every service the deployment starts is classified', () => {
  it('parses services out of the compose file (the gate must not pass by being empty)', () => {
    expect(SERVICES.length).toBeGreaterThan(0);
    expect(SERVICES).toContain('payload');
  });

  it('classifies every service — an unclassified service is a process nobody looked at', () => {
    const unclassified = SERVICES.filter((s) => !(s in SERVICE_DISPOSITION));
    expect(unclassified, [
      'These services are started by the deployment and carry no declared disposition.',
      'A container is a door. `payload-intel` stood in this file for 68 phases running a',
      'person resolver and an IP geolocator, declared in plain sight, because every check',
      'that read this file asked what it ADVERTISED and none asked what it STARTS.',
    ].join(' ')).toEqual([]);
  });

  it('has no stale classification (a removed service must leave the register)', () => {
    const present = new Set(SERVICES);
    const stale = Object.keys(SERVICE_DISPOSITION).filter((s) => !present.has(s));
    expect(stale, 'classified services that the compose file no longer starts').toEqual([]);
  });

  /**
   * A service built from a local directory ships that directory's code. The
   * scan in Part A must actually reach it, or the classification above is a
   * label over an unread process.
   */
  it('scans the source of every locally-built service', () => {
    const source = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    const contexts = [...source.matchAll(/^\s*context:\s*(\S+)\s*$/gm)].map((m) => m[1]);
    const unscanned: string[] = [];
    for (const ctx of contexts) {
      const dir = ctx.replace(/^\.\//, '').replace(/^\.$/, '');
      if (dir === '') continue; // the repo root: covered by the whole surface
      if (!existsSync(join(ROOT, dir))) {
        unscanned.push(`${ctx}: build context does not exist`);
        continue;
      }
      const covered = SURFACE.some((f) => f.startsWith(`${dir}/`));
      if (!covered) unscanned.push(`${ctx}: no source file under it is scanned by Part A`);
    }
    expect(unscanned, [
      'A service is built from a directory whose source the capability scan never reads.',
      'Classifying a container without reading what it runs is the label-over-an-unread',
      'process the route gate already paid for once.',
    ].join(' ')).toEqual([]);
  });
});

/**
 * PART C — what a route ADMITS as a subject.
 *
 * The route gate's person markers match parameter NAMES. `entity/expand`
 * named its parameters `type` and `id` and carried the prohibited subject as
 * a VALUE in an allowlist. The marker set could not see it, the
 * classification called it `'freight'`, and the route forwarded
 * `type=person` and `type=ip` to the resolver.
 *
 * So: a route may not ADMIT a natural person or a host as the subject it
 * resolves, whatever its parameters are called.
 */
const PROHIBITED_SUBJECTS = new Set(['person', 'ip', 'phone', 'email', 'username', 'ssn', 'dob']);

const API_ROOT = join(ROOT, 'src/app/api');

function routeFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, prefix ? `${prefix}/${entry}` : entry);
      else if (entry === 'route.ts') out.push(prefix);
    }
  };
  walk(API_ROOT, '');
  return out.sort();
}

describe('no route admits a natural person or a host as its subject', () => {
  const ROUTES = routeFiles();

  it('finds routes to check (the gate must not pass by being empty)', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
  });

  it('declares no subject allowlist containing a person or a host', () => {
    const findings: string[] = [];
    for (const route of ROUTES) {
      const source = readFileSync(join(API_ROOT, route, 'route.ts'), 'utf8');
      // Allowlist-shaped declarations: `const ALLOWED_TYPES = new Set([...])`
      // and `const VALID_KINDS = [...]`, which is the shape the remnant used.
      const decls = source.matchAll(
        /\b(?:ALLOWED|PERMITTED|VALID|SUPPORTED)[A-Z_]*\b[^=\n]*=\s*(?:new Set\()?\s*\[([^\]]*)\]/g,
      );
      for (const decl of decls) {
        const values = [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1].toLowerCase());
        for (const value of values) {
          if (PROHIBITED_SUBJECTS.has(value)) {
            findings.push(`${route}: admits '${value}' as a resolvable subject`);
          }
        }
      }
    }
    expect(findings, [
      'A route admits a natural person or a host as the subject it resolves. The route',
      "gate's person markers match parameter NAMES, so a route whose params are called",
      "'type' and 'id' passes it while forwarding type=person to a resolver. What a route",
      'admits is part of what it does, and it is checked here because it was not there.',
    ].join(' ')).toEqual([]);
  });
});

/**
 * PART D — THE RETIRED IDENTITY (ledger phase 76).
 *
 * Phase 47 swept the pre-fork name and domain out of the tree and listed what
 * it had deliberately left. Five tracked files kept the pre-fork production
 * domain anyway, and none of them was on that list:
 *
 *   public/robots.txt          the crawler-facing identity line, plus a
 *                              `Sitemap:` pointing at the retired host
 *   public/sitemap.xml         `<loc>` naming the retired host as canonical
 *   src/app/docs/DocsClient    the pre-hydration origin for every
 *                              copy-pasteable curl on the docs page
 *   src/components/PayloadMap  the fallback link on an SDK entity popup
 *   deploy.sh                  printed "<retired host> is live" to the
 *                              operator on every deploy
 *
 * Phase 47's reasoning was that the name ASSERTS A PURPOSE — it swept the
 * outbound User-Agent for exactly that reason. These five assert it to
 * crawlers, to readers, and to the operator's own terminal.
 *
 * The gate is a scan rather than a list, because the previous remedy WAS a
 * list and the list is what fell behind. Scoped to the tracked working tree
 * minus `docs/`, which is the historical record: the ledger describes the
 * pre-fork era and renaming it would falsify it.
 */
const RETIRED_IDENTITY: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /osirisai\.live/i, what: 'the pre-fork production domain' },
  { pattern: /Osiris Global Intelligence/i, what: 'the pre-fork platform name' },
  /**
   * DEPLOYING the upstream project, as distinct from CREDITING it (phase 78).
   *
   * `DOCKER.md` — the shipped self-hosting guide — told an operator to clone
   * the un-forked upstream repository and to `docker pull` its image, under
   * the container name `payload`. Following the documented steps stands up the
   * original reconnaissance platform, with every person-targeting and
   * host-scanning route A-0 deleted, still in it. The compose file repeated
   * the instruction, and the CasaOS store tile fetched its icon and screenshots
   * from that repository at runtime.
   *
   * Every deletion this project has made is bypassed by an operator who
   * follows its own deployment guide, which makes this the widest gap the
   * route-surface work has left — the routes were removed from the tree and
   * the tree was not what the guide installed.
   *
   * THE LINE, and why these patterns are shaped the way they are: attribution
   * NAMES the origin, an instruction RUNS it. Phase 46 deliberately kept the
   * upstream credit in `README.md` — the fork's origin is a fact and the MIT
   * licence is honoured — so a prose link must stay legal. These match only
   * the executable forms: a registry pull, a clone command, a runtime asset
   * fetch.
   */
  { pattern: /ghcr\.io\/simplifaisoul/i, what: 'a pull of the upstream OSINT image' },
  { pattern: /git\s+clone\s+\S*github\.com\/simplifaisoul/i, what: 'a clone of the upstream OSINT repository' },
  { pattern: /raw\.githubusercontent\.com\/simplifaisoul/i, what: 'a runtime asset fetch from the upstream OSINT repository' },
];

/** A wider net than the capability scan: identity travels in prose and config. */
const IDENTITY_EXT = /\.(?:js|mjs|cjs|ts|tsx|py|sh|txt|xml|json|webmanifest|yml|yaml|md)$/;

function identitySurface(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!IDENTITY_EXT.test(entry)) continue;
      const rel = relative(ROOT, full).split(sep).join('/');
      if (rel.startsWith('package-lock.json')) continue;
      // Tests are the checking apparatus, not the shipped identity, and this
      // check CANNOT exclude itself any other way: the patterns below have to
      // contain the strings they forbid. That is the fourth time in nine
      // phases a marker has matched the prose defining it — the phase-73
      // remedy (don't write the literal) is unavailable when the literal IS
      // the rule, so the scope excludes the apparatus instead, by a rule
      // rather than by an exemption for one file. Part A draws the same line.
      if (/\.test\.(?:ts|tsx|mjs)$/.test(rel)) continue;
      out.push(rel);
    }
  };
  walk(ROOT);
  return out.sort();
}

describe('the instrument asserts no retired identity', () => {
  const SURFACE_D = identitySurface();

  it('finds files to check (the gate must not pass by being empty)', () => {
    expect(SURFACE_D.length).toBeGreaterThan(50);
    expect(SURFACE_D).toContain('public/robots.txt');
  });

  it('names the pre-fork platform or domain nowhere outside the historical record', () => {
    const findings: string[] = [];
    for (const file of SURFACE_D) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const { pattern, what } of RETIRED_IDENTITY) {
        if (pattern.test(source)) findings.push(`${file}: asserts ${what}`);
      }
    }
    expect(findings, [
      'A tracked artifact still carries the pre-fork identity. Phase 47 swept the name',
      'on the argument that it ASSERTS A PURPOSE the application does not have, and then',
      'left five files asserting it to crawlers, to readers of the docs, and to the',
      'operator\'s own terminal. The remedy that failed was a list; this is a scan.',
    ].join(' ')).toEqual([]);
  });
});
