import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CorpusReplayTarget } from './corpusRepository';
import { collectCorpusReplayRecords, replayCorpusToCentral } from './corpusReplay';
import {
  PhysicalEconomyCorpus,
  corpusRecordInput,
  type CorpusRecordInput,
  type StoredCorpusRecord,
} from './physicalEconomyCorpus';

const evidence = (suffix: string, knownAt: string): CorpusRecordInput => ({
  schema: 'payload.corpus.record.v1',
  recordId: `rec:evidence:${suffix}:v1`,
  recordType: 'evidence',
  knownAt,
  evidenceId: `evidence:${suffix}`,
  sourceId: `source:${suffix}`,
  title: `${suffix} evidence`,
  sourceUrl: `https://example.test/${suffix}`,
  artifactSha256: (suffix === 'global' ? 'a' : 'b').repeat(64),
  retrievedAt: knownAt,
});

class PhysicalReplayTarget implements CorpusReplayTarget {
  readonly backend = 'postgresql' as const;
  readonly databasePath: string;
  private readonly corpus: PhysicalEconomyCorpus;
  constructor(path: string, private readonly tamper = false) {
    this.databasePath = path;
    this.corpus = new PhysicalEconomyCorpus(path);
  }
  close() { this.corpus.close(); }
  summary() { return this.corpus.summary(); }
  append(...args: Parameters<PhysicalEconomyCorpus['append']>) { return this.corpus.append(...args); }
  page(...args: Parameters<PhysicalEconomyCorpus['page']>) { return this.corpus.page(...args); }
  projectionSource(...args: Parameters<PhysicalEconomyCorpus['projectionSource']>) { return this.corpus.projectionSource(...args); }
  findFacilities(...args: Parameters<PhysicalEconomyCorpus['findFacilities']>) { return this.corpus.findFacilities(...args); }
  readProjectionEvents(...args: Parameters<PhysicalEconomyCorpus['readProjectionEvents']>) { return this.corpus.readProjectionEvents(...args); }
  checkpointProjection(...args: Parameters<PhysicalEconomyCorpus['checkpointProjection']>) { return this.corpus.checkpointProjection(...args); }
  async replayPage(...args: Parameters<PhysicalEconomyCorpus['replayPage']>) { return this.corpus.replayPage(...args); }
  async importReplayRecords(records: readonly StoredCorpusRecord[]) {
    for (const [index, record] of records.entries()) {
      const input = corpusRecordInput(record);
      const altered = this.tamper && index === records.length - 1 && input.recordType === 'evidence'
        ? { ...input, title: `${input.title} altered` }
        : input;
      const result = this.corpus.append(record.scope, [altered], record.recordedAt);
      if (result.kind !== 'committed') throw new Error(result.code);
    }
    return { imported: records.length, lastSequence: records.at(-1)?.sequence ?? 0 };
  }
}

describe('edge-to-central corpus replay', () => {
  it('preserves global sequence, scope chains, canonical hashes, and projection digests', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payload-corpus-replay-'));
    const edge = new PhysicalEconomyCorpus(join(directory, 'edge.sqlite'));
    const central = new PhysicalReplayTarget(join(directory, 'central.sqlite'));
    try {
      edge.append('global', [evidence('global', '2026-01-01T00:00:00.000Z')], '2026-01-01T00:01:00.000Z');
      edge.append('customer:acme', [evidence('private', '2026-01-02T00:00:00.000Z')], '2026-01-02T00:01:00.000Z');
      const dryRun = await replayCorpusToCentral(edge, central, { apply: false, knowledgeCutoff: '2026-01-03T00:00:00.000Z' });
      expect(dryRun).toMatchObject({ kind: 'corpus_replay_plan', recordCount: 2, firstSequence: 1, lastSequence: 2, scopes: ['customer:acme', 'global'] });
      const applied = await replayCorpusToCentral(edge, central, { apply: true, knowledgeCutoff: '2026-01-03T00:00:00.000Z' });
      expect(applied).toMatchObject({ kind: 'corpus_replay_verified', imported: 2 });
      if (applied.kind === 'corpus_replay_verified') {
        expect(applied.edgeCanonicalDigest).toBe(applied.centralCanonicalDigest);
        expect(applied.projections).toHaveLength(2);
      }
      expect((await collectCorpusReplayRecords(central)).map(record => record.recordHash))
        .toEqual((await collectCorpusReplayRecords(edge)).map(record => record.recordHash));
    } finally { edge.close(); central.close(); }
  });

  it('refuses a target that changes one canonical byte during replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'payload-corpus-replay-tamper-'));
    const edge = new PhysicalEconomyCorpus(join(directory, 'edge.sqlite'));
    const central = new PhysicalReplayTarget(join(directory, 'central.sqlite'), true);
    try {
      edge.append('global', [evidence('global', '2026-01-01T00:00:00.000Z')], '2026-01-01T00:01:00.000Z');
      await expect(replayCorpusToCentral(edge, central, { apply: true, knowledgeCutoff: '2026-01-03T00:00:00.000Z' }))
        .rejects.toThrow(/CANONICAL_MISMATCH/);
    } finally { edge.close(); central.close(); }
  });
});
