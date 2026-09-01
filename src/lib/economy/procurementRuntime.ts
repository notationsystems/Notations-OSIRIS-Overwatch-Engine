/** Server-only owner for procurement and physical-position state. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { payloadEventDatabase, payloadEventDatabasePath } from './payloadEventDatabaseRuntime';
import { ProcurementWorkflow } from './procurement';
import { FileProcurementStore } from './procurementStore';
import { processSingleton } from './processSingleton';

export function procurementJournalPath(): string {
  return resolve(/* turbopackIgnore: true */ process.cwd(), env('PAYLOAD_PROCUREMENT_LOG') ?? 'data-archive/procurement.jsonl');
}

export function procurementWorkflow(): ProcurementWorkflow {
  const databasePath = payloadEventDatabasePath();
  if (databasePath) {
    return processSingleton(`procurement-workflow:sqlite:${databasePath}`, () => {
      const database = payloadEventDatabase();
      if (!database) throw new Error('PAYLOAD_DATABASE_PATH resolved without a database owner');
      return new ProcurementWorkflow(database.procurementStore());
    });
  }
  const path = procurementJournalPath();
  return processSingleton(`procurement-workflow:${path}`, () => new ProcurementWorkflow(new FileProcurementStore(path)));
}
