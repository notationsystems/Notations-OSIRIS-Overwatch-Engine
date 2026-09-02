/** Append-only registry for mined candidate knowledge and mining provenance. */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { stableValue } from './loadOperationsStore';
import type { CorpusMiningResult, MiningRun, PatternCandidate } from './corpusMining';

export type StoredMiningRun = MiningRun & {
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly runHash: string;
};

export type PatternRegistryWriteResult =
  | { readonly kind: 'mining_registered'; readonly idempotent: boolean; readonly run: StoredMiningRun; readonly candidates: readonly PatternCandidate[] }
  | { readonly kind: 'refusal'; readonly code: 'CORPUS_PATTERN_CONFLICT' | 'CORPUS_MINING_RESULT_INVALID'; readonly detail: string; readonly remedy: string };

type RunRow = {
  sequence: number;
  run_id: string;
  corpus_build_id: string;
  algorithm: string;
  completed_at: string;
  previous_hash: string | null;
  run_hash: string;
  run_json: string;
};
type CandidateRow = { candidate_id: string; run_id: string; candidate_hash: string; candidate_json: string };

const HASH = /^[a-f0-9]{64}$/;
const RUN_ID = /^mining-run:[a-f0-9]{64}$/;
const PATTERN_ID = /^pattern:[a-f0-9]{64}$/;
const HASH_DOMAIN = 'payload.corpus.pattern-registry.run.v1';

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
function refusal(code: Extract<PatternRegistryWriteResult, { kind: 'refusal' }>['code'], detail: string, remedy: string): PatternRegistryWriteResult {
  return freeze({ kind: 'refusal' as const, code, detail, remedy });
}

function resultDefect(result: CorpusMiningResult): string | null {
  if (result.kind !== 'corpus_mining_result' || result.run.schema !== 'payload.corpus.mining-run.v1' || !RUN_ID.test(result.run.miningRunId) || !HASH.test(result.run.corpusBuildDigest) || !HASH.test(result.run.inputFingerprint) || !validTime(result.run.startedAt) || !validTime(result.run.completedAt) || Date.parse(result.run.completedAt) < Date.parse(result.run.startedAt)) return 'mining run identity, digest, or time is invalid';
  if (new Set(result.run.inputRecordIds).size !== result.run.inputRecordIds.length || new Set(result.run.outputPatternIds).size !== result.run.outputPatternIds.length) return 'mining run input or output identities are duplicated';
  const patternIds = result.candidates.map(candidate => candidate.patternId);
  if (canonical([...patternIds].sort()) !== canonical([...result.run.outputPatternIds].sort())) return 'mining run outputs do not match its candidates';
  for (const candidate of result.candidates) {
    if (candidate.schema !== 'payload.corpus.pattern-candidate.v1' || !PATTERN_ID.test(candidate.patternId) || candidate.miningRunId !== result.run.miningRunId || candidate.corpusBuildId !== result.run.corpusBuildId || candidate.validationStatus !== 'CANDIDATE' || !validTime(candidate.generatedAt) || candidate.score.value < 2 || !Number.isSafeInteger(candidate.score.value)) return `candidate ${candidate.patternId || '(missing)'} is invalid`;
  }
  return null;
}

