/**
 * PayloadOS Miner V0, specialized by the Payload physical-economy build.
 *
 * Mining consumes one verified CorpusBuild and emits candidate knowledge. It
 * never writes relationships back into canonical state. Algorithms operate on
 * explicit records, preserve policy/evidence lineage, and state their coverage
 * limits instead of treating corpus absence as evidence of world absence.
 */

import { createHash } from 'node:crypto';
import {
  PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION,
  PAYLOAD_PRODUCT_ID,
  PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID,
} from './payloadCorpusDefinition';
import { stableValue } from './loadOperationsStore';
import { joinCorpusPolicies, type CorpusPolicyLineage } from './corpusPolicy';
import type { CompiledCorpusProjection } from './corpusProjection';
import { corpusEvidenceClosure, corpusRecordReferenceIds } from './physicalEconomyCorpus';
import type { CorpusEvidenceRecord, CorpusEntityRecord, CorpusRelationshipRecord, StoredCorpusRecord } from './physicalEconomyCorpus';

export const CORPUS_MINER_VERSION = '1.0.0';
export const SHARED_DEPENDENCY_ALGORITHM = 'shared_dependency_fan_in';
export const SHARED_DEPENDENCY_ALGORITHM_VERSION = '1.0.0';

export type PatternValidationStatus = 'CANDIDATE' | 'VALIDATED' | 'REJECTED' | 'SUPERSEDED';

export type PatternCandidate = {
  readonly schema: 'payload.corpus.pattern-candidate.v1';
  readonly patternId: string;
  readonly patternType: 'SHARED_DEPENDENCY';
  readonly focalEntityId: string;
  readonly entityIds: readonly string[];
  readonly relationshipIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly algorithm: typeof SHARED_DEPENDENCY_ALGORITHM;
  readonly algorithmVersion: typeof SHARED_DEPENDENCY_ALGORITHM_VERSION;
  readonly corpusBuildId: string;
  readonly miningRunId: string;
  readonly score: { readonly metric: 'distinct_dependents'; readonly value: number };
  readonly generatedAt: string;
  readonly uncertainty: {
    readonly kind: 'structural_candidate';
    readonly coverage: 'EXPLICIT_CORPUS_RELATIONSHIPS_ONLY';
    readonly limitation: string;
  };
  readonly validationStatus: Extract<PatternValidationStatus, 'CANDIDATE'>;
  readonly policy: CorpusPolicyLineage;
};

export type MiningRun = {
  readonly schema: 'payload.corpus.mining-run.v1';
  readonly miningRunId: string;
  readonly corpusBuildId: string;
  readonly corpusBuildDigest: string;
  readonly minerVersion: typeof CORPUS_MINER_VERSION;
  readonly algorithm: typeof SHARED_DEPENDENCY_ALGORITHM;
  readonly algorithmVersion: typeof SHARED_DEPENDENCY_ALGORITHM_VERSION;
  readonly parameters: { readonly minimumDependents: number; readonly depth: 1; readonly entityId?: string };
  readonly featureSet: readonly ['relationship:depends_on'];
  readonly temporalBoundary: { readonly knowledgeCutoff: string };
  readonly inputRecordIds: readonly string[];
  readonly inputFingerprint: string;
  readonly outputPatternIds: readonly string[];
  readonly policyLineageId: string | null;
  readonly startedAt: string;
  readonly completedAt: string;
};

export type CorpusMiningResult = {
  readonly kind: 'corpus_mining_result';
  readonly run: MiningRun;
  readonly candidates: readonly PatternCandidate[];
};

