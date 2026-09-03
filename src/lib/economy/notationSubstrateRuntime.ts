/** Server-only owner for the local Notation Data Substrate edge store. */

import { extname, resolve } from 'node:path';
import { env } from './envCompat';
import { NotationSubstrateStore } from './notationSubstrateStore';
import { physicalEconomyCorpusPath } from './physicalEconomyCorpusRuntime';
import { processSingleton } from './processSingleton';

export function notationSubstratePath(): string | null {
  const configured = env('PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH')?.trim();
  if (configured) return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
  const corpusPath = physicalEconomyCorpusPath();
  if (!corpusPath) return null;
  const extension = extname(corpusPath);
  return extension ? `${corpusPath.slice(0, -extension.length)}.notation-substrate${extension}` : `${corpusPath}.notation-substrate.sqlite`;
}

export function notationSubstrateStore(): NotationSubstrateStore | null {
  const path = notationSubstratePath();
  if (!path) return null;
  return processSingleton(`notation-substrate:${path}`, () => new NotationSubstrateStore(path));
}
