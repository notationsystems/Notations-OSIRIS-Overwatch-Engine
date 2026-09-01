import { NextResponse } from 'next/server';
import { z } from 'zod';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { HttpProjectAdapterGateway } from '../../../../lib/economy/projectCargoAdapters';
import { projectCargoActions } from '../../../../lib/economy/projectCargoActionsRuntime';
import { hashCommand } from '../../../../lib/economy/projectCargoStore';

export const runtime = 'nodejs';
const identifier = z.string().trim().min(1).max(180).regex(/^[A-Za-z0-9][A-Za-z0-9:_./-]*$/);
const requestSchema = z.object({
  requestId: identifier, actorId: identifier, submittedAt: z.string().refine(value => Number.isFinite(Date.parse(value))),
  projectId: identifier, integration: z.enum(['carrier', 'edi', 'accounting', 'payment']), operation: identifier, externalReference: identifier,
  fields: z.record(z.string().regex(/^[a-z][a-z0-9_.-]{0,80}$/), z.union([z.string().trim().max(500), z.number().finite(), z.boolean()])).default({}),
}).strict();

const FORBIDDEN_FIELD = /(token|secret|password|email|phone|contact)/i;

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req); if (denied) return denied;
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'project_integration_not_json' }, { status: 400 }); }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'project_integration_invalid', detail: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') }, { status: 400 });
  if (Object.keys(parsed.data.fields).some(key => FORBIDDEN_FIELD.test(key))) return NextResponse.json({ error: 'project_integration_sensitive_field', detail: 'Credentials and contact details are not accepted in durable integration metadata.' }, { status: 422 });
  const gateway = new HttpProjectAdapterGateway(parsed.data.integration);
  const sent = await gateway.send({ projectId: parsed.data.projectId, operation: parsed.data.operation, externalReference: parsed.data.externalReference, fields: parsed.data.fields });
  if (sent.kind === 'refusal') return NextResponse.json(sent, { status: sent.code === 'PROJECT_ADAPTER_NOT_CONFIGURED' ? 503 : sent.code === 'PROJECT_ADAPTER_REJECTED' ? 502 : 504 });
  const recorded = await projectCargoActions().execute({
    action: 'record_integration', requestId: `integration:${hashCommand({ requestId: parsed.data.requestId, externalReference: parsed.data.externalReference })}`,
    actorId: parsed.data.actorId, submittedAt: parsed.data.submittedAt,
    payload: { projectId: parsed.data.projectId, integration: parsed.data.integration, direction: 'outbound', status: sent.status, externalReference: parsed.data.externalReference, metadata: { operation: parsed.data.operation, provider: sent.provider, providerReference: sent.providerReference }, evidenceReferences: [], sourceReference: parsed.data.externalReference },
  });
  if (recorded.kind === 'refusal') return NextResponse.json({ ...recorded, delivery: sent }, { status: 503 });
  return NextResponse.json({ kind: 'project_integration_accepted', delivery: sent, project: recorded.project }, { status: recorded.persistence === 'appended' ? 201 : 200 });
}
