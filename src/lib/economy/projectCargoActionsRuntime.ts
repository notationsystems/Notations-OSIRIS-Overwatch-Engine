/** Server-only owner for the project-cargo business-intent adapter. */

import { processSingleton } from './processSingleton';
import { ProjectCargoActions } from './projectCargoActions';
import { projectCargoJournalPath, projectCargoWorkflow } from './projectCargoRuntime';
import { payloadEventDatabasePath } from './payloadEventDatabaseRuntime';

export function projectCargoActions(): ProjectCargoActions {
  const owner = payloadEventDatabasePath() ?? projectCargoJournalPath();
  return processSingleton(`project-cargo-actions:v1:${owner}`, () => new ProjectCargoActions(projectCargoWorkflow()));
}
