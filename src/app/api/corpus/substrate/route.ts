import { NextResponse } from 'next/server';
import { authorizeCorpusProjectionWorker, authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import { notationSubstrateStore } from '@/lib/economy/notationSubstrateRuntime';
import type { NotationVectorProjectionInput } from '@/lib/economy/notationSubstrate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 262_144;

function owner() {
  try { return { store: notationSubstrateStore(), error: null }; }
  catch { return { store: null, error: 'The substrate store failed its integrity or configuration check.' }; }
}

function unavailable(error: string | null) {
  return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_NOT_CONFIGURED', detail: error ?? 'No Notation substrate database is configured.', remedy: 'Configure PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH on persistent storage and run the substrate sync worker.' }, { status: 503 });
}

function queryFailure(error: unknown) {
  const detail = error instanceof Error ? error.message : 'Substrate query failed.';
  const invalid = detail.startsWith('NOTATION_SUBSTRATE_QUERY_INVALID') || detail.startsWith('NOTATION_VECTOR_QUERY_INVALID');
  return NextResponse.json({ kind: 'refusal', code: invalid ? detail.split(':')[0] : 'NOTATION_SUBSTRATE_UNAVAILABLE', detail }, { status: invalid ? 400 : 503 });
}

export async function GET(request: Request) {
  const denied = authorizeCorpusQuery(request); if (denied) return denied;
  const owned = owner(); if (!owned.store) return unavailable(owned.error);
  const params = new URL(request.url).searchParams;
  const view = params.get('view') ?? 'status';
  try {
    if (view === 'status') return NextResponse.json(owned.store.status(), { headers: { 'Cache-Control': 'private, no-store' } });
    if (view === 'acknowledgements') return NextResponse.json({ kind: 'notation_substrate_acknowledgement_page', acknowledgements: owned.store.acknowledgements({ afterSequence: Number(params.get('afterSequence') ?? '0'), limit: Number(params.get('limit') ?? '100') }) }, { headers: { 'Cache-Control': 'private, no-store' } });
    if (view === 'lag') return NextResponse.json({ kind: 'notation_substrate_lag_page', samples: owned.store.lagSamples({ ...(params.get('channelId') ? { channelId: params.get('channelId')! } : {}), limit: Number(params.get('limit') ?? '100') }) }, { headers: { 'Cache-Control': 'private, no-store' } });
    if (view === 'semantic-documents') return NextResponse.json({ kind: 'notation_semantic_document_page', documents: owned.store.semanticDocuments({ ...(params.get('afterKnownAt') ? { afterKnownAt: params.get('afterKnownAt')! } : {}), ...(params.get('withoutModelId') ? { withoutModelId: params.get('withoutModelId')! } : {}), ...(params.get('withoutModelVersion') ? { withoutModelVersion: params.get('withoutModelVersion')! } : {}), limit: Number(params.get('limit') ?? '100') }) }, { headers: { 'Cache-Control': 'private, no-store' } });
    return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_QUERY_INVALID', detail: 'view must be status, acknowledgements, lag, or semantic-documents.' }, { status: 400 });
  } catch (error) { return queryFailure(error); }
}

export async function POST(request: Request) {
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_INPUT_INVALID', detail: `Request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_INPUT_INVALID', detail: 'Expected a discriminated substrate action.' }, { status: 400 });
  const value = body as Record<string, unknown>;
  const action = value.action;
  const denied = action === 'put_vector' ? authorizeCorpusProjectionWorker(request) : authorizeCorpusQuery(request);
  if (denied) return denied;
  const owned = owner(); if (!owned.store) return unavailable(owned.error);
  try {
    if (action === 'put_vector') {
      const allowed = new Set(['action', 'documentUri', 'documentHash', 'modelId', 'modelVersion', 'values', 'generatedAt']);
      if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('NOTATION_VECTOR_INPUT_INVALID: unknown input field');
      const projection = owned.store.putVector(value as unknown as NotationVectorProjectionInput);
      return NextResponse.json(projection, { status: projection.idempotent ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
    }
    if (action === 'vector_search') {
      const allowed = new Set(['action', 'modelId', 'modelVersion', 'values', 'limit']);
      if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('NOTATION_VECTOR_QUERY_INVALID: unknown input field');
      return NextResponse.json(owned.store.vectorSearch({ modelId: value.modelId as string, modelVersion: value.modelVersion as string, values: value.values as readonly number[], limit: value.limit as number | undefined }), { headers: { 'Cache-Control': 'private, no-store' } });
    }
    return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SUBSTRATE_INPUT_INVALID', detail: 'action must be put_vector or vector_search.' }, { status: 400 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Substrate operation failed.';
    const conflict = detail.startsWith('NOTATION_VECTOR_CONFLICT');
    const invalid = detail.startsWith('NOTATION_VECTOR_INPUT_INVALID') || detail.startsWith('NOTATION_VECTOR_QUERY_INVALID') || detail.startsWith('NOTATION_VECTOR_DOCUMENT_MISMATCH');
    return NextResponse.json({ kind: 'refusal', code: detail.split(':')[0], detail }, { status: conflict ? 409 : invalid ? 400 : 503 });
  }
}
