/** Ordered federation contract from Payload into the Notation Data Substrate. */

import type { CompiledCorpusProjection } from './corpusProjection';
import { corpusRecordReferenceIds, type StoredCorpusRecord } from './physicalEconomyCorpus';
import { corpusVerificationDigest } from './corpusVerification';

export const NOTATION_CORPUS_SYNC_SCHEMA = 'payload.notation.sync-page.v1' as const;
export const PAYLOAD_NOTATION_NODE_URI = 'notation://node/payload' as const;
export const PAYLOAD_PUBLIC_FEDERATION_CHANNEL = Object.freeze({
  schema: 'payload.notation.federation-channel.v1' as const,
  channelId: 'payload:public:global' as const,
  audience: 'public' as const,
  scope: 'global' as const,
  projectionId: 'public:global' as const,
  status: 'READY' as const,
  requiredEntitlements: Object.freeze([] as string[]),
});

export type NotationFederationChannel =
  | typeof PAYLOAD_PUBLIC_FEDERATION_CHANNEL
  | {
      readonly schema: 'payload.notation.federation-channel.v1';
      readonly channelId: 'payload:internal:global' | `payload:customer:${string}`;
      readonly audience: 'internal' | 'customer';
      readonly scope: 'global' | `customer:${string}`;
      readonly projectionId: string | null;
      readonly status: 'BLOCKED_UNTIL_GOVERNED_PROJECTION';
      readonly requiredEntitlements: readonly string[];
    };

export type NotationObjectKind = 'artifact' | 'entity' | 'observation' | 'claim';

export type NotationCorpusSyncEnvelope = {
  readonly schema: 'payload.notation.sync-envelope.v1';
  readonly sourceNodeUri: typeof PAYLOAD_NOTATION_NODE_URI;
  readonly namespace: 'payload';
  readonly sequence: number;
  readonly eventId: string;
  readonly eventType: 'corpus.record.appended';
  readonly operation: 'UPSERT_APPEND_ONLY';
  readonly recordType: StoredCorpusRecord['recordType'];
  readonly localRecordId: string;
  readonly recordUri: string;
  readonly objectUri: string;
  readonly corpusBuildUri: string;
  readonly knownAt: string;
  readonly occurredAt: string;
  readonly recordHash: string;
  readonly referenceUris: readonly string[];
  readonly record: StoredCorpusRecord;
  readonly envelopeDigest: string;
};

export type NotationCorpusSyncPage = {
  readonly schema: typeof NOTATION_CORPUS_SYNC_SCHEMA;
  readonly sourceNodeUri: typeof PAYLOAD_NOTATION_NODE_URI;
  readonly channel: typeof PAYLOAD_PUBLIC_FEDERATION_CHANNEL;
  readonly authority: {
    readonly canonical: 'Payload canonical corpus';
    readonly destination: 'Notation Data Substrate';
    readonly model: 'one_logical_identity_space_many_physical_representations';
  };
  readonly projectionId: string;
  readonly corpusBuildId: string;
  readonly corpusBuildUri: string;
  readonly projectionDigest: string;
  readonly policyLineageId: string;
  readonly scope: 'global';
  readonly audience: 'public';
  readonly afterSequence: number;
  readonly nextAfterSequence: number;
  readonly sourceSequence: number;
  readonly remainingEnvelopeCount: number;
  readonly sourceLatestOccurredAt: string | null;
  readonly hasMore: boolean;
  readonly envelopes: readonly NotationCorpusSyncEnvelope[];
  readonly pageDigest: string;
  readonly limitations: readonly string[];
};

const encode = (value: string): string => encodeURIComponent(value);

export function notationUri(kind: 'record' | 'source' | 'artifact' | 'entity' | 'observation' | 'claim' | 'dataset' | 'state' | 'model' | 'transform', localId: string): string {
  return `notation://${kind}/payload/${encode(localId)}`;
}

/** Declares future channels without granting access or fabricating a projection. */
export function notationFederationChannel(channelId: string): NotationFederationChannel | null {
  if (channelId === PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId || channelId === 'public-global') return PAYLOAD_PUBLIC_FEDERATION_CHANNEL;
  if (channelId === 'payload:internal:global' || channelId === 'internal-global') return Object.freeze({
    schema: 'payload.notation.federation-channel.v1' as const,
    channelId: 'payload:internal:global' as const,
    audience: 'internal' as const,
    scope: 'global' as const,
    projectionId: null,
    status: 'BLOCKED_UNTIL_GOVERNED_PROJECTION' as const,
    requiredEntitlements: Object.freeze(['corpus:read:internal']),
  });
  const match = /^(?:payload:)?customer:([a-z0-9][a-z0-9._-]{1,63})$/.exec(channelId);
  if (!match) return null;
  return Object.freeze({
    schema: 'payload.notation.federation-channel.v1' as const,
    channelId: `payload:customer:${match[1]}` as const,
    audience: 'customer' as const,
    scope: `customer:${match[1]}` as const,
    projectionId: null,
    status: 'BLOCKED_UNTIL_GOVERNED_PROJECTION' as const,
    requiredEntitlements: Object.freeze([`tenant:${match[1]}:projection`, `tenant:${match[1]}:federation`]),
  });
}

