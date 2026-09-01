import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT, VERSION, REPO_URL, userAgent, isWellFormedUserAgent } from './identity';

const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * `identity.ts` and this file both quote the malformed forms on purpose —
 * one to document what it prevents, one to assert the detector fires on
 * them. Excluding exactly these two, by name, is the smallest exclusion
 * that does not blind the check to anything else; the module's own output
 * is covered by the unit tests above, which is what makes the exclusion
 * safe rather than convenient.
 */
const SELF = ['identity.ts', 'identity.test.ts'];
const FILES = walk(SRC).filter(f => !SELF.some(s => f.endsWith(`/${s}`)));

describe('the product token', () => {
  it('is one token — the defect this module exists for', () => {
    expect(PRODUCT).not.toMatch(/\s/);
    expect(isWellFormedUserAgent(userAgent())).toBe(true);
    expect(isWellFormedUserAgent(userAgent('a role with spaces'))).toBe(true);
  });

  it('rejects exactly the shape the branding sweep produced', () => {
    // What was actually in the tree, on twelve files.
    expect(isWellFormedUserAgent('Payload Terminal/4.2')).toBe(false);
    expect(isWellFormedUserAgent('Payload Terminal-Tile-Proxy/1.0')).toBe(false);
    expect(isWellFormedUserAgent('Payload Terminal Severe Weather Layer')).toBe(false);
    // And accepts the well-formed forms it must not over-reject.
    expect(isWellFormedUserAgent('PayloadTerminal/0.1.0 (+https://example.invalid)')).toBe(true);
    expect(isWellFormedUserAgent('Mozilla/5.0 (Windows NT 10.0) Chrome/126.0.0.0')).toBe(true);
  });

  it('states the version package.json states', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('names the repository this source is actually in', () => {
    // A URL handed to upstream operators and printed in the public docs has
    // to resolve to THIS project. Both previous values are pinned out by
    // name: one was a different owner's repository, the other was this
    // repository's former name, which GitHub still redirects — and a
    // redirect is not a name.
    expect(REPO_URL).toContain('notationsystems');
    expect(REPO_URL).not.toContain('simplifaisoul');
    expect(REPO_URL).not.toContain('Notations-OSIRIS-Overwatch-Engine');
  });

  it('the docs clone command names the directory the clone actually creates', () => {
    // The `cd` after a `git clone` said `cd payload`, which is not what any
    // clone of this repository produces. That is checkable forever from
    // inside the tree, so it is checked, and it is the half of the URL
    // problem a test can hold.
    const docs = readFileSync(join(SRC, 'app/docs/DocsClient.tsx'), 'utf8');
    const clone = docs.match(/git clone (\S+)\.git\s*\ncd (\S+)/);
    expect(clone, 'the docs no longer contain a clone-then-cd block').not.toBeNull();
    const [, cloneUrl, cd] = clone!;
    expect(cloneUrl).toBe(REPO_URL);
    expect(cd).toBe(REPO_URL.split('/').pop());
  });
});

/**
 * THE STANDING CHECK. A pin on the identity module alone would hold while
 * the next hand-written header walked straight past it, which is the class
 * of defect this whole project keeps naming: a check correct about what it
 * examined and silent about what shipped.
 */
describe('every outbound identity in the tree, not just the module', () => {
  const IDENTITY_HEADER = /['"]User-Agent['"]\s*:\s*(['"`])((?:(?!\1).)*)\1/gi;

  it('no source file hand-writes a malformed User-Agent literal', () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(IDENTITY_HEADER)) {
        const ua = m[2];
        // stealthFetch deliberately impersonates a browser; those literals
        // are a separate mechanism with their own reason, and they are
        // well-formed anyway.
        if (!isWellFormedUserAgent(ua)) {
          offenders.push(`${f.replace(process.cwd() + '/', '')}: ${ua}`);
        }
      }
    }
    expect(offenders, `malformed User-Agent literals:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('no source file still points at the wrong repository', () => {
    const offenders = FILES
      .filter(f => readFileSync(f, 'utf8').includes('simplifaisoul'))
      .map(f => f.replace(process.cwd() + '/', ''));
    expect(offenders, `wrong repository URL in:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the product name never reaches an outbound header with a space in it', () => {
    // Catches the sweep's exact failure even in a header this test does not
    // know the name of: the two-word display name adjacent to a version.
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/Payload Terminal[-/]\S/g)) {
        offenders.push(`${f.replace(process.cwd() + '/', '')}: ${m[0]}`);
      }
    }
    expect(offenders, `display name used as an identifier:\n${offenders.join('\n')}`).toEqual([]);
  });
});
