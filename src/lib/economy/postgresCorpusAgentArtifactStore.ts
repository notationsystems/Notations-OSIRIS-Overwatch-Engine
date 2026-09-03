/** PostgreSQL/RLS store for the linearized corpus agent-artifact journal. */

import { Pool, type PoolClient, type PoolConfig } from 'pg';
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

const REQUIRED_MIGRATION = 2;
const ARTIFACT_SEQUENCE_LOCK = 1_917_309_339;

type ArtifactRow = {
  sequence: string | number;
  scope: CorpusScope;
  artifact_id: string;
  artifact_type: CorpusAgentArtifactInput['artifactType'];
  corpus_build_id: string;
  recorded_at: string;
  previous_hash: string | null;
  artifact_hash: string;
  artifact_json: CorpusAgentArtifactInput | string;
};

export type PostgresCorpusAgentArtifactStoreOptions = {
  readonly tenantId?: string;
  readonly capability: 'query' | 'compiler';
  readonly maxConnections?: number;
  readonly ssl?: false | { readonly rejectUnauthorized: boolean };
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function safeSequence(value: string | number): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('CORPUS_AGENT_ARTIFACT_CORRUPT: unsafe sequence');
  return sequence;
}

function parseRow(row: ArtifactRow): StoredCorpusAgentArtifact {
  let input: CorpusAgentArtifactInput;
  try { input = typeof row.artifact_json === 'string' ? JSON.parse(row.artifact_json) as CorpusAgentArtifactInput : row.artifact_json; }
  catch { throw new Error(`CORPUS_AGENT_ARTIFACT_CORRUPT: ${row.artifact_id} contains invalid JSON`); }
  const defect = corpusAgentArtifactDefect(input);
  if (defect || input.artifactId !== row.artifact_id || input.artifactType !== row.artifact_type || input.corpusBuildId !== row.corpus_build_id ||
      (input.artifactType === 'build_attestation' && !verifyCorpusBuildAttestation(input.payload))) {
    throw new Error(`CORPUS_AGENT_ARTIFACT_CORRUPT: ${row.artifact_id} contradicts indexed metadata${defect ? ` (${defect})` : ''}`);
  }
  return freeze({
    ...input,
    sequence: safeSequence(row.sequence),
    scope: row.scope,
    recordedAt: row.recorded_at,
    previousHash: row.previous_hash,
    artifactHash: row.artifact_hash,
  } as StoredCorpusAgentArtifact);
}

function displayDatabasePath(connectionString: string): string {
  try {
    const parsed = new URL(connectionString);
    return `postgresql://${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\//, '') || '(default)'}/payload_corpus/agent_artifacts`;
  } catch {
    return 'postgresql://configured/payload_corpus/agent_artifacts';
  }
}

export class PostgresCorpusAgentArtifactStore implements CorpusAgentArtifactRepository {
  readonly backend = 'postgresql' as const;
  readonly databasePath: string;
  private readonly pool: Pool;
  private readonly tenantId: string | undefined;
  private readonly capability: PostgresCorpusAgentArtifactStoreOptions['capability'];
  private ready: Promise<void> | null = null;

