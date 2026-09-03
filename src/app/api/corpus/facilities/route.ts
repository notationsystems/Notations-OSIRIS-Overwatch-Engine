import { NextResponse } from 'next/server';
import { buildFacilityAnswerWarrant, publicCorpusBuildReference } from '@/lib/economy/corpusAnswer';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
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
 * Public, read-only query over a compiled global read model.
 *
 * Customer scope is intentionally not a query parameter. A shared public route
 * must be unable—not merely instructed not—to compose a customer's private
 * records into its answer. It never reads canonical tables directly.
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
  let store;
  try { corpus = physicalEconomyCorpus('query'); store = corpusProjectionStore(); }
  catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CORRUPT', detail: error instanceof Error ? error.message : 'Corpus read-model integrity could not be established.', remedy: 'Rebuild the disposable projection from verified canonical state.' }, { status: 503 });
  }
  if (!corpus || !store) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_CONFIGURED', detail: 'Canonical corpus or public read-model storage is not configured.', remedy: 'Set PAYLOAD_CORPUS_DATABASE_PATH and PAYLOAD_CORPUS_READ_MODEL_PATH, ingest classified records, then compile the public projection.' }, { status: 503 });
  }
  let projection;
  try { projection = store.loadPublic(); }
  catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CORRUPT', detail: error instanceof Error ? error.message : 'Corpus read-model integrity could not be established.', remedy: 'Delete only the derived read model and rebuild it from verified canonical state.' }, { status: 503 });
  }
  if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'The public global read model has not been compiled.', remedy: 'Run the authenticated public/global corpus compiler after ingestion.' }, { status: 503 });
  let current;
  try { current = await corpus.projectionSource('global'); }
  catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_UNAVAILABLE', detail: error instanceof Error ? error.message : 'Canonical corpus integrity could not be established.', remedy: 'Restore canonical state from a verified backup before serving projections.' }, { status: 503 });
  }
  if (!projectionMatchesSource(projection.manifest, current)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: `Public projection ends at canonical sequence ${projection.manifest.sourceSequence}; canonical global state now ends at ${current.sourceSequence}.`, remedy: 'Recompile the public/global projection before returning corpus answers.' }, { status: 503 });
  if (knowledgeCutoff && Date.parse(knowledgeCutoff) !== Date.parse(projection.manifest.knowledgeCutoff)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_TIME_UNAVAILABLE', detail: `The active public read model is pinned to ${projection.manifest.knowledgeCutoff}.`, remedy: 'Omit knowledgeCutoff or compile and address a versioned historical projection.' }, { status: 409 });
  const result = store.findFacilities(materialRef, asOf);
  if (result.kind === 'facility_discovery') {
    const answer = buildFacilityAnswerWarrant(materialRef, result, projection.records, projection.manifest);
    if (answer.kind === 'refusal') return NextResponse.json(answer, { status: 403, headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json({ ...result, query, interpretedAs: materialRef, warrant: answer.warrant }, { status: 200, headers: { 'Cache-Control': 'private, no-store' } });
  }
  return NextResponse.json({ ...result, query, interpretedAs: materialRef, warrant: { corpusBuild: publicCorpusBuildReference(projection.manifest) } }, {
    status: result.kind === 'refusal' ? statusFor(result.code) : 200,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
