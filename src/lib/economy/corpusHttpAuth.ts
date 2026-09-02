import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from './envCompat';

/** Dedicated administrative boundary for corpus append and raw record replay. */
export function authorizeCorpusAdministration(request: Request): NextResponse | null {
  const expected = env('PAYLOAD_CORPUS_INGEST_TOKEN');
  if (!expected) return NextResponse.json({
    kind: 'refusal', code: 'CORPUS_ADMIN_NOT_CONFIGURED',
    detail: 'Corpus administration is fail-closed until PAYLOAD_CORPUS_INGEST_TOKEN is configured.',
    remedy: 'Set a dedicated research-worker secret; do not reuse a public query credential.',
  }, { status: 503 });
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ADMIN_UNAUTHORIZED' }, { status: 401 });
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) return NextResponse.json({ kind: 'refusal', code: 'CORPUS_ADMIN_UNAUTHORIZED' }, { status: 401 });
  return null;
}
