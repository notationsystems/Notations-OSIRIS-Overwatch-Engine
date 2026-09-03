import { NextResponse } from 'next/server';
import { authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { compileCorpusAgentContext, CorpusAgentContextError, parseCorpusEvidenceLevel } from '@/lib/economy/corpusAgentContext';
import { buildCorpusContextPackage, CorpusRetrievalError, planCorpusRetrieval, type CorpusRetrievalRequest } from '@/lib/economy/corpusRetrieval';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 128_000;

function owners() {
  try { return { corpus: physicalEconomyCorpus('query'), projection: corpusProjectionStore(), error: null }; }
  catch (error) { return { corpus: null, projection: null, error: error instanceof Error ? error.message : 'Corpus integrity could not be established.' }; }
}
export async function POST(request: Request) {
  const denied = authorizeCorpusQuery(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_INPUT_INVALID', detail: `Request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_INPUT_INVALID', detail: 'Expected a bounded corpus retrieval request.' }, { status: 400 });
  const value = body as CorpusRetrievalRequest & { mode?: unknown; evidenceLevel?: unknown };
  if (value.mode !== undefined && value.mode !== 'plan' && value.mode !== 'context' && value.mode !== 'agent') return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_INPUT_INVALID', detail: 'mode must be plan, context, or agent.' }, { status: 400 });
  if (value.mode !== 'agent' && value.evidenceLevel !== undefined) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_EVIDENCE_LEVEL_INVALID', detail: 'evidenceLevel is valid only when mode is agent.' }, { status: 400 });
  let evidenceLevel;
  try { evidenceLevel = value.mode === 'agent' ? parseCorpusEvidenceLevel(value.evidenceLevel) : undefined; }
  catch (error) { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_EVIDENCE_LEVEL_INVALID', detail: error instanceof Error ? error.message : 'Evidence level is invalid.' }, { status: 400 }); }
  const owned = owners();
  if (!owned.corpus || !owned.projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_CONFIGURED', detail: owned.error ?? 'Canonical corpus or compiled read model is unavailable.', remedy: 'Configure both corpus paths, ingest classified records, and compile the public projection.' }, { status: 503 });
  try {
    const projection = owned.projection.loadPublic();
    if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'No public projection has been compiled.', remedy: 'Run the authenticated public/global compiler first.' }, { status: 503 });
    const current = await owned.corpus.projectionSource('global');
    if (!projectionMatchesSource(projection.manifest, current)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: `Projection ends at canonical sequence ${projection.manifest.sourceSequence}; canonical global state ends at ${current.sourceSequence}.`, remedy: 'Recompile before producing model context.' }, { status: 503 });
    const plan = planCorpusRetrieval(projection, value);
    if (value.mode === 'plan') return NextResponse.json({ kind: 'corpus_retrieval_plan', plan }, { headers: { 'Cache-Control': 'private, no-store' } });
    const context = buildCorpusContextPackage(projection, plan);
    if (value.mode === 'agent') {
      const agentContext = compileCorpusAgentContext(projection, plan, context, evidenceLevel!);
      return NextResponse.json({ kind: 'corpus_agent_context', plan, agentContext }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    return NextResponse.json({ kind: 'corpus_context', plan, context }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof CorpusAgentContextError) return NextResponse.json({ kind: 'refusal', code: error.code, detail: error.message, remedy: 'Use a supported evidence budget against one current policy-filtered CorpusBuild.' }, { status: 400 });
    if (error instanceof CorpusRetrievalError) {
      const status = error.code === 'CORPUS_ENTITY_UNRESOLVED' ? 404 : error.code === 'CORPUS_PROJECTION_TIME_UNAVAILABLE' ? 409 : 400;
      return NextResponse.json({ kind: 'refusal', code: error.code, detail: error.message, remedy: error.code === 'CORPUS_PROJECTION_TIME_UNAVAILABLE' ? 'Compile and address a versioned historical projection for that knowledge time.' : 'Use canonical IDs, bounded traversal, ISO times, and limits accepted by the retrieval contract.' }, { status });
    }
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_RETRIEVAL_FAILED', detail: error instanceof Error ? error.message : 'Context compilation failed.', remedy: 'Verify the canonical ledger and rebuild the disposable projection.' }, { status: 503 });
  }
}
