/** Server-only owner for the commercial-position business-intent adapter. */

import { CommercialActions } from './commercialActions';
import { commercialJournalPath, commercialWorkflow } from './commercialRuntime';
import { payloadEventDatabasePath } from './payloadEventDatabaseRuntime';
import { processSingleton } from './processSingleton';
import { procurementWorkflow } from './procurementRuntime';

export function commercialActions(): CommercialActions {
  const owner = payloadEventDatabasePath() ?? commercialJournalPath();
  return processSingleton(`commercial-actions:v1:${owner}`, () => new CommercialActions(commercialWorkflow(), procurementWorkflow()));
}