function canonical(value: unknown): string { return JSON.stringify(stableValue(value)); }
function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
function validTime(value: string): boolean { return Number.isFinite(Date.parse(value)); }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function recordsWithEvidence(records: readonly StoredCorpusRecord[], selected: readonly StoredCorpusRecord[]): readonly StoredCorpusRecord[] {
  return [...selected, ...corpusEvidenceClosure(records, selected)]
    .filter((record, index, all) => all.findIndex(candidate => candidate.recordId === record.recordId) === index)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * Detect explicit fan-in: two or more distinct entities name the same upstream
 * object through active `depends_on` relationships. This is a structural
 * candidate, not evidence that the dependency is exclusive or material.
 */
export function mineSharedDependencies(
  projection: CompiledCorpusProjection,
  options: { readonly minimumDependents?: number; readonly entityId?: string; readonly depth?: 1; readonly executedAt?: string } = {},
): CorpusMiningResult {
  if (projection.manifest.productId !== PAYLOAD_PRODUCT_ID
    || projection.manifest.corpusDefinitionId !== PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionId
    || projection.manifest.corpusDefinitionFingerprint !== PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionFingerprint
    || !PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.miningPrograms.includes(PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID)) {
    throw new Error('CORPUS_MINING_DOMAIN_MISMATCH: this mining program is not authorized by the projection CorpusDefinition');
  }
  const minimumDependents = options.minimumDependents ?? 2;
  const depth = options.depth ?? 1;
  const entityId = options.entityId?.trim();
  const executedAt = options.executedAt ?? new Date().toISOString();
  if (!Number.isSafeInteger(minimumDependents) || minimumDependents < 2 || minimumDependents > 100 || depth !== 1 || (entityId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/.test(entityId)) || !validTime(executedAt)) {
    throw new Error('CORPUS_MINING_INPUT_INVALID: entityId, depth=1, minimumDependents=2..100, or executedAt is invalid');
  }
  const relationships = projection.records
    .filter((record): record is StoredCorpusRecord & CorpusRelationshipRecord => record.recordType === 'relationship' && record.predicate === 'depends_on')
    .sort((a, b) => a.relationshipId.localeCompare(b.relationshipId));
  const entities = new Map(projection.records
    .filter((record): record is StoredCorpusRecord & CorpusEntityRecord => record.recordType === 'entity')
    .map(record => [record.entityId, record]));
  const evidence = new Map(projection.records
    .filter((record): record is StoredCorpusRecord & CorpusEvidenceRecord => record.recordType === 'evidence')
    .map(record => [record.evidenceId, record]));
  const inputRecords = recordsWithEvidence(projection.records, [
    ...relationships,
    ...[...new Set(relationships.flatMap(record => [record.subjectEntityId, record.objectEntityId]))].flatMap(id => entities.get(id) ? [entities.get(id)!] : []),
  ]);
  const runBasis = {
    corpusBuildId: projection.manifest.corpusBuildId,
    corpusBuildDigest: projection.manifest.projectionDigest,
    minerVersion: CORPUS_MINER_VERSION,
    algorithm: SHARED_DEPENDENCY_ALGORITHM,
    algorithmVersion: SHARED_DEPENDENCY_ALGORITHM_VERSION,
    parameters: { minimumDependents, depth, ...(entityId ? { entityId } : {}) },
    temporalBoundary: { knowledgeCutoff: projection.manifest.knowledgeCutoff },
    inputFingerprint: digest(inputRecords.map(record => ({ recordId: record.recordId, recordHash: record.recordHash }))),
    executedAt,
  };
  const miningRunId = `mining-run:${digest(runBasis)}`;
  const byDependency = new Map<string, Array<StoredCorpusRecord & CorpusRelationshipRecord>>();
  for (const relationship of relationships) {
    const grouped = byDependency.get(relationship.objectEntityId) ?? [];
    grouped.push(relationship);
    byDependency.set(relationship.objectEntityId, grouped);
  }

  const candidates: PatternCandidate[] = [];
  for (const [dependencyId, grouped] of [...byDependency].sort(([a], [b]) => a.localeCompare(b))) {
    const dependentIds = [...new Set(grouped.map(record => record.subjectEntityId))].sort();
    if (dependentIds.length < minimumDependents) continue;
    if (entityId && dependencyId !== entityId && !dependentIds.includes(entityId)) continue;
    const selected = recordsWithEvidence(projection.records, [
      ...grouped,
      ...[dependencyId, ...dependentIds].flatMap(id => entities.get(id) ? [entities.get(id)!] : []),
    ]);
    const policy = joinCorpusPolicies(selected, { outputForm: 'RECORD_LEVEL' });
    if (policy.kind === 'refusal') throw new Error(`${policy.code}: ${policy.detail}`);
    const relationshipIds = grouped.map(record => record.relationshipId).sort();
    const evidenceIds = [...new Set(selected.flatMap(record => record.recordType === 'evidence' ? [record.evidenceId] : corpusRecordReferenceIds(record)))]
      .filter(id => evidence.has(id)).sort();
    const patternId = `pattern:${digest({ miningRunId, patternType: 'SHARED_DEPENDENCY', focalEntityId: dependencyId, dependentIds, relationshipIds })}`;
    candidates.push(freeze({
      schema: 'payload.corpus.pattern-candidate.v1' as const,
      patternId,
      patternType: 'SHARED_DEPENDENCY' as const,
      focalEntityId: dependencyId,
      entityIds: Object.freeze([dependencyId, ...dependentIds].sort()),
      relationshipIds: Object.freeze(relationshipIds),
      evidenceIds: Object.freeze(evidenceIds),
      algorithm: SHARED_DEPENDENCY_ALGORITHM,
      algorithmVersion: SHARED_DEPENDENCY_ALGORITHM_VERSION,
      corpusBuildId: projection.manifest.corpusBuildId,
      miningRunId,
      score: Object.freeze({ metric: 'distinct_dependents' as const, value: dependentIds.length }),
      generatedAt: executedAt,
      uncertainty: Object.freeze({
        kind: 'structural_candidate' as const,
        coverage: 'EXPLICIT_CORPUS_RELATIONSHIPS_ONLY' as const,
        limitation: 'Fan-in is computed only from explicit depends_on records in this CorpusBuild; it does not establish exclusivity, materiality, causality, or completeness.',
      }),
      validationStatus: 'CANDIDATE' as const,
      policy: policy.lineage,
    }));
  }
  candidates.sort((a, b) => a.patternId.localeCompare(b.patternId));
  const runPolicy = inputRecords.length > 0 ? joinCorpusPolicies(inputRecords, { outputForm: 'RECORD_LEVEL' }) : null;
  if (runPolicy?.kind === 'refusal') throw new Error(`${runPolicy.code}: ${runPolicy.detail}`);
  const run: MiningRun = freeze({
    schema: 'payload.corpus.mining-run.v1' as const,
    miningRunId,
    corpusBuildId: projection.manifest.corpusBuildId,
    corpusBuildDigest: projection.manifest.projectionDigest,
    minerVersion: CORPUS_MINER_VERSION,
    algorithm: SHARED_DEPENDENCY_ALGORITHM,
    algorithmVersion: SHARED_DEPENDENCY_ALGORITHM_VERSION,
    parameters: Object.freeze({ minimumDependents, depth, ...(entityId ? { entityId } : {}) }),
    featureSet: Object.freeze(['relationship:depends_on'] as const),
    temporalBoundary: Object.freeze({ knowledgeCutoff: projection.manifest.knowledgeCutoff }),
    inputRecordIds: Object.freeze(inputRecords.map(record => record.recordId).sort()),
    inputFingerprint: runBasis.inputFingerprint,
    outputPatternIds: Object.freeze(candidates.map(candidate => candidate.patternId)),
    policyLineageId: runPolicy?.lineage.lineageId ?? null,
    startedAt: executedAt,
    completedAt: executedAt,
  });
  return freeze({ kind: 'corpus_mining_result' as const, run, candidates });
}
