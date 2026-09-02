import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { patternRegistry } from '@/lib/economy/patternRegistryRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const ENV_NAMES = ['PAYLOAD_CORPUS_MINER_TOKEN', 'PAYLOAD_CORPUS_COMPILER_TOKEN', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH', 'PAYLOAD_DATABASE_PATH'] as const;
const oldEnv = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
const directories: string[] = [];
const at = '2026-09-02T12:00:00.000Z';

function request(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
  return new Request(url, { method, headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
}

function records(): CorpusRecordInput[] {
  const evidenceId = 'evidence:api-miner';
  return [
    { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:api-miner', recordType: 'evidence', knownAt: at, evidenceId, sourceId: 'source:api-miner', title: 'Dependency evidence', sourceUrl: 'https://example.test/api-miner', artifactSha256: 'c'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
    ...['a', 'b', 'shared'].map(name => ({ schema: 'payload.corpus.record.v1' as const, recordId: `record:entity:${name}`, recordType: 'entity' as const, knownAt: at, entityId: `pe:organization:${name}`, entityKind: 'organization' as const, canonicalName: name, evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS })),
    ...['a', 'b'].map(name => ({ schema: 'payload.corpus.record.v1' as const, recordId: `record:relationship:${name}`, recordType: 'relationship' as const, knownAt: at, relationshipId: `relationship:${name}-shared`, subjectEntityId: `pe:organization:${name}`, predicate: 'depends_on' as const, objectEntityId: 'pe:organization:shared', valueKind: 'reported' as const, confidence: 'high' as const, evidenceIds: [evidenceId], access: OPEN_PUBLIC_CORPUS_ACCESS })),
  ];
}

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'payload-miner-api-'));
  directories.push(directory);
  process.env.PAYLOAD_CORPUS_DATABASE_PATH = join(directory, 'corpus.sqlite');
  process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = join(directory, 'read.sqlite');
  process.env.PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH = join(directory, 'patterns.sqlite');
  process.env.PAYLOAD_CORPUS_MINER_TOKEN = 'MINER-ONLY-TEST-TOKEN';
  process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = 'COMPILER-ONLY-TEST-TOKEN';
  delete process.env.PAYLOAD_DATABASE_PATH;
  const corpus = new PhysicalEconomyCorpus(process.env.PAYLOAD_CORPUS_DATABASE_PATH);
  expect(corpus.append('global', records(), at).kind).toBe('committed');
  const projection = new CorpusProjectionStore(process.env.PAYLOAD_CORPUS_READ_MODEL_PATH);
  compilePublicProjection(corpus, projection, at, at);
  projection.close();
  corpus.close();
  return directory;
}

afterEach(async () => {
  const corpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (corpusPath) {
    const path = resolve(corpusPath);
    try { physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${path}`);
  }
  const projectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  if (projectionPath) {
    const path = resolve(projectionPath);
    try { corpusProjectionStore()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-projection:${path}`);
  }
  const registryPath = process.env.PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH;
  if (registryPath) {
    const path = resolve(registryPath);
    try { patternRegistry()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-pattern-registry:${path}`);
  }
  for (const name of ENV_NAMES) {
    const value = oldEnv.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('/api/corpus/mining/dependencies', () => {
  it('uses a dedicated fail-closed miner identity', async () => {
    delete process.env.PAYLOAD_CORPUS_MINER_TOKEN;
    expect((await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', undefined, {}))).status).toBe(503);
    process.env.PAYLOAD_CORPUS_MINER_TOKEN = 'MINER-ONLY-TEST-TOKEN';
    expect((await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', 'COMPILER-ONLY-TEST-TOKEN', {}))).status).toBe(401);
  });

  it('mines, registers, replays, and pages candidate knowledge without canonical mutation', async () => {
    await setup();
    const body = { entityId: 'pe:organization:shared', depth: 1, minimumDependents: 2, executedAt: at };
    const created = await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', 'MINER-ONLY-TEST-TOKEN', body));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      kind: 'mining_registered', idempotent: false, run: { sequence: 1, parameters: { entityId: body.entityId, depth: 1, minimumDependents: 2 } },
      candidates: [{ patternType: 'SHARED_DEPENDENCY', focalEntityId: 'pe:organization:shared', validationStatus: 'CANDIDATE' }],
    });
    const replay = await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', 'MINER-ONLY-TEST-TOKEN', body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotent: true, run: { sequence: 1 } });
    const summary = await GET(request('GET', 'http://localhost/api/corpus/mining/dependencies?view=summary', 'MINER-ONLY-TEST-TOKEN'));
    expect(await summary.json()).toMatchObject({ runCount: 1, candidateCount: 1 });
    const corpus = physicalEconomyCorpus();
    expect(corpus?.summary().lastSequence).toBe(6);
  });

  it('rejects raw canonical fields and refuses to mine a stale CorpusBuild', async () => {
    await setup();
    const invalid = await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', 'MINER-ONLY-TEST-TOKEN', { records: [] }));
    expect(invalid.status).toBe(400);
    const corpus = new PhysicalEconomyCorpus(process.env.PAYLOAD_CORPUS_DATABASE_PATH!);
    expect(corpus.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'record:evidence:new', recordType: 'evidence', knownAt: '2026-09-02T13:00:00.000Z', evidenceId: 'evidence:new', sourceId: 'source:new', title: 'New evidence', sourceUrl: 'https://example.test/new', artifactSha256: 'd'.repeat(64), retrievedAt: '2026-09-02T13:00:00.000Z', access: OPEN_PUBLIC_CORPUS_ACCESS }], '2026-09-02T13:00:00.000Z').kind).toBe('committed');
    corpus.close();
    const stale = await POST(request('POST', 'http://localhost/api/corpus/mining/dependencies', 'MINER-ONLY-TEST-TOKEN', { executedAt: at }));
    expect(stale.status).toBe(503);
    expect(await stale.json()).toMatchObject({ code: 'CORPUS_PROJECTION_STALE' });
  });
});
