import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { corpusKnowledgeIndexPath, corpusKnowledgeIndexStore } from '@/lib/economy/corpusKnowledgeIndexRuntime';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const environment = ['PAYLOAD_CORPUS_QUERY_TOKEN', 'PAYLOAD_CORPUS_COMPILER_TOKEN', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_DATABASE_PATH', 'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_INDEX_PATH'] as const;
const original = new Map(environment.map(name => [name, process.env[name]]));
const directories: string[] = [];

afterEach(async () => {
  const indexPath = corpusKnowledgeIndexPath();
  if (indexPath) { try { corpusKnowledgeIndexStore()?.close(); } catch { /* already closed */ } resetProcessSingleton(`corpus-knowledge-index:${indexPath}`); }
  const projectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  if (projectionPath) { try { corpusProjectionStore()?.close(); } catch { /* already closed */ } resetProcessSingleton(`physical-economy-projection:${resolve(projectionPath)}`); }
  const corpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (corpusPath) { try { await physicalEconomyCorpus()?.close(); } catch { /* already closed */ } resetProcessSingleton(`physical-economy-corpus:${resolve(corpusPath)}`); }
  for (const name of environment) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('/api/corpus/index', () => {
  it('builds once under compiler authority and serves bounded search and coverage under query authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-index-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    const projectionPath = join(directory, 'projection.sqlite');
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    process.env.PAYLOAD_CORPUS_COMPILER_TOKEN = 'COMPILER-TOKEN';
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    process.env.PAYLOAD_CORPUS_INDEX_PATH = join(directory, 'index.sqlite');
    delete process.env.PAYLOAD_DATABASE_PATH;
    const at = new Date().toISOString();
    const records: CorpusRecordInput[] = [
      { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:index-api', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:index-api', sourceId: 'source:index-api', title: 'Terminal registry', sourceUrl: 'https://example.test/index', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS },
      { schema: 'payload.corpus.record.v1', recordId: 'record:entity:index-api', recordType: 'entity', knownAt: at, entityId: 'pe:facility:index-api', entityKind: 'facility', canonicalName: 'Polymer Index Terminal', evidenceIds: ['evidence:index-api'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    ];
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', records, at).kind).toBe('committed');
    const projection = new CorpusProjectionStore(projectionPath);
    compilePublicProjection(corpus, projection, at, at);
    corpus.close(); projection.close();

    const unauthorized = (await POST(new Request('http://localhost/api/corpus/index', { method: 'POST', headers: { authorization: 'Bearer QUERY-TOKEN' }, body: '{}' })))!;
    expect(unauthorized.status).toBe(401);
    const built = (await POST(new Request('http://localhost/api/corpus/index', { method: 'POST', headers: { authorization: 'Bearer COMPILER-TOKEN' }, body: JSON.stringify({ builtAt: at }) })))!;
    expect(built.status).toBe(201);
    expect(await built.json()).toMatchObject({ kind: 'corpus_knowledge_index_stored', idempotent: false, manifest: { documentCount: 2 } });

    const searched = (await GET(new Request('http://localhost/api/corpus/index?q=polymer%20terminal&entityKinds=facility', { headers: { authorization: 'Bearer QUERY-TOKEN' } })))!;
    expect(searched.status).toBe(200);
    expect(await searched.json()).toMatchObject({ kind: 'corpus_knowledge_index_search', hits: [{ recordId: 'record:entity:index-api', score: { basis: 'deterministic_weighted_term_frequency_v1' } }] });
    const coverage = (await GET(new Request('http://localhost/api/corpus/index?view=coverage', { headers: { authorization: 'Bearer QUERY-TOKEN' } })))!;
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toMatchObject({ kind: 'corpus_knowledge_index_coverage', coverage: { spatial: { entityCount: 1, unlocatedEntityCount: 1 }, signals: expect.arrayContaining([expect.objectContaining({ code: 'ENTITY_LOCATION_UNOBSERVED' })]) } });
  });
});
