import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GET, materialFromFacilityQuery } from './route';
import { OPEN_PUBLIC_CORPUS_ACCESS, type CorpusAccess } from '@/lib/economy/corpusPolicy';
import { compilePublicProjection, CorpusProjectionStore } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const oldProjectionPath = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
const paths: string[] = [];

afterEach(async () => {
  const configured = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (configured) {
    const path = resolve(configured);
    try { physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${path}`);
  }
  const configuredProjection = process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  if (configuredProjection) {
    const path = resolve(configuredProjection);
    try { corpusProjectionStore()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-projection:${path}`);
  }
  if (oldCorpusPath === undefined) delete process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  else process.env.PAYLOAD_CORPUS_DATABASE_PATH = oldCorpusPath;
  if (oldDatabasePath === undefined) delete process.env.PAYLOAD_DATABASE_PATH;
  else process.env.PAYLOAD_DATABASE_PATH = oldDatabasePath;
  if (oldProjectionPath === undefined) delete process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
  else process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = oldProjectionPath;
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const knownAt = '2026-01-10T00:00:00.000Z';
const evidence = 'evidence:polypropylene:directory';

function records(): CorpusRecordInput[] {
  const values: CorpusRecordInput[] = [
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:polypropylene:v1', recordType: 'evidence', knownAt,
      evidenceId: evidence, sourceId: 'source:industry-directory', title: 'Polypropylene facility directory',
      sourceUrl: 'https://example.com/polypropylene', artifactSha256: 'b'.repeat(64), retrievedAt: knownAt,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:material:polypropylene:v1', recordType: 'entity', knownAt,
      entityId: 'pe:material:polypropylene', entityKind: 'material', canonicalName: 'Polypropylene', evidenceIds: [evidence],
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:alias:polypropylene:v1', recordType: 'alias', knownAt,
      aliasId: 'alias:material:polypropylene', scheme: 'common-name', value: 'polypropylene', entityId: 'pe:material:polypropylene', evidenceIds: [evidence],
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:global-pp:v1', recordType: 'entity', knownAt,
      entityId: 'pe:facility:global-pp', entityKind: 'facility', canonicalName: 'Global PP Plant', countryCode: 'CA',
      location: { lat: 43.65, lng: -79.38, precision: 'site' }, evidenceIds: [evidence],
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:global-pp:v1', recordType: 'relationship', knownAt,
      relationshipId: 'relationship:global-pp-produces-polypropylene', subjectEntityId: 'pe:facility:global-pp', predicate: 'produces', objectEntityId: 'pe:material:polypropylene',
      valueKind: 'reported', confidence: 'high', evidenceIds: [evidence],
    },
  ];
  return values.map(record => ({ ...record, access: OPEN_PUBLIC_CORPUS_ACCESS } as CorpusRecordInput));
}

const privateAccess: CorpusAccess = {
  visibility: 'CUSTOMER_PRIVATE', licenseClass: 'CUSTOMER_CONFIDENTIAL', redistributionClass: 'PROHIBITED', retentionClass: 'CUSTOMER_CONTRACT',
  allowedUses: ['SEARCH', 'ANALYSIS'], tenantId: 'acme',
};

describe('GET /api/corpus/facilities', () => {
  it('parses the first visual-query intent deterministically', () => {
    expect(materialFromFacilityQuery('polypropylene production')).toBe('polypropylene');
    expect(materialFromFacilityQuery('HDPE facilities')).toBe('HDPE');
    expect(materialFromFacilityQuery('ABS')).toBe('ABS');
  });

  it('fails closed when canonical or read-model storage is not configured', async () => {
    delete process.env.PAYLOAD_CORPUS_DATABASE_PATH;
    delete process.env.PAYLOAD_DATABASE_PATH;
    delete process.env.PAYLOAD_CORPUS_READ_MODEL_PATH;
    const response = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_CONFIGURED' });
  });

  it('projects only evidence-linked global facilities and cannot accept a customer scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-corpus-api-'));
    paths.push(dir);
    const path = join(dir, 'corpus.sqlite');
    const projectionPath = join(dir, 'public-read-model.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = path;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const seed = new PhysicalEconomyCorpus(path);
    expect(seed.append('global', records(), '2026-01-10T00:01:00.000Z').kind).toBe('committed');
    expect(seed.append('customer:acme', [{
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:private-pp:v1', recordType: 'entity', knownAt,
      entityId: 'pe:facility:private-pp', entityKind: 'facility', canonicalName: 'Private PP Plant', evidenceIds: [evidence], access: privateAccess,
    }, {
      schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:private-pp:v1', recordType: 'relationship', knownAt,
      relationshipId: 'relationship:private-pp-produces-polypropylene', subjectEntityId: 'pe:facility:private-pp', predicate: 'produces', objectEntityId: 'pe:material:polypropylene',
      valueKind: 'reported', confidence: 'medium', evidenceIds: [evidence], access: privateAccess,
    }], '2026-01-10T00:02:00.000Z').kind).toBe('committed');
    const projection = new CorpusProjectionStore(projectionPath);
    expect(compilePublicProjection(seed, projection, '2026-02-01T00:00:00.000Z', '2026-02-01T00:01:00.000Z').kind).toBe('projection_stored');
    projection.close();
    seed.close();

    const response = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene%20production&scope=customer:acme&asOf=2026-02-01'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      kind: 'facility_discovery', query: 'polypropylene production', interpretedAs: 'polypropylene', scope: 'global',
      facilities: [{ entityId: 'pe:facility:global-pp', name: 'Global PP Plant', evidence: [{ evidenceId: evidence }] }],
      warrant: {
        schema: 'payload.corpus.answer-warrant.v1',
        basis: 'evidence_linked_canonical_records',
        canonicalIdentities: ['pe:facility:global-pp', 'pe:material:polypropylene'],
        projectionId: 'public:global',
        projectionRecordCount: 5,
        compilerVersion: '1.2.0',
        policy: { inputCount: 5, effective: { classification: 'PUBLIC', externalRelease: 'PERMITTED' } },
        corpusBuild: { projectionId: 'public:global', embeddingVersion: null, ontologyVersion: 'payload.physical-economy.v1' },
      },
    });
    expect(body.warrant.computation[0].inputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.warrant.computation[0].outputDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.warrant.verification).toMatchObject({
      verificationLevel: 'REPRODUCIBLE',
      provenanceStatus: 'COMPLETE',
      sourceTruthClaimed: false,
      commitment: { leafCount: 5 },
      attestation: { status: 'NOT_ATTESTED' },
      zkProof: { status: 'NOT_GENERATED' },
    });
    expect(body.warrant.warrantGraph).toMatchObject({ scorePolicy: 'NO_COMPOSITE_TRUST_SCORE' });
    expect(body.warrant.warrantGraph.nodes.some((node: { canonicalId?: string }) => node.canonicalId === 'pe:facility:global-pp')).toBe(true);
    expect(body.warrant).not.toHaveProperty('sourceSequence');
    expect(body.warrant).not.toHaveProperty('sourceDigest');
    expect(body.warrant.corpusBuild).not.toHaveProperty('canonicalStateFingerprint');
  });

  it('returns typed input and resolution refusals', async () => {
    const bad = await GET(new Request('http://localhost/api/corpus/facilities?q=x'));
    expect(bad.status).toBe(400);
    const dir = await mkdtemp(join(tmpdir(), 'payload-corpus-api-'));
    paths.push(dir);
    const path = join(dir, 'empty.sqlite');
    const projectionPath = join(dir, 'empty-read-model.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = path;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const empty = new PhysicalEconomyCorpus(path);
    const projection = new CorpusProjectionStore(projectionPath);
    compilePublicProjection(empty, projection, '2026-02-01T00:00:00.000Z', '2026-02-01T00:01:00.000Z');
    projection.close();
    empty.close();
    const miss = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene'));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ kind: 'refusal', code: 'MATERIAL_UNRESOLVED' });
  });

  it('refuses to serve a read model after canonical global state advances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-corpus-api-'));
    paths.push(dir);
    const path = join(dir, 'corpus.sqlite');
    const projectionPath = join(dir, 'read-model.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = path;
    process.env.PAYLOAD_CORPUS_READ_MODEL_PATH = projectionPath;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const seed = new PhysicalEconomyCorpus(path);
    seed.append('global', records(), '2026-01-10T00:01:00.000Z');
    const projection = new CorpusProjectionStore(projectionPath);
    compilePublicProjection(seed, projection, '2026-02-01T00:00:00.000Z', '2026-02-01T00:01:00.000Z');
    seed.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:new-public:v1', recordType: 'evidence', knownAt: '2026-02-02T00:00:00.000Z', evidenceId: 'evidence:new-public', sourceId: 'source:new-public', title: 'New public source', sourceUrl: 'https://example.com/new', artifactSha256: 'd'.repeat(64), retrievedAt: '2026-02-02T00:00:00.000Z', access: OPEN_PUBLIC_CORPUS_ACCESS }], '2026-02-02T00:01:00.000Z');
    projection.close();
    seed.close();
    const response = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE' });
  });
});
