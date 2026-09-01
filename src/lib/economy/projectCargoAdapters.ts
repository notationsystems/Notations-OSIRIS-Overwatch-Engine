/** Fail-closed provider-neutral boundaries for project execution systems. */

import { env } from './envCompat';

export type ProjectOutboundIntegration = 'carrier' | 'edi' | 'accounting' | 'payment';

export type ProjectAdapterEnvelope = {
  readonly projectId: string;
  readonly operation: string;
  readonly externalReference: string;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
};

export type ProjectAdapterResult =
  | { readonly kind: 'accepted'; readonly provider: string; readonly externalReference: string; readonly providerReference: string; readonly status: 'accepted' | 'pending' }
  | { readonly kind: 'refusal'; readonly code: 'PROJECT_ADAPTER_NOT_CONFIGURED' | 'PROJECT_ADAPTER_TIMEOUT' | 'PROJECT_ADAPTER_REJECTED' | 'PROJECT_ADAPTER_UNAVAILABLE'; readonly detail: string; readonly remedy: string };

function setting(integration: ProjectOutboundIntegration, suffix: 'URL' | 'TOKEN' | 'PROVIDER'): string | undefined {
  return env(`PAYLOAD_PROJECT_${integration.toUpperCase()}_${suffix}`);
}

function timeoutMs(): number {
  const parsed = Number(env('PAYLOAD_PROJECT_ADAPTER_TIMEOUT_MS') ?? '10000');
  return Number.isFinite(parsed) && parsed >= 1000 && parsed <= 60_000 ? parsed : 10_000;
}

function refusal(code: Extract<ProjectAdapterResult, { kind: 'refusal' }>['code'], detail: string, remedy: string): ProjectAdapterResult {
  return Object.freeze({ kind: 'refusal' as const, code, detail, remedy });
}

export class HttpProjectAdapterGateway {
  constructor(private readonly integration: ProjectOutboundIntegration) {}

  async send(envelope: ProjectAdapterEnvelope): Promise<ProjectAdapterResult> {
    const url = setting(this.integration, 'URL')?.trim();
    const token = setting(this.integration, 'TOKEN')?.trim();
    const provider = setting(this.integration, 'PROVIDER')?.trim() || `${this.integration}-webhook`;
    if (!url || !token) return refusal('PROJECT_ADAPTER_NOT_CONFIGURED', `${this.integration} adapter URL or token is missing.`, `Configure PAYLOAD_PROJECT_${this.integration.toUpperCase()}_URL and PAYLOAD_PROJECT_${this.integration.toUpperCase()}_TOKEN.`);
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { return refusal('PROJECT_ADAPTER_NOT_CONFIGURED', `${this.integration} adapter URL is invalid.`, 'Configure an absolute HTTPS provider endpoint.'); }
    const local = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'host.docker.internal';
    if (endpoint.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && local)) return refusal('PROJECT_ADAPTER_NOT_CONFIGURED', `${this.integration} adapter must use HTTPS in production.`, 'Configure a TLS-protected provider endpoint.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs());
    try {
      const response = await fetch(endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': envelope.externalReference },
        body: JSON.stringify({ schema: 'payload.project.integration.v1', integration: this.integration, ...envelope }),
      });
      const body = await response.text();
      if (!response.ok) return refusal('PROJECT_ADAPTER_REJECTED', `${provider} rejected ${this.integration} exchange with HTTP ${response.status}.`, 'Inspect the provider response and retry the same idempotency identity after correcting the request.');
      let providerReference = envelope.externalReference;
      let status: 'accepted' | 'pending' = 'accepted';
      if (body.trim()) {
        try {
          const parsed = JSON.parse(body) as { providerReference?: unknown; status?: unknown };
          if (typeof parsed.providerReference === 'string' && parsed.providerReference.trim()) providerReference = parsed.providerReference.trim().slice(0, 180);
          if (parsed.status === 'pending') status = 'pending';
        } catch { /* a 2xx empty/non-JSON body still acknowledges the idempotent exchange */ }
      }
      return Object.freeze({ kind: 'accepted' as const, provider, externalReference: envelope.externalReference, providerReference, status });
    } catch (error) {
      return (error as Error).name === 'AbortError'
        ? refusal('PROJECT_ADAPTER_TIMEOUT', `${provider} did not acknowledge before the deadline.`, 'Retry the same external reference; never allocate a new idempotency identity for an uncertain delivery.')
        : refusal('PROJECT_ADAPTER_UNAVAILABLE', `${provider} request failed: ${(error as Error).message}`, 'Restore provider connectivity and retry the same external reference.');
    } finally { clearTimeout(timer); }
  }
}
