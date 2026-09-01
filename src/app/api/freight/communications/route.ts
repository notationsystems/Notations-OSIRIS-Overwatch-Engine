import { NextResponse } from 'next/server';
import type {
  CarrierCommunicationCommandResult,
  SendCarrierDispatchCommand,
} from '../../../../lib/economy/carrierCommunications';
import {
  carrierCommunicationsWorkflow,
  carrierDispatchConfigurationDefect,
} from '../../../../lib/economy/carrierCommunicationsRuntime';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';

export const runtime = 'nodejs';

const MAX_COMMAND_BYTES = 64_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function statusFor(result: CarrierCommunicationCommandResult): number {
  if (result.kind === 'accepted') return result.persistence === 'appended' ? 201 : 200;
  if (result.kind === 'delivery_failed') return result.snapshot.attempts.at(-1)?.failure?.retryable ? 502 : 422;
  if (result.code === 'COMMUNICATION_OPERATION_NOT_FOUND' ||
      result.code === 'COMMUNICATION_MESSAGE_UNKNOWN') return 404;
  if (result.code === 'COMMUNICATION_STORE_UNAVAILABLE' ||
      result.code === 'COMMUNICATION_STORE_CORRUPT') return 503;
  if (result.code === 'COMMUNICATION_EVENT_ID_CONFLICT' ||
      result.code === 'COMMUNICATION_STORE_CONCURRENT_WRITE' ||
      result.code === 'COMMUNICATION_ALREADY_DELIVERED') return 409;
  return 422;
}

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const operationId = new URL(req.url).searchParams.get('operationId');
  const workflow = carrierCommunicationsWorkflow();
  const result = operationId ? await workflow.get(operationId) : await workflow.list();
  if (Array.isArray(result)) return NextResponse.json({ communications: result });
  if ('kind' in result && result.kind === 'refusal') {
    return NextResponse.json(result, { status: statusFor(result) });
  }
  return NextResponse.json(result);
}

export async function POST(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const configurationDefect = carrierDispatchConfigurationDefect();
  if (configurationDefect) {
    return NextResponse.json({
      error: 'carrier_gateway_not_configured',
      detail: configurationDefect,
      remedy: 'Configure the outbound carrier webhook URL and bearer token before requesting delivery.',
    }, { status: 503 });
  }
  let bodyText: string;
  try { bodyText = await req.text(); }
  catch { return NextResponse.json({ error: 'command_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_COMMAND_BYTES) {
    return NextResponse.json({ error: 'command_too_large' }, { status: 413 });
  }
  let body: unknown;
  try { body = JSON.parse(bodyText); }
  catch { return NextResponse.json({ error: 'command_not_json' }, { status: 400 }); }
  if (!isRecord(body) || body.command !== 'send_dispatch' || !isRecord(body.payload)) {
    return NextResponse.json({
      error: 'command_shape_invalid',
      detail: 'Expected { command: "send_dispatch", payload: object }.',
    }, { status: 400 });
  }
  try {
    const result = await carrierCommunicationsWorkflow()
      .send(body.payload as unknown as SendCarrierDispatchCommand);
    return NextResponse.json(result, { status: statusFor(result) });
  } catch (error) {
    return NextResponse.json({
      error: 'command_shape_invalid',
      detail: (error as Error).message,
    }, { status: 400 });
  }
}
