import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const environment = ['PAYLOAD_CORPUS_PROJECTOR_TOKEN', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_DATABASE_PATH', 'PAYLOAD_CORPUS_READ_MODEL_PATH'] as const;
const original = new Map(environment.map(name => [name, process.env[name]]));
const directories: string[] = [];

afterEach(async () => {
  const projectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  if (projectionPath) { try { corpusProjectionStore()?.close(); } catch { /* already closed */ } resetProcessSingleton(`physical-economy-projection:${resolve(projectionPath)}`); }
  const corpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (corpusPath) { try { await physicalEconomyCorpus()?.close(); } catch { /* already closed */ } resetProcessSingleton(`physical-economy-corpus:${resolve(corpusPath)}`); }
  for (const name of environment) { const value = original.get(name); if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('/api/corpus/federation', () => {
  it('serves a build-bound Notation sync page and records a monotonic consumer checkpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-federation-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    const projectionPath = join(directory, 'projection.sqlite');
    process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN = 'PROJECTOR-TOKEN';
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const at = new Date().toISOString();
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'record:evidence:federation-api', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:federation-api', sourceId: 'source:federation-api', title: 'Federation evidence', sourceUrl: 'https://example.test/federation', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS }], at).kind).toBe('committed');
    const projectionStore = new CorpusProjectionStore(projectionPath);
    const compiled = compilePublicProjection(corpus, projectionStore, at, at).manifest;
    corpus.close(); projectionStore.close();

    expect((await GET(new Request('http://localhost/api/corpus/federation', { headers: { authorization: 'Bearer WRONG' } })))!.status).toBe(401);
    const response = (await GET(new Request('http://localhost/api/corpus/federation?afterSequence=0&limit=10', { headers: { authorization: 'Bearer PROJECTOR-TOKEN' } })))!;
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(page).toMatchObject({ schema: 'payload.notation.sync-page.v1', sourceNodeUri: 'notation://node/payload', corpusBuildId: compiled.corpusBuildId, nextAfterSequence: 1, envelopes: [{ objectUri: 'notation://artifact/payload/evidence%3Afederation-api' }] });
    const checkpoint = (await POST(new Request('http://localhost/api/corpus/federation', { method: 'POST', headers: { authorization: 'Bearer PROJECTOR-TOKEN' }, body: JSON.stringify({ consumerId: 'primary-fabric', sequence: page.nextAfterSequence, corpusBuildId: page.corpusBuildId, projectionDigest: page.projectionDigest, updatedAt: at }) })))!;
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({ kind: 'notation_corpus_sync_checkpoint', consumerId: 'primary-fabric', checkpoint: { projector: 'notation-sync:primary-fabric', sequence: 1 } });
  });
});
