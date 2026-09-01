/** Server-only owner for the procurement business-intent adapter. */

import { ProcurementActions } from './procurementActions';
import { payloadEventDatabasePath } from './payloadEventDatabaseRuntime';
import { procurementJournalPath, procurementWorkflow } from './procurementRuntime';
import { processSingleton } from './processSingleton';

export function procurementActions(): ProcurementActions {
  const owner = payloadEventDatabasePath() ?? procurementJournalPath();
  return processSingleton(`procurement-actions:v1:${owner}`, () => new ProcurementActions(procurementWorkflow()));
}
