import { NextResponse } from 'next/server';
import { authorizeCorpusCompilation, authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import type { CorpusKnowledgeIndexSearchRequest } from '@/lib/economy/corpusKnowledgeIndex';
import { corpusKnowledgeIndexStore } from '@/lib/economy/corpusKnowledgeIndexRuntime';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { awaitCorpus } from '@/lib/economy/corpusRepository';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 4_096;
const BODY_KEYS = new Set(['builtAt']);

function owners(capability: 'query' | 'compiler') {
  try {
    return { corpus: physicalEconomyCorpus(capability), projection: corpusProjectionStore(), index: corpusKnowledgeIndexStore(), error: null };
  } catch {
    return { corpus: null, projection: null, index: null, error: 'A corpus index dependency failed its integrity or configuration check.' };
  }
}

function list(value: string | null): string[] | undefined {
  if (!value) return undefined;
  return [...new Set(value.split(',').map(entry => entry.trim()).filter(Boolean))].sort();
}

async function current(owned: ReturnType<typeof owners>) {
  if (!owned.corpus || !owned.projection || !owned.index) return { refusal: NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_NOT_CONFIGURED', detail: owned.error ?? 'Canonical corpus, public projection, or index storage is not configured.', remedy: 'Configure the corpus database, public read model, and PAYLOAD_CORPUS_INDEX_PATH.' }, { status: 503 }) };
  const projection = owned.projection.loadPublic();
  if (!projection) return { refusal: NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'No public CorpusBuild is available to index.', remedy: 'Compile the public/global corpus projection first.' }, { status: 503 }) };
  const source = await awaitCorpus(owned.corpus.projectionSource('global'));
  if (!projectionMatchesSource(projection.manifest, source)) return { refusal: NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: 'The public projection does not represent current canonical global state.', remedy: 'Recompile the public CorpusBuild before rebuilding or querying its index.' }, { status: 503 }) };
  return { projection, index: owned.index };
}

export async function GET(request: Request) {
  const denied = authorizeCorpusQuery(request); if (denied) return denied;
  try {
    const state = await current(owners('query'));
    if ('refusal' in state) return state.refusal;
    const indexed = state.index.load();
    if (!indexed) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_NOT_BUILT', detail: 'No knowledge index has been built for the current corpus.', remedy: 'Use compiler authority to build the index from the current public CorpusBuild.' }, { status: 503 });
    if (indexed.manifest.projectionDigest !== state.projection.manifest.projectionDigest || indexed.manifest.corpusBuildId !== state.projection.manifest.corpusBuildId) {
      return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_STALE', detail: 'The knowledge index belongs to a different public CorpusBuild.', remedy: 'Rebuild the index from the current projection; never merge index generations.' }, { status: 503 });
    }
    const params = new URL(request.url).searchParams;
    const view = params.get('view');
    if (view === 'manifest') return NextResponse.json({ kind: 'corpus_knowledge_index_manifest', manifest: indexed.manifest }, { headers: { 'Cache-Control': 'private, no-store' } });
    if (view === 'coverage') return NextResponse.json({ kind: 'corpus_knowledge_index_coverage', indexId: indexed.manifest.indexId, corpusBuildId: indexed.manifest.corpusBuildId, projectionDigest: indexed.manifest.projectionDigest, coverage: indexed.manifest.coverage, limitations: indexed.manifest.limitations }, { headers: { 'Cache-Control': 'private, no-store' } });
    if (view && view !== 'search') return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_QUERY_INVALID', detail: 'view must be search, manifest, or coverage.' }, { status: 400 });
    const bboxValues = ['west', 'south', 'east', 'north'].map(name => params.get(name));
    const someBbox = bboxValues.some(value => value !== null);
    const allBbox = bboxValues.every(value => value !== null);
    if (someBbox && !allBbox) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_QUERY_INVALID', detail: 'Spatial filtering requires west, south, east, and north together.' }, { status: 400 });
    const searchRequest: CorpusKnowledgeIndexSearchRequest = {
      query: params.get('q') ?? '',
      ...(list(params.get('recordTypes')) ? { recordTypes: list(params.get('recordTypes')) as CorpusKnowledgeIndexSearchRequest['recordTypes'] } : {}),
      ...(list(params.get('entityKinds')) ? { entityKinds: list(params.get('entityKinds')) as CorpusKnowledgeIndexSearchRequest['entityKinds'] } : {}),
      ...(list(params.get('predicates')) ? { predicates: list(params.get('predicates')) as CorpusKnowledgeIndexSearchRequest['predicates'] } : {}),
      ...(list(params.get('sourceIds')) ? { sourceIds: list(params.get('sourceIds')) } : {}),
      ...(params.get('asOf') ? { asOf: params.get('asOf')! } : {}),
      ...(params.get('knownAt') ? { knownAt: params.get('knownAt')! } : {}),
      ...(allBbox ? { bbox: { west: Number(bboxValues[0]), south: Number(bboxValues[1]), east: Number(bboxValues[2]), north: Number(bboxValues[3]) } } : {}),
      ...(params.get('limit') ? { limit: Number(params.get('limit')) } : {}),
    };
    return NextResponse.json(state.index.search(searchRequest), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Index query failed.';
    const invalid = detail.startsWith('CORPUS_INDEX_QUERY_INVALID');
    return NextResponse.json({ kind: 'refusal', code: invalid ? 'CORPUS_INDEX_QUERY_INVALID' : 'CORPUS_INDEX_UNAVAILABLE', detail, remedy: invalid ? 'Use a bounded lexical query and valid physical-economy facets, time boundaries, and bounding box.' : 'Restore or rebuild the disposable index from the exact current public CorpusBuild.' }, { status: invalid ? 400 : 503 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusCompilation(request); if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_INPUT_INVALID', detail: `Index request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown = {};
  try { body = text.trim() ? JSON.parse(text) : {}; } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_INPUT_INVALID', detail: 'Expected only { builtAt? }.' }, { status: 400 });
  const builtAt = (body as { builtAt?: unknown }).builtAt;
  if (builtAt !== undefined && (typeof builtAt !== 'string' || !Number.isFinite(Date.parse(builtAt)))) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_INPUT_INVALID', detail: 'builtAt must be an ISO date-time.' }, { status: 400 });
  try {
    const state = await current(owners('compiler'));
    if ('refusal' in state) return state.refusal;
    const stored = state.index.replace(state.projection, typeof builtAt === 'string' ? builtAt : new Date().toISOString());
    return NextResponse.json(stored, { status: stored.idempotent ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_INDEX_BUILD_FAILED', detail: error instanceof Error ? error.message : 'Index build failed.', remedy: 'Verify the current public CorpusBuild and restore or rebuild the disposable index store.' }, { status: 503 });
  }
}
