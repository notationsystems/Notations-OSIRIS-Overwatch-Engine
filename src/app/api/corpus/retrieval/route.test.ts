import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POST } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldToken = process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const oldProjectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
const directories: string[] = [];
const at = '2026-02-04T00:00:00.000Z';

function request(token: string | undefined, body: unknown) {
  return new Request('http://localhost/api/corpus/retrieval', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function records(): CorpusRecordInput[] {
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  return [
    { ...common, recordId: 'rec:evidence:retrieval-api:v1', recordType: 'evidence', evidenceId: 'evidence:retrieval-api', sourceId: 'source:retrieval-api', title: 'Capacity record', sourceUrl: 'https://example.test/capacity', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: 'rec:evidence-unit:retrieval-api:v1', recordType: 'evidence_unit', evidenceUnitId: 'evidence-unit:retrieval-api', artifactEvidenceId: 'evidence:retrieval-api', modality: 'structured_record', locator: { jsonPath: '$.capacity' }, extraction: { kind: 'system_record', version: '1.0.0', adapter: 'test-adapter' }, contentSha256: 'b'.repeat(64), extractedText: 'capacity 42 tonnes' },
    { ...common, recordId: 'rec:entity:retrieval-api:v1', recordType: 'entity', entityId: 'pe:facility:retrieval-api', entityKind: 'facility', canonicalName: 'Retrieval Test Facility', evidenceIds: ['evidence-unit:retrieval-api'] },
    { ...common, recordId: 'rec:observation:retrieval-api:v1', recordType: 'observation', observationId: 'observation:retrieval-api', entityId: 'pe:facility:retrieval-api', observationType: 'capacity', metric: 'capacity', value: 42, unit: 't', validFrom: '2026-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:retrieval-api'] },
    { ...common, recordId: 'rec:assertion:retrieval-api:v1', recordType: 'assertion', assertionId: 'assertion:retrieval-api', entityId: 'pe:facility:retrieval-api', propertyKey: 'capacity', selectedValue: 42, unit: 't', status: 'accepted', selectionPolicy: 'reviewed-source-v1', validFrom: '2026-01-01T00:00:00.000Z', confidence: 'high', evidence: [{ observationId: 'observation:retrieval-api', role: 'supports' }] },
  ];
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
  for (const [name, value] of [['PAYLOAD_CORPUS_QUERY_TOKEN', oldToken], ['PAYLOAD_CORPUS_DATABASE_PATH', oldCorpusPath], ['PAYLOAD_DATABASE_PATH', oldDatabasePath], ['PAYLOAD_CORPUS_READ_MODEL_PATH', oldProjectionPath]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
describe('POST /api/corpus/retrieval', () => {
  it('fails closed under a dedicated query identity', async () => {
    delete process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
    expect((await POST(request(undefined, { query: 'capacity' }))).status).toBe(503);
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-ONLY-TOKEN';
    expect((await POST(request('WRONG-TOKEN', { query: 'capacity' }))).status).toBe(401);
  });

  it('returns a deterministic plan and evidence-complete ContextPackage from the current projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-retrieval-api-'));
    directories.push(directory);
    const corpusPath = join(directory, 'corpus.sqlite');
    const projectionPath = join(directory, 'projection.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-ONLY-TOKEN';
    const corpus = new PhysicalEconomyCorpus(corpusPath);
    expect(corpus.append('global', records(), '2026-02-04T00:01:00.000Z').kind).toBe('committed');
    const projection = new CorpusProjectionStore(projectionPath);
    compilePublicProjection(corpus, projection, at, '2026-02-04T00:02:00.000Z');
    corpus.close();
    projection.close();

    const body = { query: 'Retrieval Test Facility capacity', entityIds: ['pe:facility:retrieval-api'], propertyKeys: ['capacity'], asOf: '2026-02-04T00:00:00.000Z', evidenceQuery: 'capacity' };
    const first = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, body));
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({ kind: 'corpus_context', context: { assertions: [{ assertionId: 'assertion:retrieval-api' }], evidenceUnits: [{ evidenceUnitId: 'evidence-unit:retrieval-api' }], artifacts: [{ evidenceId: 'evidence:retrieval-api' }], missingEvidence: [] } });

    const second = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, mode: 'plan' }));
    expect(second.status).toBe(200);
    expect((await second.json()).plan.planId).toBe(result.plan.planId);

    const fast = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, mode: 'agent', evidenceLevel: 'FAST' }));
    expect(fast.status).toBe(200);
    const fastResult = await fast.json();
    expect(fastResult).toMatchObject({ kind: 'corpus_agent_context', agentContext: { evidenceBudget: { requestedLevel: 'FAST', assuranceAvailable: 'PROVENANCE' }, assertions: [{ assertionId: 'assertion:retrieval-api' }] } });
    expect(fastResult.agentContext).not.toHaveProperty('evidence');
    expect(fastResult.agentContext).not.toHaveProperty('proof');

    const verified = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, mode: 'agent', evidenceLevel: 'VERIFIED' }));
    expect(verified.status).toBe(200);
    expect(await verified.json()).toMatchObject({ kind: 'corpus_agent_context', agentContext: { evidenceBudget: { requestedLevel: 'VERIFIED', assuranceAvailable: 'REPRODUCIBLE' }, proof: { membershipProofsVerified: true, envelope: { attestation: { status: 'NOT_ATTESTED' }, zkProof: { status: 'NOT_GENERATED' } } } } });

    const invalidLevel = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, mode: 'agent', evidenceLevel: 'MAXIMUM' }));
    expect(invalidLevel.status).toBe(400);
    expect(await invalidLevel.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_EVIDENCE_LEVEL_INVALID' });

    const ignoredLevel = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, mode: 'context', evidenceLevel: 'FAST' }));
    expect(ignoredLevel.status).toBe(400);

    const historical = await POST(request(process.env.PAYLOAD_CORPUS_QUERY_TOKEN, { ...body, knownAt: '2026-02-03T00:00:00.000Z' }));
    expect(historical.status).toBe(409);
    expect(await historical.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_PROJECTION_TIME_UNAVAILABLE' });
  });
});
