import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import type { RecordCarrierEventCommand } from '../../../../lib/economy/carrierCommunications';
import { carrierCommunicationsWorkflow } from '../../../../lib/economy/carrierCommunicationsRuntime';
import { env } from '../../../../lib/economy/envCompat';
import { hashCommand } from '../../../../lib/economy/loadOperationsStore';

export const runtime = 'nodejs';

const MAX_EVENT_BYTES = 256_000;
const MAX_CLOCK_SKEW_SECONDS = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function authenticate(rawBody: string, req: Request, nowMs: number): NextResponse | null {
  const secret = env('PAYLOAD_CARRIER_WEBHOOK_SECRET');
  if (!secret?.trim() || Buffer.byteLength(secret, 'utf8') < 32) {
    return NextResponse.json({ error: 'carrier_webhook_not_configured' }, { status: 503 });
  }
  const timestamp = req.headers.get('x-payload-timestamp');
  const signature = req.headers.get('x-payload-signature');
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature?.startsWith('sha256=')) {
    return NextResponse.json({ error: 'carrier_webhook_unauthorized' }, { status: 401 });
  }
  const timestampSeconds = Number(timestamp);
  if (Math.abs(Math.floor(nowMs / 1000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return NextResponse.json({ error: 'carrier_webhook_stale' }, { status: 401 });
  }
  const suppliedHex = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/.test(suppliedHex)) {
    return NextResponse.json({ error: 'carrier_webhook_unauthorized' }, { status: 401 });
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return NextResponse.json({ error: 'carrier_webhook_unauthorized' }, { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  let rawBody: string;
  try { rawBody = await req.text(); }
  catch { return NextResponse.json({ error: 'carrier_event_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_EVENT_BYTES) {
    return NextResponse.json({ error: 'carrier_event_too_large' }, { status: 413 });
  }
  const now = Date.now();
  const denied = authenticate(rawBody, req, now);
  if (denied) return denied;
  let body: unknown;
  try { body = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: 'carrier_event_not_json' }, { status: 400 }); }
  if (!isRecord(body)) return NextResponse.json({ error: 'carrier_event_shape_invalid' }, { status: 400 });
  const carrierEventId = typeof body.carrierEventId === 'string' ? body.carrierEventId : '';
  const command: RecordCarrierEventCommand = {
    operationId: typeof body.operationId === 'string' ? body.operationId : '',
    messageId: typeof body.messageId === 'string' ? body.messageId : '',
    eventId: `carrier-event:${hashCommand({
      carrierId: body.carrierId,
      carrierEventId,
    })}`,
    carrierEventId,
    carrierId: typeof body.carrierId === 'string' ? body.carrierId : '',
    eventKind: body.eventKind as RecordCarrierEventCommand['eventKind'],
    status: body.status as RecordCarrierEventCommand['status'],
    occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : '',
    knownAt: typeof body.knownAt === 'string' ? body.knownAt : '',
    recordedAt: new Date(now).toISOString(),
    evidenceIds: [`carrier-webhook:${hashCommand(body)}`],
  };
  try {
    const result = await carrierCommunicationsWorkflow().recordCarrierEvent(command);
    if (result.kind === 'refusal') {
      const unavailable = result.code === 'COMMUNICATION_STORE_CORRUPT' ||
        result.code === 'COMMUNICATION_STORE_UNAVAILABLE';
      const conflict = result.code === 'COMMUNICATION_EVENT_ID_CONFLICT';
      return NextResponse.json(result, { status: unavailable ? 503 : conflict ? 409 : 422 });
    }
    return NextResponse.json(result, { status: result.persistence === 'appended' ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({
      error: 'carrier_event_shape_invalid',
      detail: (error as Error).message,
    }, { status: 400 });
  }
}
