import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from './envCompat';

function authorizeDedicatedBearer(
  request: Request,
  environmentName: 'PAYLOAD_CORPUS_INGEST_TOKEN' | 'PAYLOAD_CORPUS_COMPILER_TOKEN',
  unavailableCode: 'CORPUS_ADMIN_NOT_CONFIGURED' | 'CORPUS_COMPILER_NOT_CONFIGURED',
  unauthorizedCode: 'CORPUS_ADMIN_UNAUTHORIZED' | 'CORPUS_COMPILER_UNAUTHORIZED',
  remedy: string,
): NextResponse | null {
  const expected = env(environmentName);
  if (!expected) return NextResponse.json({
    kind: 'refusal', code: unavailableCode,
    detail: `This service boundary is fail-closed until ${environmentName} is configured.`,
    remedy,
  }, { status: 503 });
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return NextResponse.json({ kind: 'refusal', code: unauthorizedCode }, { status: 401 });
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return NextResponse.json({ kind: 'refusal', code: unauthorizedCode }, { status: 401 });
  return null;
}

/** Research workers may append/replay canonical records, but cannot publish projections. */
export function authorizeCorpusAdministration(request: Request): NextResponse | null {
  return authorizeDedicatedBearer(
    request, 'PAYLOAD_CORPUS_INGEST_TOKEN', 'CORPUS_ADMIN_NOT_CONFIGURED', 'CORPUS_ADMIN_UNAUTHORIZED',
    'Set a dedicated research-worker secret; do not reuse query or compiler credentials.',
  );
}

/** Corpus Compiler may publish/inspect read models, but cannot mutate canonical state. */
export function authorizeCorpusCompilation(request: Request): NextResponse | null {
  return authorizeDedicatedBearer(
    request, 'PAYLOAD_CORPUS_COMPILER_TOKEN', 'CORPUS_COMPILER_NOT_CONFIGURED', 'CORPUS_COMPILER_UNAUTHORIZED',
    'Set a dedicated compiler-service secret; do not reuse ingestion or public query credentials.',
  );
}
