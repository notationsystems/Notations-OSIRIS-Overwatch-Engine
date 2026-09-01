/** Shared fail-closed authority check for private freight-operation routes. */

import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from './envCompat';

export function authorizeOperationsSurface(req: Request): NextResponse | null {
  const expected = env('PAYLOAD_OPERATIONS_TOKEN');
  if (!expected?.trim()) {
    return NextResponse.json({
      error: 'operations_not_configured',
      detail: 'Private freight operations are fail-closed until PAYLOAD_OPERATIONS_TOKEN is configured.',
      remedy: 'Set a deployment secret and send it as a Bearer token.',
    }, { status: 503 });
  }
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) {
    return NextResponse.json({ error: 'operations_unauthorized' }, { status: 401 });
  }
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({
      error: 'operations_unauthorized',
      detail: 'The request did not carry the configured operations authority.',
      remedy: 'Authenticate as an authorized Terminal operator.',
    }, { status: 401 });
  }
  return null;
}

/** Dedicated machine authority for OTLP sensor ingestion; operator tokens are not sensor credentials. */
export function authorizeTelemetrySurface(req: Request): NextResponse | null {
  const expected = env('PAYLOAD_TELEMETRY_TOKEN');
  if (!expected?.trim()) {
    return NextResponse.json({
      error: 'telemetry_not_configured',
      detail: 'Project telemetry ingestion is fail-closed until PAYLOAD_TELEMETRY_TOKEN is configured.',
      remedy: 'Set a dedicated machine secret and send it as an OTLP Bearer token.',
    }, { status: 503 });
  }
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return NextResponse.json({ error: 'telemetry_unauthorized' }, { status: 401 });
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    return NextResponse.json({
      error: 'telemetry_unauthorized',
      detail: 'The request did not carry the configured telemetry authority.',
      remedy: 'Authenticate the collector with the dedicated telemetry token.',
    }, { status: 401 });
  }
  return null;
}
