/** Server-only owner for the append-only mined-pattern registry. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { PatternRegistry } from './patternRegistry';
import { processSingleton } from './processSingleton';

export function patternRegistryPath(): string | null {
  const configured = env('PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH')?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ process.cwd(), configured) : null;
}

export function patternRegistry(): PatternRegistry | null {
  const path = patternRegistryPath();
  if (!path) return null;
  return processSingleton(`physical-economy-pattern-registry:${path}`, () => new PatternRegistry(path));
}