function objectIdentity(record: StoredCorpusRecord): { readonly kind: NotationObjectKind; readonly id: string } {
  switch (record.recordType) {
    case 'evidence': return { kind: 'artifact', id: record.evidenceId };
    case 'evidence_unit': return { kind: 'artifact', id: record.evidenceUnitId };
    case 'entity': return { kind: 'entity', id: record.entityId };
    case 'observation': return { kind: 'observation', id: record.observationId };
    case 'alias': return { kind: 'claim', id: record.aliasId };
    case 'relationship': return { kind: 'claim', id: record.relationshipId };
    case 'assertion': return { kind: 'claim', id: record.assertionId };
  }
}

function recordReferences(record: StoredCorpusRecord): readonly string[] {
  const references = corpusRecordReferenceIds(record).map(reference =>
    notationUri(reference.startsWith('observation:') ? 'observation' : 'artifact', reference));
  switch (record.recordType) {
    case 'evidence':
      references.push(notationUri('source', record.sourceId));
      break;
    case 'entity':
      break;
    case 'alias':
    case 'observation':
    case 'assertion':
      references.push(notationUri('entity', record.entityId));
      break;
    case 'relationship':
      references.push(notationUri('entity', record.subjectEntityId), notationUri('entity', record.objectEntityId));
      break;
    case 'evidence_unit':
      break;
  }
  return Object.freeze([...new Set(references)].sort());
}

export function notationSyncEnvelope(record: StoredCorpusRecord, corpusBuildId: string): NotationCorpusSyncEnvelope {
  const object = objectIdentity(record);
  const basis = {
    schema: 'payload.notation.sync-envelope.v1' as const,
    sourceNodeUri: PAYLOAD_NOTATION_NODE_URI,
    namespace: 'payload' as const,
    sequence: record.sequence,
    eventId: `corpus-event:${record.recordHash}`,
    eventType: 'corpus.record.appended' as const,
    operation: 'UPSERT_APPEND_ONLY' as const,
    recordType: record.recordType,
    localRecordId: record.recordId,
    recordUri: notationUri('record', record.recordId),
    objectUri: notationUri(object.kind, object.id),
    corpusBuildUri: notationUri('dataset', corpusBuildId),
    knownAt: record.knownAt,
    occurredAt: record.recordedAt,
    recordHash: record.recordHash,
    referenceUris: recordReferences(record),
    record,
  };
  return Object.freeze({ ...basis, envelopeDigest: corpusVerificationDigest(basis) });
}

/**
 * Pages one policy-filtered public CorpusBuild using canonical sequence cursors.
 * When excluded canonical records create a terminal gap, nextAfterSequence
 * advances to sourceSequence so a consumer can deterministically catch up.
 */
export function buildNotationCorpusSyncPage(
  projection: CompiledCorpusProjection,
  options: { readonly afterSequence?: number; readonly limit?: number } = {},
): NotationCorpusSyncPage {
  const afterSequence = options.afterSequence ?? 0;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('NOTATION_SYNC_CURSOR_INVALID: afterSequence must be non-negative and limit must be 1..500');
  }
  const available = projection.records.filter(record => record.sequence > afterSequence);
  const selected = available.slice(0, limit);
  const hasMore = available.length > selected.length;
  const nextAfterSequence = hasMore
    ? selected.at(-1)!.sequence
    : Math.max(afterSequence, projection.manifest.sourceSequence);
  const envelopes = selected.map(record => notationSyncEnvelope(record, projection.manifest.corpusBuildId));
  const pageBasis = {
    schema: NOTATION_CORPUS_SYNC_SCHEMA,
    sourceNodeUri: PAYLOAD_NOTATION_NODE_URI,
    channel: PAYLOAD_PUBLIC_FEDERATION_CHANNEL,
    authority: {
      canonical: 'Payload canonical corpus' as const,
      destination: 'Notation Data Substrate' as const,
      model: 'one_logical_identity_space_many_physical_representations' as const,
    },
    projectionId: projection.manifest.projectionId,
    corpusBuildId: projection.manifest.corpusBuildId,
    corpusBuildUri: notationUri('dataset', projection.manifest.corpusBuildId),
    projectionDigest: projection.manifest.projectionDigest,
    policyLineageId: projection.manifest.policyLineageId,
    scope: 'global' as const,
    audience: 'public' as const,
    afterSequence,
    nextAfterSequence,
    sourceSequence: projection.manifest.sourceSequence,
    remainingEnvelopeCount: available.length - selected.length,
    sourceLatestOccurredAt: projection.records.at(-1)?.recordedAt ?? null,
    hasMore,
    envelopes,
    limitations: [
      'This V1 feed contains only the policy-filtered public/global CorpusBuild; customer and internal scopes require separately authorized projections.',
      'Payload remains authoritative for its canonical records; the Notation Data Substrate stores identities and representations, not a second mutable truth.',
      'A sync envelope proves deterministic identity and content linkage, not the empirical truth of its source observation.',
    ],
  };
  return Object.freeze({ ...pageBasis, pageDigest: corpusVerificationDigest(pageBasis) });
}
