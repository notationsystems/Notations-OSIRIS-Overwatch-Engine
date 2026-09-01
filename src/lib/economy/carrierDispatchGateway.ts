/** Fail-closed webhook adapter for provider-neutral carrier tender delivery. */

import type {
  CarrierDispatchEnvelope,
  CarrierDispatchGateway,
  CarrierDispatchGatewayResult,
} from './carrierCommunications';

export interface WebhookCarrierDispatchGatewayOptions {
  readonly endpoint: string;
  readonly bearerToken: string;
  readonly provider: string;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => string;
}

const MAX_RESPONSE_BYTES = 65_536;

export function carrierDispatchEndpointDefect(value: string): string | null {
  let endpoint: URL;
  try { endpoint = new URL(value); }
  catch { return 'Carrier dispatch endpoint is not a valid URL.'; }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    return 'Carrier dispatch endpoint must be an HTTP(S) URL without embedded credentials.';
  }
  const localHttp = endpoint.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'].includes(endpoint.hostname);
  if (endpoint.protocol !== 'https:' && !localHttp) {
    return 'Carrier dispatch endpoint must use HTTPS except for an explicit local development host.';
  }
  return null;
}

function safeEndpoint(value: string): URL {
  const defect = carrierDispatchEndpointDefect(value);
  if (defect) throw new Error(defect);
  return new URL(value);
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(`Carrier gateway response exceeds ${MAX_RESPONSE_BYTES} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function failure(
  provider: string,
  completedAt: string,
  code: string,
  detail: string,
  retryable: boolean,
  evidenceIds: readonly string[],
): CarrierDispatchGatewayResult {
  return Object.freeze({
    kind: 'failed' as const,
    provider,
    completedAt,
    code,
    detail: detail.slice(0, 500),
    retryable,
    evidenceIds: Object.freeze([...evidenceIds]),
  });
}

export class WebhookCarrierDispatchGateway implements CarrierDispatchGateway {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(private readonly options: WebhookCarrierDispatchGatewayOptions) {
    this.endpoint = safeEndpoint(options.endpoint);
    if (!options.bearerToken.trim()) throw new Error('Carrier dispatch bearer token is empty.');
    if (!options.provider.trim()) throw new Error('Carrier dispatch provider identity is empty.');
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = Math.min(30_000, Math.max(1_000, options.timeoutMs ?? 10_000));
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async deliver(
    envelope: CarrierDispatchEnvelope,
    idempotencyKey: string,
  ): Promise<CarrierDispatchGatewayResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.options.bearerToken}`,
          'content-type': 'application/json',
          'idempotency-key': idempotencyKey,
          'x-payload-message-id': envelope.messageId,
          'x-payload-schema': envelope.schemaVersion,
        },
        body: JSON.stringify(envelope),
      });
      const completedAt = this.now();
      let body: string;
      try { body = await responseText(response); }
      catch (error) {
        return failure(
          this.options.provider,
          completedAt,
          'PROVIDER_RESPONSE_TOO_LARGE',
          (error as Error).message,
          false,
          [`carrier-http-status:${response.status}`],
        );
      }
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 ||
          response.status === 429 || response.status >= 500;
        return failure(
          this.options.provider,
          completedAt,
          `PROVIDER_HTTP_${response.status}`,
          `Carrier gateway returned HTTP ${response.status}; its response body was not persisted.`,
          retryable,
          [`carrier-http-status:${response.status}`],
        );
      }
      let receipt: unknown;
      try { receipt = JSON.parse(body); }
      catch {
        return failure(
          this.options.provider,
          completedAt,
          'PROVIDER_RECEIPT_INVALID',
          'Carrier gateway accepted the request without a valid JSON receipt.',
          true,
          [`carrier-http-status:${response.status}`],
        );
      }
      const record = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
        ? receipt as Record<string, unknown>
        : null;
      const receiptId = typeof record?.receiptId === 'string' ? record.receiptId.trim() : '';
      const acceptedAt = typeof record?.acceptedAt === 'string' ? record.acceptedAt : completedAt;
      if (!receiptId || receiptId.length > 256 || !Number.isFinite(Date.parse(acceptedAt))) {
        return failure(
          this.options.provider,
          completedAt,
          'PROVIDER_RECEIPT_INVALID',
          'Carrier gateway receipt lacks a bounded receiptId or valid acceptedAt.',
          true,
          [`carrier-http-status:${response.status}`],
        );
      }
      return Object.freeze({
        kind: 'delivered' as const,
        provider: this.options.provider,
        providerReceiptId: receiptId,
        acceptedAt,
        completedAt,
        evidenceIds: Object.freeze([
          `carrier-http-status:${response.status}`,
          `carrier-provider-receipt:${receiptId}`,
        ]),
      });
    } catch (error) {
      const completedAt = this.now();
      const aborted = controller.signal.aborted;
      return failure(
        this.options.provider,
        completedAt,
        aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
        aborted
          ? `Carrier gateway did not complete within ${this.timeoutMs}ms.`
          : `Carrier gateway request failed with ${(error as Error).name || 'network error'}.`,
        true,
        [`carrier-gateway-error:${aborted ? 'timeout' : 'network'}`],
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
