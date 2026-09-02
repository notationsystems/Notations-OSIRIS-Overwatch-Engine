/**
 * Corpus Builder V0 canonical-write boundary.
 *
 * Acquisition, extraction, normalization, and resolution may occur upstream;
 * this service attests only the validated typed-record commit it performs.
 */

import { createHash } from 'node:crypto';
import {
  CORPUS_ENGINE_ID,
  CORPUS_ENGINE_VERSION,
  assertCorpusDefinition,
  type CorpusDefinition,
} from './corpusDefinition';
import { stableValue } from './loadOperationsStore';
import { PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION } from './payloadCorpusDefinition';
import type { CorpusAppendResult, CorpusRecordInput, CorpusScope, PhysicalEconomyCorpus } from './physicalEconomyCorpus';

export const CORPUS_BUILDER_VERSION = '1.2.0';

export type CorpusBuilderManifest = {
  readonly schema: 'payload.corpus.builder-manifest.v1';
  readonly builderRunId: string;
  readonly builderVersion: typeof CORPUS_BUILDER_VERSION;
  readonly corpusEngineId: typeof CORPUS_ENGINE_ID;
  readonly corpusEngineVersion: typeof CORPUS_ENGINE_VERSION;
  readonly corpusDefinitionId: string;
  readonly corpusDefinitionFingerprint: string;
  readonly productId: string;
  readonly coverage: 'CANONICAL_WRITE_ONLY';
  readonly upstreamAcquisitionAttested: false;
  readonly scope: CorpusScope;
  readonly recordIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly claimRecordIds: readonly string[];
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly recordedAt: readonly string[];
  readonly canonicalCommitFingerprint: string;
};

export type CorpusBuilderResult =
  | (Extract<CorpusAppendResult, { kind: 'committed' }> & { readonly builderManifest: CorpusBuilderManifest })
  | Extract<CorpusAppendResult, { kind: 'refusal' }>;

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function buildCanonicalCorpusBatch(
  corpus: PhysicalEconomyCorpus,
  scope: CorpusScope,
  records: readonly CorpusRecordInput[],
  recordedAt?: string,
  corpusDefinition: CorpusDefinition = PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION,
): CorpusBuilderResult {
  assertCorpusDefinition(corpusDefinition);
  if (corpusDefinition.definitionFingerprint !== PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionFingerprint) {
    throw new Error('CORPUS_BUILDER_DOMAIN_UNSUPPORTED: this V0 repository adapter writes only the Payload physical-economy corpus');
  }
  for (const record of records) {
    const unsupported = record.recordType === 'entity' && typeof record.entityKind === 'string' && !corpusDefinition.entityTypes.includes(record.entityKind)
      ? `entity type ${record.entityKind}`
      : record.recordType === 'relationship' && typeof record.predicate === 'string' && !corpusDefinition.relationTypes.includes(record.predicate)
        ? `relation type ${record.predicate}`
        : record.recordType === 'observation' && (record.observationType === undefined || typeof record.observationType === 'string') && !corpusDefinition.observationTypes.includes(record.observationType ?? 'metric')
          ? `observation type ${record.observationType ?? 'metric'}` : null;
    if (unsupported) throw new Error(`CORPUS_BUILDER_DEFINITION_MISMATCH: ${unsupported} is not admitted by ${corpusDefinition.definitionId}`);
  }
  const result = corpus.append(scope, records, recordedAt);
  if (result.kind === 'refusal') return result;
  const ordered = [...result.records].sort((a, b) => a.sequence - b.sequence);
  const recordIds = ordered.map(record => record.recordId);
  const evidenceIds = ordered.flatMap(record => record.recordType === 'evidence' ? [record.evidenceId] : record.recordType === 'evidence_unit' ? [record.evidenceUnitId] : []);
  const claimRecordIds = ordered.filter(record => record.recordType !== 'evidence' && record.recordType !== 'evidence_unit').map(record => record.recordId);
  const commitBasis = ordered.map(record => ({ recordId: record.recordId, recordHash: record.recordHash }));
  const canonicalCommitFingerprint = digest(commitBasis);
  const builderRunId = `corpus-builder:${digest({
    corpusEngineId: CORPUS_ENGINE_ID,
    corpusEngineVersion: CORPUS_ENGINE_VERSION,
    builderVersion: CORPUS_BUILDER_VERSION,
    corpusDefinitionFingerprint: corpusDefinition.definitionFingerprint,
    productId: corpusDefinition.product.productId,
    scope,
    canonicalCommitFingerprint,
  })}`;
  const manifest: CorpusBuilderManifest = freeze({
    schema: 'payload.corpus.builder-manifest.v1' as const,
    builderRunId,
    builderVersion: CORPUS_BUILDER_VERSION,
    corpusEngineId: CORPUS_ENGINE_ID,
    corpusEngineVersion: CORPUS_ENGINE_VERSION,
    corpusDefinitionId: corpusDefinition.definitionId,
    corpusDefinitionFingerprint: corpusDefinition.definitionFingerprint,
    productId: corpusDefinition.product.productId,
    coverage: 'CANONICAL_WRITE_ONLY' as const,
    upstreamAcquisitionAttested: false as const,
    scope,
    recordIds: Object.freeze(recordIds),
    evidenceIds: Object.freeze(evidenceIds),
    claimRecordIds: Object.freeze(claimRecordIds),
    firstSequence: ordered[0].sequence,
    lastSequence: ordered.at(-1)!.sequence,
    recordedAt: Object.freeze([...new Set(ordered.map(record => record.recordedAt))].sort()),
    canonicalCommitFingerprint,
  });
  return freeze({ ...result, builderManifest: manifest });
}
