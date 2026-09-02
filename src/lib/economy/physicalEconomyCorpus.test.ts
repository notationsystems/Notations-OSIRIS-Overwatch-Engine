import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS, type CorpusAccess } from './corpusPolicy';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const temporaryDirectories: string[] = [];
const known = '2026-01-10T12:00:00.000Z';
const recorded = '2026-01-10T12:05:00.000Z';

async function corpus() {
  const directory = await mkdtemp(resolve(tmpdir(), 'payload-corpus-test-'));
  temporaryDirectories.push(directory);
  const path = resolve(directory, 'corpus.sqlite');
  return { database: new PhysicalEconomyCorpus(path), path };
}

function globalFixture(): CorpusRecordInput[] {
  const evidenceIds = ['evidence:datasheet:hdpe'];
  const records: CorpusRecordInput[] = [
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:evidence:hdpe:v1', recordType: 'evidence', knownAt: known,
      evidenceId: evidenceIds[0], sourceId: 'source:producer:catalogue', title: 'Producer HDPE catalogue',
      sourceUrl: 'https://example.test/hdpe.pdf', artifactSha256: 'a'.repeat(64), retrievedAt: known,
      publishedAt: '2026-01-01T00:00:00.000Z', locator: 'page 4',
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:material:hdpe:v1', recordType: 'entity', knownAt: known,
      entityId: 'pe:material:hdpe', entityKind: 'material', canonicalName: 'High-density polyethylene', evidenceIds,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:organization:polymerco:v1', recordType: 'entity', knownAt: known,
      entityId: 'pe:organization:polymerco', entityKind: 'organization', canonicalName: 'Polymer Co', evidenceIds,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:baytown:v1', recordType: 'entity', knownAt: known,
      entityId: 'pe:facility:baytown', entityKind: 'facility', canonicalName: 'Baytown Polymers Plant', countryCode: 'US',
      location: { lat: 29.735, lng: -94.977, precision: 'site' }, evidenceIds,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:alias:material:hdpe:v1', recordType: 'alias', knownAt: known,
      aliasId: 'alias:material:hdpe', scheme: 'payload-material-name', value: 'HDPE', entityId: 'pe:material:hdpe', evidenceIds,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:baytown-produces-hdpe:v1', recordType: 'relationship', knownAt: known,
      relationshipId: 'relationship:baytown-produces-hdpe', subjectEntityId: 'pe:facility:baytown', predicate: 'produces', objectEntityId: 'pe:material:hdpe',
      validFrom: '2020-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds,
    },
    {
      schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:baytown-operated-by-polymerco:v1', recordType: 'relationship', knownAt: known,
      relationshipId: 'relationship:baytown-operated-by-polymerco', subjectEntityId: 'pe:facility:baytown', predicate: 'operated_by', objectEntityId: 'pe:organization:polymerco',
      valueKind: 'reported', confidence: 'high', evidenceIds,
    },
  ];
  return records.map(record => ({ ...record, access: OPEN_PUBLIC_CORPUS_ACCESS } as CorpusRecordInput));
}

