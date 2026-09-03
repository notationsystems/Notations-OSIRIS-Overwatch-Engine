/** Pull worker that makes federation ingestion and upstream acknowledgement resumable. */

import { PAYLOAD_PUBLIC_FEDERATION_CHANNEL, type NotationCorpusSyncPage } from './notationCorpusFederation';
import type { NotationSubstrateStore } from './notationSubstrateStore';

export type NotationSubstrateSyncWorkerConfig = {
  readonly sourceUrl: string;
  readonly sourceToken: string;
  readonly consumerId: string;
  readonly pageLimit?: number;
  readonly now?: () => string;
  readonly fetch?: typeof fetch;
};

const CONSUMER = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function sourceBase(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('NOTATION_SYNC_WORKER_CONFIG_INVALID: sourceUrl is invalid'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('NOTATION_SYNC_WORKER_CONFIG_INVALID: sourceUrl must be an HTTP(S) origin/base path without credentials, query, or fragment');
  return parsed.toString().replace(/\/$/, '');
}

async function responseJson(response: Response, label: string): Promise<unknown> {
  try { return await response.json(); }
  catch { throw new Error(`NOTATION_SYNC_WORKER_PROTOCOL_INVALID: ${label} did not return JSON`); }
}

export async function runNotationSubstrateSyncOnce(store: NotationSubstrateStore, config: NotationSubstrateSyncWorkerConfig) {
  const sourceUrl = sourceBase(config.sourceUrl);
  const token = config.sourceToken.trim();
  const consumerId = config.consumerId.trim();
  const pageLimit = config.pageLimit ?? 100;
  const now = config.now ?? (() => new Date().toISOString());
  const fetcher = config.fetch ?? fetch;
  if (!token || !CONSUMER.test(consumerId) || !Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) throw new Error('NOTATION_SYNC_WORKER_CONFIG_INVALID: token, consumer identity, or page limit is invalid');
  const state = store.channel(PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId);
  if (state && state.last_upstream_ack_sequence < state.last_ingested_sequence) {
    const acknowledgedAt = now();
    const acknowledgementResponse = await fetcher(`${sourceUrl}/api/corpus/federation`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ consumerId, sequence: state.last_ingested_sequence, corpusBuildId: state.corpus_build_id, projectionDigest: state.projection_digest, updatedAt: acknowledgedAt }),
      cache: 'no-store',
    });
    const acknowledgementBody = await responseJson(acknowledgementResponse, 'federation acknowledgement recovery');
    if (!acknowledgementResponse.ok) return Object.freeze({
      kind: 'notation_substrate_sync' as const,
      channelId: state.channel_id,
      sourceNodeUri: state.source_node_uri,
      recoveryOnly: true as const,
      upstreamAcknowledged: false as const,
      upstreamRefusal: { status: acknowledgementResponse.status, code: String((acknowledgementBody as { code?: unknown })?.code ?? 'UNKNOWN') },
      hasMore: false,
      hasMoreBasis: 'UNOBSERVED_DURING_ACK_RECOVERY' as const,
    });
    const channel = store.markUpstreamAcknowledged(state.channel_id, state.last_ingested_sequence, now());
    return Object.freeze({
      kind: 'notation_substrate_sync' as const,
      channelId: state.channel_id,
      sourceNodeUri: state.source_node_uri,
      recoveryOnly: true as const,
      upstreamAcknowledged: true as const,
      upstream: acknowledgementBody,
      channel,
      hasMore: false,
      hasMoreBasis: 'UNOBSERVED_DURING_ACK_RECOVERY' as const,
    });
  }
  const afterSequence = state?.last_ingested_sequence ?? 0;
  const getUrl = new URL(`${sourceUrl}/api/corpus/federation`);
  getUrl.searchParams.set('channel', PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId);
  getUrl.searchParams.set('afterSequence', String(afterSequence));
  getUrl.searchParams.set('limit', String(pageLimit));
  const pageResponse = await fetcher(getUrl, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, cache: 'no-store' });
  const pageBody = await responseJson(pageResponse, 'federation source');
  if (!pageResponse.ok) throw new Error(`NOTATION_SYNC_SOURCE_REFUSED: HTTP ${pageResponse.status} ${(pageBody as { code?: unknown })?.code ?? 'UNKNOWN'}`);
  const page = pageBody as NotationCorpusSyncPage;
  const ingestedAt = now();
  const ingestion = store.ingest(page, ingestedAt);
  const acknowledgementResponse = await fetcher(`${sourceUrl}/api/corpus/federation`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ consumerId, sequence: ingestion.acknowledgement.acknowledgedSequence, corpusBuildId: page.corpusBuildId, projectionDigest: page.projectionDigest, updatedAt: ingestedAt }),
    cache: 'no-store',
  });
  const acknowledgementBody = await responseJson(acknowledgementResponse, 'federation acknowledgement');
  if (!acknowledgementResponse.ok) {
    return Object.freeze({
      kind: 'notation_substrate_sync' as const,
      channelId: page.channel.channelId,
      sourceNodeUri: page.sourceNodeUri,
      ingestion,
      upstreamAcknowledged: false as const,
      upstreamRefusal: { status: acknowledgementResponse.status, code: String((acknowledgementBody as { code?: unknown })?.code ?? 'UNKNOWN') },
      hasMore: page.hasMore,
    });
  }
  const channel = store.markUpstreamAcknowledged(page.channel.channelId, ingestion.acknowledgement.acknowledgedSequence, now());
  return Object.freeze({
    kind: 'notation_substrate_sync' as const,
    channelId: page.channel.channelId,
    sourceNodeUri: page.sourceNodeUri,
    ingestion,
    upstreamAcknowledged: true as const,
    upstream: acknowledgementBody,
    channel,
    hasMore: page.hasMore,
  });
}
