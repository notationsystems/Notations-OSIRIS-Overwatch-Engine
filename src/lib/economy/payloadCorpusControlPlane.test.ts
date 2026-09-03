import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CorpusAgentArtifactPage, StoredCorpusAgentArtifact } from './corpusAgentArtifacts';
import { corpusAttestationKeyId, signCorpusBuildAttestation } from './corpusBuildAttestation';
import { compileCorpusKnowledgeIndex } from './corpusKnowledgeIndex';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPayloadCorpusControlPlane } from './payloadCorpusControlPlane';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';
import { buildCorpusCommitment } from './corpusVerification';
import { payloadSp1ProgramIdentity } from './sp1ProgramIdentity';

const NOW = '2026-09-02T16:00:00.000Z';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'payload-control-plane-'));
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const records: CorpusRecordInput[] = [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:control', recordType: 'evidence', knownAt: NOW, evidenceId: 'evidence:control', sourceId: 'source:port-authority', title: 'Port authority report', sourceUrl: 'https://example.test/port', artifactSha256: 'a'.repeat(64), retrievedAt: NOW, access: OPEN_PUBLIC_CORPUS_ACCESS },
    { schema: 'payload.corpus.record.v1', recordId: 'record:entity:control', recordType: 'entity', knownAt: NOW, entityId: 'pe:port:control', entityKind: 'port', canonicalName: 'Control Port', location: { lng: -79.38, lat: 43.65, precision: 'exact' }, evidenceIds: ['evidence:control'], access: OPEN_PUBLIC_CORPUS_ACCESS },
  ];
  const appended = corpus.append('global', records, NOW);
  if (appended.kind !== 'committed') throw new Error(appended.code);
  const source = corpus.projectionSource('global', NOW);
  const projection = buildPublicProjection(source, NOW);
  return { directory, corpus, source, projection };
}

function emptyPage(): CorpusAgentArtifactPage {
  return { kind: 'corpus_agent_artifact_page', scope: 'global', afterSequence: 0, nextAfterSequence: 0, hasMore: false, artifacts: [] };
}

describe('Payload physical-economy control plane', () => {
  it('models the real corpus topology and leaves unavailable operations telemetry unobserved', () => {
    const value = fixture();
    try {
      const snapshot = buildPayloadCorpusControlPlane({
        generatedAt: NOW,
        projectionStaleAfterMs: 86_400_000,
        canonical: { backend: 'sqlite', source: value.source },
        projection: value.projection,
        projectionCurrent: true,
        index: { backend: 'sqlite', manifest: compileCorpusKnowledgeIndex(value.projection, NOW).manifest, current: true },
        artifactBackend: 'sqlite',
        artifactPage: emptyPage(),
        recentArtifacts: [],
        currentBuildAttestation: null,
        sp1: payloadSp1ProgramIdentity(),
      });
      expect(snapshot).toMatchObject({
        schema: 'payload.corpus.control-plane.v1',
        ecosystemId: 'payload:physical-economy',
        dock: { spatial: { status: 'UNOBSERVED', code: 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED' } },
      });
      expect(snapshot.topology.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 'payload:corpus:canonical', health: expect.objectContaining({ status: 'healthy' }) }),
        expect.objectContaining({ nodeId: 'payload:corpus:projection', health: expect.objectContaining({ status: 'healthy' }) }),
        expect.objectContaining({ nodeId: 'payload:source:source:port-authority', health: expect.objectContaining({ status: 'unobserved' }) }),
        expect.objectContaining({ nodeId: 'payload:proof:payload-event-batch-v1', metadata: expect.objectContaining({ appliesToCorpusBuild: false }) }),
      ]));
      const query = snapshot.topology.nodes.find(node => node.nodeId === 'payload:mcp:query')!;
      expect(query.capabilities[0]).toMatchObject({ latency: { status: 'UNOBSERVED' }, cost: { status: 'UNOBSERVED' } });
      expect(snapshot.operator.attention.map(item => item.code)).toEqual(expect.arrayContaining(['CORPUS_BUILD_UNSIGNED', 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED']));
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });

  it('turns a persisted build signature into a non-dispatch timeline event', () => {
    const value = fixture();
    try {
      const { privateKey } = generateKeyPairSync('ed25519');
      const attestation = signCorpusBuildAttestation({
        manifest: value.projection.manifest,
        commitment: buildCorpusCommitment(value.projection.manifest, value.projection.records),
        signer: { keyId: corpusAttestationKeyId(privateKey), privateKey },
        signedAt: NOW,
      });
      const stored: StoredCorpusAgentArtifact = {
        artifactType: 'build_attestation', artifactId: attestation.attestationId,
        corpusBuildId: attestation.statement.corpusBuildId, payload: attestation,
        sequence: 1, scope: 'global', recordedAt: NOW, previousHash: null, artifactHash: 'b'.repeat(64),
      };
      const page: CorpusAgentArtifactPage = { ...emptyPage(), nextAfterSequence: 1, artifacts: [stored] };
      const snapshot = buildPayloadCorpusControlPlane({
        generatedAt: NOW, projectionStaleAfterMs: 86_400_000,
        canonical: { backend: 'sqlite', source: value.source }, projection: value.projection, projectionCurrent: true,
        index: { backend: 'sqlite', manifest: compileCorpusKnowledgeIndex(value.projection, NOW).manifest, current: true },
        artifactBackend: 'sqlite', artifactPage: page, recentArtifacts: [stored], currentBuildAttestation: stored,
        sp1: payloadSp1ProgramIdentity(),
      });
      expect(snapshot.timeline.events).toEqual([
        expect.objectContaining({ sequence: 1, changed: 'corpus_build_attested', requestedBy: { id: 'payload:role:corpus-compiler', basis: 'AUTHENTICATED_ROLE' }, dispatched: false }),
      ]);
      expect(snapshot.topology.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 'payload:attestation:ed25519', health: expect.objectContaining({ status: 'healthy' }) }),
        expect.objectContaining({ nodeId: 'payload:index:knowledge', health: expect.objectContaining({ status: 'healthy' }) }),
      ]));
      expect(snapshot.operator.attention.map(item => item.code)).not.toContain('CORPUS_BUILD_UNSIGNED');
    } finally {
      value.corpus.close();
      rmSync(value.directory, { recursive: true, force: true });
    }
  });
});
