import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { PhysicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldToken = process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN;
const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const directories: string[] = [];

function getRequest(token?: string) {
  return new Request('http://localhost/api/corpus/projectors?afterSequence=0&limit=10', { headers: token ? { authorization: `Bearer ${token}` } : undefined });
}

function postRequest(token: string, body: unknown) {
  return new Request('http://localhost/api/corpus/projectors', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

afterEach(async () => {
  const configured = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (configured) {
    const path = resolve(configured);
    try { physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${path}`);
  }
  for (const [name, value] of [['PAYLOAD_CORPUS_PROJECTOR_TOKEN', oldToken], ['PAYLOAD_CORPUS_DATABASE_PATH', oldCorpusPath], ['PAYLOAD_DATABASE_PATH', oldDatabasePath]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('/api/corpus/projectors', () => {
  it('streams durable events and records monotonic checkpoints under compiler authority', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-projectors-api-'));
    directories.push(directory);
    const path = join(directory, 'corpus.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = path;
    delete process.env.PAYLOAD_DATABASE_PATH;
    process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN = 'PROJECTOR-ONLY-TOKEN';
    const corpus = new PhysicalEconomyCorpus(path);
    expect(corpus.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:projector-api:v1', recordType: 'evidence', knownAt: '2026-02-04T00:00:00.000Z', evidenceId: 'evidence:projector-api', sourceId: 'source:projector-api', title: 'Projector API evidence', sourceUrl: 'https://example.test/projector', artifactSha256: 'a'.repeat(64), retrievedAt: '2026-02-04T00:00:00.000Z', access: OPEN_PUBLIC_CORPUS_ACCESS }], '2026-02-04T00:01:00.000Z').kind).toBe('committed');
    corpus.close();

    expect((await GET(getRequest('WRONG-TOKEN'))).status).toBe(401);
    const eventsResponse = await GET(getRequest(process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN));
    expect(eventsResponse.status).toBe(200);
    expect(await eventsResponse.json()).toMatchObject({ kind: 'corpus_projection_event_page', events: [{ sequence: 1, recordId: 'rec:evidence:projector-api:v1' }] });

    const checkpoint = await POST(postRequest(process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN, { projector: 'projector:qdrant', sequence: 1, updatedAt: '2026-02-04T00:02:00.000Z' }));
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toMatchObject({ kind: 'corpus_projector_checkpoint', sequence: 1 });
    const regression = await POST(postRequest(process.env.PAYLOAD_CORPUS_PROJECTOR_TOKEN, { projector: 'projector:qdrant', sequence: 0, updatedAt: '2026-02-04T00:03:00.000Z' }));
    expect(regression.status).toBe(409);
    expect(await regression.json()).toMatchObject({ code: 'CORPUS_PROJECTION_CHECKPOINT_REGRESSION' });
  });
});
