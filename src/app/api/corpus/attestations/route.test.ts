import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { POST as retrieve } from '@/app/api/corpus/retrieval/route';
import { corpusAgentArtifactPath, corpusAgentArtifactStore } from '@/lib/economy/corpusAgentArtifactRuntime';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const ENV = ['PAYLOAD_CORPUS_COMPILER_TOKEN', 'PAYLOAD_CORPUS_QUERY_TOKEN', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_DATABASE_PATH', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH', 'PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH', 'PAYLOAD_CORPUS_ATTESTATION_KEY_ID'] as const;
const oldEnv = new Map(ENV.map(name => [name, process.env[name]]));
const directories: string[] = [];
const at = '2026-09-02T18:00:00.000Z';

function request(url: string, method: 'GET' | 'POST', token: string, body?: unknown) {
  return new Request(url, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

afterEach(async () => {
  const corpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (corpusPath) {
    try { await physicalEconomyCorpus('compiler')?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${resolve(corpusPath)}`);
  }
  const projectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  if (projectionPath) {
    try { corpusProjectionStore()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-projection:${resolve(projectionPath)}`);
  }
  const artifactPath = corpusAgentArtifactPath();
  if (artifactPath) {
    try { await corpusAgentArtifactStore('query')?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`corpus-agent-artifacts:sqlite:${artifactPath}`);
  }
  for (const name of ENV) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('/api/corpus/attestations', () => {
  it('signs, persists, retrieves, and applies the exact current CorpusBuild attestation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-attestation-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    const projectionPath = join(directory, 'projection.sqlite');
    const artifactPath = join(directory, 'agent-artifacts.sqlite');
    const keyPath = join(directory, 'corpus-attestation.pem');
    const { privateKey } = generateKeyPairSync('ed25519');
    await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = 'COMPILER-TOKEN';
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    process.env.PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH = artifactPath;
    process.env.PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH = keyPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const records: CorpusRecordInput[] = [
      { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:attestation-api', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:attestation-api', sourceId: 'source:attestation-api', title: 'Attestation API source', sourceUrl: 'https://example.test/attestation-api', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
      { schema: 'payload.corpus.record.v1', recordId: 'record:entity:attestation-api', recordType: 'entity', knownAt: at, entityId: 'pe:facility:attestation-api', entityKind: 'facility', canonicalName: 'Attestation API Facility', location: { lat: 43.65, lng: -79.38, precision: 'site' }, evidenceIds: ['evidence:attestation-api'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    ];
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', records, at).kind).toBe('committed');
    const projection = new CorpusProjectionStore(projectionPath);
    const compiled = compilePublicProjection(corpus, projection, at, at);
    corpus.close();
    projection.close();

    const signed = await POST(request('http://localhost/api/corpus/attestations', 'POST', 'COMPILER-TOKEN', { corpusBuildId: compiled.manifest.corpusBuildId, signedAt: at }));
    expect(signed.status).toBe(201);
    const signedBody = await signed.json();
    expect(signedBody).toMatchObject({
      kind: 'corpus_build_attestation',
      attestation: { statement: { corpusBuildId: compiled.manifest.corpusBuildId, clockBasis: 'SIGNER_CLOCK', independentTimestamp: false }, signature: { algorithm: 'ed25519' } },
      persistence: { sequence: 1, idempotent: false },
      zkPrograms: [{ programId: 'payload_event_batch_v1', status: 'CEREMONIALLY_PINNED', proofScope: 'authorized_operational_event_batches', appliesToCorpusBuildAttestation: false }],
    });
    const repeated = await POST(request('http://localhost/api/corpus/attestations', 'POST', 'COMPILER-TOKEN', { corpusBuildId: compiled.manifest.corpusBuildId, signedAt: at }));
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ persistence: { sequence: 1, idempotent: true } });

    const read = await GET(request(`http://localhost/api/corpus/attestations?corpusBuildId=${encodeURIComponent(compiled.manifest.corpusBuildId)}`, 'GET', 'QUERY-TOKEN'));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ attestation: { attestationId: signedBody.attestation.attestationId }, persistence: { sequence: 1 } });

    const agent = await retrieve(request('http://localhost/api/corpus/retrieval', 'POST', 'QUERY-TOKEN', { mode: 'agent', evidenceLevel: 'VERIFIED', query: 'Attestation API Facility', entityIds: ['pe:facility:attestation-api'], asOf: at }));
    expect(agent.status).toBe(201);
    expect(await agent.json()).toMatchObject({
      persistence: { sequence: 2 },
      agentContext: { evidenceBudget: { assuranceAvailable: 'ATTESTED' }, proof: { envelope: { verificationLevel: 'ATTESTED', attestation: { status: 'ATTESTED' }, zkProof: { status: 'NOT_GENERATED' } }, buildAttestation: { attestationId: signedBody.attestation.attestationId } } },
    });
  });
});
