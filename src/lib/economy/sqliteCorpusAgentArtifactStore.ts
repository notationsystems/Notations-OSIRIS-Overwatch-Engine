/** SQLite/WAL edge store for immutable corpus agent artifacts. */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  corpusAgentArtifactDefect,
  corpusAgentArtifactHash,
  corpusAgentArtifactInput,
  verifyCorpusAgentArtifactSet,
  visibleCorpusAgentArtifactScopes,
  type CorpusAgentArtifactAppendResult,
  type CorpusAgentArtifactInput,
  type CorpusAgentArtifactPage,
  type CorpusAgentArtifactRepository,
  type StoredCorpusAgentArtifact,
} from './corpusAgentArtifacts';
import { verifyCorpusBuildAttestation } from './corpusBuildAttestation';
import { canonicalCorpusJson, corpusScopeValid, type CorpusScope } from './physicalEconomyCorpus';

type ArtifactRow = {
  sequence: number;
  scope: CorpusScope;
  artifact_id: string;
  artifact_type: CorpusAgentArtifactInput['artifactType'];
  corpus_build_id: string;
  recorded_at: string;
  previous_hash: string | null;
  artifact_hash: string;
  artifact_json: string;
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function parseRow(row: ArtifactRow): StoredCorpusAgentArtifact {
  let input: CorpusAgentArtifactInput;
  try { input = JSON.parse(row.artifact_json) as CorpusAgentArtifactInput; }
  catch { throw new Error(`CORPUS_AGENT_ARTIFACT_CORRUPT: ${row.artifact_id} contains invalid JSON`); }
  const defect = corpusAgentArtifactDefect(input);
  if (defect || input.artifactId !== row.artifact_id || input.artifactType !== row.artifact_type || input.corpusBuildId !== row.corpus_build_id ||
      (input.artifactType === 'build_attestation' && !verifyCorpusBuildAttestation(input.payload))) {
    throw new Error(`CORPUS_AGENT_ARTIFACT_CORRUPT: ${row.artifact_id} contradicts indexed metadata${defect ? ` (${defect})` : ''}`);
  }
  return freeze({ ...input, sequence: Number(row.sequence), scope: row.scope, recordedAt: row.recorded_at, previousHash: row.previous_hash, artifactHash: row.artifact_hash } as StoredCorpusAgentArtifact);
}

export class SqliteCorpusAgentArtifactStore implements CorpusAgentArtifactRepository {
  readonly backend = 'sqlite' as const;
  readonly databasePath: string;
  private readonly db: Database.Database;

  constructor(path: string) {
    this.databasePath = resolve(path);
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS corpus_agent_artifacts (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL,
        artifact_id TEXT NOT NULL UNIQUE,
        artifact_type TEXT NOT NULL CHECK(artifact_type IN ('agent_result','build_attestation')),
        corpus_build_id TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        previous_hash TEXT,
        artifact_hash TEXT NOT NULL UNIQUE,
        artifact_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS corpus_agent_artifacts_scope_sequence
        ON corpus_agent_artifacts(scope, sequence);
      CREATE INDEX IF NOT EXISTS corpus_agent_artifacts_build_type_sequence
        ON corpus_agent_artifacts(corpus_build_id, artifact_type, sequence DESC);
      CREATE TRIGGER IF NOT EXISTS corpus_agent_artifacts_no_update
        BEFORE UPDATE ON corpus_agent_artifacts BEGIN
          SELECT RAISE(ABORT, 'CORPUS_AGENT_ARTIFACT_IMMUTABLE');
        END;
      CREATE TRIGGER IF NOT EXISTS corpus_agent_artifacts_no_delete
        BEFORE DELETE ON corpus_agent_artifacts BEGIN
          SELECT RAISE(ABORT, 'CORPUS_AGENT_ARTIFACT_IMMUTABLE');
        END;
    `);
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('CORPUS_AGENT_ARTIFACT_CORRUPT: SQLite quick_check did not return ok'); }
    try { verifyCorpusAgentArtifactSet(this.all()); } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  append(scope: CorpusScope, artifact: CorpusAgentArtifactInput, recordedAt = new Date().toISOString()): CorpusAgentArtifactAppendResult {
    const defect = corpusAgentArtifactDefect(artifact);
    if (!corpusScopeValid(scope) || !Number.isFinite(Date.parse(recordedAt)) || defect ||
        (artifact.artifactType === 'build_attestation' && !verifyCorpusBuildAttestation(artifact.payload))) {
      throw new Error(`CORPUS_AGENT_ARTIFACT_INVALID: ${defect ?? 'scope, time, or signature is invalid'}`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const priorRow = this.db.prepare('SELECT * FROM corpus_agent_artifacts WHERE artifact_id = ?').get(artifact.artifactId) as ArtifactRow | undefined;
      if (priorRow) {
        const prior = parseRow(priorRow);
        if (prior.scope !== scope || canonicalCorpusJson(corpusAgentArtifactInput(prior)) !== canonicalCorpusJson(artifact)) {
          throw new Error(`CORPUS_AGENT_ARTIFACT_CONFLICT: ${artifact.artifactId} already exists with different immutable content`);
        }
        this.db.exec('COMMIT');
        return freeze({ kind: 'committed' as const, artifact: prior, idempotent: true });
      }
      const next = this.db.prepare("SELECT seq + 1 AS sequence FROM sqlite_sequence WHERE name = 'corpus_agent_artifacts'").get() as { sequence?: number } | undefined;
      const sequence = Number(next?.sequence ?? 1);
      const tail = this.db.prepare('SELECT artifact_hash FROM corpus_agent_artifacts WHERE scope = ? ORDER BY sequence DESC LIMIT 1').get(scope) as { artifact_hash: string } | undefined;
      const previousHash = tail?.artifact_hash ?? null;
      const artifactHash = corpusAgentArtifactHash({ sequence, scope, recordedAt, previousHash, artifact });
      const result = this.db.prepare(`
        INSERT INTO corpus_agent_artifacts(scope, artifact_id, artifact_type, corpus_build_id, recorded_at, previous_hash, artifact_hash, artifact_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(scope, artifact.artifactId, artifact.artifactType, artifact.corpusBuildId, recordedAt, previousHash, artifactHash, canonicalCorpusJson(artifact));
      const stored = freeze({ ...artifact, sequence: Number(result.lastInsertRowid), scope, recordedAt, previousHash, artifactHash } as StoredCorpusAgentArtifact);
      this.db.exec('COMMIT');
      return freeze({ kind: 'committed' as const, artifact: stored, idempotent: false });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  get(scope: CorpusScope, artifactId: string): StoredCorpusAgentArtifact | null {
    if (!corpusScopeValid(scope) || !artifactId.trim()) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: scope or artifact id is invalid');
    const scopes = visibleCorpusAgentArtifactScopes(scope);
    const placeholders = scopes.map(() => '?').join(',');
    const row = this.db.prepare(`SELECT * FROM corpus_agent_artifacts WHERE scope IN (${placeholders}) AND artifact_id = ?`).get(...scopes, artifactId) as ArtifactRow | undefined;
    return row ? parseRow(row) : null;
  }

  latestBuildAttestation(scope: CorpusScope, corpusBuildId: string): StoredCorpusAgentArtifact | null {
    if (!corpusScopeValid(scope) || !corpusBuildId.trim()) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: scope or build id is invalid');
    const scopes = visibleCorpusAgentArtifactScopes(scope);
    const placeholders = scopes.map(() => '?').join(',');
    const row = this.db.prepare(`
      SELECT * FROM corpus_agent_artifacts
      WHERE scope IN (${placeholders}) AND corpus_build_id = ? AND artifact_type = 'build_attestation'
      ORDER BY sequence DESC LIMIT 1
    `).get(...scopes, corpusBuildId) as ArtifactRow | undefined;
    return row ? parseRow(row) : null;
  }

  page(options: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number } = {}): CorpusAgentArtifactPage {
    const scope = options.scope ?? 'global';
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!corpusScopeValid(scope) || !Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: scope, cursor, or limit is invalid');
    }
    const scopes = visibleCorpusAgentArtifactScopes(scope);
    const placeholders = scopes.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT * FROM corpus_agent_artifacts WHERE scope IN (${placeholders}) AND sequence > ? ORDER BY sequence ASC LIMIT ?`).all(...scopes, afterSequence, limit + 1) as ArtifactRow[];
    const hasMore = rows.length > limit;
    const artifacts = rows.slice(0, limit).map(parseRow);
    return freeze({ kind: 'corpus_agent_artifact_page' as const, scope, afterSequence, nextAfterSequence: artifacts.at(-1)?.sequence ?? afterSequence, hasMore, artifacts });
  }

  recent(options: { readonly scope?: CorpusScope; readonly limit?: number } = {}): readonly StoredCorpusAgentArtifact[] {
    const scope = options.scope ?? 'global';
    const limit = options.limit ?? 100;
    if (!corpusScopeValid(scope) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: scope or limit is invalid');
    }
    const all = this.all();
    verifyCorpusAgentArtifactSet(all);
    const scopes = new Set(visibleCorpusAgentArtifactScopes(scope));
    return freeze(all.filter(artifact => scopes.has(artifact.scope)).slice(-limit));
  }

  private all(): StoredCorpusAgentArtifact[] {
    return (this.db.prepare('SELECT * FROM corpus_agent_artifacts ORDER BY sequence ASC').all() as ArtifactRow[]).map(parseRow);
  }
}
