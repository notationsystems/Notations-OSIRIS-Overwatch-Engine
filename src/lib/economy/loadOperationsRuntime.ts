/** Server-only runtime owner for the persistent Terminal operations journal. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import { LoadOperationsWorkflow } from './loadOperations';
import { FileLoadOperationStore } from './loadOperationsStore';
import { processSingleton } from './processSingleton';

export function loadOperationsJournalPath(): string {
  return resolve(env('PAYLOAD_OPERATIONS_LOG') ?? `${process.cwd()}/data-archive/load-operations.jsonl`);
}

export function loadOperationsWorkflow(): LoadOperationsWorkflow {
  const path = loadOperationsJournalPath();
  return processSingleton(`load-operations-workflow:${path}`, () =>
    new LoadOperationsWorkflow(new FileLoadOperationStore(path)));
}
