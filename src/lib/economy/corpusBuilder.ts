/**
 * Corpus Builder V0 canonical-write boundary.
 *
 * Acquisition, extraction, normalization, and resolution may occur upstream;
 * this service attests only the validated typed-record commit it performs.
 */

import { createHash } from 'node:crypto';
import { stableValue } from './loadOperationsStore';
import type { CorpusAppendResult, CorpusRecordInput, CorpusScope, PhysicalEconomyCorpus } from './physicalEconomyCorpus';

export const CORPUS_BUILDER_VERSION = '1.0.0';

export type CorpusBuilderManifest = {
  readonly schema: 'payload.corpus.builder-manifest.v1';
  readonly builderRunId: string;
  readonly builderVersion: typeof CORPUS_BUILDER_VERSION;
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
): CorpusBuilderResult {
  const result = corpus.append(scope, records, recordedAt);
  if (result.kind === 'refusal') return result;
  const ordered = [...result.records].sort((a, b) => a.sequence - b.sequence);
  const recordIds = ordered.map(record => record.recordId);
  const evidenceIds = ordered.filter(record => record.recordType === 'evidence').map(record => record.evidenceId);
  const claimRecordIds = ordered.filter(record => record.recordType !== 'evidence').map(record => record.recordId);
  const commitBasis = ordered.map(record => ({ recordId: record.recordId, recordHash: record.recordHash }));
  const canonicalCommitFingerprint = digest(commitBasis);
  const builderRunId = `corpus-builder:${digest({ builderVersion: CORPUS_BUILDER_VERSION, scope, canonicalCommitFingerprint })}`;
  const manifest: CorpusBuilderManifest = freeze({
    schema: 'payload.corpus.builder-manifest.v1' as const,
    builderRunId,
    builderVersion: CORPUS_BUILDER_VERSION,
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
