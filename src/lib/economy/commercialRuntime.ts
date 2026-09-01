/** Server-only owner for inventory, sales, and customer-commitment state. */

import { resolve } from 'node:path';
import { CommercialWorkflow } from './commercial';
import { FileCommercialStore } from './commercialStore';
import { env } from './envCompat';
import { payloadEventDatabase, payloadEventDatabasePath } from './payloadEventDatabaseRuntime';
import { processSingleton } from './processSingleton';

export function commercialJournalPath(): string {
  return resolve(/* turbopackIgnore: true */ process.cwd(), env('PAYLOAD_COMMERCIAL_LOG') ?? 'data-archive/commercial.jsonl');
}

export function commercialWorkflow(): CommercialWorkflow {
  const databasePath = payloadEventDatabasePath();
  if (databasePath) {
    return processSingleton(`commercial-workflow:sqlite:${databasePath}`, () => {
      const database = payloadEventDatabase();
      if (!database) throw new Error('PAYLOAD_DATABASE_PATH resolved without a database owner');
      return new CommercialWorkflow(database.commercialStore());
    });
  }
  const path = commercialJournalPath();
  return processSingleton(`commercial-workflow:${path}`, () => new CommercialWorkflow(new FileCommercialStore(path)));
}
