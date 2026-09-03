import { NextResponse } from 'next/server';
import { authorizeCorpusCompilation } from '@/lib/economy/corpusHttpAuth';
import { compilePublicProjectionFromRepository } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 8_192;

function owners() {
  try {
    return { corpus: physicalEconomyCorpus('compiler'), projection: corpusProjectionStore(), error: null };
  } catch (error) {
    return { corpus: null, projection: null, error: error instanceof Error ? error.message : 'Corpus or projection integrity could not be established.' };
  }
}

export async function GET(request: Request) {
  const denied = authorizeCorpusCompilation(request);
  if (denied) return denied;
  const owned = owners();
  if (!owned.projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_CONFIGURED', detail: owned.error ?? 'No corpus read-model database is configured.', remedy: 'Set PAYLOAD_CORPUS_READ_MODEL_PATH to a disposable, persistent SQLite path.' }, { status: 503 });
  try {
    const projection = owned.projection.loadPublic();
    if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'The public global projection has not been compiled.', remedy: 'POST the public/global compiler request after canonical ingestion.' }, { status: 404 });
    return NextResponse.json({ kind: projection.kind, manifest: projection.manifest }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_CORRUPT', detail: error instanceof Error ? error.message : 'Projection integrity failed.', remedy: 'Delete only the derived read model and rebuild it from verified canonical state.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusCompilation(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID', detail: `Compiler request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID', detail: 'Expected { audience: "public", scope: "global", knowledgeCutoff? }.' }, { status: 400 });
  const value = body as { audience?: unknown; scope?: unknown; knowledgeCutoff?: unknown };
  if (value.audience !== 'public' || value.scope !== 'global' || (value.knowledgeCutoff !== undefined && (typeof value.knowledgeCutoff !== 'string' || !Number.isFinite(Date.parse(value.knowledgeCutoff))))) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_INPUT_INVALID', detail: 'V0 compiles only audience=public, scope=global, with an optional ISO knowledgeCutoff.', remedy: 'Private overlays require an authenticated tenant-specific projection and are not exposed by this compiler.' }, { status: 400 });
  }
  const owned = owners();
  if (!owned.corpus || !owned.projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_UNAVAILABLE', detail: owned.error ?? 'Canonical corpus or read-model storage is not configured.', remedy: 'Set PAYLOAD_CORPUS_DATABASE_PATH and PAYLOAD_CORPUS_READ_MODEL_PATH before compiling.' }, { status: 503 });
  try {
    const result = await compilePublicProjectionFromRepository(owned.corpus, owned.projection, value.knowledgeCutoff as string | undefined);
    return NextResponse.json(result, { status: result.idempotent ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_FAILED', detail: error instanceof Error ? error.message : 'Corpus compilation failed.', remedy: 'Verify canonical integrity and classifications, then rebuild the disposable read model.' }, { status: 503 });
  }
}