  constructor(connectionString: string, options: PostgresCorpusAgentArtifactStoreOptions) {
    if (!connectionString.trim()) throw new Error('CORPUS_AGENT_ARTIFACT_CONFIG_INVALID: connection string is empty');
    if (options.tenantId !== undefined && !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(options.tenantId)) throw new Error('CORPUS_AGENT_ARTIFACT_CONFIG_INVALID: tenant id is invalid');
    this.databasePath = displayDatabasePath(connectionString);
    this.tenantId = options.tenantId;
    this.capability = options.capability;
    const config: PoolConfig = {
      connectionString,
      max: options.maxConnections ?? 5,
      application_name: `payload-corpus-agent-${options.capability}`,
      ...(options.ssl === false || options.ssl === undefined ? {} : { ssl: options.ssl }),
    };
    this.pool = new Pool(config);
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.pool.query<{ version: string | number }>('SELECT COALESCE(MAX(version), 0) AS version FROM payload_corpus.schema_migrations')
        .then(result => {
          if (Number(result.rows[0]?.version ?? 0) < REQUIRED_MIGRATION) throw new Error(`CORPUS_POSTGRES_NOT_MIGRATED: migration ${REQUIRED_MIGRATION} is required for agent artifacts`);
        })
        .catch(error => {
          this.ready = null;
          throw error;
        });
    }
    await this.ready;
  }

  private assertScope(scope: CorpusScope): void {
    if (!corpusScopeValid(scope) || scope !== 'global' && scope !== `customer:${this.tenantId ?? ''}`) {
      throw new Error('CORPUS_AGENT_ARTIFACT_SCOPE_DENIED: scope is invalid or belongs to another tenant');
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureReady();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('payload.tenant_id', $1, true), set_config('payload.allow_global_write', $2, true)", [this.tenantId ?? '', this.capability === 'compiler' ? 'on' : 'off']);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* connection already failed */ }
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadVisible(client: PoolClient): Promise<StoredCorpusAgentArtifact[]> {
    const result = await client.query<ArtifactRow>(`
      SELECT sequence::text, scope, artifact_id, artifact_type, corpus_build_id,
             recorded_at, previous_hash, artifact_hash, artifact_json
      FROM payload_corpus.agent_artifacts ORDER BY sequence ASC
    `);
    const artifacts = result.rows.map(parseRow);
    verifyCorpusAgentArtifactSet(artifacts);
    return artifacts;
  }

  async append(scope: CorpusScope, artifact: CorpusAgentArtifactInput, recordedAt = new Date().toISOString()): Promise<CorpusAgentArtifactAppendResult> {
    this.assertScope(scope);
    const defect = corpusAgentArtifactDefect(artifact);
    if (!Number.isFinite(Date.parse(recordedAt)) || defect ||
        artifact.artifactType === 'agent_result' && this.capability !== 'query' ||
        artifact.artifactType === 'build_attestation' && (this.capability !== 'compiler' || !verifyCorpusBuildAttestation(artifact.payload))) {
      throw new Error(`CORPUS_AGENT_ARTIFACT_INVALID: ${defect ?? 'capability, time, or signature is invalid'}`);
    }
    return this.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ARTIFACT_SEQUENCE_LOCK]);
      const prior = await client.query<ArtifactRow>('SELECT sequence::text, scope, artifact_id, artifact_type, corpus_build_id, recorded_at, previous_hash, artifact_hash, artifact_json FROM payload_corpus.agent_artifacts WHERE artifact_id = $1', [artifact.artifactId]);
      if (prior.rows[0]) {
        const stored = parseRow(prior.rows[0]);
        if (stored.scope !== scope || canonicalCorpusJson(corpusAgentArtifactInput(stored)) !== canonicalCorpusJson(artifact)) throw new Error(`CORPUS_AGENT_ARTIFACT_CONFLICT: ${artifact.artifactId} already exists with different immutable content`);
        return freeze({ kind: 'committed' as const, artifact: stored, idempotent: true });
      }
      const sequenceResult = await client.query<{ sequence: string }>("SELECT nextval(pg_get_serial_sequence('payload_corpus.agent_artifacts', 'sequence'))::text AS sequence");
      const sequence = safeSequence(sequenceResult.rows[0]?.sequence ?? 0);
      const tail = await client.query<{ artifact_hash: string }>('SELECT artifact_hash FROM payload_corpus.agent_artifacts WHERE scope = $1 ORDER BY sequence DESC LIMIT 1', [scope]);
      const previousHash = tail.rows[0]?.artifact_hash ?? null;
      const artifactHash = corpusAgentArtifactHash({ sequence, scope, recordedAt, previousHash, artifact });
      await client.query(`
        INSERT INTO payload_corpus.agent_artifacts(
          sequence, scope, artifact_id, artifact_type, corpus_build_id,
          recorded_at, recorded_at_time, previous_hash, artifact_hash, artifact_json
        ) VALUES ($1,$2,$3,$4,$5,$6,$6::timestamptz,$7,$8,$9::jsonb)
      `, [sequence, scope, artifact.artifactId, artifact.artifactType, artifact.corpusBuildId, recordedAt, previousHash, artifactHash, canonicalCorpusJson(artifact)]);
      const stored = freeze({ ...artifact, sequence, scope, recordedAt, previousHash, artifactHash } as StoredCorpusAgentArtifact);
      return freeze({ kind: 'committed' as const, artifact: stored, idempotent: false });
    });
  }

  async get(scope: CorpusScope, artifactId: string): Promise<StoredCorpusAgentArtifact | null> {
    this.assertScope(scope);
    if (!artifactId.trim()) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: artifact id is required');
    return this.transaction(async client => {
      const visible = await this.loadVisible(client);
      const scopes = new Set(visibleCorpusAgentArtifactScopes(scope));
      return visible.find(artifact => scopes.has(artifact.scope) && artifact.artifactId === artifactId) ?? null;
    });
  }

  async latestBuildAttestation(scope: CorpusScope, corpusBuildId: string): Promise<StoredCorpusAgentArtifact | null> {
    this.assertScope(scope);
    if (!corpusBuildId.trim()) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: build id is required');
    return this.transaction(async client => {
      const scopes = new Set(visibleCorpusAgentArtifactScopes(scope));
      return (await this.loadVisible(client)).filter(artifact => scopes.has(artifact.scope) && artifact.artifactType === 'build_attestation' && artifact.corpusBuildId === corpusBuildId).at(-1) ?? null;
    });
  }

  async page(options: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number } = {}): Promise<CorpusAgentArtifactPage> {
    const scope = options.scope ?? 'global';
    const afterSequence = options.afterSequence ?? 0;
    const limit = options.limit ?? 100;
    this.assertScope(scope);
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: cursor or limit is invalid');
    return this.transaction(async client => {
      const scopes = new Set(visibleCorpusAgentArtifactScopes(scope));
      const rows = (await this.loadVisible(client)).filter(artifact => scopes.has(artifact.scope) && artifact.sequence > afterSequence);
      const hasMore = rows.length > limit;
      const artifacts = rows.slice(0, limit);
      return freeze({ kind: 'corpus_agent_artifact_page' as const, scope, afterSequence, nextAfterSequence: artifacts.at(-1)?.sequence ?? afterSequence, hasMore, artifacts });
    });
  }

  async recent(options: { readonly scope?: CorpusScope; readonly limit?: number } = {}): Promise<readonly StoredCorpusAgentArtifact[]> {
    const scope = options.scope ?? 'global';
    const limit = options.limit ?? 100;
    this.assertScope(scope);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('CORPUS_AGENT_ARTIFACT_QUERY_INVALID: limit is invalid');
    return this.transaction(async client => {
      const scopes = new Set(visibleCorpusAgentArtifactScopes(scope));
      return freeze((await this.loadVisible(client)).filter(artifact => scopes.has(artifact.scope)).slice(-limit));
    });
  }
}
