import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock('../../../../lib/economy/controlTowerRuntime', () => ({
  operationsControlTower: () => runtime,
}));

import { GET } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const token = 'PUBLIC-TEST-OPERATIONS-TOKEN-NOT-A-SECRET';

function request(bearer?: string): Request {
  return new Request('http://localhost/api/freight/control-tower', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
});

describe('freight control-tower API', () => {
  it('is private and fail-closed', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request())).status).toBe(503);
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    expect((await GET(request('wrong-token'))).status).toBe(401);
    expect(runtime.read).not.toHaveBeenCalled();
  });

  it('returns the joined projection without shared-cache eligibility', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.read.mockResolvedValue({
      kind: 'control_tower_snapshot',
      asOf: '2026-09-01T12:00:00.000Z',
      policy: {},
      portfolio: { totalLoads: 1 },
      loads: [{ operationId: 'operation:1' }],
    });
    const response = await GET(request(token));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      kind: 'control_tower_snapshot',
      portfolio: { totalLoads: 1 },
    });
    expect(runtime.read).toHaveBeenCalledWith(expect.any(String));
  });

  it('reports unavailable journals as a service failure', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.read.mockResolvedValue({
      kind: 'refusal',
      code: 'CONTROL_TOWER_OPERATIONS_UNAVAILABLE',
      detail: 'journal unavailable',
      remedy: 'mount storage',
    });
    const response = await GET(request(token));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: 'CONTROL_TOWER_OPERATIONS_UNAVAILABLE',
    });
  });
});
