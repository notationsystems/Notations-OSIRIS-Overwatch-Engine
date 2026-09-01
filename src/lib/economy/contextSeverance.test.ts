import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE STANDING CHECK FOR CONTEXT SEVERANCE (ledger phase 38).
 *
 * The class, stated: a mechanism whose EFFECTIVE SCOPE is narrower than
 * its APPARENT SCOPE, with nothing failing. Every prior instance in this
 * project has this shape — the world-file commodity filter that dropped
 * aluminium for twenty rounds, the guards that evaluated on copper and
 * were silent about the other partition, and the module-context
 * severance found by running the deployed instance, where the boot
 * report, the outbound limiter and the state warming each ran correctly
 * in a context nobody read from. No exception, no red test, and each
 * mechanism's own self-report was TRUE — about an artifact that was not
 * the one in use.
 *
 * Module-level mutable state is one door into that class, and the only
 * one this test can see. It is not the last door: the next instance will
 * arrive through something else, exactly as the module-context one did
 * after the predicate-scoped ones. What this check does is close THIS
 * door by construction and force every exception to be argued in
 * writing, so the register and the world cannot quietly disagree.
 *
 * The rule: every module-level mutable container in the economy
 * instrument is either reached through `processSingleton` (shared across
 * every module context by construction) or listed below with the reason
 * it is safe to be context-local. Accounting for every drop, applied to
 * state instead of rows.
 */

/**
 * THE ROOTS THIS GUARD WATCHES.
 *
 * It was one directory. The class it catches is not confined to one directory:
 * `src/lib/spatial/` and `src/lib/ui/` hold instrument code today, and a
 * module-level Map in either is severed by exactly the same Next behaviour
 * `processSingleton.ts` documents. A guard scoped to `src/lib/economy` while
 * named for "the economy instrument" has an EFFECTIVE SCOPE narrower than its
 * APPARENT one — the class this suite exists to catch, in the check itself.
 *
 * Adding a root is cheap; discovering a severed cache in production is not.
 */
const SCANNED_ROOTS = ['src/lib/economy', 'src/lib/spatial', 'src/lib/ui', 'src/lib/audit'] as const;
const ECONOMY_DIR = join(process.cwd(), 'src/lib/economy');

/**
 * Deliberate exceptions, each with the argument for it. A new entry here
 * is a claim someone has to defend in review — which is the point.
 */
const CONTEXT_LOCAL_BY_DESIGN: Record<string, string> = {
  // Keyed by ROOT-QUALIFIED path: with more than one root scanned, a bare
  // filename could exempt a file in a directory nobody argued about.
  'src/lib/economy/envCompat.ts':
    'The `warned` set de-duplicates a deprecation warning and nothing reads it. ' +
    'Severed, each module context warns once about the same legacy variable name — ' +
    'the message repeats, no answer changes, and the failure mode is a duplicated ' +
    'log line rather than two contexts disagreeing about a value. The variable ' +
    'itself is read from process.env on every call, which IS shared.',
};

/** Containers whose contents never change after module evaluation are not
 *  state: a severed copy is byte-identical to the original, so severance
 *  cannot change an answer. Matched by SHOUT_CASE naming, which this
 *  codebase uses for constants, AND verified never to be mutated. */
const MUTATORS = /\.(set|add|delete|clear|push|pop|splice|shift|unshift|sort|fill)\s*\(/;

/** `processSingleton(` OR `processSingleton<T>(` — boot.ts passes a type
 *  parameter, and a literal match missed it. Found by this file's own
 *  by-name check failing, which is the check earning its place. */
const REACHES_REGISTRY = /processSingleton\s*(?:<[^>]*>)?\s*\(/;

interface Finding { file: string; line: number; decl: string }

function scan(): Finding[] {
  const out: Finding[] = [];
  for (const root of SCANNED_ROOTS) {
   const dir = join(process.cwd(), root);
   for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, i) => {
      // Module level only: a declaration at column 0.
      const m = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[\s*\]|\{)/.exec(line);
      if (!m) return;
      const name = m[1];
      // Reached through the registry → shared by construction.
      if (REACHES_REGISTRY.test(line) || REACHES_REGISTRY.test(lines[i + 1] ?? '')) return;
      // A constant that is never mutated cannot be severed into disagreement.
      const mutated = new RegExp(`\\b${name}${MUTATORS.source}`).test(src);
      if (!mutated) return;
      out.push({ file: `${root}/${file}`, line: i + 1, decl: line.trim().slice(0, 90) });
    });
   }
  }
  return out;
}

