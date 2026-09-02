/** Server-only owner for the physical-economy corpus database. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { PhysicalEconomyCorpus } from './physicalEconomyCorpus';
import { processSingleton } from './processSingleton';

export function physicalEconomyCorpusPath(): string | null {
  // A separate file is useful when the public corpus is replicated without
  // private operations. Falling back to the Payload event database keeps a
  // single backed-up SQLite/WAL boundary for compact installations.
  const configured = env('PAYLOAD_CORPUS_DATABASE_PATH')?.trim() || env('PAYLOAD_DATABASE_PATH')?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ process.cwd(), configured) : null;
}

export function physicalEconomyCorpus(): PhysicalEconomyCorpus | null {
  const path = physicalEconomyCorpusPath();
  if (!path) return null;
  return processSingleton(`physical-economy-corpus:${path}`, () => new PhysicalEconomyCorpus(path));
}
