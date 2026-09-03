/** Server-only owner for the physical-economy corpus database. */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { CorpusRepository } from './corpusRepository';
import { env } from './envCompat';
import { PostgresCorpusRepository } from './postgresCorpusRepository';
import { PhysicalEconomyCorpus } from './physicalEconomyCorpus';
import { processSingleton } from './processSingleton';

export type CorpusRepositoryCapability = 'query' | 'ingest' | 'projector' | 'compiler';

const URL_ENV: Record<CorpusRepositoryCapability, string> = {
  query: 'PAYLOAD_CORPUS_QUERY_DATABASE_URL',
  ingest: 'PAYLOAD_CORPUS_INGEST_DATABASE_URL',
  projector: 'PAYLOAD_CORPUS_PROJECTOR_DATABASE_URL',
  compiler: 'PAYLOAD_CORPUS_COMPILER_DATABASE_URL',
};

export function physicalEconomyCorpusPath(): string | null {
  // A separate file is useful when the public corpus is replicated without
  // private operations. Falling back to the Payload event database keeps a
  // single backed-up SQLite/WAL boundary for compact installations.
  const configured = env('PAYLOAD_CORPUS_DATABASE_PATH')?.trim() || env('PAYLOAD_DATABASE_PATH')?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ process.cwd(), configured) : null;
}

export function physicalEconomyCorpus(capability: CorpusRepositoryCapability = 'query'): CorpusRepository | null {
  const connectionString = env(URL_ENV[capability])?.trim() || env('PAYLOAD_CORPUS_POSTGRES_URL')?.trim();
  if (connectionString) {
    const tenantId = env('PAYLOAD_CORPUS_TENANT_ID')?.trim() || undefined;
    const allowGlobalWrites = capability !== 'query' && env('PAYLOAD_CORPUS_ALLOW_GLOBAL_WRITE') === 'true';
    const sslMode = env('PAYLOAD_CORPUS_POSTGRES_SSL')?.trim();
    if (sslMode && sslMode !== 'require' && sslMode !== 'disable') throw new Error('CORPUS_POSTGRES_CONFIG_INVALID: PAYLOAD_CORPUS_POSTGRES_SSL must be require or disable');
    const identity = createHash('sha256').update(`${capability}\0${connectionString}\0${tenantId ?? ''}\0${allowGlobalWrites}`).digest('hex');
    return processSingleton(`physical-economy-corpus:postgres:${identity}`, () => new PostgresCorpusRepository(connectionString, {
      tenantId,
      allowGlobalWrites,
      applicationName: `payload-corpus-${capability}`,
      ...(sslMode === 'require' ? { ssl: { rejectUnauthorized: true } } : sslMode === 'disable' ? { ssl: false } : {}),
    }));
  }
  const path = physicalEconomyCorpusPath();
  if (!path) return null;
  return processSingleton(`physical-economy-corpus:${path}`, () => new PhysicalEconomyCorpus(path));
}
