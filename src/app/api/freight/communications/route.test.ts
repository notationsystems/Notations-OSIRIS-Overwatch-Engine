import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  configurationDefect: null as string | null,
  list: vi.fn(),
  get: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../../../../lib/economy/carrierCommunicationsRuntime', () => ({
  carrierDispatchConfigurationDefect: () => runtime.configurationDefect,
  carrierCommunicationsWorkflow: () => ({
    list: runtime.list,
    get: runtime.get,
    send: runtime.send,
  }),
}));

import { GET, POST } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const token = 'PUBLIC-TEST-OPERATIONS-TOKEN-NOT-A-SECRET';

afterEach(() => {
  vi.clearAllMocks();
  runtime.configurationDefect = null;
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
});

function request(method: 'GET' | 'POST', bearer?: string, body?: unknown, suffix = ''): Request {
  return new Request(`http://localhost/api/freight/communications${suffix}`, {
    method,
    headers: bearer ? {
      authorization: `Bearer ${bearer}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('carrier communications API', () => {
  it('uses the private operations authority for reads and sends', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request('GET'))).status).toBe(503);
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    expect((await GET(request('GET', 'PUBLIC-TEST-WRONG-TOKEN-NOT-A-SECRET'))).status).toBe(401);
    expect(runtime.list).not.toHaveBeenCalled();
  });

  it('lists delivery projections without requiring an outbound provider', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.configurationDefect = 'not configured';
    runtime.list.mockResolvedValue([]);
    const response = await GET(request('GET', token));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ communications: [] });
  });

  it('fails closed before send when the carrier gateway is not configured', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.configurationDefect = 'PAYLOAD_CARRIER_DISPATCH_URL is not configured.';
    const response = await POST(request('POST', token, {
      command: 'send_dispatch',
      payload: { operationId: 'operation:1', eventId: 'attempt:1', requestedAt: '2026-09-01T12:00:00Z' },
    }));
    expect(response.status).toBe(503);
    expect(runtime.send).not.toHaveBeenCalled();
  });

  it('passes a bounded typed send command to the durable workflow', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    const payload = {
      operationId: 'operation:1',
      eventId: 'attempt:1',
      requestedAt: '2026-09-01T12:00:00.000Z',
    };
    runtime.send.mockResolvedValue({
      kind: 'refusal',
      code: 'COMMUNICATION_OPERATION_NOT_FOUND',
      detail: 'not found',
      remedy: 'register and dispatch',
    });
    const response = await POST(request('POST', token, { command: 'send_dispatch', payload }));
    expect(response.status).toBe(404);
    expect(runtime.send).toHaveBeenCalledWith(payload);
  });
});
