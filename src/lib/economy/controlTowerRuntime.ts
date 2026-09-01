/** Server-only runtime owner for the joined freight control-tower read model. */

import { FreightControlTower } from './controlTower';
import { carrierCommunicationsWorkflow } from './carrierCommunicationsRuntime';
import { loadOperationsWorkflow } from './loadOperationsRuntime';
import { processSingleton } from './processSingleton';

export function operationsControlTower(): FreightControlTower {
  return processSingleton('freight-control-tower', () => new FreightControlTower(
    loadOperationsWorkflow(),
    carrierCommunicationsWorkflow(),
  ));
}
