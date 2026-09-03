import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { compileCorpusAgentContext } from './corpusAgentContext';
import { buildCorpusAgentResult } from './corpusAgentArtifacts';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { buildCorpusContextPackage, planCorpusRetrieval } from './corpusRetrieval';
import { buildCorpusSpatialResult } from './corpusSpatialResult';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';
import { SqliteCorpusAgentArtifactStore } from './sqliteCorpusAgentArtifactStore';

const at = '2026-09-02T17:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-agent-artifacts-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const records: CorpusRecordInput[] = [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:result', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:result', sourceId: 'source:result', title: 'Result source', sourceUrl: 'https://example.test/result', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:result', recordType: 'entity', knownAt: at, entityId: 'pe:facility:result', entityKind: 'facility', canonicalName: 'Result Facility', location: { lat: 43.65, lng: -79.38, precision: 'site' }, evidenceIds: ['evidence:result'], access: OPEN_PUBLIC_CORPUS_ACCESS },
  ];
  const appended = corpus.append('global', records, at);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const projection = buildPublicProjection(corpus.projectionSource('global', at), at);
  const plan = planCorpusRetrieval(projection, { query: 'Result Facility', entityIds: ['pe:facility:result'] });
  const context = buildCorpusContextPackage(projection, plan);
  const result = (level: 'FAST' | 'VERIFIED') => {
    const agentContext = compileCorpusAgentContext(projection, plan, context, level);
    return buildCorpusAgentResult({ plan, agentContext, spatial: buildCorpusSpatialResult(agentContext) });
  };
  return { directory, corpus, result };
}

describe('SQLite corpus agent-artifact journal', () => {
  it('persists deterministic results in one immutable, restart-verifiable sequence', () => {
    const value = fixture();
    const path = join(value.directory, 'agent-artifacts.sqlite');
    try {
      const store = new SqliteCorpusAgentArtifactStore(path);
      const fast = value.result('FAST');
      const verified = value.result('VERIFIED');
      expect(fast.output.resultManifest).toMatchObject({
        schema: 'notation.result-manifest.v1',
        methodology: { capabilityId: 'agent-result-sidecar', capabilityStatus: 'BETA' },
        corpus: { corpusBuildId: fast.corpusBuildId, projectionDigest: fast.projectionDigest },
        uncertainty: { spatialState: 'OBSERVED' },
        verification: { level: 'PROVENANCE', sourceTruthClaimed: false, commitmentId: null },
        deliberateNonClaims: expect.arrayContaining([expect.stringContaining('source observations are empirically true')]),
        manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(verified.output.resultManifest.verification).toMatchObject({ level: 'REPRODUCIBLE', sourceTruthClaimed: false, commitmentId: expect.stringMatching(/^corpus-commitment:/), attestationStatus: 'NOT_ATTESTED', zkProofStatus: 'NOT_GENERATED' });
      const first = store.append('global', { artifactType: 'agent_result', artifactId: fast.resultId, corpusBuildId: fast.corpusBuildId, payload: fast }, at);
      const second = store.append('global', { artifactType: 'agent_result', artifactId: verified.resultId, corpusBuildId: verified.corpusBuildId, payload: verified }, '2026-09-02T17:01:00.000Z');
      const replay = store.append('global', { artifactType: 'agent_result', artifactId: fast.resultId, corpusBuildId: fast.corpusBuildId, payload: fast }, '2026-09-02T17:02:00.000Z');
      expect(first).toMatchObject({ idempotent: false, artifact: { sequence: 1, previousHash: null } });
      expect(second).toMatchObject({ idempotent: false, artifact: { sequence: 2, previousHash: first.artifact.artifactHash } });
      expect(replay).toMatchObject({ idempotent: true, artifact: { sequence: 1, recordedAt: at } });
      expect(store.get('global', verified.resultId)?.payload).toEqual(verified);
      expect(store.page({ limit: 1 })).toMatchObject({ hasMore: true, nextAfterSequence: 1, artifacts: [{ artifactId: fast.resultId }] });
      expect(store.recent({ limit: 1 }).map(artifact => artifact.artifactId)).toEqual([verified.resultId]);
      store.close();

      const reopened = new SqliteCorpusAgentArtifactStore(path);
      expect(reopened.page().artifacts.map(artifact => artifact.artifactId)).toEqual([fast.resultId, verified.resultId]);
      reopened.close();

      const raw = new Database(path);
      expect(() => raw.prepare("UPDATE corpus_agent_artifacts SET artifact_json = '{}' WHERE sequence = 1").run()).toThrow(/IMMUTABLE/);
      expect(() => raw.prepare('DELETE FROM corpus_agent_artifacts WHERE sequence = 1').run()).toThrow(/IMMUTABLE/);
      raw.close();
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