describe('context severance: mutable module state is shared or argued for', () => {
  it('every mutable module-level container is a process singleton or a listed exception', () => {
    const unaccounted = scan().filter(f => !(f.file in CONTEXT_LOCAL_BY_DESIGN));
    expect(
      unaccounted,
      'Mutable module-level state that is NOT reached through processSingleton.\n' +
      'Next duplicates modules across contexts (instrumentation vs routes), so this\n' +
      'state can silently sever: each copy behaves correctly and they disagree, with\n' +
      'nothing thrown. Either wrap it in processSingleton(), or add the file to\n' +
      'CONTEXT_LOCAL_BY_DESIGN with the argument for why severance is harmless:\n' +
      unaccounted.map(f => `  ${f.file}:${f.line}  ${f.decl}`).join('\n'),
    ).toEqual([]);
  });

  /**
   * THE EXEMPTION LIST IS A PREMISE, AND A PREMISE GOES STALE.
   *
   * `CONTEXT_LOCAL_BY_DESIGN` records why a file's module state is safe to
   * sever. If that file is later repaired — the state wrapped in
   * processSingleton, or deleted outright — the entry stays, and a reader
   * of the list believes an exemption is load-bearing when it exempts
   * nothing. Worse, the guard reports green either way, so the list and the
   * tree quietly disagree with the suite agreeing with both.
   *
   * That is the defect class this file names, pointed at this file's own
   * premise: recompute it every run rather than trusting what was true when
   * it was written. Every entry must name a file that exists AND still be
   * flagged by the scanner, or it is removed.
   */
  it('every exemption still earns its place — a repaired file leaves the list', () => {
    const flagged = new Set(scan().map(f => f.file));
    const present = new Set(
      SCANNED_ROOTS.flatMap(root =>
        readdirSync(join(process.cwd(), root)).map(f => `${root}/${f}`)),
    );
    const stale: string[] = [];
    for (const file of Object.keys(CONTEXT_LOCAL_BY_DESIGN)) {
      if (!present.has(file)) { stale.push(`${file} (no such file)`); continue; }
      if (!flagged.has(file)) stale.push(`${file} (no module-level mutable state any more)`);
    }
    expect(stale, [
      'These entries no longer exempt anything. An exemption list that keeps paid-off entries',
      'stops measuring the debt, and an entry for a file that was repaired or deleted reads as',
      'a live argument for a hazard that is gone. Remove them.',
    ].join(' ')).toEqual([]);
  });

  it('every exemption carries an argument, not a placeholder', () => {
    for (const [file, reason] of Object.entries(CONTEXT_LOCAL_BY_DESIGN)) {
      expect(reason.length, `${file} needs the reason severance is harmless, not a note`)
        .toBeGreaterThan(40);
    }
  });

  it('the scanner is not vacuous: it finds planted severable state and ignores constants', () => {
    // A scanner that never fires would pass the check above forever. This
    // asserts it fires on the shape it is meant to catch, and stays quiet
    // on the shape it must not flag.
    const severable = `const cache = new Map<string, number>();\ncache.set('k', 1);\n`;
    const constant = `const LOOKUP = new Set([152]);\nif (LOOKUP.has(152)) {}\n`;
    const wrapped = `const s = processSingleton('x', () => new Map<string, number>());\ns.set('k', 1);\n`;
    const wrappedGeneric = `const s = processSingleton<Map<string, number>>('x', () => new Map());\ns.set('k', 1);\n`;

    const detect = (src: string) => {
      const lines = src.split('\n');
      return lines.some((line, i) => {
        const m = /^(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(new\s+(?:Map|Set|WeakMap|WeakSet)\b|\[\s*\]|\{)/.exec(line);
        if (!m) return false;
        if (REACHES_REGISTRY.test(line) || REACHES_REGISTRY.test(lines[i + 1] ?? '')) return false;
        return new RegExp(`\\b${m[1]}${MUTATORS.source}`).test(src);
      });
    };
    expect(detect(severable), 'must flag mutable module state').toBe(true);
    expect(detect(constant), 'must not flag an immutable lookup').toBe(false);
    expect(detect(wrapped), 'must not flag state already shared').toBe(false);
    // The generic form is the one that slipped past a literal match.
    expect(detect(wrappedGeneric), 'must not flag shared state declared with a type parameter').toBe(false);
  });

  it('the widened roots are actually walked, not just declared', () => {
    // A root added to the list but never read would leave the guard exactly as
    // narrow as before while reading as though it had been widened — the same
    // apparent/effective scope gap, one level up. Assert each root contributes
    // real files to the walk.
    for (const root of SCANNED_ROOTS) {
      const files = readdirSync(join(process.cwd(), root)).filter(
        f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
      expect(files.length, `${root} contributes no scannable file`).toBeGreaterThan(0);
    }
    expect(SCANNED_ROOTS.length).toBeGreaterThan(1);
  });

  it('the instruments that feed the FROZEN continue criterion are shared, by name', () => {
    // Named individually rather than left to the sweep: a severed demand
    // instrument under-reports an afternoon while every write looks
    // correct, and the S-7 criterion cannot be amended afterwards to
    // repair a reading taken through half a session.
    for (const file of ['sessionTelemetry.ts', 'mcpSession.ts', 'store.ts', 'boot.ts', 'observability.ts', 'outboundRate.ts']) {
      const src = readFileSync(join(ECONOMY_DIR, file), 'utf8');
      expect(REACHES_REGISTRY.test(src), `${file} must reach its state through the shared registry`).toBe(true);
    }
  });
});
