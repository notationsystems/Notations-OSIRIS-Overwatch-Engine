/** Destination-side contracts for the Notation Data Substrate. */

import { authorizeCorpusObject, PUBLIC_PROJECTION_ACTOR } from './corpusPolicy';
import { canonicalCorpusJson, corpusRecordHash, type CorpusRecordInput, type StoredCorpusRecord } from './physicalEconomyCorpus';
import {
  NOTATION_CORPUS_SYNC_SCHEMA,
  PAYLOAD_NOTATION_NODE_URI,
  PAYLOAD_PUBLIC_FEDERATION_CHANNEL,
  notationSyncEnvelope,
  notationUri,
  type NotationCorpusSyncEnvelope,
  type NotationCorpusSyncPage,
} from './notationCorpusFederation';
import { corpusVerificationDigest } from './corpusVerification';

export const NOTATION_SUBSTRATE_SCHEMA = 'notation.substrate.sqlite.v1' as const;
export const NOTATION_SEMANTIC_DOCUMENT_SCHEMA = 'notation.semantic-document.v1' as const;

export type NotationSemanticDocument = {
  readonly schema: typeof NOTATION_SEMANTIC_DOCUMENT_SCHEMA;
  readonly documentUri: string;
  readonly sourceNodeUri: string;
  readonly channelId: string;
  readonly sourceRecordUri: string;
  readonly objectUri: string;
  readonly recordType: StoredCorpusRecord['recordType'];
  readonly text: string;
  readonly knownAt: string;
  readonly corpusBuildUri: string;
  readonly projectionDigest: string;
  readonly referenceUris: readonly string[];
  readonly documentHash: string;
};

export type NotationSubstrateAcknowledgement = {
  readonly schema: 'notation.substrate.acknowledgement.v1';
  readonly journalSequence: number;
  readonly acknowledgementId: string;
  readonly channelId: string;
  readonly sourceNodeUri: string;
  readonly pageDigest: string;
  readonly corpusBuildId: string;
  readonly projectionDigest: string;
  readonly afterSequence: number;
  readonly acknowledgedSequence: number;
  readonly sourceSequence: number;
  readonly appliedRecords: number;
  readonly existingRecords: number;
  readonly acknowledgedAt: string;
  readonly previousHash: string | null;
  readonly acknowledgementHash: string;
};

export type NotationSubstrateLagSample = {
  readonly schema: 'notation.substrate.lag-sample.v1';
  readonly sampleId: string;
  readonly channelId: string;
  readonly sourceNodeUri: string;
  readonly observedAt: string;
  readonly acknowledgedSequence: number;
  readonly sourceSequence: number;
  readonly canonicalSequenceLag: number;
  readonly remainingEnvelopeCount: number;
  readonly publicTimeLagMs: number | null;
  readonly timeLagBasis: 'LATEST_PUBLIC_ENVELOPE' | 'UNOBSERVED';
};

export type NotationVectorProjectionInput = {
  readonly documentUri: string;
  readonly documentHash: string;
  readonly modelId: string;
  readonly modelVersion: string;
  readonly values: readonly number[];
  readonly generatedAt?: string;
};

const HASH = /^[a-f0-9]{64}$/;
const URI = /^notation:\/\/[a-z][a-z0-9-]*\/[A-Za-z0-9._~%:/-]+$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function semanticText(record: StoredCorpusRecord): string {
  switch (record.recordType) {
    case 'evidence': return `${record.title}\nsource ${record.sourceId}`;
    case 'evidence_unit': return `${record.modality} ${record.extraction.kind}\n${record.extractedText ?? ''}`.trim();
    case 'entity': return `${record.canonicalName}\n${record.entityKind} ${record.countryCode ?? ''}\n${record.description ?? ''}`.trim();
    case 'alias': return `${record.value}\nalias ${record.scheme} for ${record.entityId}`;
    case 'relationship': return `${record.subjectEntityId} ${record.predicate} ${record.objectEntityId}\n${record.valueKind} ${record.confidence}`;
    case 'observation': return `${record.entityId} ${record.observationType ?? 'metric'} ${record.metric} ${String(record.value)} ${record.unit ?? ''}\n${record.valueKind} ${record.basis ?? ''}`.trim();
    case 'assertion': return `${record.entityId} ${record.propertyKey} ${typeof record.selectedValue === 'object' ? canonicalCorpusJson(record.selectedValue) : String(record.selectedValue)} ${record.unit ?? ''}\n${record.status} ${record.selectionPolicy}`.trim();
  }
}

