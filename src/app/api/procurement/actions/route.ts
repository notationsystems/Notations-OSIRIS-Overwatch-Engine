import { NextResponse } from 'next/server';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { procurementActions } from '../../../../lib/economy/procurementActionsRuntime';

export const runtime = 'nodejs';
const MAX_ACTION_BYTES = 64_000;

function statusFor(code: string): number {
  if (code.includes('NOT_FOUND') || code.includes('UNKNOWN')) return 404;
  if (code.includes('CORRUPT') || code.includes('UNAVAILABLE')) return 503;
  if (code.includes('CONFLICT') || code.includes('DUPLICATE') || code.includes('PHASE')) return 409;
  return 422;
}

function isPortfolioRefusal(
  value: Awaited<ReturnType<ReturnType<typeof procurementActions>['list']>>,
): value is Exclude<typeof value, readonly unknown[]> {
  return !Array.isArray(value);
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const procurementId = new URL(req.url).searchParams.get('procurementId')?.trim();
  if (!procurementId) {
    const procurements = await procurementActions().list();
    if (isPortfolioRefusal(procurements)) return NextResponse.json(procurements, { status: statusFor(procurements.code) });
    return NextResponse.json({ kind: 'procurement_portfolio', procurements });
  }
  const result = await procurementActions().inspect(procurementId);
  return NextResponse.json(result, { status: result.kind === 'refusal' ? statusFor(result.code) : 200 });
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  let raw: string;
  try { raw = await req.text(); }
  catch { return NextResponse.json({ error: 'procurement_action_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_ACTION_BYTES) return NextResponse.json({ error: 'procurement_action_too_large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); }
  catch { return NextResponse.json({ error: 'procurement_action_not_json' }, { status: 400 }); }
  const result = await procurementActions().execute(body);
  if (result.kind === 'refusal') return NextResponse.json(result, { status: statusFor(result.code) });
  return NextResponse.json(result, { status: result.persistence === 'appended' ? 201 : 200 });
}
