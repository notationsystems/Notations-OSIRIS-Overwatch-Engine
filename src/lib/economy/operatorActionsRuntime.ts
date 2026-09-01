/** Server-only owner for the constrained operator action adapter. */

import { carrierCommunicationsWorkflow } from './carrierCommunicationsRuntime';
import { loadOperationsWorkflow } from './loadOperationsRuntime';
import { OperatorActions } from './operatorActions';
import { processSingleton } from './processSingleton';

export function operatorActions(): OperatorActions {
  return processSingleton('operator-actions:v1', () => new OperatorActions(
    loadOperationsWorkflow(),
    carrierCommunicationsWorkflow(),
  ));
}
