/** Server-only owner for the disposable, policy-filtered corpus read model. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { CorpusProjectionStore } from './corpusProjection';
import { processSingleton } from './processSingleton';

export function corpusProjectionPath(): string | null {
  const configured = env('PAYLOAD_CORPUS_READ_MODEL_PATH')?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ process.cwd(), configured) : null;
}

export function corpusProjectionStore(): CorpusProjectionStore | null {
  const path = corpusProjectionPath();
  if (!path) return null;
  return processSingleton(`physical-economy-projection:${path}`, () => new CorpusProjectionStore(path));
}
