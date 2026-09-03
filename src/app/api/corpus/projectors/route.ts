import { NextResponse } from 'next/server';
import { authorizeCorpusProjectionWorker } from '@/lib/economy/corpusHttpAuth';
import type { CorpusScope } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 16_384;

function owner() {
  try { return { corpus: physicalEconomyCorpus('projector'), error: null }; }
  catch (error) { return { corpus: null, error: error instanceof Error ? error.message : 'Corpus integrity could not be established.' }; }
}

function projectorFailure(error: unknown, operation: 'cursor' | 'checkpoint') {
  const detail = error instanceof Error ? error.message : `Projection ${operation} failed.`;
  if (detail.startsWith('CORPUS_TENANT_SCOPE_DENIED')) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_SCOPE_DENIED', detail, remedy: 'Use projector credentials bound to the requested tenant.' }, { status: 403 });
  }
  if (detail.startsWith('CORPUS_PROJECTION_CHECKPOINT_REGRESSION')) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CHECKPOINT_REGRESSION', detail, remedy: 'Advance only to a visible outbox sequence already processed by this projector.' }, { status: 409 });
  }
  const invalidCode = operation === 'cursor' ? 'CORPUS_PROJECTION_CURSOR_INVALID' : 'CORPUS_PROJECTION_CHECKPOINT_INVALID';
  if (detail.startsWith(invalidCode) || detail.startsWith('CORPUS_SCOPE_INVALID')) {
    return NextResponse.json({ kind: 'refusal', code: invalidCode, detail, remedy: operation === 'cursor' ? 'Use global or one authorized customer scope, a non-negative cursor, and limit 1..500.' : 'Advance only to a visible outbox sequence already processed by this projector.' }, { status: 400 });
  }
  return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail, remedy: 'Restore the projector repository connection and confirm the pinned PostgreSQL/PostGIS migration.' }, { status: 503 });
}

export async function GET(request: Request) {
  const denied = authorizeCorpusProjectionWorker(request);
  if (denied) return denied;
  const owned = owner();
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH.' }, { status: 503 });
  const { searchParams } = new URL(request.url);
  try {
    const events = await owned.corpus.readProjectionEvents({
      scope: (searchParams.get('scope') ?? 'global') as CorpusScope,
      afterSequence: Number(searchParams.get('afterSequence') ?? '0'),
      limit: Number(searchParams.get('limit') ?? '100'),
    });
    return NextResponse.json(events, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return projectorFailure(error, 'cursor');
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusProjectionWorker(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CHECKPOINT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CHECKPOINT_INVALID', detail: `Request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CHECKPOINT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CHECKPOINT_INVALID', detail: 'Expected { projector, scope?, sequence, updatedAt? }.' }, { status: 400 });
  const value = body as { projector?: unknown; scope?: unknown; sequence?: unknown; updatedAt?: unknown };
  const owned = owner();
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH.' }, { status: 503 });
  try {
    return NextResponse.json(await owned.corpus.checkpointProjection({
      projector: value.projector as string,
      scope: value.scope as CorpusScope | undefined,
      sequence: value.sequence as number,
      updatedAt: value.updatedAt as string | undefined,
    }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return projectorFailure(error, 'checkpoint');
  }
}
