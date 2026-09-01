import { NextResponse } from 'next/server';
import { authorizeOperationsSurface } from '../../../../lib/economy/operationsHttpAuth';
import { payloadEventDatabase } from '../../../../lib/economy/payloadEventDatabaseRuntime';
import type { PayloadEventStream } from '../../../../lib/economy/payloadEventDatabase';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = authorizeOperationsSurface(req);
  if (denied) return denied;
  const database = payloadEventDatabase();
  if (!database) {
    return NextResponse.json({
      kind: 'refusal',
      code: 'PAYLOAD_DATABASE_NOT_CONFIGURED',
      detail: 'PAYLOAD_DATABASE_PATH is not configured; the compatibility JSONL journals remain active.',
      remedy: 'Configure a persistent SQLite path and migrate the two existing journals before switching storage.',
    }, { status: 503 });
  }
  const url = new URL(req.url);
  const after = Number(url.searchParams.get('after') ?? '0');
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const operationId = url.searchParams.get('operationId')?.trim() || undefined;
  const rawStream = url.searchParams.get('stream')?.trim();
  const stream = rawStream === 'load_operation' || rawStream === 'carrier_communication' || rawStream === 'procurement'
    ? rawStream as PayloadEventStream
    : undefined;
  if (rawStream && !stream) {
    return NextResponse.json({
      kind: 'refusal', code: 'PAYLOAD_DATABASE_QUERY_INVALID',
      detail: `Unknown event stream ${rawStream}.`,
      remedy: 'Use load_operation, carrier_communication, or procurement.',
    }, { status: 400 });
  }
  try {
    return NextResponse.json({
      summary: database.summary(),
      page: database.queryEvents({ afterSequence: after, limit, operationId, stream }),
    });
  } catch (error) {
    const invalid = (error as Error).message.includes('QUERY_INVALID');
    return NextResponse.json({
      kind: 'refusal',
      code: invalid ? 'PAYLOAD_DATABASE_QUERY_INVALID' : 'PAYLOAD_DATABASE_UNAVAILABLE',
      detail: (error as Error).message,
      remedy: invalid ? 'Use a non-negative cursor and a page size from 1 to 500.' : 'Stop writes and run SQLite integrity checks before restoring service.',
    }, { status: invalid ? 400 : 503 });
  }
}
