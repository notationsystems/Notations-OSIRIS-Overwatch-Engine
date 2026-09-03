import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { archiveV2CorpusProjection, inspectCorpusProjection } from './corpusProjectionRebuild';

function projection(path: string, specificationId: string): void {
  const db = new Database(path);
  db.exec('CREATE TABLE corpus_projection_manifests(projection_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL)');
  db.prepare('INSERT INTO corpus_projection_manifests VALUES (?, ?)').run('public:global', JSON.stringify({ representationSpecification: { specificationId } }));
  db.close();
}

describe('public read-model v2 to v3 rebuild boundary', () => {
  it('identifies and recoverably archives v2 before a rebuild', () => {
    const directory = mkdtempSync(join(tmpdir(), 'payload-projection-rebuild-'));
    const path = join(directory, 'projection.sqlite');
    projection(path, 'payload.corpus.public-read-model.v2');
    expect(inspectCorpusProjection(path)).toEqual({ state: 'obsolete', specificationId: 'payload.corpus.public-read-model.v2' });
    const archived = archiveV2CorpusProjection(path, '2026-09-02T20:00:00.000Z');
    expect(archived).toHaveLength(1);
    expect(existsSync(archived[0])).toBe(true);
    expect(inspectCorpusProjection(path)).toEqual({ state: 'missing' });
  });

  it('refuses to archive unknown or current projection specifications', () => {
    const directory = mkdtempSync(join(tmpdir(), 'payload-projection-refuse-'));
    const unknown = join(directory, 'unknown.sqlite');
    const current = join(directory, 'current.sqlite');
    projection(unknown, 'payload.corpus.public-read-model.v99');
    projection(current, 'payload.corpus.public-read-model.v3');
    expect(inspectCorpusProjection(unknown)).toEqual({ state: 'unsupported', specificationId: 'payload.corpus.public-read-model.v99' });
    expect(inspectCorpusProjection(current)).toEqual({ state: 'current', specificationId: 'payload.corpus.public-read-model.v3' });
    expect(() => archiveV2CorpusProjection(unknown)).toThrow(/ARCHIVE_REFUSED/);
    expect(() => archiveV2CorpusProjection(current)).toThrow(/ARCHIVE_REFUSED/);
  });
});
