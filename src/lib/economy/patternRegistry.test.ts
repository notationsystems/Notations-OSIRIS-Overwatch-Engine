import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { mineSharedDependencies } from './corpusMining';
import { buildPublicProjection } from './corpusProjection';
import { PatternRegistry } from './patternRegistry';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const directories: string[] = [];
const at = '2026-09-03T01:00:00.000Z';

function records(): CorpusRecordInput[] {
  const evidenceId = 'evidence:registry';
  return [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:registry', recordType: 'evidence', knownAt: at, evidenceId, sourceId: 'source:registry', title: 'Dependency evidence', sourceUrl: 'https://example.test/registry', artifactSha256: 'b'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
    ...['one', 'two', 'shared'].map(name => ({ schema: 'payload.corpus.record.v1' as const, recordId: `record:entity:${name}`, recordType: 'entity' as const, knownAt: at, entityId: `pe:organization:${name}`, entityKind: 'organization' as const, canonicalName: name, evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS })),
    ...['one', 'two'].map(name => ({ schema: 'payload.corpus.record.v1' as const, recordId: `record:relationship:${name}`, recordType: 'relationship' as const, knownAt: at, relationshipId: `relationship:${name}-shared`, subjectEntityId: `pe:organization:${name}`, predicate: 'depends_on' as const, objectEntityId: 'pe:organization:shared', valueKind: 'reported' as const, confidence: 'high' as const, evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS })),
  ];
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'payload-pattern-registry-'));
  directories.push(directory);
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  expect(corpus.append('global', records(), at).kind).toBe('committed');
  const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
  const result = mineSharedDependencies(projection, { executedAt: at });
  return { directory, corpus, result };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Pattern Registry', () => {
  it('persists an exact mining run append-only and makes replay idempotent', async () => {
    const { directory, corpus, result } = await setup();
    const registry = new PatternRegistry(join(directory, 'patterns.sqlite'));
    try {
      expect(registry.register(result)).toMatchObject({ kind: 'mining_registered', idempotent: false, run: { sequence: 1 }, candidates: [{ validationStatus: 'CANDIDATE' }] });
      expect(registry.register(result)).toMatchObject({ kind: 'mining_registered', idempotent: true, run: { sequence: 1 } });
      expect(registry.summary()).toMatchObject({ lastSequence: 1, runCount: 1, candidateCount: 1 });
      expect(registry.page()).toMatchObject({ nextAfterSequence: 1, hasMore: false, runs: [{ candidates: [{ patternType: 'SHARED_DEPENDENCY' }] }] });
      expect(corpus.summary().lastSequence).toBe(6);
    } finally { registry.close(); corpus.close(); }
  });

  it('refuses candidate tampering when the disposable registry is reopened', async () => {
    const { directory, corpus, result } = await setup();
    const path = join(directory, 'patterns.sqlite');
    const registry = new PatternRegistry(path);
    registry.register(result);
    registry.close();
    corpus.close();
    const raw = new Database(path);
    raw.prepare("UPDATE corpus_pattern_candidates SET candidate_json = '{}'").run();
    raw.close();
    expect(() => new PatternRegistry(path)).toThrow(/CORPUS_PATTERN_REGISTRY_CORRUPT/);
  });
});
