import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldToken = process.env.PAYLOAD_CORPUS_COMPILER_TOKEN;
const oldIngestToken = process.env.PAYLOAD_CORPUS_INGEST_TOKEN;
const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const oldProjectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
const directories: string[] = [];

function request(method: 'GET' | 'POST', token?: string, body?: unknown) {
  return new Request('http://localhost/api/corpus/projections', {
    method,
    headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
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
  for (const [name, value] of [['PAYLOAD_CORPUS_COMPILER_TOKEN', oldToken], ['PAYLOAD_CORPUS_INGEST_TOKEN', oldIngestToken], ['PAYLOAD_CORPUS_DATABASE_PATH', oldCorpusPath], ['PAYLOAD_DATABASE_PATH', oldDatabasePath], ['PAYLOAD_CORPUS_READ_MODEL_PATH', oldProjectionPath]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('/api/corpus/projections', () => {
  it('fails closed without the corpus administration identity', async () => {
    delete process.env.PAYLOAD_CORPUS_COMPILER_TOKEN;
    expect((await POST(request('POST', undefined, { audience: 'public', scope: 'global' }))).status).toBe(503);
    process.env.PAYLOAD_CORPUS_INGEST_TOKEN = 'INGEST-ONLY-TOKEN';
    process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = 'COMPILER-ONLY-TOKEN';
    expect((await POST(request('POST', process.env.PAYLOAD_CORPUS_INGEST_TOKEN, { audience: 'public', scope: 'global' }))).status).toBe(401);
  });

  it('compiles, reads, and idempotently rebuilds the public projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-projection-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = join(directory, 'read-model.sqlite');
    delete process.env.PAYLOAD_DATABASE_PATH;
    const token = 'CORPUS-PROJECTION-TEST-TOKEN';
    process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = token;
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', [
      { schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:public-api:v1', recordType: 'evidence', knownAt: '2026-01-01T00:00:00.000Z', evidenceId: 'evidence:public-api', sourceId: 'source:public-api', title: 'Public evidence', sourceUrl: 'https://example.test/public', artifactSha256: 'a'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z', access: OPEN_PUBLIC_CORPUS_ACCESS },
      { schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:unclassified-api:v1', recordType: 'evidence', knownAt: '2026-01-01T00:00:00.000Z', evidenceId: 'evidence:unclassified-api', sourceId: 'source:unclassified-api', title: 'Unclassified evidence', sourceUrl: 'https://example.test/unclassified', artifactSha256: 'b'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z' },
    ], '2026-01-01T00:01:00.000Z').kind).toBe('committed');
    corpus.close();

    const body = { audience: 'public', scope: 'global', knowledgeCutoff: '2026-01-02T00:00:00.000Z' };
    const created = await POST(request('POST', token, body));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody).toMatchObject({ kind: 'projection_stored', idempotent: false, manifest: { projectionId: 'public:global', recordCount: 1, excludedRecords: 1, exclusions: [{ code: 'CORPUS_CLASSIFICATION_MISSING', count: 1 }] } });
    const read = await GET(request('GET', token));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ kind: 'compiled_corpus_projection', manifest: { projectionDigest: createdBody.manifest.projectionDigest } });
    const replay = await POST(request('POST', token, body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ idempotent: true, manifest: { projectionDigest: createdBody.manifest.projectionDigest } });
  });

  it('refuses unsupported audience or private-scope compilation', async () => {
    process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = 'CORPUS-PROJECTION-TEST-TOKEN';
    const response = await POST(request('POST', process.env.PAYLOAD_CORPUS_COMPILER_TOKEN, { audience: 'customer', scope: 'customer:acme' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID' });
  });
});