export class PatternRegistry {
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
      CREATE TABLE IF NOT EXISTS corpus_mining_runs (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        corpus_build_id TEXT NOT NULL,
        algorithm TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        previous_hash TEXT,
        run_hash TEXT NOT NULL UNIQUE,
        run_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS corpus_pattern_candidates (
        candidate_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES corpus_mining_runs(run_id),
        pattern_type TEXT NOT NULL,
        focal_entity_id TEXT NOT NULL,
        validation_status TEXT NOT NULL CHECK(validation_status = 'CANDIDATE'),
        candidate_hash TEXT NOT NULL,
        candidate_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS corpus_patterns_focal ON corpus_pattern_candidates(focal_entity_id, pattern_type);
      CREATE INDEX IF NOT EXISTS corpus_patterns_run ON corpus_pattern_candidates(run_id, candidate_id);
    `);
    const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!integrity || !Object.values(integrity).includes('ok')) { this.db.close(); throw new Error('CORPUS_PATTERN_REGISTRY_CORRUPT: SQLite quick_check did not return ok'); }
    try { this.allRuns(); }
    catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  register(result: CorpusMiningResult): PatternRegistryWriteResult {
    const defect = resultDefect(result);
    if (defect) return refusal('CORPUS_MINING_RESULT_INVALID', defect, 'Regenerate the result through a supported, versioned Payload Miner algorithm.');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.allRuns();
      const existing = this.db.prepare('SELECT * FROM corpus_mining_runs WHERE run_id = ?').get(result.run.miningRunId) as RunRow | undefined;
      if (existing) {
        const loaded = this.parseStoredRun(existing);
        const candidates = this.loadCandidates(result.run.miningRunId);
        if (canonical(loadedRunView(loaded)) !== canonical(result.run) || canonical(candidates) !== canonical(result.candidates)) {
          this.db.exec('ROLLBACK');
          return refusal('CORPUS_PATTERN_CONFLICT', `Mining run ${result.run.miningRunId} already exists with different content.`, 'Use a new executedAt for a new run; an immutable run ID is never overwritten.');
        }
        this.db.exec('COMMIT');
        return freeze({ kind: 'mining_registered' as const, idempotent: true, run: loaded, candidates });
      }
      const collision = result.candidates.find(candidate => this.db.prepare('SELECT 1 FROM corpus_pattern_candidates WHERE candidate_id = ?').get(candidate.patternId));
      if (collision) {
        this.db.exec('ROLLBACK');
        return refusal('CORPUS_PATTERN_CONFLICT', `Pattern ${collision.patternId} already belongs to another mining run.`, 'Regenerate the result with a distinct immutable run identity.');
      }
      const tail = this.db.prepare('SELECT sequence, run_hash FROM corpus_mining_runs ORDER BY sequence DESC LIMIT 1').get() as { sequence: number; run_hash: string } | undefined;
      const sequence = (tail?.sequence ?? 0) + 1;
      const previousHash = tail?.run_hash ?? null;
      const runHash = digest({ domain: HASH_DOMAIN, sequence, previousHash, run: result.run, candidates: result.candidates });
      this.db.prepare('INSERT INTO corpus_mining_runs(sequence, run_id, corpus_build_id, algorithm, completed_at, previous_hash, run_hash, run_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(sequence, result.run.miningRunId, result.run.corpusBuildId, result.run.algorithm, result.run.completedAt, previousHash, runHash, canonical(result.run));
      const insert = this.db.prepare('INSERT INTO corpus_pattern_candidates(candidate_id, run_id, pattern_type, focal_entity_id, validation_status, candidate_hash, candidate_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const candidate of result.candidates) insert.run(candidate.patternId, result.run.miningRunId, candidate.patternType, candidate.focalEntityId, candidate.validationStatus, digest(candidate), canonical(candidate));
      this.db.exec('COMMIT');
      return freeze({ kind: 'mining_registered' as const, idempotent: false, run: { ...result.run, sequence, previousHash, runHash }, candidates: result.candidates });
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  page(options: { readonly afterSequence?: number; readonly limit?: number } = {}) {
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 250) throw new Error('CORPUS_PATTERN_QUERY_INVALID: cursor or limit is invalid');
    const all = this.allRuns().filter(run => run.sequence > afterSequence);
    const selected = all.slice(0, limit);
    return freeze({
      kind: 'corpus_pattern_registry_page' as const,
      afterSequence,
      nextAfterSequence: selected.at(-1)?.sequence ?? afterSequence,
      hasMore: all.length > selected.length,
      runs: selected.map(run => ({ ...run, candidates: this.loadCandidates(run.miningRunId) })),
    });
  }

  summary() {
    this.allRuns();
    const runCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM corpus_mining_runs').get() as { count: number }).count);
    const candidateCount = Number((this.db.prepare('SELECT COUNT(*) AS count FROM corpus_pattern_candidates').get() as { count: number }).count);
    const lastSequence = Number((this.db.prepare('SELECT MAX(sequence) AS sequence FROM corpus_mining_runs').get() as { sequence: number | null }).sequence ?? 0);
    return freeze({ kind: 'corpus_pattern_registry_summary' as const, durability: 'sqlite_wal' as const, lastSequence, runCount, candidateCount });
  }

  private loadCandidates(runId: string): readonly PatternCandidate[] {
    const rows = this.db.prepare('SELECT * FROM corpus_pattern_candidates WHERE run_id = ? ORDER BY candidate_id ASC').all(runId) as CandidateRow[];
    return freeze(rows.map(row => {
      let candidate: PatternCandidate;
      try { candidate = JSON.parse(row.candidate_json) as PatternCandidate; }
      catch { throw new Error(`CORPUS_PATTERN_REGISTRY_CORRUPT: candidate ${row.candidate_id} has invalid JSON`); }
      if (row.run_id !== runId || candidate.patternId !== row.candidate_id || candidate.miningRunId !== row.run_id || candidate.validationStatus !== 'CANDIDATE' || !HASH.test(row.candidate_hash) || digest(candidate) !== row.candidate_hash) throw new Error(`CORPUS_PATTERN_REGISTRY_CORRUPT: candidate ${row.candidate_id} contradicts indexed metadata`);
      return candidate;
    }));
  }

  private parseStoredRun(row: RunRow): StoredMiningRun {
    let run: MiningRun;
    try { run = JSON.parse(row.run_json) as MiningRun; }
    catch { throw new Error(`CORPUS_PATTERN_REGISTRY_CORRUPT: run ${row.run_id} has invalid JSON`); }
    if (!Number.isSafeInteger(Number(row.sequence)) || Number(row.sequence) < 1 || run.miningRunId !== row.run_id || run.corpusBuildId !== row.corpus_build_id || run.algorithm !== row.algorithm || run.completedAt !== row.completed_at || !RUN_ID.test(row.run_id) || !HASH.test(row.run_hash) || (row.previous_hash !== null && !HASH.test(row.previous_hash))) throw new Error(`CORPUS_PATTERN_REGISTRY_CORRUPT: run ${row.run_id} contradicts indexed metadata`);
    return freeze({ ...run, sequence: Number(row.sequence), previousHash: row.previous_hash, runHash: row.run_hash });
  }

  private allRuns(): readonly StoredMiningRun[] {
    const rows = this.db.prepare('SELECT * FROM corpus_mining_runs ORDER BY sequence ASC').all() as RunRow[];
    let previousHash: string | null = null;
    return freeze(rows.map(row => {
      const run = this.parseStoredRun(row);
      const candidates = this.loadCandidates(run.miningRunId);
      const defect = resultDefect({ kind: 'corpus_mining_result', run: loadedRunView(run), candidates });
      const expected = digest({ domain: HASH_DOMAIN, sequence: run.sequence, previousHash, run: loadedRunView(run), candidates });
      if (defect || run.previousHash !== previousHash || run.runHash !== expected) throw new Error(`CORPUS_PATTERN_REGISTRY_CORRUPT: chain fails at sequence ${run.sequence}${defect ? ` (${defect})` : ''}`);
      previousHash = run.runHash;
      return run;
    }));
  }
}

function loadedRunView(run: StoredMiningRun): MiningRun {
  return Object.fromEntries(
    Object.entries(run).filter(([key]) => key !== 'sequence' && key !== 'previousHash' && key !== 'runHash'),
  ) as MiningRun;
}
