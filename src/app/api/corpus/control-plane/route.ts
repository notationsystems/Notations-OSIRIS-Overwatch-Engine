import { NextResponse } from 'next/server';
import { corpusAgentArtifactStore } from '@/lib/economy/corpusAgentArtifactRuntime';
import type { CorpusAgentArtifactPage, StoredCorpusAgentArtifact } from '@/lib/economy/corpusAgentArtifacts';
import { authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import { buildPayloadCorpusControlPlane } from '@/lib/economy/payloadCorpusControlPlane';
import { projectionMatchesSource, type CompiledCorpusProjection } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { awaitCorpus } from '@/lib/economy/corpusRepository';
import { env } from '@/lib/economy/envCompat';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import type { CorpusProjectionSource } from '@/lib/economy/physicalEconomyCorpus';
import { payloadSp1ProgramIdentity } from '@/lib/economy/sp1ProgramIdentity';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMPTY_PAGE: CorpusAgentArtifactPage = Object.freeze({
  kind: 'corpus_agent_artifact_page',
  scope: 'global',
  afterSequence: 0,
  nextAfterSequence: 0,
  hasMore: false,
  artifacts: [],
});

function integer(value: string | null, fallback: number, minimum: number, maximum: number): number | null {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function staleAfterMs(): number | null {
  const configured = env('PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS')?.trim();
  return integer(configured ?? null, 86_400_000, 60_000, 31_536_000_000);
}

export async function GET(req: Request) {
  const denied = authorizeCorpusQuery(req); if (denied) return denied;
  const url = new URL(req.url);
  const afterSequence = integer(url.searchParams.get('afterSequence'), 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(url.searchParams.get('limit'), 100, 1, 500);
  const freshness = staleAfterMs();
  if (afterSequence === null || limit === null || freshness === null) {
    return NextResponse.json({
      kind: 'refusal',
      code: 'PAYLOAD_CONTROL_PLANE_QUERY_INVALID',
      detail: 'Timeline cursor, page limit, or projection freshness policy is invalid.',
      remedy: 'Use an integer afterSequence >= 0, limit from 1 to 500, and PAYLOAD_CORPUS_CONTROL_STALE_AFTER_MS from 60000 to 31536000000.',
    }, { status: 422, headers: { 'Cache-Control': 'private, no-store' } });
  }

  const generatedAt = new Date().toISOString();
  const faults: { component: 'canonical' | 'projection' | 'artifacts'; code: string }[] = [];
  let canonical: { backend: 'sqlite' | 'postgresql'; source: CorpusProjectionSource } | null = null;
  let projection: CompiledCorpusProjection | null = null;
  let artifactBackend: 'sqlite' | 'postgresql' | null = null;
  let artifactPage: CorpusAgentArtifactPage = { ...EMPTY_PAGE, afterSequence, nextAfterSequence: afterSequence };
  let recentArtifacts: readonly StoredCorpusAgentArtifact[] = [];
  let currentBuildAttestation: StoredCorpusAgentArtifact | null = null;

  try {
    const repository = physicalEconomyCorpus('query');
    if (!repository) faults.push({ component: 'canonical', code: 'CORPUS_DATABASE_NOT_CONFIGURED' });
    else canonical = { backend: repository.backend, source: await awaitCorpus(repository.projectionSource('global', generatedAt)) };
  } catch {
    faults.push({ component: 'canonical', code: 'CORPUS_DATABASE_UNAVAILABLE' });
  }

  try {
    const store = corpusProjectionStore();
    if (!store) faults.push({ component: 'projection', code: 'CORPUS_PROJECTION_NOT_CONFIGURED' });
    else {
      projection = store.loadPublic();
      if (!projection) faults.push({ component: 'projection', code: 'CORPUS_PROJECTION_NOT_COMPILED' });
    }
  } catch {
    faults.push({ component: 'projection', code: 'CORPUS_PROJECTION_UNAVAILABLE' });
  }

  try {
    const store = corpusAgentArtifactStore('query');
    if (!store) faults.push({ component: 'artifacts', code: 'CORPUS_AGENT_ARTIFACT_STORE_NOT_CONFIGURED' });
    else {
      artifactBackend = store.backend;
      artifactPage = await store.page({ scope: 'global', afterSequence, limit });
      recentArtifacts = await store.recent({ scope: 'global', limit: 500 });
      if (projection) currentBuildAttestation = await store.latestBuildAttestation('global', projection.manifest.corpusBuildId);
    }
  } catch {
    faults.push({ component: 'artifacts', code: 'CORPUS_AGENT_ARTIFACT_STORE_UNAVAILABLE' });
  }

  const snapshot = buildPayloadCorpusControlPlane({
    generatedAt,
    projectionStaleAfterMs: freshness,
    canonical,
    projection,
    projectionCurrent: Boolean(canonical && projection && projectionMatchesSource(projection.manifest, canonical.source)),
    artifactBackend,
    artifactPage,
    recentArtifacts,
    currentBuildAttestation,
    sp1: payloadSp1ProgramIdentity(),
    faults,
  });
  return NextResponse.json(snapshot, { headers: { 'Cache-Control': 'private, no-store' } });
}
