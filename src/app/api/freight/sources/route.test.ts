import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  pullCarrier: vi.fn(),
  pullDiesel: vi.fn(),
}));

vi.mock('../../../../lib/economy/freightDataSourcesRuntime', () => ({
  freightDataSources: () => runtime,
}));

import { GET } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const token = 'PUBLIC-TEST-OPERATIONS-TOKEN-NOT-A-SECRET';

function request(query = '', bearer?: string): Request {
  return new Request(`http://localhost/api/freight/sources${query}`, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
  });
}

afterEach(() => {
  vi.clearAllMocks();
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
});

describe('freight source API', () => {
  it('is private and fail-closed', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request('?includeDiesel=1'))).status).toBe(503);
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    expect((await GET(request('?includeDiesel=1', 'wrong-token'))).status).toBe(401);
    expect(runtime.pullDiesel).not.toHaveBeenCalled();
  });

  it('requires a bounded source request and pairs USDOT with internal identity', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    expect((await GET(request('', token))).status).toBe(400);
    expect((await GET(request('?usdot=44110', token))).status).toBe(400);
    expect((await GET(request('?usdot=44110&carrierId=dispatcher%40example.com', token))).status).toBe(400);
    expect((await GET(request('?includeDiesel=sometimes', token))).status).toBe(400);
    expect(runtime.pullCarrier).not.toHaveBeenCalled();
  });

  it('pulls carrier and fuel together and exposes explicit incompleteness', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.pullCarrier.mockResolvedValue({
      kind: 'carrier_source_observation',
      sourceId: 'fmcsa-qcmobile',
      missing: [{ field: 'cargo_insurance_expiry', reason: 'not a COI', remedy: 'pull COI' }],
    });
    runtime.pullDiesel.mockResolvedValue({
      kind: 'diesel_benchmark_observation', sourceId: 'eia-weekly-diesel', period: '2026-08-31',
    });
    const response = await GET(request('?usdot=44110&carrierId=carrier%3Agreyhound&includeDiesel=1', token));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      incomplete: true,
      carrier: { kind: 'carrier_source_observation' },
      fuel: { kind: 'diesel_benchmark_observation' },
    });
    expect(runtime.pullCarrier).toHaveBeenCalledWith(expect.objectContaining({
      usdot: '44110', carrierId: 'carrier:greyhound',
    }));
    expect(runtime.pullDiesel).toHaveBeenCalledWith(expect.objectContaining({ retrievedAt: expect.any(String) }));
  });

  it('returns a source-level failure when every requested provider is unavailable', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.pullDiesel.mockResolvedValue({
      kind: 'refusal',
      code: 'SOURCE_NOT_CONFIGURED',
      sourceId: 'eia-weekly-diesel',
      detail: 'not configured',
      remedy: 'set key',
    });
    const response = await GET(request('?includeDiesel=1', token));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ incomplete: true, fuel: { code: 'SOURCE_NOT_CONFIGURED' } });
  });

  it('keeps a successful source response when another provider fails', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.pullCarrier.mockResolvedValue({
      kind: 'carrier_source_observation', sourceId: 'fmcsa-qcmobile', missing: [],
    });
    runtime.pullDiesel.mockResolvedValue({
      kind: 'refusal', code: 'SOURCE_UNAVAILABLE', sourceId: 'eia-weekly-diesel',
      detail: 'upstream unavailable', remedy: 'retry',
    });
    const response = await GET(request('?usdot=44110&carrierId=carrier%3Agreyhound&includeDiesel=1', token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      incomplete: true,
      carrier: { kind: 'carrier_source_observation' },
      fuel: { code: 'SOURCE_UNAVAILABLE' },
    });
  });
});