const privateAccess: CorpusAccess = {
  visibility: 'CUSTOMER_PRIVATE', licenseClass: 'CUSTOMER_CONFIDENTIAL', redistributionClass: 'PROHIBITED', retentionClass: 'CUSTOMER_CONTRACT',
  allowedUses: ['SEARCH', 'ANALYSIS'], tenantId: 'acme',
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Physical-Economy Corpus V0', () => {
  it('represents the wider company-to-flow graph declared by Payload', async () => {
    const { database } = await corpus();
    const evidence = globalFixture()[0];
    const evidenceIds = ['evidence:datasheet:hdpe'];
    const wideRecords: CorpusRecordInput[] = [
      evidence,
      { schema: 'payload.corpus.record.v1', recordId: 'rec:entity:supplier:v1', recordType: 'entity', knownAt: known, entityId: 'pe:supplier:one', entityKind: 'supplier', canonicalName: 'Supplier One', evidenceIds },
      { schema: 'payload.corpus.record.v1', recordId: 'rec:entity:port:v1', recordType: 'entity', knownAt: known, entityId: 'pe:port:one', entityKind: 'port', canonicalName: 'Port One', evidenceIds },
      { schema: 'payload.corpus.record.v1', recordId: 'rec:entity:vessel:v1', recordType: 'entity', knownAt: known, entityId: 'pe:vessel:one', entityKind: 'vessel', canonicalName: 'Vessel One', evidenceIds },
      { schema: 'payload.corpus.record.v1', recordId: 'rec:relation:vessel-port:v1', recordType: 'relationship', knownAt: known, relationshipId: 'relationship:vessel-calls-port', subjectEntityId: 'pe:vessel:one', predicate: 'calls_at', objectEntityId: 'pe:port:one', valueKind: 'reported', confidence: 'high', evidenceIds },
      { schema: 'payload.corpus.record.v1', recordId: 'rec:observation:vessel-position:v1', recordType: 'observation', knownAt: known, observationId: 'observation:vessel-position', entityId: 'pe:vessel:one', observationType: 'vessel_position', metric: 'latitude', value: 43.2, unit: 'degrees', valueKind: 'reported', confidence: 'high', evidenceIds },
    ];
    try {
      expect(database.append('global', wideRecords, recorded)).toMatchObject({ kind: 'committed', records: expect.arrayContaining([
        expect.objectContaining({ entityKind: 'supplier' }), expect.objectContaining({ entityKind: 'port' }),
        expect.objectContaining({ entityKind: 'vessel' }), expect.objectContaining({ predicate: 'calls_at' }),
        expect.objectContaining({ observationType: 'vessel_position' }),
      ]) });
    } finally { database.close(); }
  });

  it('commits an immutable linear sequence and answers evidence-linked facility discovery', async () => {
    const { database } = await corpus();
    try {
      const committed = database.append('global', globalFixture(), recorded);
      expect(committed).toMatchObject({ kind: 'committed', idempotent: false });
      if (committed.kind !== 'committed') throw new Error('fixture refused');
      expect(committed.records.map(record => record.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(committed.records[0].previousHash).toBeNull();
      expect(committed.records[1].previousHash).toBe(committed.records[0].recordHash);

      expect(database.findFacilities('HDPE', { asOf: '2026-02-01T00:00:00.000Z', knowledgeCutoff: '2026-02-01T00:00:00.000Z' })).toMatchObject({
        kind: 'facility_discovery',
        material: { entityId: 'pe:material:hdpe', name: 'High-density polyethylene' },
        scope: 'global',
        facilities: [{
          entityId: 'pe:facility:baytown', name: 'Baytown Polymers Plant', countryCode: 'US',
          operator: { entityId: 'pe:organization:polymerco', name: 'Polymer Co' },
          relationshipId: 'relationship:baytown-produces-hdpe', confidence: 'high',
          evidence: [{ evidenceId: 'evidence:datasheet:hdpe', artifactSha256: 'a'.repeat(64) }],
        }],
      });
      expect(database.summary()).toMatchObject({ lastSequence: 7, records: expect.arrayContaining([{ scope: 'global', recordType: 'entity', count: 3 }]) });
    } finally { database.close(); }
  });

  it('composes global knowledge with exactly one customer scope', async () => {
    const { database } = await corpus();
    try {
      database.append('global', globalFixture(), recorded);
      const privateRecords: CorpusRecordInput[] = [
        {
          schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:customer-plant:v1', recordType: 'entity', knownAt: known,
          entityId: 'pe:facility:customer-plant', entityKind: 'facility', canonicalName: 'Customer Qualified Plant', countryCode: 'CA', evidenceIds: ['evidence:datasheet:hdpe'], access: privateAccess,
        },
        {
          schema: 'payload.corpus.record.v1', recordId: 'rec:relationship:customer-plant-produces-hdpe:v1', recordType: 'relationship', knownAt: known,
          relationshipId: 'relationship:customer-plant-produces-hdpe', subjectEntityId: 'pe:facility:customer-plant', predicate: 'produces', objectEntityId: 'pe:material:hdpe',
          valueKind: 'reported', confidence: 'medium', evidenceIds: ['evidence:datasheet:hdpe'], access: privateAccess,
        },
      ];
      expect(database.append('customer:acme', privateRecords, recorded).kind).toBe('committed');
      const global = database.findFacilities('HDPE', { scope: 'global', asOf: recorded, knowledgeCutoff: recorded });
      const acme = database.findFacilities('HDPE', { scope: 'customer:acme', asOf: recorded, knowledgeCutoff: recorded });
      const other = database.findFacilities('HDPE', { scope: 'customer:other', asOf: recorded, knowledgeCutoff: recorded });
      expect(global.kind === 'facility_discovery' ? global.facilities.map(item => item.entityId) : []).toEqual(['pe:facility:baytown']);
      expect(acme.kind === 'facility_discovery' ? acme.facilities.map(item => item.entityId) : []).toEqual(['pe:facility:baytown', 'pe:facility:customer-plant']);
      expect(other.kind === 'facility_discovery' ? other.facilities.map(item => item.entityId) : []).toEqual(['pe:facility:baytown']);
      expect(database.page({ scope: 'customer:other', limit: 100, knowledgeCutoff: recorded }).records.some(record => record.scope === 'customer:acme')).toBe(false);
    } finally { database.close(); }
  });

  it('supports explicit temporal revisions without rewriting history', async () => {
    const { database } = await corpus();
    try {
      database.append('global', globalFixture(), recorded);
      const revision: CorpusRecordInput = {
        schema: 'payload.corpus.record.v1', recordId: 'rec:entity:facility:baytown:v2', recordType: 'entity', knownAt: '2026-06-01T00:00:00.000Z',
        supersedes: 'rec:entity:facility:baytown:v1', entityId: 'pe:facility:baytown', entityKind: 'facility', canonicalName: 'Baytown Polymer Complex', countryCode: 'US',
        location: { lat: 29.735, lng: -94.977, precision: 'site' }, evidenceIds: ['evidence:datasheet:hdpe'],
      };
      expect(database.append('global', [revision], '2026-06-01T00:01:00.000Z').kind).toBe('committed');
      const before = database.findFacilities('HDPE', { asOf: '2026-07-01T00:00:00.000Z', knowledgeCutoff: '2026-05-01T00:00:00.000Z' });
      const after = database.findFacilities('HDPE', { asOf: '2026-07-01T00:00:00.000Z', knowledgeCutoff: '2026-07-01T00:00:00.000Z' });
      expect(before.kind === 'facility_discovery' ? before.facilities[0].name : '').toBe('Baytown Polymers Plant');
      expect(after.kind === 'facility_discovery' ? after.facilities[0].name : '').toBe('Baytown Polymer Complex');
      expect(database.page({ limit: 100, knowledgeCutoff: '2026-07-01T00:00:00.000Z' }).records).toHaveLength(8);
    } finally { database.close(); }
  });

  it('is idempotent for exact replay and refuses mutation, missing evidence, and anachronistic claims', async () => {
    const { database } = await corpus();
    try {
      const fixture = globalFixture();
      expect(database.append('global', fixture, recorded)).toMatchObject({ kind: 'committed', idempotent: false });
      expect(database.append('global', fixture, recorded)).toMatchObject({ kind: 'committed', idempotent: true });
      const changed = { ...fixture[1], canonicalName: 'Changed in place' } as CorpusRecordInput;
      expect(database.append('global', [changed], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_RECORD_CONFLICT' });
      const missing = { ...fixture[1], recordId: 'rec:entity:material:missing-evidence:v1', entityId: 'pe:material:missing-evidence', evidenceIds: ['evidence:not-held'] } as CorpusRecordInput;
      expect(database.append('global', [missing], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_REFERENCE_MISSING' });
      const unsupported = { ...fixture[1], recordId: 'rec:entity:material:unsupported:v1', entityId: 'pe:material:unsupported', evidenceIds: [] } as CorpusRecordInput;
      expect(database.append('global', [unsupported], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID' });
      const early = { ...fixture[1], recordId: 'rec:entity:material:early:v1', entityId: 'pe:material:early', knownAt: '2025-01-01T00:00:00.000Z' } as CorpusRecordInput;
      expect(database.append('global', [early], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_KNOWLEDGE_ORDER_INVALID' });
      const duplicateStableIdentity = { ...fixture[6], recordId: 'rec:relationship:baytown-produces-hdpe:duplicate' } as CorpusRecordInput;
      expect(database.append('global', [duplicateStableIdentity], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_RECORD_CONFLICT' });
      const wrongTenantScope = { ...fixture[0], recordId: 'rec:evidence:wrong-scope:v1', evidenceId: 'evidence:wrong-scope', access: privateAccess } as CorpusRecordInput;
      expect(database.append('global', [wrongTenantScope], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: expect.stringMatching(/scope-inconsistent/i) });
      const credentialedStorageUri = { ...fixture[0], recordId: 'rec:evidence:credentialed-uri:v1', evidenceId: 'evidence:credentialed-uri', storageUri: 'https://user:secret@example.test/raw.pdf' } as CorpusRecordInput;
      expect(database.append('global', [credentialedStorageUri], recorded)).toMatchObject({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: expect.stringMatching(/artifact metadata/i) });
    } finally { database.close(); }
  });

  it('returns typed refusals for unresolved and ambiguous material identities', async () => {
    const { database } = await corpus();
    try {
      expect(database.findFacilities('HDPE')).toMatchObject({ kind: 'refusal', code: 'MATERIAL_UNRESOLVED' });
      const records = globalFixture();
      records.splice(5, 0,
        {
          schema: 'payload.corpus.record.v1', recordId: 'rec:entity:material:recycled-hdpe:v1', recordType: 'entity', knownAt: known,
          entityId: 'pe:material:recycled-hdpe', entityKind: 'material', canonicalName: 'Recycled HDPE', evidenceIds: ['evidence:datasheet:hdpe'],
        },
        {
          schema: 'payload.corpus.record.v1', recordId: 'rec:alias:material:recycled-hdpe:v1', recordType: 'alias', knownAt: known,
          aliasId: 'alias:material:recycled-hdpe', scheme: 'customer-language', value: 'HDPE', entityId: 'pe:material:recycled-hdpe', evidenceIds: ['evidence:datasheet:hdpe'],
        },
      );
      expect(database.append('global', records, recorded).kind).toBe('committed');
      expect(database.findFacilities('HDPE', { asOf: recorded, knowledgeCutoff: recorded })).toMatchObject({ kind: 'refusal', code: 'MATERIAL_AMBIGUOUS' });
    } finally { database.close(); }
  });

  it('refuses semantic tampering even when SQLite remains structurally valid', async () => {
    const { database, path } = await corpus();
    database.append('global', globalFixture(), recorded);
    database.close();
    const raw = new Database(path);
    raw.prepare("UPDATE corpus_records SET record_json = '{}' WHERE sequence = 2").run();
    raw.close();
    expect(() => new PhysicalEconomyCorpus(path)).toThrow(/CORPUS_DATABASE_CORRUPT/);
  });
});
