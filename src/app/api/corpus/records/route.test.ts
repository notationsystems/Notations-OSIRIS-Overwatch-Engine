import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GET, POST } from './route';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldToken = process.env.PAYLOAD_CORPUS_INGEST_TOKEN;
const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const directories: string[] = [];

function request(method: 'GET' | 'POST', url: string, token?: string, body?: unknown) {
  return new Request(url, { method, headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
}

afterEach(async () => {
  const configured = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (configured) {
    const path = resolve(configured);
    try { physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${path}`);
  }
  for (const [name, value] of [['PAYLOAD_CORPUS_INGEST_TOKEN', oldToken], ['PAYLOAD_CORPUS_DATABASE_PATH', oldCorpusPath], ['PAYLOAD_DATABASE_PATH', oldDatabasePath]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('/api/corpus/records', () => {
  it('fails closed without a dedicated administrative secret', async () => {
    delete process.env.PAYLOAD_CORPUS_INGEST_TOKEN;
    expect((await GET(request('GET', 'http://localhost/api/corpus/records'))).status).toBe(503);
    process.env.PAYLOAD_CORPUS_INGEST_TOKEN = 'CORPUS-ADMIN-TEST-TOKEN';
    expect((await GET(request('GET', 'http://localhost/api/corpus/records', 'WRONG-TOKEN'))).status).toBe(401);
  });

  it('appends once, replays by global cursor, and reports summary without a filesystem path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-corpus-records-'));
    directories.push(directory);
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = join(directory, 'corpus.sqlite');
    delete process.env.PAYLOAD_DATABASE_PATH;
    const token = 'CORPUS-ADMIN-TEST-TOKEN';
    process.env.PAYLOAD_CORPUS_INGEST_TOKEN = token;
    const record = {
      schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:test:v1', recordType: 'evidence', knownAt: '2026-01-01T00:00:00.000Z',
      evidenceId: 'evidence:test:001', sourceId: 'source:test:001', title: 'Test evidence', sourceUrl: 'https://example.com/evidence',
      artifactSha256: 'c'.repeat(64), retrievedAt: '2026-01-01T00:00:00.000Z',
    };
    const body = { scope: 'global', records: [record], recordedAt: '2026-01-01T00:01:00.000Z' };
    const created = await POST(request('POST', 'http://localhost/api/corpus/records', token, body));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      kind: 'committed', idempotent: false, records: [{ sequence: 1 }],
      builderManifest: {
        corpusEngineId: 'notation-systems.payloados.corpus-engine',
        productId: 'notation-systems.product.payload',
        corpusDefinitionId: 'payload.corpus-definition.physical-economy.v1',
        corpusDefinitionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const replay = await POST(request('POST', 'http://localhost/api/corpus/records', token, body));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ kind: 'committed', idempotent: true });

    const page = await GET(request('GET', 'http://localhost/api/corpus/records?afterSequence=0&limit=1', token));
    expect(await page.json()).toMatchObject({ kind: 'physical_economy_corpus_page', nextAfterSequence: 1, records: [{ evidenceId: 'evidence:test:001' }] });
    const summary = await GET(request('GET', 'http://localhost/api/corpus/records?view=summary', token));
    const summaryBody = await summary.json();
    expect(summaryBody).toMatchObject({ kind: 'physical_economy_corpus_summary', lastSequence: 1 });
    expect(summaryBody).not.toHaveProperty('databasePath');
  });

  it('refuses malformed records without partially appending them', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-corpus-records-'));
    directories.push(directory);
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = join(directory, 'corpus.sqlite');
    delete process.env.PAYLOAD_DATABASE_PATH;
    const token = 'CORPUS-ADMIN-TEST-TOKEN';
    process.env.PAYLOAD_CORPUS_INGEST_TOKEN = token;
    const response = await POST(request('POST', 'http://localhost/api/corpus/records', token, { scope: 'global', records: [{ recordType: 'entity' }] }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID' });
    const summary = await GET(request('GET', 'http://localhost/api/corpus/records?view=summary', token));
    expect(await summary.json()).toMatchObject({ lastSequence: 0, records: [] });
  });
});
