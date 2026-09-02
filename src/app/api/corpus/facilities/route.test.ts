import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { GET, materialFromFacilityQuery } from './route';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { resetProcessSingleton } from '@/lib/economy/processSingleton';

const oldCorpusPath = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
const oldDatabasePath = process.env.PAYLOAD_DATABASE_PATH;
const paths: string[] = [];

afterEach(async () => {
  const configured = process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  if (configured) {
    const path = resolve(configured);
    try { physicalEconomyCorpus()?.close(); } catch { /* already closed */ }
    resetProcessSingleton(`physical-economy-corpus:${path}`);
  }
  if (oldCorpusPath === undefined) delete process.env.PAYLOAD_CORPUS_DATABASE_PATH;
  else process.env.PAYLOAD_CORPUS_DATABASE_PATH = oldCorpusPath;
  if (oldDatabasePath === undefined) delete process.env.PAYLOAD_DATABASE_PATH;
  else process.env.PAYLOAD_DATABASE_PATH = oldDatabasePath;
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

const knownAt = '2026-01-10T00:00:00.000Z';
const evidence = 'evidence:polypropylene:directory';

function records(): CorpusRecordInput[] {
  return [
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
}

describe('GET /api/corpus/facilities', () => {
  it('parses the first visual-query intent deterministically', () => {
    expect(materialFromFacilityQuery('polypropylene production')).toBe('polypropylene');
    expect(materialFromFacilityQuery('HDPE facilities')).toBe('HDPE');
    expect(materialFromFacilityQuery('ABS')).toBe('ABS');
  });

  it('fails closed when no corpus database is configured', async () => {
    delete process.env.PAYLOAD_CORPUS_DATABASE_PATH;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const response = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_NOT_CONFIGURED' });
  });

  it('projects only evidence-linked global facilities and cannot accept a customer scope', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-corpus-api-'));
    paths.push(dir);
    const path = join(dir, 'corpus.sqlite');
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = path;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const seed = new PhysicalEconomyCorpus(path);
    expect(seed.append('global', records(), '2026-01-10T00:01:00.000Z').kind).toBe('committed');
    expect(seed.append('customer:acme', [{
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:private-pp:v1', recordType: 'entity', knownAt,
      entityId: 'pe:facility:private-pp', entityKind: 'facility', canonicalName: 'Private PP Plant', evidenceIds: [evidence],
    }, {
      schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:private-pp:v1', recordType: 'relationship', knownAt,
      relationshipId: 'relationship:private-pp-produces-polypropylene', subjectEntityId: 'pe:facility:private-pp', predicate: 'produces', objectEntityId: 'pe:material:polypropylene',
      valueKind: 'reported', confidence: 'medium', evidenceIds: [evidence],
    }], '2026-01-10T00:02:00.000Z').kind).toBe('committed');
    seed.close();

    const response = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene%20production&scope=customer:acme&asOf=2026-02-01'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'facility_discovery', query: 'polypropylene production', interpretedAs: 'polypropylene', scope: 'global',
      facilities: [{ entityId: 'pe:facility:global-pp', name: 'Global PP Plant', evidence: [{ evidenceId: evidence }] }],
    });
  });

  it('returns typed input and resolution refusals', async () => {
    const bad = await GET(new Request('http://localhost/api/corpus/facilities?q=x'));
    expect(bad.status).toBe(400);
    const dir = await mkdtemp(join(tmpdir(), 'payload-corpus-api-'));
    paths.push(dir);
    process.env.PAYLOAD_CORPUS_DATABASE_PATH = join(dir, 'empty.sqlite');
    delete process.env.PAYLOAD_DATABASE_PATH;
    const miss = await GET(new Request('http://localhost/api/corpus/facilities?q=polypropylene'));
    expect(miss.status).toBe(404);
    expect(await miss.json()).toMatchObject({ kind: 'refusal', code: 'MATERIAL_UNRESOLVED' });
  });
});
