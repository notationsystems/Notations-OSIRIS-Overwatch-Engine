import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNotationCorpusSyncPage } from './notationCorpusFederation';
import { NotationSubstrateStore } from './notationSubstrateStore';
import { runNotationSubstrateSyncOnce } from './notationSubstrateSyncWorker';
import { OPEN_PUBLIC_CORPUS_ACCESS } from './corpusPolicy';
import { buildPublicProjection } from './corpusProjection';
import { PhysicalEconomyCorpus } from './physicalEconomyCorpus';

const at = '2026-09-02T21:00:00.000Z';

function page(directory: string) {
  const corpus = new PhysicalEconomyCorpus(join(directory, 'corpus.sqlite'));
  const result = corpus.append('global', [{ schema: 'payload.corpus.record.v1', recordId: 'record:evidence:worker', recordType: 'evidence', knownAt: at, evidenceId: 'evidence:worker', sourceId: 'source:worker', title: 'Worker source', sourceUrl: 'https://example.test/worker', artifactSha256: 'a'.repeat(64), retrievedAt: at, access: OPEN_PUBLIC_CORPUS_ACCESS }], at);
  if (result.kind !== 'committed') throw new Error(result.code);
  const value = buildNotationCorpusSyncPage(buildPublicProjection(corpus.projectionSource('global', at), at));
  corpus.close(); return value;
}

describe('Notation substrate sync worker', () => {
  it('pulls, verifies, ingests, acknowledges, and records the acknowledged cursor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'notation-worker-'));
    const store = new NotationSubstrateStore(join(directory, 'substrate.sqlite'));
    const sourcePage = page(directory);
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input); const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (method === 'GET') return new Response(JSON.stringify(sourcePage), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ kind: 'notation_corpus_sync_checkpoint' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const result = await runNotationSubstrateSyncOnce(store, { sourceUrl: 'http://payload:3000', sourceToken: 'SECRET', consumerId: 'primary-fabric', now: () => at, fetch: fetcher });
      expect(result).toMatchObject({ upstreamAcknowledged: true, ingestion: { acknowledgement: { acknowledgedSequence: 1 } } });
      expect(calls[0]).toMatchObject({ method: 'GET' });
      expect(calls[0].url).toContain('afterSequence=0');
      expect(calls[1]).toMatchObject({ method: 'POST', body: { consumerId: 'primary-fabric', sequence: 1, corpusBuildId: sourcePage.corpusBuildId, projectionDigest: sourcePage.projectionDigest } });
      expect(store.status().channels[0]).toMatchObject({ lastIngestedSequence: 1, lastUpstreamAcknowledgedSequence: 1, acknowledgementLag: 0 });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('keeps a committed destination cursor recoverable when the upstream acknowledgement fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'notation-worker-recovery-'));
    const store = new NotationSubstrateStore(join(directory, 'substrate.sqlite'));
    const sourcePage = page(directory);
    let acknowledgementAttempts = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      if ((init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify(sourcePage), { status: 200, headers: { 'content-type': 'application/json' } });
      acknowledgementAttempts += 1;
      return acknowledgementAttempts === 1
        ? new Response(JSON.stringify({ kind: 'refusal', code: 'SOURCE_TEMPORARILY_UNAVAILABLE' }), { status: 503, headers: { 'content-type': 'application/json' } })
        : new Response(JSON.stringify({ kind: 'notation_corpus_sync_checkpoint' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const first = await runNotationSubstrateSyncOnce(store, { sourceUrl: 'http://payload:3000', sourceToken: 'SECRET', consumerId: 'primary-fabric', now: () => at, fetch: fetcher });
      expect(first).toMatchObject({ upstreamAcknowledged: false, upstreamRefusal: { status: 503, code: 'SOURCE_TEMPORARILY_UNAVAILABLE' } });
      expect(store.status().channels[0]).toMatchObject({ lastIngestedSequence: 1, lastUpstreamAcknowledgedSequence: 0, acknowledgementLag: 1 });

      const second = await runNotationSubstrateSyncOnce(store, { sourceUrl: 'http://payload:3000', sourceToken: 'SECRET', consumerId: 'primary-fabric', now: () => at, fetch: fetcher });
      expect(second).toMatchObject({ upstreamAcknowledged: true, recoveryOnly: true, hasMoreBasis: 'UNOBSERVED_DURING_ACK_RECOVERY' });
      expect(store.status().channels[0]).toMatchObject({ lastIngestedSequence: 1, lastUpstreamAcknowledgedSequence: 1, acknowledgementLag: 0 });
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
});
