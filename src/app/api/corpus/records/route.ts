import { NextResponse } from 'next/server';
import { buildCanonicalCorpusBatchFromRepository } from '@/lib/economy/corpusBuilder';
import { authorizeCorpusAdministration } from '@/lib/economy/corpusHttpAuth';
import type { CorpusRecordInput, CorpusScope } from '@/lib/economy/physicalEconomyCorpus';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 2_000_000;

function owner(capability: 'query' | 'ingest') {
  try { return { corpus: physicalEconomyCorpus(capability), error: null }; }
  catch (error) { return { corpus: null, error: error instanceof Error ? error.message : 'Corpus integrity could not be established.' }; }
}

function repositoryFailure(error: unknown, operation: 'query' | 'ingest') {
  const detail = error instanceof Error ? error.message : 'Corpus repository operation failed.';
  if (detail.startsWith('CORPUS_TENANT_SCOPE_DENIED') || detail.startsWith('CORPUS_GLOBAL_WRITE_DENIED')) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_SCOPE_DENIED', detail, remedy: 'Use credentials bound to the requested tenant and an explicitly authorized global writer for global ingestion.' }, { status: 403 });
  }
  const invalid = operation === 'query'
    ? detail.startsWith('CORPUS_QUERY_INVALID') || detail.startsWith('CORPUS_SCOPE_INVALID')
    : detail.startsWith('CORPUS_BUILDER_') || detail.startsWith('CORPUS_SCOPE_INVALID');
  if (invalid) return NextResponse.json({
    kind: 'refusal', code: operation === 'query' ? 'CORPUS_QUERY_INVALID' : 'CORPUS_INPUT_INVALID', detail,
    remedy: operation === 'query' ? 'Use an authorized scope, non-negative cursor, limit 1..500, and ISO knowledge cutoff.' : 'Correct the typed record; malformed input is never partially appended.',
  }, { status: 400 });
  return NextResponse.json({
    kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail,
    remedy: 'Restore the repository connection and confirm the pinned PostgreSQL/PostGIS migration before retrying.',
  }, { status: 503 });
}

export async function GET(request: Request) {
  const denied = authorizeCorpusAdministration(request);
  if (denied) return denied;
  const owned = owner('query');
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH before replay.' }, { status: 503 });
  const { searchParams } = new URL(request.url);
  try {
    if (searchParams.get('view') === 'summary') {
      const summary = await owned.corpus.summary();
      return NextResponse.json({
        kind: summary.kind, durability: summary.durability,
        lastSequence: summary.lastSequence, records: summary.records,
      }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const scope = (searchParams.get('scope') ?? 'global') as CorpusScope;
    const afterSequence = Number(searchParams.get('afterSequence') ?? '0');
    const limit = Number(searchParams.get('limit') ?? '100');
    const knowledgeCutoff = searchParams.get('knowledgeCutoff') ?? undefined;
    return NextResponse.json(await owned.corpus.page({ scope, afterSequence, limit, knowledgeCutoff }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return repositoryFailure(error, 'query');
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
  const owned = owner('ingest');
  if (!owned.corpus) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: owned.error ?? 'No corpus database is configured.', remedy: 'Configure or restore PAYLOAD_CORPUS_DATABASE_PATH before ingestion.' }, { status: 503 });
  const value = body as { scope: CorpusScope; records: CorpusRecordInput[]; recordedAt?: string };
  try {
    const result = await buildCanonicalCorpusBatchFromRepository(owned.corpus, value.scope, value.records, value.recordedAt);
    if (result.kind === 'committed') return NextResponse.json(result, { status: result.idempotent ? 200 : 201 });
    const status = result.code === 'CORPUS_RECORD_CONFLICT' || result.code === 'CORPUS_REVISION_INVALID' ? 409 : 422;
    return NextResponse.json(result, { status });
  } catch (error) {
    return repositoryFailure(error, 'ingest');
  }
}
