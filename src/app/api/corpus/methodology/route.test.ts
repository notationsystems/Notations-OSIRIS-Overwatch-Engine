import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('/api/corpus/methodology', () => {
  it('publishes the versioned, inspectable trust contract without corpus credentials', async () => {
    const response = await GET(new Request('http://localhost/api/corpus/methodology?view=full'));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toMatch(/^"[a-f0-9]{64}"$/);
    expect(await response.json()).toMatchObject({
      kind: 'payload_corpus_methodology',
      methodology: {
        methodologyId: 'payload:methodology:physical-economy',
        methodologyVersion: 'payload.methodology.physical-economy@1.0.0',
        deliberateNonClaims: expect.arrayContaining([expect.stringContaining('missing observations as zero')]),
        capabilities: expect.arrayContaining([
          expect.objectContaining({ capabilityId: 'canonical-corpus', status: 'PRODUCTION', implementation: 'AVAILABLE' }),
          expect.objectContaining({ capabilityId: 'corpus-build-zk-proof', status: 'RESEARCH', implementation: 'NOT_IMPLEMENTED' }),
        ]),
        methodologyDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('refuses partial or invented methodology views', async () => {
    const response = await GET(new Request('http://localhost/api/corpus/methodology?view=summary'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ kind: 'refusal', code: 'CORPUS_METHODOLOGY_QUERY_INVALID' });
  });
});
