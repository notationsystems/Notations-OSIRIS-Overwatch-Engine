/** Server-only owner for persistent corpus agent results and attestations. */

import { createHash } from 'node:crypto';
import { extname, resolve } from 'node:path';
import type { CorpusAgentArtifactRepository } from './corpusAgentArtifacts';
import { env } from './envCompat';
import { physicalEconomyCorpusPath } from './physicalEconomyCorpusRuntime';
import { PostgresCorpusAgentArtifactStore } from './postgresCorpusAgentArtifactStore';
import { processSingleton } from './processSingleton';
import { SqliteCorpusAgentArtifactStore } from './sqliteCorpusAgentArtifactStore';

export type CorpusAgentArtifactCapability = 'query' | 'compiler';

function derivedSqlitePath(corpusPath: string): string {
  const extension = extname(corpusPath);
  return extension ? `${corpusPath.slice(0, -extension.length)}.agent-artifacts${extension}` : `${corpusPath}.agent-artifacts.sqlite`;
}

export function corpusAgentArtifactPath(): string | null {
  const configured = env('PAYLOAD_CORPUS_AGENT_ARTIFACT_PATH')?.trim();
  if (configured) return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  const corpusPath = physicalEconomyCorpusPath();
  return corpusPath ? derivedSqlitePath(corpusPath) : null;
}

export function corpusAgentArtifactStore(capability: CorpusAgentArtifactCapability): CorpusAgentArtifactRepository | null {
  const connectionString = env('PAYLOAD_CORPUS_AGENT_DATABASE_URL')?.trim()
    || env(capability === 'query' ? 'PAYLOAD_CORPUS_QUERY_DATABASE_URL' : 'PAYLOAD_CORPUS_COMPILER_DATABASE_URL')?.trim()
    || env('PAYLOAD_CORPUS_POSTGRES_URL')?.trim();
  if (connectionString) {
    const tenantId = env('PAYLOAD_CORPUS_TENANT_ID')?.trim() || undefined;
    const sslMode = env('PAYLOAD_CORPUS_POSTGRES_SSL')?.trim();
    if (sslMode && sslMode !== 'require' && sslMode !== 'disable') throw new Error('CORPUS_AGENT_ARTIFACT_CONFIG_INVALID: PAYLOAD_CORPUS_POSTGRES_SSL must be require or disable');
    const identity = createHash('sha256').update(`${capability}\0${connectionString}\0${tenantId ?? ''}`).digest('hex');
    return processSingleton(`corpus-agent-artifacts:postgres:${identity}`, () => new PostgresCorpusAgentArtifactStore(connectionString, {
      capability,
      tenantId,
      ...(sslMode === 'require' ? { ssl: { rejectUnauthorized: true } } : sslMode === 'disable' ? { ssl: false } : {}),
    }));
  }
  const path = corpusAgentArtifactPath();
  if (!path) return null;
  return processSingleton(`corpus-agent-artifacts:sqlite:${path}`, () => new SqliteCorpusAgentArtifactStore(path));
}
