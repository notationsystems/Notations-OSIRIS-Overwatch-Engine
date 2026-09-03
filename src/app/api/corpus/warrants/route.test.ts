import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GET } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';
import { verifyCorpusRecordInclusion } from '@/lib/economy/corpusVerification';

const oldToken = process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const oldProjectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
const directories: string[] = [];
const at = '2026-09-02T12:00:00.000Z';

function request(query: string, token?: string) {
  return new Request(`http://localhost/api/corpus/warrants?${query}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

function records(): CorpusRecordInput[] {
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS };
  return [
    { ...common, recordId: 'record:evidence:warrant-api', recordType: 'evidence', evidenceId: 'evidence:warrant-api', sourceId: 'source:warrant-api', title: 'Warrant API source', sourceUrl: 'https://example.test/warrant-api', artifactSha256: 'a'.repeat(64), retrievedAt: at },
    { ...common, recordId: 'record:entity:warrant-api', recordType: 'entity', entityId: 'pe:facility:warrant-api', entityKind: 'facility', canonicalName: 'Warrant API Facility', evidenceIds: ['evidence:warrant-api'] },
    { ...common, recordId: 'record:observation:warrant-api-primary', recordType: 'observation', observationId: 'observation:warrant-api-primary', entityId: 'pe:facility:warrant-api', observationType: 'capacity', metric: 'capacity', value: 800, unit: 'kt/y', validFrom: at, valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence:warrant-api'] },
    { ...common, recordId: 'record:observation:warrant-api-conflict', recordType: 'observation', observationId: 'observation:warrant-api-conflict', entityId: 'pe:facility:warrant-api', observationType: 'capacity', metric: 'capacity', value: 620, unit: 'kt/y', validFrom: at, valueKind: 'reported', confidence: 'medium', evidenceIds: ['evidence:warrant-api'] },
    { ...common, recordId: 'record:assertion:warrant-api', recordType: 'assertion', assertionId: 'assertion:warrant-api', entityId: 'pe:facility:warrant-api', propertyKey: 'capacity', selectedValue: 800, unit: 'kt/y', status: 'accepted', selectionPolicy: 'reviewed-source-v1', validFrom: at, confidence: 'medium', evidence: [{ observationId: 'observation:warrant-api-primary', role: 'supports' }, { observationId: 'observation:warrant-api-conflict', role: 'contradicts' }] },
  ];
}

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), 'payload-warrant-api-'));
  directories.push(directory);
  const corpusPath = join(directory, 'corpus.sqlite');
  const projectionPath = join(directory, 'projection.sqlite');
  process.env.PAYLOAD_CORPUS_DATABASE_PATH = corpusPath;
  process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
  delete process.env.PAYLOAD_DATABASE_PATH;
  const corpus = new PhysicalEconomyCorpus(corpusPath);
  expect(corpus.append('global', records(), at).kind).toBe('committed');
  const projection = new CorpusProjectionStore(projectionPath);
  expect(compilePublicProjection(corpus, projection, at, '2026-09-02T12:01:00.000Z').kind).toBe('projection_stored');
  projection.close();
  corpus.close();
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

describe('GET /api/corpus/warrants', () => {
  it('fails closed under the dedicated corpus-query identity', async () => {
    delete process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
    expect((await GET(request('entityId=pe:facility:warrant-api'))).status).toBe(503);
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-ONLY-TOKEN';
    expect((await GET(request('entityId=pe:facility:warrant-api', 'WRONG-TOKEN'))).status).toBe(401);
  });

  it('returns a score-free graph and verifiable membership proofs from the current public build', async () => {
    await seed();
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-ONLY-TOKEN';
    const response = await GET(request('entityId=pe%3Afacility%3Awarrant-api&maximumRecords=20', 'QUERY-ONLY-TOKEN'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: 'corpus_warrant_graph',
      subject: { requestedId: 'pe:facility:warrant-api', canonicalId: 'pe:facility:warrant-api' },
      verification: {
        verificationLevel: 'REPRODUCIBLE',
        provenanceStatus: 'COMPLETE',
        sourceTruthClaimed: false,
        attestation: { status: 'NOT_ATTESTED' },
        zkProof: { status: 'NOT_GENERATED' },
      },
      graph: { scorePolicy: 'NO_COMPOSITE_TRUST_SCORE' },
    });
    expect(body.graph.edges.some((edge: { kind: string }) => edge.kind === 'supported_by')).toBe(true);
    expect(body.graph.edges.some((edge: { kind: string }) => edge.kind === 'contradicted_by')).toBe(true);
    expect(JSON.stringify(body.graph)).not.toContain('trustScore');
    expect(body.verification.inclusionProofs.every((proof: Parameters<typeof verifyCorpusRecordInclusion>[1]) => verifyCorpusRecordInclusion(body.verification.commitment, proof))).toBe(true);
  });

  it('refuses ambiguous, unresolved, and over-broad warrant requests', async () => {
    await seed();
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-ONLY-TOKEN';
    expect((await GET(request('recordId=record%3Aentity%3Awarrant-api&entityId=pe%3Afacility%3Awarrant-api', 'QUERY-ONLY-TOKEN'))).status).toBe(400);
    expect((await GET(request('entityId=pe%3Afacility%3Amissing', 'QUERY-ONLY-TOKEN'))).status).toBe(404);
    const broad = await GET(request('entityId=pe%3Afacility%3Awarrant-api&maximumRecords=1', 'QUERY-ONLY-TOKEN'));
    expect(broad.status).toBe(413);
    expect(await broad.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_WARRANT_TOO_BROAD' });
  });
});
