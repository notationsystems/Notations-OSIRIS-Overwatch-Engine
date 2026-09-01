import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ recordCarrierEvent: vi.fn() }));

vi.mock('../../../../lib/economy/carrierCommunicationsRuntime', () => ({
  carrierCommunicationsWorkflow: () => ({ recordCarrierEvent: runtime.recordCarrierEvent }),
}));

import { POST } from './route';

const oldSecret = process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET;
const secret = 'PUBLIC-TEST-WEBHOOK-SECRET-NOT-A-SECRET';

afterEach(() => {
  vi.clearAllMocks();
  if (oldSecret === undefined) delete process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET;
  else process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET = oldSecret;
});

function signedRequest(body: string, timestamp: string, signatureSecret = secret): Request {
  const signature = createHmac('sha256', signatureSecret).update(`${timestamp}.${body}`).digest('hex');
  return new Request('http://localhost/api/freight/carrier-events', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-payload-timestamp': timestamp,
      'x-payload-signature': `sha256=${signature}`,
    },
    body,
  });
}

describe('carrier event webhook', () => {
  it('fails closed when the webhook secret is absent or the signature is wrong', async () => {
    const body = '{}';
    const timestamp = String(Math.floor(Date.now() / 1000));
    delete process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET;
    expect((await POST(signedRequest(body, timestamp))).status).toBe(503);
    process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET = secret;
    expect((await POST(signedRequest(body, timestamp, 'PUBLIC-TEST-WRONG-SECRET-NOT-A-SECRET'))).status).toBe(401);
    expect(runtime.recordCarrierEvent).not.toHaveBeenCalled();
  });

  it('rejects correctly signed replay outside the clock window', async () => {
    process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET = secret;
    const stale = String(Math.floor(Date.now() / 1000) - 301);
    expect((await POST(signedRequest('{}', stale))).status).toBe(401);
    expect(runtime.recordCarrierEvent).not.toHaveBeenCalled();
  });

  it('converts an authenticated provider callback into bounded evidence', async () => {
    process.env.PAYLOAD_CARRIER_WEBHOOK_SECRET = secret;
    const now = new Date();
    const body = JSON.stringify({
      operationId: 'operation:1',
      messageId: 'dispatch:message:1',
      carrierEventId: 'provider-event:1',
      carrierId: 'carrier:a',
      eventKind: 'acknowledgement',
      status: 'accepted',
      occurredAt: new Date(now.getTime() - 2_000).toISOString(),
      knownAt: new Date(now.getTime() - 1_000).toISOString(),
      ignoredProviderField: 'must not enter the journal',
    });
    runtime.recordCarrierEvent.mockResolvedValue({
      kind: 'accepted', persistence: 'appended', snapshot: { acknowledgement: 'accepted' },
    });
    const response = await POST(signedRequest(body, String(Math.floor(now.getTime() / 1000))));
    expect(response.status).toBe(201);
    expect(runtime.recordCarrierEvent).toHaveBeenCalledOnce();
    const command = runtime.recordCarrierEvent.mock.calls[0][0];
    expect(command).toMatchObject({
      operationId: 'operation:1',
      messageId: 'dispatch:message:1',
      carrierEventId: 'provider-event:1',
      carrierId: 'carrier:a',
      eventKind: 'acknowledgement',
      status: 'accepted',
    });
    expect(command.eventId).toMatch(/^carrier-event:[a-f0-9]{64}$/);
    expect(command.evidenceIds).toEqual([expect.stringMatching(/^carrier-webhook:[a-f0-9]{64}$/)]);
    expect(command).not.toHaveProperty('ignoredProviderField');
  });
});
