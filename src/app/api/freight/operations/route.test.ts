import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attestationOf } from '../../../../lib/economy/attestation';
import { present, type Opportunity, type OpportunityFieldName } from '../../../../lib/economy/intake';
import { GET, POST } from './route';

const oldToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const oldLog = process.env.PAYLOAD_OPERATIONS_LOG;
const dirs: string[] = [];

afterEach(async () => {
  if (oldToken === undefined) delete process.env.PAYLOAD_OPERATIONS_TOKEN;
  else process.env.PAYLOAD_OPERATIONS_TOKEN = oldToken;
  if (oldLog === undefined) delete process.env.PAYLOAD_OPERATIONS_LOG;
  else process.env.PAYLOAD_OPERATIONS_LOG = oldLog;
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function opportunity(origin = 'Toronto, ON'): Opportunity {
  const fields: Record<OpportunityFieldName, ReturnType<typeof present<string | number>>> = {
    origin: present(origin, origin),
    destination: present('Detroit, MI', 'Detroit'),
    commodity: present('packaged food', 'packaged food'),
    weightLbs: present(38000, '38000 lbs'),
    equipment: present('reefer_53', '53 foot reefer'),
    pickupWindow: present('2026-09-01T14:00:00.000Z/2026-09-01T15:00:00.000Z', 'September 1, 2–3pm'),
    deliveryWindow: present('2026-09-02T17:00:00.000Z/2026-09-02T19:00:00.000Z', 'September 2, 5–7pm'),
    targetRate: present(220000, 'CAD 2200'),
  };
  return {
    opportunityId: 'opportunity:route:1',
    sourceMessageId: 'message:route:1',
    channel: 'gmail',
    receivedAt: '2026-09-01T12:00:00.000Z',
    fields,
    missingFields: [],
    unparsedFields: [],
    completeness: { present: 8, of: 8 },
    quotable: true,
    blockedOn: [],
    attestation: attestationOf('derived', 'medium', 'negotiating_position', 'route test intake'),
    extractedBy: { id: 'extractor:route', vendor: 'vendor:test' },
    renderedClaim: 'sanitized route test opportunity',
  };
}

function request(
  method: 'GET' | 'POST',
  token?: string,
  body?: unknown,
  suffix = '',
): Request {
  return new Request(`http://localhost/api/freight/operations${suffix}`, {
    method,
    headers: token ? {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe('persistent freight operations API', () => {
  it('fails closed when authority is unconfigured or wrong', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(request('GET'))).status).toBe(503);
    process.env.PAYLOAD_OPERATIONS_TOKEN = 'PUBLIC-TEST-OPERATIONS-TOKEN-NOT-A-SECRET';
    expect((await GET(request('GET', 'PUBLIC-TEST-WRONG-TOKEN-NOT-A-SECRET'))).status).toBe(401);
  });

  it('persists a sanitized opportunity and reads it through a new request', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-operations-route-'));
    dirs.push(dir);
    const file = join(dir, 'operations.jsonl');
    const token = 'PUBLIC-TEST-ROUTE-AUTHORITY-NOT-A-SECRET';
    process.env.PAYLOAD_OPERATIONS_TOKEN = token;
    process.env.PAYLOAD_OPERATIONS_LOG = file;
    const payload = {
      operationId: 'opportunity:route:1',
      eventId: 'event:route:intake',
      recordedAt: '2026-09-01T12:00:00.000Z',
      opportunity: opportunity(),
    };
    const posted = await POST(request('POST', token, { command: 'register_opportunity', payload }));
    expect(posted.status).toBe(201);
    expect(await posted.json()).toMatchObject({
      kind: 'accepted', snapshot: { operationId: 'opportunity:route:1', phase: 'alternatives_pending' },
    });
    const fetched = await GET(request('GET', token, undefined, '?operationId=opportunity%3Aroute%3A1'));
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({
      operationId: 'opportunity:route:1', durability: 'local_jsonl_single_writer',
    });
    const journal = await readFile(file, 'utf8');
    expect(journal).not.toContain(token);
  });

  it('does not let a hand-built payload bypass the load-only intake boundary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'payload-operations-route-'));
    dirs.push(dir);
    process.env.PAYLOAD_OPERATIONS_LOG = join(dir, 'operations.jsonl');
    process.env.PAYLOAD_OPERATIONS_TOKEN = 'PUBLIC-TEST-ROUTE-AUTHORITY-NOT-A-SECRET';
    const payload = {
      operationId: 'opportunity:route:1',
      eventId: 'event:route:intake',
      recordedAt: '2026-09-01T12:00:00.000Z',
      opportunity: opportunity('dispatcher@example.com'),
    };
    const response = await POST(request('POST', process.env.PAYLOAD_OPERATIONS_TOKEN, {
      command: 'register_opportunity', payload,
    }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      kind: 'refusal', code: 'OPERATION_COMMAND_INVALID',
    });
  });
});
