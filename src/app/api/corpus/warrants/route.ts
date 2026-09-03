import { NextResponse } from 'next/server';
import { authorizeCorpusQuery } from '@/lib/economy/corpusHttpAuth';
import { projectionMatchesSource } from '@/lib/economy/corpusProjection';
import { corpusProjectionStore } from '@/lib/economy/corpusProjectionRuntime';
import { physicalEconomyCorpus } from '@/lib/economy/physicalEconomyCorpusRuntime';
import { buildVerificationEnvelope, corpusVerificationDigest } from '@/lib/economy/corpusVerification';
import {
  buildCorpusWarrantGraph,
  CorpusWarrantError,
  selectCorpusWarrantBasis,
  warrantSubjectIdentity,
  warrantSubjectLabel,
} from '@/lib/economy/corpusWarrantGraph';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;

function owners() {
  try { return { corpus: physicalEconomyCorpus('query'), projection: corpusProjectionStore(), error: null }; }
  catch (error) { return { corpus: null, projection: null, error: error instanceof Error ? error.message : 'Warrant storage integrity could not be established.' }; }
}

/**
 * Returns only a graph over the current policy-filtered CorpusBuild. Canonical
 * records remain behind the repository boundary; query authority cannot use
 * this route to escape object-level projection policy.
 */
export async function GET(request: Request) {
  const denied = authorizeCorpusQuery(request);
  if (denied) return denied;
  const { searchParams } = new URL(request.url);
  const recordId = searchParams.get('recordId')?.trim() || undefined;
  const entityId = searchParams.get('entityId')?.trim() || undefined;
  const maximumRecords = Number(searchParams.get('maximumRecords') ?? '200');
  if (Boolean(recordId) === Boolean(entityId) || (recordId && !ID.test(recordId)) || (entityId && !ID.test(entityId)) || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 500) {
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_WARRANT_INPUT_INVALID', detail: 'Specify exactly one valid recordId or entityId; maximumRecords must be 1..500.', remedy: 'Use a canonical identifier from a current ContextPackage or corpus answer.' }, { status: 400 });
  }
  const owned = owners();
  if (!owned.corpus || !owned.projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_WARRANT_UNAVAILABLE', detail: owned.error ?? 'Canonical corpus or public read model is not configured.', remedy: 'Restore the query repository and rebuild the current public projection.' }, { status: 503 });
  try {
    const projection = owned.projection.loadPublic();
    if (!projection) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_NOT_BUILT', detail: 'No public CorpusBuild is available for a warrant walk.', remedy: 'Compile the public/global representation first.' }, { status: 503 });
    const current = await owned.corpus.projectionSource('global');
    if (!projectionMatchesSource(projection.manifest, current)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_PROJECTION_STALE', detail: 'The public CorpusBuild no longer represents current canonical global state.', remedy: 'Recompile before constructing a warrant graph.' }, { status: 503 });
    const basis = selectCorpusWarrantBasis(projection.records, { recordId, entityId }, maximumRecords);
    const subjectId = recordId ?? entityId!;
    const inputDigest = corpusVerificationDigest({ subjectId, maximumRecords, corpusBuildId: projection.manifest.corpusBuildId });
    const outputDigest = corpusVerificationDigest(basis.map(record => ({ recordId: record.recordId, recordHash: record.recordHash })));
    const verification = buildVerificationEnvelope({
      manifest: projection.manifest,
      projectionRecords: projection.records,
      basisRecords: basis,
      programId: 'payload:warrant-walk',
      algorithmVersion: '1.0.0',
      inputDigest,
      outputDigest,
      parameters: { recordId: recordId ?? null, entityId: entityId ?? null, maximumRecords },
    });
    const graph = buildCorpusWarrantGraph({ statement: warrantSubjectLabel(basis), basisRecords: basis, manifest: projection.manifest, verification });
    return NextResponse.json({
      kind: 'corpus_warrant_graph',
      subject: { requestedId: subjectId, canonicalId: warrantSubjectIdentity(basis) },
      verification,
      graph,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    if (error instanceof CorpusWarrantError) {
      const status = error.code === 'CORPUS_WARRANT_TOO_BROAD' ? 413 : error.code === 'CORPUS_WARRANT_SUBJECT_UNRESOLVED' ? 404 : 400;
      return NextResponse.json({ kind: 'refusal', code: error.code, detail: error.message, remedy: error.code === 'CORPUS_WARRANT_TOO_BROAD' ? 'Select one exact record or request a smaller entity warrant.' : 'Use a canonical identifier present in the current CorpusBuild.' }, { status });
    }
    return NextResponse.json({ kind: 'refusal', code: 'CORPUS_WARRANT_UNAVAILABLE', detail: error instanceof Error ? error.message : 'The warrant graph could not be constructed.', remedy: 'Verify projection integrity and rebuild it from canonical state.' }, { status: 503 });
  }
}
