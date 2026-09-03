import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { buildNotationCorpusSyncPage } from '@/lib/economy/notationCorpusFederation';
import { notationSubstratePath, notationSubstrateStore } from '@/lib/economy/notationSubstrateRuntime';
import { NotationSubstrateStore } from '@/lib/economy/notationSubstrateStore';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { buildPublicProjection } from '@/lib/economy/corpusProjection';
import { PhysicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpus';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const environment = ['PAYLOAD_CORPUS_QUERY_TOKEN', 'PAYLOAD_CORPUS_PROJECTOR_TOKEN', 'PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_DATABASE_PATH'] as const;
const original = new Map(environment.map(name => [name, process.env[name]]));
const directories: string[] = [];

afterEach(async () => {
  const path = notationSubstratePath();
  if (path) { try { notationSubstrateStore()?.close(); } catch { /* already closed */ } resetProcessSingleton(`notation-substrate:${path}`); }
  for (const name of environment) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('/api/corpus/substrate', () => {
  it('reports durable sync state and separates vector projection authority from vector query authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'notation-substrate-api-'));
    directories.push(directory);
    const databasePath = join(directory, 'substrate.sqlite');
    process.env.PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH = databasePath;
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN = 'PROJECTOR-TOKEN';
    const at = new Date().toISOString();
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    const appended = corpus.append('global', [
      { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:substrate-api', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:substrate-api', sourceId: 'source:substrate-api', title: 'Substrate API source', sourceUrl: 'https://example.test/substrate-api', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
      { schema: 'payload.corpus.record.v1', recordId: 'record:entity:substrate-api', recordType: 'entity', knownAt: at, entityId: 'pe:facility:substrate-api', entityKind: 'facility', canonicalName: 'Semantic Terminal', evidenceIds: ['evidence:substrate-api'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    ], at);
    expect(appended.kind).toBe('committed');
    const page = buildNotationCorpusSyncPage(buildPublicProjection(corpus.projectionSource('global', at), at));
    corpus.close();
    const direct = new NotationSubstrateStore(databasePath);
    direct.ingest(page, at);
    const document = direct.semanticDocuments().find(item => item.recordType === 'entity')!;
    direct.close();

    const status = (await GET(new Request('http://localhost/api/corpus/substrate', { headers: { authorization: 'Bearer QUERY-TOKEN' } })))!;
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ kind: 'notation_substrate_status', counts: { identities: 2, semanticDocuments: 2, vectorProjections: 0 }, boundaries: { embeddingProviderStatus: 'UNOBSERVED' } });

    const denied = (await POST(new Request('http://localhost/api/corpus/substrate', { method: 'POST', headers: { authorization: 'Bearer QUERY-TOKEN' }, body: JSON.stringify({ action: 'put_vector', documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0] }) })))!;
    expect(denied.status).toBe(401);
    const projected = (await POST(new Request('http://localhost/api/corpus/substrate', { method: 'POST', headers: { authorization: 'Bearer PROJECTOR-TOKEN' }, body: JSON.stringify({ action: 'put_vector', documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0], generatedAt: at }) })))!;
    expect(projected.status).toBe(201);
    expect(await projected.json()).toMatchObject({ kind: 'notation_vector_projection', idempotent: false });
    const replayed = (await POST(new Request('http://localhost/api/corpus/substrate', { method: 'POST', headers: { authorization: 'Bearer PROJECTOR-TOKEN' }, body: JSON.stringify({ action: 'put_vector', documentUri: document.documentUri, documentHash: document.documentHash, modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0], generatedAt: at }) })))!;
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ kind: 'notation_vector_projection', idempotent: true });

    const searched = (await POST(new Request('http://localhost/api/corpus/substrate', { method: 'POST', headers: { authorization: 'Bearer QUERY-TOKEN' }, body: JSON.stringify({ action: 'vector_search', modelId: 'embedding:test', modelVersion: '1.0.0', values: [1, 0], limit: 5 }) })))!;
    expect(searched.status).toBe(200);
    expect(await searched.json()).toMatchObject({ kind: 'notation_vector_search', hits: [{ documentUri: document.documentUri, score: { value: 1, basis: 'cosine_similarity' } }] });
  });
});