export function semanticDocumentForEnvelope(envelope: NotationCorpusSyncEnvelope, projectionDigest: string, channelId = PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId): NotationSemanticDocument {
  const basis = {
    schema: NOTATION_SEMANTIC_DOCUMENT_SCHEMA,
    documentUri: notationUri('state', `semantic-document:${envelope.localRecordId}`),
    sourceNodeUri: envelope.sourceNodeUri,
    channelId,
    sourceRecordUri: envelope.recordUri,
    objectUri: envelope.objectUri,
    recordType: envelope.recordType,
    text: semanticText(envelope.record),
    knownAt: envelope.knownAt,
    corpusBuildUri: envelope.corpusBuildUri,
    projectionDigest,
    referenceUris: [...envelope.referenceUris],
  };
  return freeze({ ...basis, documentHash: corpusVerificationDigest(basis) });
}

function publicPolicyDefect(record: StoredCorpusRecord): string | null {
  if (record.scope !== 'global') return 'public federation records must have global scope';
  for (const use of ['PROJECTION', 'SEARCH', 'DERIVATION', 'REDISTRIBUTION'] as const) {
    const decision = authorizeCorpusObject(record, PUBLIC_PROJECTION_ACTOR, use);
    if (decision.kind === 'denied') return `${record.recordId} is not authorized for ${use}: ${decision.code}`;
  }
  return null;
}

/** Recomputes all page/envelope identities before destination mutation. */
export function verifyNotationCorpusSyncPage(page: NotationCorpusSyncPage): void {
  if (!page || page.schema !== NOTATION_CORPUS_SYNC_SCHEMA || page.sourceNodeUri !== PAYLOAD_NOTATION_NODE_URI ||
      page.channel?.channelId !== PAYLOAD_PUBLIC_FEDERATION_CHANNEL.channelId || page.channel.status !== 'READY' ||
      page.scope !== 'global' || page.audience !== 'public' || !HASH.test(page.projectionDigest) || !HASH.test(page.policyLineageId) ||
      !Number.isSafeInteger(page.afterSequence) || page.afterSequence < 0 || !Number.isSafeInteger(page.nextAfterSequence) ||
      page.nextAfterSequence < page.afterSequence || !Number.isSafeInteger(page.sourceSequence) || page.sourceSequence < page.nextAfterSequence ||
      !Number.isSafeInteger(page.remainingEnvelopeCount) || page.remainingEnvelopeCount < 0 ||
      page.sourceLatestOccurredAt !== null && !validTime(page.sourceLatestOccurredAt) || page.envelopes.length > 500) {
    throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: page metadata or channel is invalid');
  }
  const pageBasis: Record<string, unknown> = { ...page };
  delete pageBasis.pageDigest;
  if (!HASH.test(page.pageDigest) || corpusVerificationDigest(pageBasis) !== page.pageDigest) throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: page digest does not reproduce');
  let prior = page.afterSequence;
  for (const envelope of page.envelopes) {
    const expected = notationSyncEnvelope(envelope.record, page.corpusBuildId);
    const { sequence, scope, recordedAt, previousHash, recordHash, ...recordInput } = envelope.record;
    const expectedRecordHash = corpusRecordHash(sequence, scope, recordedAt, previousHash, recordInput as CorpusRecordInput);
    if (envelope.sequence <= prior || envelope.sequence > page.nextAfterSequence ||
        recordHash !== expectedRecordHash ||
        envelope.envelopeDigest !== expected.envelopeDigest || canonicalCorpusJson(envelope) !== canonicalCorpusJson(expected) ||
        publicPolicyDefect(envelope.record)) {
      throw new Error(`NOTATION_SUBSTRATE_PAGE_INVALID: envelope ${envelope.localRecordId ?? '(unknown)'} is invalid or unauthorized`);
    }
    prior = envelope.sequence;
  }
  if (page.hasMore && (!page.envelopes.length || page.nextAfterSequence !== page.envelopes.at(-1)?.sequence || page.remainingEnvelopeCount < 1)) {
    throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: continuing page has an invalid cursor or remaining count');
  }
  if (!page.hasMore && (page.remainingEnvelopeCount !== 0 || page.nextAfterSequence !== Math.max(page.afterSequence, page.sourceSequence))) {
    throw new Error('NOTATION_SUBSTRATE_PAGE_INVALID: terminal page does not advance to the source sequence');
  }
}

export function vectorProjectionDefect(input: NotationVectorProjectionInput): string | null {
  if (!URI.test(input.documentUri) || !HASH.test(input.documentHash) || !MODEL.test(input.modelId) || !MODEL.test(input.modelVersion)) return 'identity, document hash, model, or version is invalid';
  if (!Array.isArray(input.values) || input.values.length < 1 || input.values.length > 4096 || input.values.some(value => typeof value !== 'number' || !Number.isFinite(value))) return 'vector must contain 1..4096 finite numbers';
  if (input.generatedAt !== undefined && !validTime(input.generatedAt)) return 'generatedAt is invalid';
  return null;
}
