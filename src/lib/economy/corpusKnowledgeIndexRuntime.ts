/** Server-only owner for the disposable corpus knowledge index. */

import { extname, resolve } from 'node:path';
import { CorpusKnowledgeIndexStore } from './corpusKnowledgeIndexStore';
import { corpusProjectionPath } from './corpusProjectionRuntime';
import { env } from './envCompat';
import { processSingleton } from './processSingleton';

export function corpusKnowledgeIndexPath(): string | null {
  const configured = env('PAYLOAD_CORPUS_INDEX_PATH')?.trim();
  if (configured) return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  const projectionPath = corpusProjectionPath();
  if (!projectionPath) return null;
  const extension = extname(projectionPath);
  return extension ? `${projectionPath.slice(0, -extension.length)}.knowledge-index${extension}` : `${projectionPath}.knowledge-index.sqlite`;
}

export function corpusKnowledgeIndexStore(): CorpusKnowledgeIndexStore | null {
  const path = corpusKnowledgeIndexPath();
  if (!path) return null;
  return processSingleton(`corpus-knowledge-index:${path}`, () => new CorpusKnowledgeIndexStore(path));
}
