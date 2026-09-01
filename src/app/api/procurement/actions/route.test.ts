import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GET, POST } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const oldLog = process.env.PAYLOAD_PROCUREMENT_LOG;
const oldDatabase = process.env.PAYLOAD_DATABASE_PATH;
const directories: string[] = [];

afterEach(async () => {
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
  if (oldLog === undefined) delete process.env.PAYLOAD_PROCUREMENT_LOG;
  else process.env.PAYLOAD_PROCUREMENT_LOG = oldLog;
  if (oldDatabase === undefined) delete process.env.PAYLOAD_DATABASE_PATH;
  else process.env.PAYLOAD_DATABASE_PATH = oldDatabase;
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function request(method: 'GET' | 'POST', token?: string, body?: unknown, suffix = ''): Request {
  return new Request(`http://localhost/api/procurement/actions${suffix}`, {
    method,
    headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('authenticated procurement cockpit API', () => {
  it('fails closed without configured authority', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request('GET'))).status).toBe(503);
  });

  it('registers and lists a requirement without storing the bearer token', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-procurement-api-'));
    directories.push(directory);
    const journal = join(directory, 'procurement.jsonl');
    const token = 'PUBLIC-TEST-PROCUREMENT-TOKEN-NOT-A-SECRET';
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    process.env.PAYLOAD_PROCUREMENT_LOG = journal;
    delete process.env.PAYLOAD_DATABASE_PATH;
    const body = {
      action: 'register_requirement', requestId: 'request:api:procurement:1', actorId: 'desk:procurement',
      submittedAt: '2026-09-01T10:00:00.000Z', payload: {
        procurementId: 'procurement:api:1', sourceReference: 'rfq:api:1', materialId: 'material:api', specificationId: 'spec:api',
        quantity: 25, unit: 'tonne', destinationId: 'facility:api', deliveryStart: '2026-09-10T00:00:00.000Z',
        deliveryEnd: '2026-09-20T00:00:00.000Z', currency: 'CAD',
      },
    };
    const posted = await POST(request('POST', token, body));
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({ kind: 'accepted', procurement: { procurementId: 'procurement:api:1', phase: 'alternatives_pending' } });
    const listed = await GET(request('GET', token));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ kind: 'procurement_portfolio', procurements: [{ procurementId: 'procurement:api:1' }] });
    expect(await readFile(journal, 'utf8')).not.toContain(token);
  });

  it('rejects internal event fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-procurement-api-'));
    directories.push(directory);
    process.env.PAYLOAD_PROCUREMENT_LOG = join(directory, 'procurement.jsonl');
    process.env.PAYLOAD_OPERATIONS_TOKEN = 'PUBLIC-TEST-PROCUREMENT-TOKEN-NOT-A-SECRET';
    delete process.env.PAYLOAD_DATABASE_PATH;
    const response = await POST(request('POST', process.env.PAYLOAD_OPERATIONS_TOKEN, {
      action: 'freeze_decision_set', requestId: 'request:injection', actorId: 'desk:procurement', submittedAt: '2026-09-01T10:00:00.000Z',
      commandHash: 'attacker-controlled', payload: { procurementId: 'procurement:missing' },
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'PROCUREMENT_COMMAND_INVALID' });
  });
});
