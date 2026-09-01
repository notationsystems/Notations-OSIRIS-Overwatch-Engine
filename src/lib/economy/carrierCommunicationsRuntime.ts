/** Server-only runtime owner for carrier delivery and callback evidence. */

import { resolve } from 'node:path';
import { env } from './envCompat';
import {
  CarrierCommunicationsWorkflow,
  type CarrierDispatchGateway,
  type CarrierDispatchGatewayResult,
} from './carrierCommunications';
import { FileCarrierCommunicationStore } from './carrierCommunicationsStore';
import {
  WebhookCarrierDispatchGateway,
  carrierDispatchEndpointDefect,
} from './carrierDispatchGateway';
import { loadOperationsJournalPath, loadOperationsWorkflow } from './loadOperationsRuntime';
import { hashCommand } from './loadOperationsStore';
import { processSingleton } from './processSingleton';

export function carrierCommunicationsJournalPath(): string {
  const configured = env('PAYLOAD_CARRIER_COMMUNICATIONS_LOG') ??
    'data-archive/carrier-communications.jsonl';
  return resolve(/* turbopackIgnore: true */ process.cwd(), configured);
}

export function carrierDispatchConfigurationDefect(): string | null {
  const endpoint = env('PAYLOAD_CARRIER_DISPATCH_URL')?.trim();
  if (!endpoint) return 'PAYLOAD_CARRIER_DISPATCH_URL is not configured.';
  const endpointDefect = carrierDispatchEndpointDefect(endpoint);
  if (endpointDefect) return endpointDefect;
  if (!env('PAYLOAD_CARRIER_DISPATCH_TOKEN')?.trim()) return 'PAYLOAD_CARRIER_DISPATCH_TOKEN is not configured.';
  return null;
}

class UnconfiguredCarrierGateway implements CarrierDispatchGateway {
  async deliver(): Promise<CarrierDispatchGatewayResult> {
    return {
      kind: 'failed',
      provider: 'unconfigured',
      code: 'PROVIDER_NOT_CONFIGURED',
      detail: 'Carrier delivery is fail-closed until its endpoint and token are configured.',
      retryable: false,
      completedAt: new Date().toISOString(),
      evidenceIds: ['carrier-gateway:unconfigured'],
    };
  }
}

function carrierGateway(): CarrierDispatchGateway {
  const endpoint = env('PAYLOAD_CARRIER_DISPATCH_URL')?.trim();
  const token = env('PAYLOAD_CARRIER_DISPATCH_TOKEN')?.trim();
  if (!endpoint || !token) return new UnconfiguredCarrierGateway();
  const rawTimeout = Number(env('PAYLOAD_CARRIER_DISPATCH_TIMEOUT_MS'));
  return new WebhookCarrierDispatchGateway({
    endpoint,
    bearerToken: token,
    provider: env('PAYLOAD_CARRIER_DISPATCH_PROVIDER')?.trim() || 'carrier-webhook',
    ...(Number.isFinite(rawTimeout) ? { timeoutMs: rawTimeout } : {}),
  });
}

export function carrierCommunicationsWorkflow(): CarrierCommunicationsWorkflow {
  const communicationPath = carrierCommunicationsJournalPath();
  const operationPath = loadOperationsJournalPath();
  const gatewayIdentity = hashCommand({
    endpoint: env('PAYLOAD_CARRIER_DISPATCH_URL') ?? null,
    token: env('PAYLOAD_CARRIER_DISPATCH_TOKEN') ?? null,
    provider: env('PAYLOAD_CARRIER_DISPATCH_PROVIDER') ?? null,
    timeout: env('PAYLOAD_CARRIER_DISPATCH_TIMEOUT_MS') ?? null,
  });
  return processSingleton(
    `carrier-communications:${operationPath}:${communicationPath}:${gatewayIdentity}`,
    () => new CarrierCommunicationsWorkflow(
      loadOperationsWorkflow(),
      new FileCarrierCommunicationStore(communicationPath),
      carrierGateway(),
    ),
  );
}
