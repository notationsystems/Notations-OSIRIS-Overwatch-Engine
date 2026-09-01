/** Server-only owner for constrained project-cargo state. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { payloadEventDatabase, payloadEventDatabasePath } from './payloadEventDatabaseRuntime';
import { processSingleton } from './processSingleton';
import { ProjectCargoWorkflow } from './projectCargo';
import { FileProjectCargoStore } from './projectCargoStore';

export function projectCargoJournalPath(): string {
  return resolve(/* turbopackIgnore: true */ process.cwd(), env('PAYLOAD_PROJECT_CARGO_LOG') ?? 'data-archive/project-cargo.jsonl');
}

export function projectCargoWorkflow(): ProjectCargoWorkflow {
  const databasePath = payloadEventDatabasePath();
  if (databasePath) {
    return processSingleton(`project-cargo-workflow:sqlite:${databasePath}`, () => {
      const database = payloadEventDatabase();
      if (!database) throw new Error('PAYLOAD_DATABASE_PATH resolved without a database owner');
      return new ProjectCargoWorkflow(database.projectCargoStore());
    });
  }
  const path = projectCargoJournalPath();
  return processSingleton(`project-cargo-workflow:${path}`, () => new ProjectCargoWorkflow(new FileProjectCargoStore(path)));
}
