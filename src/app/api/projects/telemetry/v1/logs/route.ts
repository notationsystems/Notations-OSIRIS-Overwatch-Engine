import { NextResponse } from 'next/server';
import { authorizeTelemetrySurface } from '../../../../../../lib/economy/operationsHttpAuth';
import { projectCargoActions } from '../../../../../../lib/economy/projectCargoActionsRuntime';
import { decodeOtlpJsonLogs } from '../../../../../../lib/economy/projectCargoOtlp';

export const runtime = 'nodejs';
const MAX_OTLP_BYTES = 2_000_000;

export async function POST(req: Request) {
  const denied = authorizeTelemetrySurface(req); if (denied) return denied;
  if (!req.headers.get('content-type')?.toLowerCase().includes('application/json')) return NextResponse.json({ error: 'otlp_media_type_unsupported', detail: 'This receiver accepts OTLP/HTTP JSON logs.', remedy: 'Configure the Collector exporter protocol as http/json.' }, { status: 415 });
  const sourceId = req.headers.get('x-payload-source-id')?.trim() ?? '';
  let raw: string;
  try { raw = await req.text(); } catch { return NextResponse.json({ error: 'otlp_request_unreadable' }, { status: 400 }); }
  if (Buffer.byteLength(raw, 'utf8') > MAX_OTLP_BYTES) return NextResponse.json({ error: 'otlp_request_too_large' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return NextResponse.json({ error: 'otlp_request_not_json' }, { status: 400 }); }
  const observedAt = new Date().toISOString();
  const decoded = decodeOtlpJsonLogs(body, sourceId, observedAt);
  if ('kind' in decoded) return NextResponse.json({ error: 'otlp_request_invalid', detail: decoded.detail }, { status: 400 });
  let rejected = 0;
  const errors: string[] = [];
  for (const item of decoded) {
    const observation = await projectCargoActions().execute(item.request);
    if (observation.kind === 'refusal') { rejected += 1; errors.push(`${observation.code}: ${observation.detail}`); continue; }
    const exchange = await projectCargoActions().execute({
      action: 'record_integration', requestId: `${item.request.requestId}:exchange`, actorId: item.request.actorId, submittedAt: observedAt,
      payload: { projectId: item.request.payload.projectId, integration: 'sensor', direction: 'inbound', status: 'accepted', externalReference: item.externalReference, metadata: { signal: item.request.payload.signal, sensorId: item.request.payload.sensorId }, evidenceReferences: [], sourceReference: item.externalReference },
    });
    if (exchange.kind === 'refusal') { rejected += 1; errors.push(`${exchange.code}: telemetry accepted but integration audit failed: ${exchange.detail}`); }
  }
  return rejected === 0
    ? NextResponse.json({})
    : NextResponse.json({ partialSuccess: { rejectedLogRecords: rejected, errorMessage: errors.slice(0, 10).join('; ') } });
}
