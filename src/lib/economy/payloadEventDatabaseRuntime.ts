/** Server-only runtime owner for the globally ordered freight event database. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { PayloadEventDatabase } from './payloadEventDatabase';
import { processSingleton } from './processSingleton';

export function payloadEventDatabasePath(): string | null {
  const configured = env('PAYLOAD_DATABASE_PATH')?.trim();
  return configured ? resolve(/* turbopackIgnore: true */ process.cwd(), configured) : null;
}

export function payloadEventDatabase(): PayloadEventDatabase | null {
  const path = payloadEventDatabasePath();
  if (!path) return null;
  return processSingleton(`payload-event-database:${path}`, () => new PayloadEventDatabase(path));
}
