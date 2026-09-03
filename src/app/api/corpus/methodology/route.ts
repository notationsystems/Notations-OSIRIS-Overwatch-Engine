import { NextResponse } from 'next/server';
import { PAYLOAD_CORPUS_METHODOLOGY } from '@/lib/economy/corpusMethodology';

export const dynamic = 'force-dynamic';

/** Public trust contract. It contains no source data, credentials, or tenant state. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => key !== 'view') || (params.get('view') && params.get('view') !== 'full')) {
    return NextResponse.json({
      kind: 'refusal',
      code: 'CORPUS_METHODOLOGY_QUERY_INVALID',
      detail: 'The methodology endpoint accepts only view=full.',
      remedy: 'Remove unsupported parameters and inspect the complete versioned contract.',
    }, { status: 400 });
  }
  return NextResponse.json({ kind: 'payload_corpus_methodology', methodology: PAYLOAD_CORPUS_METHODOLOGY }, {
    headers: {
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=3600',
      ETag: `"${PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest}"`,
    },
  });
}
