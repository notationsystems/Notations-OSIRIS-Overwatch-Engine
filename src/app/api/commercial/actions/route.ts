import { NextResponse } from 'next/server';
import { commercialActions } from '../../../../lib/economy/commercialActionsRuntime';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';

export const runtime = 'nodejs';
const MAX_ACTION_BYTES = 64_000;

function statusFor(code: string): number {
  if (code.includes('NOT_FOUND')) return 404;
  if (code.includes('CORRUPT') || code.includes('UNAVAILABLE')) return 503;
  if (code.includes('CONFLICT') || code.includes('DUPLICATE')) return 409;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const commitmentId = new URL(req.url).searchParams.get('commitmentId')?.trim();
  if (!commitmentId) {
    const result = await commercialActions().list();
    return NextResponse.json(result, { status: result.kind === 'refusal' ? statusFor(result.code) : 200 });
  }
  const result = await commercialActions().inspect(commitmentId);
  return NextResponse.json(result, { status: result.kind === 'refusal' ? statusFor(result.code) : 200 });
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  let raw: string;
  try { raw = await req.text(); }
  catch { return NextResponse.json({ error: 'commercial_action_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_ACTION_BYTES) return NextResponse.json({ error: 'commercial_action_too_large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return NextResponse.json({ error: 'commercial_action_not_json' }, { status: 400 }); }
  const result = await commercialActions().execute(body);
  if (result.kind === 'refusal') return NextResponse.json(result, { status: statusFor(result.code) });
  return NextResponse.json(result, { status: result.persistence === 'appended' ? 201 : 200 });
}
