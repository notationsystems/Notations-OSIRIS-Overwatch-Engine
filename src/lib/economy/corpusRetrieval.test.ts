import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { buildCorpusContextPackage, CorpusRetrievalError, planCorpusRetrieval } from './corpusRetrieval';
import { PhysicalEconomyCorpus, type CorpusRecordInput } from './physicalEconomyCorpus';

const directories: string[] = [];
const knownAt = '2026-02-03T14:12:00.000Z';
const recordedAt = '2026-02-03T14:13:00.000Z';

function records(): CorpusRecordInput[] {
  const common = { schema: 'payload.corpus.record.v1' as const, knownAt, access: OPEN_PUBLIC_CORPUS_ACCESS };
  return [
    { ...common, recordId: 'rec:evidence:port-report:v1', recordType: 'evidence', evidenceId: 'evidence:port-report', sourceId: 'source:port-report', title: 'Port annual report', sourceUrl: 'https://example.test/port-report.pdf', artifactSha256: 'a'.repeat(64), retrievedAt: knownAt, artifactId: 'artifact:port-report', mediaType: 'application/pdf', parserVersion: 'pdf-table-v1' },
    { ...common, recordId: 'rec:evidence-unit:capacity-table:v1', recordType: 'evidence_unit', evidenceUnitId: 'evidence-unit:capacity-table', artifactEvidenceId: 'evidence:port-report', modality: 'document', locator: { page: 3, table: 'Capacity', row: 4, column: 'Annual capacity' }, extraction: { kind: 'parser', version: '1.4.2', adapter: 'pdf-table-v1', confidence: 0.98 }, contentSha256: 'b'.repeat(64), extractedText: 'Annual handling capacity 13.1 Mt' },
    { ...common, recordId: 'rec:entity:facility:terminal:v1', recordType: 'entity', entityId: 'pe:facility:terminal', entityKind: 'facility', canonicalName: 'Example Bulk Terminal', countryCode: 'CA', evidenceIds: ['evidence-unit:capacity-table'] },
    { ...common, recordId: 'rec:entity:material:copper:v1', recordType: 'entity', entityId: 'pe:material:copper', entityKind: 'material', canonicalName: 'Copper concentrate', evidenceIds: ['evidence-unit:capacity-table'] },
    { ...common, recordId: 'rec:relationship:terminal-produces-copper:v1', recordType: 'relationship', relationshipId: 'relationship:terminal-produces-copper', subjectEntityId: 'pe:facility:terminal', predicate: 'produces', objectEntityId: 'pe:material:copper', validFrom: '2025-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:capacity-table'] },
    { ...common, recordId: 'rec:observation:capacity:source-a:v1', recordType: 'observation', observationId: 'observation:capacity:source-a', entityId: 'pe:facility:terminal', observationType: 'capacity', metric: 'annual_handling_capacity', value: 12.8, unit: 'Mt', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'medium', evidenceIds: ['evidence-unit:capacity-table'] },
    { ...common, recordId: 'rec:observation:capacity:source-b:v1', recordType: 'observation', observationId: 'observation:capacity:source-b', entityId: 'pe:facility:terminal', observationType: 'capacity', metric: 'annual_handling_capacity', value: 13.1, unit: 'Mt', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', valueKind: 'reported', confidence: 'high', evidenceIds: ['evidence-unit:capacity-table'] },
    { ...common, recordId: 'rec:assertion:terminal-capacity:v1', recordType: 'assertion', assertionId: 'assertion:terminal-capacity', entityId: 'pe:facility:terminal', propertyKey: 'annual_handling_capacity', selectedValue: 13.1, unit: 'Mt', status: 'accepted', selectionPolicy: 'source-reliability-v1', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', confidence: 'high', evidence: [{ observationId: 'observation:capacity:source-b', role: 'supports' }, { observationId: 'observation:capacity:source-a', role: 'contradicts' }] },
  ];
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('Payload corpus evidence, assertions, and GraphRAG boundary', () => {
  it('compiles source-bounded evidence and accepted assertion support into a traceable ContextPackage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-context-'));
    directories.push(directory);
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    expect(corpus.append('global', records(), recordedAt)).toMatchObject({ kind: 'committed', idempotent: false });
    const projection = buildPublicProjection(corpus.projectionSource('global', '2026-02-04T00:00:00.000Z'), '2026-02-04T00:01:00.000Z');
    const plan = planCorpusRetrieval(projection, {
      query: 'Example Bulk Terminal capacity', entityIds: ['pe:facility:terminal'],
      propertyKeys: ['annual_handling_capacity'], asOf: '2026-01-01T00:00:00.000Z',
      traversal: { predicates: ['produces'], maxHops: 2 }, evidenceQuery: 'handling capacity',
    });
    const replayedPlan = planCorpusRetrieval(projection, {
      query: 'Example Bulk Terminal capacity', entityIds: ['pe:facility:terminal'],
      propertyKeys: ['annual_handling_capacity'], asOf: '2026-01-01T00:00:00.000Z',
      traversal: { predicates: ['produces'], maxHops: 2 }, evidenceQuery: 'handling capacity',
    });
    expect(replayedPlan.planId).toBe(plan.planId);

    const context = buildCorpusContextPackage(projection, plan);
    expect(context).toMatchObject({
      schema: 'payload.corpus.context-package.v1',
      query: { knownAt: '2026-02-04T00:00:00.000Z' },
      entities: [{ entityId: 'pe:facility:terminal' }, { entityId: 'pe:material:copper' }],
      relationships: [{ predicate: 'produces' }],
      assertions: [{ assertionId: 'assertion:terminal-capacity', status: 'accepted' }],
      evidenceUnits: [{ evidenceUnitId: 'evidence-unit:capacity-table', locator: { page: 3 } }],
      artifacts: [{ evidenceId: 'evidence:port-report', artifactSha256: 'a'.repeat(64) }],
      contradictions: [{ assertionId: 'assertion:terminal-capacity', observationIds: ['observation:capacity:source-a'] }],
      missingEvidence: [],
      retrievalTrace: { planId: plan.planId, projectionDigest: projection.manifest.projectionDigest },
    });
    expect(context.observations.map(record => record.observationId).sort()).toEqual(['observation:capacity:source-a', 'observation:capacity:source-b']);
    expect(context.contextId).toMatch(/^context-package:[a-f0-9]{64}$/);
    corpus.close();
  });

  it('refuses an unavailable historic knowledge time instead of answering from a later projection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-context-time-'));
    directories.push(directory);
    const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
    expect(corpus.append('global', records(), recordedAt).kind).toBe('committed');
    const projection = buildPublicProjection(corpus.projectionSource('global', '2026-02-04T00:00:00.000Z'), '2026-02-04T00:01:00.000Z');
    expect(() => planCorpusRetrieval(projection, { query: 'terminal', knownAt: '2026-02-03T00:00:00.000Z' })).toThrowError(CorpusRetrievalError);
    corpus.close();
  });

  it('atomically emits replayable projection events and rejects checkpoint regression', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-outbox-'));
    directories.push(directory);
    const path = join(directory, 'corpus.sqlite');
    const corpus = new PhysicalEconomyCorpus(path);
    expect(corpus.append('global', records(), recordedAt).kind).toBe('committed');
    const page = corpus.readProjectionEvents({ scope: 'global', afterSequence: 0, limit: 3 });
    expect(page).toMatchObject({ kind: 'corpus_projection_event_page', nextAfterSequence: 3, hasMore: true });
    expect(page.events.map(event => event.sequence)).toEqual([1, 2, 3]);
    expect(corpus.checkpointProjection({ projector: 'projector:qdrant', sequence: 3, updatedAt: recordedAt })).toMatchObject({ sequence: 3 });
    expect(() => corpus.checkpointProjection({ projector: 'projector:qdrant', sequence: 2, updatedAt: recordedAt })).toThrow(/REGRESSION/);
    corpus.close();

    const reopened = new PhysicalEconomyCorpus(path);
    expect(reopened.summary()).toMatchObject({ lastSequence: 8, projectionEvents: 8, projectorCheckpoints: 1 });
    expect(reopened.readProjectionEvents({ afterSequence: 3, limit: 10 }).events).toHaveLength(5);
    reopened.close();
  });

  it('refuses a projection outbox that was altered after its one-time legacy backfill', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-outbox-tamper-'));
    directories.push(directory);
    const path = join(directory, 'corpus.sqlite');
    const corpus = new PhysicalEconomyCorpus(path);
    expect(corpus.append('global', records(), recordedAt).kind).toBe('committed');
    corpus.close();
    const raw = new Database(path);
    raw.prepare('DELETE FROM corpus_outbox_events WHERE sequence = 1').run();
    raw.close();
    expect(() => new PhysicalEconomyCorpus(path)).toThrow(/projection outbox does not cover/);
  });

  it('upgrades the legacy record-type constraint before accepting Evidence IR records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-corpus-upgrade-'));
    directories.push(directory);
    const path = join(directory, 'corpus.sqlite');
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE corpus_records (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        record_id TEXT NOT NULL UNIQUE,
        record_type TEXT NOT NULL CHECK(record_type IN ('evidence','entity','alias','relationship','observation')),
        known_at TEXT NOT NULL, recorded_at TEXT NOT NULL, previous_hash TEXT,
        record_hash TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL
      );
    `);
    legacy.close();
    const upgraded = new PhysicalEconomyCorpus(path);
    expect(upgraded.append('global', records(), recordedAt)).toMatchObject({ kind: 'committed' });
    expect(upgraded.summary()).toMatchObject({ lastSequence: 8, projectionEvents: 8 });
    upgraded.close();
  });
});
