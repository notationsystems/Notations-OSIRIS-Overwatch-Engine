/** Process-wide construction for the authoritative freight-source gateway. */

import { env } from './envCompat';
import { FreightDataSourceGateway } from './freightDataSources';
import { processSingleton, resetProcessSingleton } from './processSingleton';

const SINGLETON_KEY = 'freight-data-sources';

function timeout(): number | undefined {
  const raw = env('PAYLOAD_FREIGHT_SOURCE_TIMEOUT_MS');
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export function freightDataSources(): FreightDataSourceGateway {
  return processSingleton(SINGLETON_KEY, () => new FreightDataSourceGateway({
    fmcsaWebKey: env('FMCSA_WEB_KEY'),
    eiaApiKey: env('EIA_API_KEY'),
    timeoutMs: timeout(),
  }));
}

export function resetFreightDataSources(): void {
  resetProcessSingleton(SINGLETON_KEY);
}
