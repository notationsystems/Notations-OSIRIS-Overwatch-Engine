import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';

const MIGRATION_LOCK = 1_917_309_338;

export const POSTGRES_CORPUS_MIGRATIONS = Object.freeze([
  { version: 1, name: 'payload_corpus_v3', file: '0001_payload_corpus_v3.sql' },
] as const);

export type CorpusMigrationResult = {
  readonly kind: 'corpus_postgres_migrated';
  readonly applied: readonly number[];
  readonly verified: readonly number[];
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Applies bootstrap roles and checksum-pinned, forward-only corpus migrations. */
export async function migrateCorpusPostgres(
  connectionString: string,
  rootDirectory = process.cwd(),
): Promise<CorpusMigrationResult> {
  if (!connectionString.trim()) throw new Error('CORPUS_POSTGRES_CONFIG_INVALID: migration connection string is empty');
  const directory = join(rootDirectory, 'migrations', 'postgres');
  const rolesSql = await readFile(join(directory, '0000_payload_corpus_roles.sql'), 'utf8');
  const pool = new Pool({ connectionString, max: 1, application_name: 'payload-corpus-migrator' });
  const client = await pool.connect();
  const applied: number[] = [];
  const verified: number[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(rolesSql);
    for (const migration of POSTGRES_CORPUS_MIGRATIONS) {
      const sql = await readFile(join(directory, migration.file), 'utf8');
      const checksum = sha256(sql);
      const existing = await client.query<{ name: string; sha256: string | null }>(`
        SELECT name, sha256 FROM payload_corpus.schema_migrations WHERE version = $1
      `, [migration.version]).catch(error => {
        if ((error as { code?: string }).code === '42P01' || (error as { code?: string }).code === '3F000') return { rows: [] } as { rows: Array<{ name: string; sha256: string | null }> };
        throw error;
      });
      const row = existing.rows[0];
      if (row) {
        if (row.name !== migration.name || row.sha256 !== checksum) throw new Error(`CORPUS_POSTGRES_MIGRATION_DRIFT: migration ${migration.version} no longer matches applied SQL`);
        verified.push(migration.version);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO payload_corpus.schema_migrations(version, name, sha256) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum]);
        await client.query('COMMIT');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* connection may already be gone */ }
        throw error;
      }
      applied.push(migration.version);
    }
    return Object.freeze({ kind: 'corpus_postgres_migrated' as const, applied: Object.freeze(applied), verified: Object.freeze(verified) });
  } finally {
    try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]); } catch { /* connection may already be gone */ }
    client.release();
    await pool.end();
  }
}
