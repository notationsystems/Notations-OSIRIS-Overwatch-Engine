import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const oldLog = process.env.PAYLOAD_COMMERCIAL_LOG;
const oldDatabase = process.env.PAYLOAD_DATABASE_PATH;
const directories: string[] = [];

afterEach(async () => {
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
  if (oldLog === undefined) delete process.env.PAYLOAD_COMMERCIAL_LOG;
  else process.env.PAYLOAD_COMMERCIAL_LOG = oldLog;
  if (oldDatabase === undefined) delete process.env.PAYLOAD_DATABASE_PATH;
  else process.env.PAYLOAD_DATABASE_PATH = oldDatabase;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function request(method: 'GET' | 'POST', token?: string, body?: unknown, suffix = ''): Request {
  return new Request(`http://localhost/api/commercial/actions${suffix}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('authenticated commercial-position API', () => {
  it('fails closed without configured authority', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request('GET'))).status).toBe(503);
  });

  it('persists and lists customer demand without storing the bearer token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-commercial-api-'));
    directories.push(directory);
    const journal = join(directory, 'commercial.jsonl');
    const token = 'PUBLIC-TEST-COMMERCIAL-TOKEN-NOT-A-SECRET';
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    process.env.PAYLOAD_COMMERCIAL_LOG = journal;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const body = {
      action: 'register_customer_commitment', requestId: 'request:api:commercial:1', actorId: 'desk:commercial',
      submittedAt: '2026-09-01T10:00:00.000Z', payload: {
        commitmentId: 'customer-commitment:api:1', customerId: 'customer:api', customerPurchaseOrderId: 'po:api:1',
        materialId: 'material:api', specificationId: 'spec:api', quantity: 25, unit: 'tonne', destinationId: 'facility:api',
        deliveryStart: '2026-09-10T00:00:00.000Z', deliveryEnd: '2026-09-20T00:00:00.000Z', currency: 'CAD',
      },
    };
    const posted = await POST(request('POST', token, body));
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ kind: 'accepted', book: { commitments: [{ commitment: { commitmentId: 'customer-commitment:api:1' }, phase: 'allocation_pending' }] } });
    const listed = await GET(request('GET', token));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ kind: 'commercial_book_snapshot', commitments: [{ commitment: { commitmentId: 'customer-commitment:api:1' } }] });
    expect(await readFile(journal, 'utf8')).not.toContain(token);
  });

  it('rejects internal event fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-commercial-api-'));
    directories.push(directory);
    process.env.PAYLOAD_COMMERCIAL_LOG = join(directory, 'commercial.jsonl');
    process.env.PAYLOAD_OPERATIONS_TOKEN = 'PUBLIC-TEST-COMMERCIAL-TOKEN-NOT-A-SECRET';
    delete process.env.PAYLOAD_DATABASE_PATH;
    const response = await POST(request('POST', process.env.PAYLOAD_OPERATIONS_TOKEN, {
      action: 'register_customer_commitment', requestId: 'request:injection', actorId: 'desk:commercial', submittedAt: '2026-09-01T10:00:00.000Z',
      commandHash: 'attacker-controlled', payload: {
        commitmentId: 'customer-commitment:injection', customerId: 'customer:x', customerPurchaseOrderId: 'po:x',
        materialId: 'material:x', specificationId: 'spec:x', quantity: 1, unit: 'unit', destinationId: 'facility:x',
        deliveryStart: '2026-09-01T10:00:00.000Z', deliveryEnd: '2026-09-01T10:00:00.000Z', currency: 'USD',
      },
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'COMMERCIAL_COMMAND_INVALID' });
  });
});
