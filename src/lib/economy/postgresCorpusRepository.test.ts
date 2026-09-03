import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PostgresCorpusRepository } from './postgresCorpusRepository';
import { POSTGRES_CORPUS_MIGRATIONS } from './postgresCorpusMigrations';

describe('PostgreSQL/PostGIS corpus production boundary', () => {
  it('pins a forward migration with PostGIS, service roles, RLS, and immutable application grants', () => {
    const roles = readFileSync(join(process.cwd(), 'migrations', 'postgres', '0000_payload_corpus_roles.sql'), 'utf8');
    const schema = readFileSync(join(process.cwd(), 'migrations', 'postgres', '0001_payload_corpus_v3.sql'), 'utf8');
    expect(POSTGRES_CORPUS_MIGRATIONS).toEqual([{ version: 1, name: 'payload_corpus_v3', file: '0001_payload_corpus_v3.sql' }]);
    for (const role of ['owner', 'ingest', 'query', 'projector', 'compiler']) {
      expect(roles).toContain(`payload_corpus_${role}`);
    }
    expect(roles).toContain('NOBYPASSRLS');
    expect(roles).toContain('ALTER ROLE payload_corpus_query NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
    expect(schema).toContain('CREATE EXTENSION IF NOT EXISTS postgis');
    expect(schema).toContain("sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$')");
    expect(schema).not.toMatch(/^\s*(?:BEGIN|COMMIT);/m);
    expect(schema).toContain('REVOKE ALL ON SCHEMA payload_corpus FROM PUBLIC');
    expect(schema).toContain('REVOKE ALL ON FUNCTION payload_corpus.can_write_scope(text) FROM PUBLIC');
    expect(schema).toContain('ENABLE ROW LEVEL SECURITY');
    expect(schema).toContain('FORCE ROW LEVEL SECURITY');
    expect(schema).toContain("current_setting('payload.tenant_id', true)");
    expect(schema).toContain('corpus_records_geom_gist');
    expect(schema).toContain('USING gist(geom)');
    expect(schema).toContain('payload_corpus.can_write_scope(scope)');
    expect(schema).toContain('guard_projector_checkpoint');
    expect(schema).toContain('CORPUS_PROJECTION_CHECKPOINT_REGRESSION');
    expect(schema).toContain("CHECK (event_id = 'corpus-event:' || record_hash)");
    expect(schema).toContain('FOREIGN KEY(sequence, scope, record_id, record_type, known_at, occurred_at, record_hash)');
    expect(schema).not.toMatch(/GRANT\s+(?:[^;]*,\s*)?(?:UPDATE|DELETE)[^;]*corpus_records/i);
    expect(schema).not.toMatch(/GRANT\s+(?:[^;]*,\s*)?(?:UPDATE|DELETE)[^;]*corpus_outbox_events/i);
  });

  it('redacts credentials and denies cross-tenant/global writes before opening a connection', async () => {
    const repository = new PostgresCorpusRepository('postgresql://operator:secret@db.internal:5432/payload', { tenantId: 'acme' });
    try {
      expect(repository.databasePath).toBe('postgresql://db.internal:5432/payload/payload_corpus');
      await expect(repository.append('customer:other', [])).rejects.toThrow(/TENANT_SCOPE_DENIED/);
      await expect(repository.append('global', [])).rejects.toThrow(/GLOBAL_WRITE_DENIED/);
    } finally { await repository.close(); }
  });

  it('refuses malformed tenant configuration synchronously', () => {
    expect(() => new PostgresCorpusRepository('postgresql://localhost/payload', { tenantId: 'ACME/../../' })).toThrow(/tenant id is invalid/);
  });
});
