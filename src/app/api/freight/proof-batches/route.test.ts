import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ database: null as null | { listProofBatches: ReturnType<typeof vi.fn> } }));

vi.mock('../../../../lib/economy/payloadEventDatabaseRuntime', () => ({
  payloadEventDatabase: () => runtime.database,
}));

import { GET } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const token = 'PUBLIC-TEST-OPERATIONS-TOKEN-NOT-A-SECRET';

function request(bearer?: string): Request {
  return new Request('http://localhost/api/freight/proof-batches', {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : undefined,
  });
}

afterEach(() => {
  runtime.database = null;
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
});

describe('freight proof-batch API', () => {
  it('returns the trusted program and distinguishes committed from proved coverage', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    runtime.database = { listProofBatches: vi.fn(() => [
      { batchId: 'proof-batch:1', status: 'proved', eventCount: 12 },
      { batchId: 'proof-batch:2', status: 'pending', eventCount: 5 },
    ]) };
    const response = await GET(request(token));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kind: 'payload_proof_batch_list',
      trustedProgram: {
        program: 'payload_event_batch_v1',
        sp1Version: '6.5.0',
        verificationKey: '0x008b44279df6f73c35aedf6de5145496d7b6364124ed46620bf4d4d222c54368',
      },
      summary: { total: 2, pending: 1, proving: 0, proved: 1, failed: 0, committedEvents: 17, provedEvents: 12 },
      batches: [{ batchId: 'proof-batch:1' }, { batchId: 'proof-batch:2' }],
    });
  });

  it('remains private and fails closed when durable storage is unavailable', async () => {
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    expect((await GET(request('wrong'))).status).toBe(401);
    const response = await GET(request(token));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'PAYLOAD_DATABASE_NOT_CONFIGURED' });
  });
});
