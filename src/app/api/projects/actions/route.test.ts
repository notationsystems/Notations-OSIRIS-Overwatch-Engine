import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GET, POST } from './route';
import { POST as POST_TELEMETRY } from '../telemetry/v1/logs/route';

const oldOperationsToken = process.env.PAYLOAD_OPERATIONS_TOKEN;
const oldTelemetryToken = process.env.PAYLOAD_TELEMETRY_TOKEN;
const oldLog = process.env.PAYLOAD_PROJECT_CARGO_LOG;
const oldDatabase = process.env.PAYLOAD_DATABASE_PATH;
const directories: string[] = [];

afterEach(async () => {
  for (const [key, value] of [['PAYLOAD_OPERATIONS_TOKEN', oldOperationsToken], ['PAYLOAD_TELEMETRY_TOKEN', oldTelemetryToken], ['PAYLOAD_PROJECT_CARGO_LOG', oldLog], ['PAYLOAD_DATABASE_PATH', oldDatabase]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function actionRequest(method: 'GET' | 'POST', token?: string, body?: unknown): Request {
  return new Request('http://localhost/api/projects/actions', { method, headers: token ? { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) } : undefined, ...(body ? { body: JSON.stringify(body) } : {}) });
}

function registration(submittedAt: string) {
  return {
    action: 'register_project', requestId: 'request:project:api:001', actorId: 'desk:projects', submittedAt,
    payload: { projectId: 'project:api:001', projectReference: 'project-reference:api:001', customerId: 'customer:api', originLocationId: 'facility:origin', destinationLocationId: 'facility:destination', sourceReference: 'project-order:api:001', cargoItems: [{ cargoItemId: 'cargo:api:001', assetId: 'asset:api:001', category: 'pharmaceutical_cold_chain', description: 'API test cargo', serialOrLotIds: ['lot:api:001'], quantity: 1, quantityUnit: 'unit', declaredValueCurrency: 'CAD', sourceReference: 'packing-list:api:001', constraints: { temperatureMinimumCel: 2, temperatureMaximumCel: 8, allowedOrientations: ['upright'], handlingRequirements: [], securityRequirements: [], regulatoryRequirements: [], requiredDocumentTypes: [], requiredTelemetrySignals: ['temperature'], continuousCustodyRequired: true } }] },
  };
}

describe('authenticated project cargo APIs', () => {
  it('fails closed without configured operator authority', async () => {
    delete process.env.PAYLOAD_OPERATIONS_TOKEN;
    expect((await GET(actionRequest('GET'))).status).toBe(503);
  });

  it('persists project execution and OTLP telemetry without storing bearer tokens', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'payload-project-api-')); directories.push(directory);
    const journal = join(directory, 'project-cargo.jsonl');
    const operationsToken = 'PUBLIC-TEST-PROJECT-OPERATIONS-TOKEN'; const telemetryToken = 'PUBLIC-TEST-PROJECT-TELEMETRY-TOKEN';
    process.env.PAYLOAD_OPERATIONS_TOKEN = operationsToken; process.env.PAYLOAD_TELEMETRY_TOKEN = telemetryToken; process.env.PAYLOAD_PROJECT_CARGO_LOG = journal; delete process.env.PAYLOAD_DATABASE_PATH;
    const submittedAt = new Date(Date.now() - 1000).toISOString();
    const registered = await POST(actionRequest('POST', operationsToken, registration(submittedAt)));
    expect(registered.status).toBe(201);
    expect(await registered.json()).toMatchObject({ kind: 'accepted', project: { project: { projectId: 'project:api:001' }, phase: 'planning' } });
    const otlp = { resourceLogs: [{ resource: { attributes: [{ key: 'payload.project.id', value: { stringValue: 'project:api:001' } }, { key: 'payload.cargo.item.id', value: { stringValue: 'cargo:api:001' } }, { key: 'device.id', value: { stringValue: 'sensor:api:001' } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: String((Date.now() - 500) * 1_000_000), eventName: 'payload.cargo.condition.observed', attributes: [{ key: 'payload.telemetry.signal', value: { stringValue: 'temperature' } }, { key: 'payload.telemetry.unit', value: { stringValue: 'Cel' } }, { key: 'payload.telemetry.value', value: { doubleValue: 5 } }] }] }] }] };
    const telemetry = await POST_TELEMETRY(new Request('http://localhost/api/projects/telemetry/v1/logs', { method: 'POST', headers: { authorization: `Bearer ${telemetryToken}`, 'content-type': 'application/json', 'x-payload-source-id': 'collector:api:001' }, body: JSON.stringify(otlp) }));
    expect(telemetry.status).toBe(200); expect(await telemetry.json()).toEqual({});
    const listed = await GET(actionRequest('GET', operationsToken));
    expect(await listed.json()).toMatchObject({ kind: 'project_cargo_portfolio', projects: [{ observations: [{ signal: 'temperature', numericValue: 5 }], integrations: [{ integration: 'sensor', direction: 'inbound' }] }] });
    const stored = await readFile(journal, 'utf8'); expect(stored).not.toContain(operationsToken); expect(stored).not.toContain(telemetryToken);
  });

  it('rejects OTLP telemetry without its dedicated machine authority', async () => {
    delete process.env.PAYLOAD_TELEMETRY_TOKEN;
    const response = await POST_TELEMETRY(new Request('http://localhost/api/projects/telemetry/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
    expect(response.status).toBe(503);
  });
});
