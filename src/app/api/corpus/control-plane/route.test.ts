import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POST as retrieve } from '../retrieval/route';
import { GET } from './route';
import { corpusAgentArtifactPath, corpusAgentArtifactStore } from '@/lib/economy/corpusAgentArtifactRuntime';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const environment = [
  'PAYLOAD_CORPUS_QUERY_TOKEN', 'PAYLOAD_CORPUS_DATABASE_PATH', 'PAYLOAD_DATABASE_PATH',
  'PAYLOAD_CORPUS_READ_MODEL_PATH', 'PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH',
  'PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS',
] as const;
const original = new Map(environment.map(name => [name, process.env[name]]));
const directories: string[] = [];

afterEach(async () => {
  const corpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (corpusPath) {
    try { await physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
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
  for (const name of environment) {
    const value = original.get(name);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('GET /api/corpus/control-plane', () => {
  it('projects real corpus and agent-result state into an operator and Kepler view', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-control-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    const projectionPath = join(directory, 'projection.sqlite');
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    process.env.PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH = join(directory, 'artifacts.sqlite');
    process.env.PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS = '31536000000';
    delete process.env.PAYLOAD_DATABASE_PATH;

    const now = new Date().toISOString();
    const records: CorpusRecordInput[] = [
      { schema: 'payload.corpus.record.v1', recordId: 'record:evidence:control-api', recordType: 'evidence', knownAt: now, evidenceId: 'evidence:control-api', sourceId: 'source:control-api', title: 'Control API source', sourceUrl: 'https://example.test/control', artifactSha256: 'a'.repeat(64), retrievedAt: now, access: OPEN_PUBLIC_CORPUS_ACCESS },
      { schema: 'payload.corpus.record.v1', recordId: 'record:entity:control-api', recordType: 'entity', knownAt: now, entityId: 'pe:port:control-api', entityKind: 'port', canonicalName: 'Control API Port', location: { lng: -79.38, lat: 43.65, precision: 'site' }, evidenceIds: ['evidence:control-api'], access: OPEN_PUBLIC_CORPUS_ACCESS },
    ];
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', records, now).kind).toBe('committed');
    const projection = new CorpusProjectionStore(projectionPath);
    compilePublicProjection(corpus, projection, now, now);
    corpus.close();
    projection.close();

    const retrieval = await retrieve(new Request('http://localhost/api/corpus/retrieval', {
      method: 'POST',
      headers: { authorization: 'Bearer QUERY-TOKEN', 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent', evidenceLevel: 'FAST', query: 'Control API Port', entityIds: ['pe:port:control-api'], asOf: now }),
    }));
    expect(retrieval.status).toBe(201);

    const response = await GET(new Request('http://localhost/api/corpus/control-plane?afterSequence=0&limit=10', {
      headers: { authorization: 'Bearer QUERY-TOKEN' },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      schema: 'payload.corpus.control-plane.v1',
      ecosystemId: 'payload:physical-economy',
      timeline: { afterSequence: 0, nextAfterSequence: 1, events: [{ changed: 'agent_context_persisted', why: 'Control API Port', dispatched: false }] },
      dock: { spatial: { status: 'READY', asOf: now, keplerGl: { action: 'addDataToMap' } } },
      operator: { blocked: [] },
    });
  });
});
