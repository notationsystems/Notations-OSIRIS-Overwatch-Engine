import { NextResponse } from 'next/server';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { projectCargoActions } from '../../../../lib/economy/projectCargoActionsRuntime';

export const runtime = 'nodejs';
const MAX_ACTION_BYTES = 256_000;

function statusFor(code: string): number {
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('CORRUPT') || code.includes('UNAVAILABLE')) return 503;
  if (code.includes('DUPLICATE') || code.includes('CONCURRENT')) return 409;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req); if (denied) return denied;
  const projectId = new URL(req.url).searchParams.get('projectId')?.trim();
  const result = projectId ? await projectCargoActions().inspect(projectId) : await projectCargoActions().list();
  return NextResponse.json(result, { status: result.kind === 'refusal' ? statusFor(result.code) : 200 });
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req); if (denied) return denied;
  let raw: string;
  try { raw = await req.text(); } catch { return NextResponse.json({ error: 'project_action_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_ACTION_BYTES) return NextResponse.json({ error: 'project_action_too_large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'project_action_not_json' }, { status: 400 }); }
  const result = await projectCargoActions().execute(body);
  if (result.kind === 'refusal') return NextResponse.json(result, { status: statusFor(result.code) });
  return NextResponse.json(result, { status: result.persistence === 'appended' ? 201 : 200 });
}
