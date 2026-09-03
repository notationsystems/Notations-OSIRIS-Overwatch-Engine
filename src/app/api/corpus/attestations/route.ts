import { NextResponse } from 'next/server';
import { corpusAgentArtifactStore } from '@/lib/economy/corpusAgentArtifactRuntime';
import { loadCorpusAttestationSigner, signCorpusBuildAttestation } from '@/lib/economy/corpusBuildAttestation';
import { authorizeCorpusCompilation, authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { buildCorpusCommitment } from '@/lib/economy/corpusVerification';
import { payloadSp1ProgramIdentity } from '@/lib/economy/sp1ProgramIdentity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
const MAX_BODY_BYTES = 8_192;

function sp1Capability() {
  const identity = payloadSp1ProgramIdentity();
  return {
    programId: identity.program,
    status: 'CEREMONIALLY_PINNED' as const,
    verificationKey: identity.verificationKey,
    sp1Version: identity.sp1Version,
    proofScope: 'authorized_operational_event_batches' as const,
    appliesToCorpusBuildAttestation: false as const,
    sourceCommit: identity.ceremony.sourceCommit,
    ceremonyRunUrl: identity.ceremony.runUrl,
  };
}

export async function GET(request: Request) {
  const denied = authorizeCorpusQuery(request);
  if (denied) return denied;
  const corpusBuildId = new URL(request.url).searchParams.get('corpusBuildId')?.trim();
  if (!corpusBuildId) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: 'corpusBuildId is required.' }, { status: 400 });
  let store;
  try { store = corpusAgentArtifactStore('query'); }
  catch (error) { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_STORE_UNAVAILABLE', detail: error instanceof Error ? error.message : 'Attestation store initialization failed.' }, { status: 503 }); }
  if (!store) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_STORE_UNAVAILABLE', detail: 'Persistent corpus artifact storage is not configured.' }, { status: 503 });
  try {
    const artifact = await store.latestBuildAttestation('global', corpusBuildId);
    if (!artifact || artifact.artifactType !== 'build_attestation') return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_NOT_FOUND', detail: `CorpusBuild ${corpusBuildId} has no visible signed attestation.`, zkPrograms: [sp1Capability()] }, { status: 404 });
    return NextResponse.json({ kind: 'corpus_build_attestation', attestation: artifact.payload, persistence: { sequence: artifact.sequence, recordedAt: artifact.recordedAt, artifactHash: artifact.artifactHash }, zkPrograms: [sp1Capability()] }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_READ_FAILED', detail: error instanceof Error ? error.message : 'Attestation read failed.', remedy: 'Verify the append-only agent-artifact journal.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const denied = authorizeCorpusCompilation(request);
  if (denied) return denied;
  let text: string;
  try { text = await request.text(); } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: 'Request body is unreadable.' }, { status: 400 }); }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: `Request exceeds ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let body: unknown;
  try { body = text ? JSON.parse(text) : {}; } catch { return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: 'Request body is not JSON.' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: 'Expected an optional corpusBuildId and signedAt.' }, { status: 400 });
  const value = body as { corpusBuildId?: unknown; signedAt?: unknown };
  if (value.corpusBuildId !== undefined && typeof value.corpusBuildId !== 'string' || value.signedAt !== undefined && (typeof value.signedAt !== 'string' || !Number.isFinite(Date.parse(value.signedAt)))) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_INPUT_INVALID', detail: 'corpusBuildId must be a string and signedAt must be an ISO instant.' }, { status: 400 });
  }
  try {
    const corpus = physicalEconomyCorpus('compiler');
    const projectionStore = corpusProjectionStore();
    const artifactStore = corpusAgentArtifactStore('compiler');
    const signer = loadCorpusAttestationSigner();
    if (!corpus || !projectionStore || !artifactStore) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_STORE_UNAVAILABLE', detail: 'Canonical corpus, projection, or artifact storage is not configured.', remedy: 'Configure all three persistent production stores before signing.' }, { status: 503 });
    if (!signer) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_SIGNER_NOT_CONFIGURED', detail: 'No Ed25519 corpus-build signer is configured.', remedy: 'Mount a protected Ed25519 PEM and set PAYLOAD_CORPUS_ATTESTATION_PRIVATE_KEY_PATH.' }, { status: 503 });
    const projection = projectionStore.loadPublic();
    if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'No public CorpusBuild is available to sign.' }, { status: 404 });
    if (typeof value.corpusBuildId === 'string' && value.corpusBuildId !== projection.manifest.corpusBuildId) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_BUILD_MISMATCH', detail: 'Requested build is not the current public projection.', remedy: 'Address the exact current build or restore its versioned projection before signing.' }, { status: 409 });
    const source = await corpus.projectionSource('global');
    if (!projectionMatchesSource(projection.manifest, source)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: 'The public projection is stale relative to canonical state.', remedy: 'Recompile, then sign the new exact build.' }, { status: 409 });
    const commitment = buildCorpusCommitment(projection.manifest, projection.records);
    const attestation = signCorpusBuildAttestation({ manifest: projection.manifest, commitment, signer, ...(typeof value.signedAt === 'string' ? { signedAt: value.signedAt } : {}) });
    const persisted = await artifactStore.append('global', { artifactType: 'build_attestation', artifactId: attestation.attestationId, corpusBuildId: attestation.statement.corpusBuildId, payload: attestation }, attestation.statement.signedAt);
    return NextResponse.json({ kind: 'corpus_build_attestation', attestation, persistence: { sequence: persisted.artifact.sequence, recordedAt: persisted.artifact.recordedAt, artifactHash: persisted.artifact.artifactHash, idempotent: persisted.idempotent }, zkPrograms: [sp1Capability()] }, { status: persisted.idempotent ? 200 : 201, headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ATTESTATION_FAILED', detail: error instanceof Error ? error.message : 'CorpusBuild signing failed.', remedy: 'Verify the current build, artifact journal, and protected Ed25519 key configuration.' }, { status: 503 });
  }
}
