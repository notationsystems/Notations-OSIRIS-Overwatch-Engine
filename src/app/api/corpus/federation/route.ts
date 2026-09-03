import { NextResponse } from 'next/server';
import { authorizeCorpusProjectionWorker } from '@/lib/economy/corpusHttpAuth';
import { buildNotationCorpusSyncPage, notationFederationChannel, PAYLOAD_PUBLIC_FEDERATION_CHANNEL } from '@/lib/economy/notationCorpusFederation';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { awaitCorpus } from '@/lib/economy/corpusRepository';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY_BYTES = 8_192;
const CONSUMER = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const BODY_KEYS = new Set(['consumerId', 'sequence', 'corpusBuildId', 'projectionDigest', 'updatedAt']);

function owner() {
  try {
    return { corpus: physicalEconomyCorpus('projector'), projection: corpusProjectionStore(), error: null };
  } catch {
    return { corpus: null, projection: null, error: 'A federation dependency failed its integrity or configuration check.' };
  }
}

async function current(owned: ReturnType<typeof owner>) {
  if (!owned.corpus || !owned.projection) return { refusal: NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_NOT_CONFIGURED', detail: owned.error ?? 'Canonical corpus or public read model is not configured.', remedy: 'Configure the projector repository and public CorpusBuild before synchronizing.' }, { status: 503 }) };
  const projection = owned.projection.loadPublic();
  if (!projection) return { refusal: NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_PROJECTION_NOT_BUILT', detail: 'No public CorpusBuild is available for federation.', remedy: 'Compile the public/global projection first.' }, { status: 503 }) };
  const source = await awaitCorpus(owned.corpus.projectionSource('global'));
  if (!projectionMatchesSource(projection.manifest, source)) return { refusal: NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_PROJECTION_STALE', detail: 'The public projection does not represent current canonical state.', remedy: 'Compile and verify the current CorpusBuild before continuing synchronization.' }, { status: 503 }) };
  return { corpus: owned.corpus, projection };
}

function failure(error: unknown) {
  const detail = error instanceof Error ? error.message : 'Notation substrate synchronization failed.';
  if (detail.startsWith('CORPUS_PROJECTION_CHECKPOINT_REGRESSION')) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_CHECKPOINT_REGRESSION', detail, remedy: 'Advance consumer checkpoints monotonically; rebuild a separate consumer identity to replay from zero.' }, { status: 409 });
  if (detail.startsWith('NOTATION_SYNC_CURSOR_INVALID') || detail.startsWith('CORPUS_PROJECTION_CHECKPOINT_INVALID')) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail, remedy: 'Use a bounded cursor/page size and checkpoint only an exact current sync page.' }, { status: 400 });
  return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_UNAVAILABLE', detail, remedy: 'Restore the canonical repository and public projection, then resume from the last durable consumer checkpoint.' }, { status: 503 });
}

export async function GET(request: Request) {
  const denied = authorizeCorpusProjectionWorker(request); if (denied) return denied;
  try {
    const params = new URL(request.url).searchParams;
    const channel = notationFederationChannel(params.get('channel') ?? PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId);
    if (!channel) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_CHANNEL_INVALID', detail: 'The requested federation channel identity is invalid.' }, { status: 400 });
    if (channel.status !== 'READY') return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_CHANNEL_PROJECTION_NOT_CONFIGURED', detail: `${channel.channelId} has no separately governed projection.`, channel, remedy: 'Create a policy-filtered projection with the declared scope and entitlements; a public projector token cannot widen this channel.' }, { status: 503 });
    const state = await current(owner());
    if ('refusal' in state) return state.refusal;
    const page = buildNotationCorpusSyncPage(state.projection, {
      afterSequence: Number(params.get('afterSequence') ?? '0'),
      limit: Number(params.get('limit') ?? '100'),
    });
    return NextResponse.json(page, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusProjectionWorker(request); if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail: `Request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.has(key))) return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail: 'Expected only { consumerId, sequence, corpusBuildId, projectionDigest, updatedAt? }.' }, { status: 400 });
  const value = body as Record<string, unknown>;
  if (typeof value.consumerId !== 'string' || !CONSUMER.test(value.consumerId) || !Number.isSafeInteger(value.sequence) || typeof value.corpusBuildId !== 'string' || typeof value.projectionDigest !== 'string' || value.updatedAt !== undefined && (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)))) {
    return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_INPUT_INVALID', detail: 'Consumer identity, sequence, build identity, projection digest, or update time is invalid.' }, { status: 400 });
  }
  try {
    const state = await current(owner());
    if ('refusal' in state) return state.refusal;
    if (value.corpusBuildId !== state.projection.manifest.corpusBuildId || value.projectionDigest !== state.projection.manifest.projectionDigest || Number(value.sequence) > state.projection.manifest.sourceSequence) {
      return NextResponse.json({ kind: 'refusal', code: 'NOTATION_SYNC_BUILD_MISMATCH', detail: 'The checkpoint does not identify the exact current public CorpusBuild or exceeds its source sequence.', remedy: 'Checkpoint the build and sequence returned by the current federation page.' }, { status: 409 });
    }
    const checkpoint = await state.corpus.checkpointProjection({
      projector: `notation-sync:${value.consumerId}`,
      scope: 'global',
      sequence: Number(value.sequence),
      ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
    });
    return NextResponse.json({ kind: 'notation_corpus_sync_checkpoint', sourceNodeUri: 'notation://node/payload', consumerId: value.consumerId, corpusBuildId: value.corpusBuildId, projectionDigest: value.projectionDigest, checkpoint }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return failure(error);
  }
}
