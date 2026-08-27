import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The generator module is the single source of the walk and the rules —
// the test verifies the COMMITTED manifest against the tree using the
// same walk, so the two cannot drift apart.
import { ARCHIVE_ROOTS, LIVE_LOGS, MANIFEST_PATH, buildManifest, durabilityClassOf } from '../../../scripts/archive-manifest.mjs';
import { writeFileSync, rmSync, existsSync } from 'node:fs';

/**
 * Shipping order S-2: the archive verifies against itself, in CI.
 *
 * The property, not the enumeration: every manifest entry resolves to
 * bytes whose hash matches (corruption/edit detection), every file under
 * the archive roots is indexed with a durability class (addition
 * detection — a baseline that only fires on growth rots in the shrink
 * direction, so both directions are asserted), and the unreconstructable
 * set is non-empty (vacuity: the class this whole item exists for is
 * actually populated).
 */
describe('archive manifest (S-2)', () => {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), MANIFEST_PATH), 'utf8')) as {
    counts: Record<string, number>;
    files: Array<{ path: string; sha256: string; bytes: number; class: string }>;
  };

  it('every manifest entry resolves to bytes whose hash matches', () => {
    for (const f of manifest.files) {
      const bytes = readFileSync(join(process.cwd(), f.path));
      expect(bytes.length, `${f.path} byte count`).toBe(f.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), `${f.path} sha256`).toBe(f.sha256);
      expect(f.class, `${f.path} durability class`).toBeTruthy();
    }
  });

  it('every file under the archive roots is indexed — additions and deletions both fail', () => {
    // Rebuilt from the tree with the generator's own walk: a file added
    // without regenerating the manifest, a file deleted, or a rule gap
    // all surface here with the path named.
    const fresh = buildManifest(process.cwd());
    const inManifest = new Set(manifest.files.map(f => f.path));
    const inTree = new Set(fresh.files.map(f => f.path));
    const unindexed = [...inTree].filter(p => !inManifest.has(p));
    const vanished = [...inManifest].filter(p => !inTree.has(p));
    expect(unindexed, `files present but not indexed — run: node scripts/archive-manifest.mjs`).toEqual([]);
    expect(vanished, 'indexed files missing from the tree').toEqual([]);
  });

  it('the unreconstructable set is non-empty and correctly ruled — the class this item exists for', () => {
    expect(manifest.counts.unreconstructable).toBeGreaterThan(0);
    // Every Comtrade capture is unreconstructable by rule (revised in
    // place upstream; no prior-version archive exists anywhere).
    for (const f of manifest.files) {
      if (f.path.includes('comtrade')) expect(f.class, f.path).toBe('unreconstructable');
    }
    // Discriminating check on the rules themselves: a hypothetical
    // unruled path throws rather than defaulting to a class — an
    // unclassified archive file is an unlabelled risk, refused loudly.
    expect(durabilityClassOf('data-archive/new-source/capture.json')).toBeNull();
    expect(ARCHIVE_ROOTS.length).toBeGreaterThan(1); // both roots covered
  });

  it('live demand logs are excluded BY NAME — a used instrument still verifies (F-4 finding)', () => {
    // Before this exclusion, the first production run to log a search miss
    // or an MCP call would fail buildManifest (unruled path) on the next
    // suite run — the verifier punishing the instrument for being used.
    expect(LIVE_LOGS).toContain('data-archive/mcp-sessions.jsonl');
    const plant = join(process.cwd(), 'data-archive/mcp-sessions.jsonl');
    const existed = existsSync(plant);
    if (!existed) writeFileSync(plant, '{"ts":"2026-08-27T00:00:00Z","session":"plant","tool":"search_entities","refusals":0}\n');
    try {
      const fresh = buildManifest(process.cwd()); // must NOT throw with the live log on disk
      expect(fresh.files.some(f => f.path === 'data-archive/mcp-sessions.jsonl')).toBe(false);
    } finally {
      if (!existed) rmSync(plant);
    }
  });
});
