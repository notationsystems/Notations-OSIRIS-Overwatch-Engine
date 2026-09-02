import { NextResponse } from 'next/server';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/;

/** A deliberately small, deterministic intent grammar for the first Earth query. */
export function materialFromFacilityQuery(query: string): string {
  const trimmed = query.trim();
  const intent = trimmed.match(/^(.+?)\s+(?:production|producers?|manufacturing|facilit(?:y|ies))$/i);
  return (intent?.[1] ?? trimmed).trim();
}

function statusFor(code: string): number {
  if (code === 'MATERIAL_AMBIGUOUS') return 409;
  if (code === 'MATERIAL_UNRESOLVED' || code === 'NO_EVIDENCED_FACILITIES') return 404;
  return 422;
}

/**
 * Public, read-only projection of the global corpus.
 *
 * Customer scope is intentionally not a query parameter. A shared public route
 * must be unable—not merely instructed not—to compose a customer's private
 * records into its answer.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const query = (searchParams.get('q') ?? '').trim();
  const asOf = searchParams.get('asOf') ?? undefined;
  const knowledgeCutoff = searchParams.get('knowledgeCutoff') ?? undefined;
  if (query.length < 2 || query.length > 160) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_QUERY_INVALID', detail: 'q must contain 2..160 characters.', remedy: 'Ask for a material or use “<material> production”.' }, { status: 400 });
  }
  if ((asOf && !DATE.test(asOf)) || (knowledgeCutoff && !DATE.test(knowledgeCutoff))) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_QUERY_INVALID', detail: 'asOf and knowledgeCutoff must be ISO-8601 UTC dates.', remedy: 'Use YYYY-MM-DD or an ISO UTC timestamp.' }, { status: 400 });
  }
  const materialRef = materialFromFacilityQuery(query);
  let corpus;
  try { corpus = physicalEconomyCorpus(); }
  catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: error instanceof Error ? error.message : 'Corpus integrity could not be established.', remedy: 'Restore the corpus from a verified backup before serving queries.' }, { status: 503 });
  }
  if (!corpus) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_NOT_CONFIGURED', detail: 'No physical-economy corpus database is configured.', remedy: 'Set PAYLOAD_CORPUS_DATABASE_PATH or PAYLOAD_DATABASE_PATH and ingest evidence-linked corpus records.' }, { status: 503 });
  }
  const result = corpus.findFacilities(materialRef, { scope: 'global', asOf, knowledgeCutoff });
  return NextResponse.json({ ...result, query, interpretedAs: materialRef }, {
    status: result.kind === 'refusal' ? statusFor(result.code) : 200,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
