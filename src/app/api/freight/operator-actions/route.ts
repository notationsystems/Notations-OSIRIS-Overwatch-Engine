import { NextResponse } from 'next/server';
import { carrierDispatchConfigurationDefect } from '../../../../lib/economy/carrierCommunicationsRuntime';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { operatorActions } from '../../../../lib/economy/operatorActionsRuntime';

export const runtime = 'nodejs';

const MAX_ACTION_BYTES = 64_000;

function statusFor(code: string): number {
  if (code.includes('NOT_FOUND') || code.includes('UNKNOWN')) return 404;
  if (code.includes('UNAVAILABLE') || code.includes('CORRUPT') || code === 'OPERATOR_CLOCK_INVALID') return 503;
  if (code.includes('CONFLICT') || code.includes('DUPLICATE') || code.includes('PHASE')) return 409;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const operationId = new URL(req.url).searchParams.get('operationId')?.trim();
  if (!operationId) {
    return NextResponse.json({
      error: 'operation_id_required',
      detail: 'Select a load before opening its action cockpit.',
    }, { status: 400 });
  }
  const result = await operatorActions().inspect(operationId);
  return NextResponse.json(result, { status: result.kind === 'refusal' ? statusFor(result.code) : 200 });
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  let text: string;
  try { text = await req.text(); }
  catch { return NextResponse.json({ error: 'operator_action_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_ACTION_BYTES) {
    return NextResponse.json({
      error: 'operator_action_too_large',
      detail: 'Documents and raw API commands do not belong in a cockpit action.',
    }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { return NextResponse.json({ error: 'operator_action_not_json' }, { status: 400 }); }

  if (body && typeof body === 'object' && 'action' in body && body.action === 'send_tender') {
    const defect = carrierDispatchConfigurationDefect();
    if (defect) {
      return NextResponse.json({
        kind: 'refusal',
        code: 'CARRIER_GATEWAY_NOT_CONFIGURED',
        detail: defect,
        remedy: 'Configure the outbound carrier webhook URL and token before sending a tender.',
      }, { status: 503 });
    }
  }
  const result = await operatorActions().execute(body);
  if (result.kind === 'refusal') {
    return NextResponse.json(result, { status: statusFor(result.code) });
  }
  return NextResponse.json(result, { status: result.persistence === 'appended' ? 201 : 200 });
}
