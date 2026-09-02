import { NextResponse } from 'next/server';
import { authorizeCorpusAdministration } from '@/lib/economy/corpusHttpAuth';
import type { CorpusRecordInput, CorpusScope } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 2_000_000;

function owner() {
  try { return { corpus: physicalEconomyCorpus(), error: null }; }
  catch (error) { return { corpus: null, error: error instanceof Error ? error.message : 'Corpus integrity could not be established.' }; }
}

export async function GET(request: Request) {
  const denied = authorizeCorpusAdministration(request);
  if (denied) return denied;
  const owned = owner();
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH before replay.' }, { status: 503 });
  const { searchParams } = new URL(request.url);
  if (searchParams.get('view') === 'summary') {
    const summary = owned.corpus.summary();
    return NextResponse.json({
      kind: summary.kind, durability: summary.durability,
      lastSequence: summary.lastSequence, records: summary.records,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  }
  const scope = (searchParams.get('scope') ?? 'global') as CorpusScope;
  const afterSequence = Number(searchParams.get('afterSequence') ?? '0');
  const limit = Number(searchParams.get('limit') ?? '100');
  const knowledgeCutoff = searchParams.get('knowledgeCutoff') ?? undefined;
  try {
    return NextResponse.json(owned.corpus.page({ scope, afterSequence, limit, knowledgeCutoff }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_QUERY_INVALID', detail: error instanceof Error ? error.message : 'Invalid corpus cursor.', remedy: 'Use an authorized scope, non-negative cursor, limit 1..500, and ISO knowledge cutoff.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusAdministration(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: `Batch exceeds ${MAX_BODY_BYTES} bytes.`, remedy: 'Archive raw artifacts outside the ledger and submit no more than 1000 typed records.' }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof (body as { scope?: unknown }).scope !== 'string' || !Array.isArray((body as { records?: unknown }).records)) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: 'Expected { scope, records[], recordedAt? }.', remedy: 'Submit canonical payload.corpus.record.v1 records in evidence-before-claim order.' }, { status: 400 });
  }
  const owned = owner();
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH before ingestion.' }, { status: 503 });
  const value = body as { scope: CorpusScope; records: CorpusRecordInput[]; recordedAt?: string };
  try {
    const result = owned.corpus.append(value.scope, value.records, value.recordedAt);
    if (result.kind === 'committed') return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
    const status = result.code === 'CORPUS_RECORD_CONFLICT' || result.code === 'CORPUS_REVISION_INVALID' ? 409 : 422;
    return NextResponse.json(result, { status });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INPUT_INVALID', detail: error instanceof Error ? error.message : 'Record validation failed.', remedy: 'Correct the typed record; malformed input is never partially appended.' }, { status: 400 });
  }
}
