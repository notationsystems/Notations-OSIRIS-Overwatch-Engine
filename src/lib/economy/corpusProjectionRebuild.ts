import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { CORPUS_REPRESENTATION_SPEC_VERSION } from './corpusProjection';

export type CorpusProjectionInspection =
  | { readonly state: 'missing' }
  | { readonly state: 'empty' }
  | { readonly state: 'current'; readonly specificationId: string }
  | { readonly state: 'obsolete'; readonly specificationId: 'payload.corpus.public-read-model.v2' }
  | { readonly state: 'unsupported'; readonly specificationId: string | null };

export function inspectCorpusProjection(path: string): CorpusProjectionInspection {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { state: 'missing' };
  if (!statSync(absolute).isFile()) return { state: 'unsupported', specificationId: null };
  const db = new Database(absolute, { readonly: true, fileMustExist: true });
  try {
    const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'corpus_projection_manifests'").get();
    if (!table) return { state: 'unsupported', specificationId: null };
    const row = db.prepare("SELECT manifest_json FROM corpus_projection_manifests WHERE projection_id = 'public:global'").get() as { manifest_json: string } | undefined;
    if (!row) return { state: 'empty' };
    let specificationId: string | null = null;
    try {
      const manifest = JSON.parse(row.manifest_json) as { representationSpecification?: { specificationId?: unknown } };
      specificationId = typeof manifest.representationSpecification?.specificationId === 'string' ? manifest.representationSpecification.specificationId : null;
    } catch { return { state: 'unsupported', specificationId: null }; }
    if (specificationId === CORPUS_REPRESENTATION_SPEC_VERSION) return { state: 'current', specificationId };
    if (specificationId === 'payload.corpus.public-read-model.v2') return { state: 'obsolete', specificationId };
    return { state: 'unsupported', specificationId };
  } finally {
    db.close();
  }
}

/** Archives, never deletes, an identified v2 disposable read model. */
export function archiveV2CorpusProjection(path: string, archivedAt = new Date().toISOString()): readonly string[] {
  const absolute = resolve(path);
  const inspection = inspectCorpusProjection(absolute);
  if (inspection.state !== 'obsolete') throw new Error(`CORPUS_PROJECTION_ARCHIVE_REFUSED: expected v2, found ${inspection.state}`);
  if (!Number.isFinite(Date.parse(archivedAt))) throw new Error('CORPUS_PROJECTION_ARCHIVE_REFUSED: archivedAt must be an ISO timestamp');
  const archiveDirectory = join(dirname(absolute), `${basename(absolute)}.archive`, archivedAt.replace(/[:.]/g, '-'));
  mkdirSync(archiveDirectory, { recursive: true });
  const moved: string[] = [];
  for (const candidate of [absolute, `${absolute}-wal`, `${absolute}-shm`]) {
    if (!existsSync(candidate)) continue;
    const destination = join(archiveDirectory, basename(candidate));
    renameSync(candidate, destination);
    moved.push(destination);
  }
  return Object.freeze(moved);
}
