import { NextResponse } from 'next/server';
import { authorizeCorpusMining } from '@/lib/economy/corpusHttpAuth';
import { mineSharedDependencies } from '@/lib/economy/corpusMining';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { patternRegistry } from '@/lib/economy/patternRegistryRuntime';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 8_192;
const BODY_KEYS = new Set(['entityId', 'depth', 'minimumDependents', 'executedAt']);

function owners() {
  try {
    return { corpus: physicalEconomyCorpus('query'), projection: corpusProjectionStore(), registry: patternRegistry(), error: null };
  } catch (error) {
    return { corpus: null, projection: null, registry: null, error: error instanceof Error ? error.message : 'Miner storage integrity could not be established.' };
  }
}

export async function GET(request: Request) {
  const denied = authorizeCorpusMining(request);
  if (denied) return denied;
  const owned = owners();
  if (!owned.registry) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINER_NOT_CONFIGURED', detail: owned.error ?? 'Pattern Registry storage is not configured.', remedy: 'Set PAYLOAD_CORPUS_PATTERN_REGISTRY_PATH to persistent storage controlled by the miner service.' }, { status: 503 });
  const { searchParams } = new URL(request.url);
  if (searchParams.get('view') === 'summary') return NextResponse.json(owned.registry.summary(), { headers: { 'Cache-Control': 'private, no-store' } });
  try {
    return NextResponse.json(owned.registry.page({ afterSequence: Number(searchParams.get('afterSequence') ?? '0'), limit: Number(searchParams.get('limit') ?? '100') }), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PATTERN_QUERY_INVALID', detail: error instanceof Error ? error.message : 'Pattern cursor is invalid.', remedy: 'Use a non-negative afterSequence and limit from 1 to 250.' }, { status: 400 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusMining(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_INPUT_INVALID', detail: `Mining request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_INPUT_INVALID', detail: 'Expected only { entityId?, depth?, minimumDependents?, executedAt? }.', remedy: 'Use depth=1 and minimumDependents from 2 to 100; mined candidates never accept canonical-write fields.' }, { status: 400 });
  const value = body as { entityId?: unknown; depth?: unknown; minimumDependents?: unknown; executedAt?: unknown };
  if ((value.entityId !== undefined && typeof value.entityId !== 'string') || (value.depth !== undefined && value.depth !== 1) || (value.minimumDependents !== undefined && (!Number.isSafeInteger(value.minimumDependents) || Number(value.minimumDependents) < 2 || Number(value.minimumDependents) > 100)) || (value.executedAt !== undefined && (typeof value.executedAt !== 'string' || !Number.isFinite(Date.parse(value.executedAt))))) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_INPUT_INVALID', detail: 'entityId, depth, minimumDependents, or executedAt is invalid.', remedy: 'Use a canonical entity ID, depth=1, an integer threshold from 2 to 100, and an ISO timestamp.' }, { status: 400 });
  }
  const owned = owners();
  if (!owned.corpus || !owned.projection || !owned.registry) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINER_UNAVAILABLE', detail: owned.error ?? 'Canonical, projection, or Pattern Registry storage is not configured.', remedy: 'Configure the canonical corpus, public read model, and miner registry before mining.' }, { status: 503 });
  try {
    const projection = owned.projection.loadPublic();
    if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'No public CorpusBuild is available to mine.', remedy: 'Compile the public/global representation before running the miner.' }, { status: 503 });
    const source = await owned.corpus.projectionSource('global');
    if (!projectionMatchesSource(projection.manifest, source)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: 'The active read model no longer represents current canonical global state.', remedy: 'Recompile the CorpusBuild before mining it.' }, { status: 503 });
    const result = mineSharedDependencies(projection, {
      ...(typeof value.entityId === 'string' ? { entityId: value.entityId } : {}),
      ...(value.depth === 1 ? { depth: 1 as const } : {}),
      ...(typeof value.minimumDependents === 'number' ? { minimumDependents: value.minimumDependents } : {}),
      ...(typeof value.executedAt === 'string' ? { executedAt: value.executedAt } : {}),
    });
    if (result.candidates.some(candidate => candidate.policy.effective.externalRelease !== 'PERMITTED')) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_OUTPUT_POLICY_DENIED', detail: 'At least one candidate is not authorized for emission.', remedy: 'Keep restricted candidates on an authorized internal surface.' }, { status: 403 });
    const stored = owned.registry.register(result);
    if (stored.kind === 'refusal') return NextResponse.json(stored, { status: stored.code === 'CORPUS_PATTERN_CONFLICT' ? 409 : 422 });
    return NextResponse.json(stored, { status: stored.idempotent ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_MINING_FAILED', detail: error instanceof Error ? error.message : 'Dependency mining failed.', remedy: 'Verify the CorpusBuild, policy labels, registry integrity, and typed mining parameters.' }, { status: 503 });
  }
}
