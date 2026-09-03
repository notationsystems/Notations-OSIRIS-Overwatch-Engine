/** Immutable, linearly ordered artifacts produced by corpus-facing agents. */

import { createHash } from 'node:crypto';
import type { CorpusAgentContext, CorpusEvidenceLevel } from './corpusAgentContext';
import type { CorpusBuildAttestation } from './corpusBuildAttestation';
import type { CorpusRetrievalPlan } from './corpusRetrieval';
import type { CorpusSpatialResult } from './corpusSpatialResult';
import { canonicalCorpusJson, corpusScopeValid, corpusVisibleScopes, type CorpusScope } from './physicalEconomyCorpus';
import { corpusVerificationDigest } from './corpusVerification';

export type CorpusAgentResult = {
  readonly schema: 'payload.corpus.agent-result.v1';
  readonly resultId: string;
  readonly agentContextId: string;
  readonly corpusBuildId: string;
  readonly projectionDigest: string;
  readonly evidenceLevel: CorpusEvidenceLevel;
  readonly requestDigest: string;
  readonly output: {
    readonly kind: 'corpus_agent_context';
    readonly plan: CorpusRetrievalPlan;
    readonly agentContext: CorpusAgentContext;
    readonly spatial: CorpusSpatialResult;
  };
};

export type CorpusAgentArtifactInput =
  | { readonly artifactType: 'agent_result'; readonly artifactId: string; readonly corpusBuildId: string; readonly payload: CorpusAgentResult }
  | { readonly artifactType: 'build_attestation'; readonly artifactId: string; readonly corpusBuildId: string; readonly payload: CorpusBuildAttestation };

export type StoredCorpusAgentArtifact = CorpusAgentArtifactInput & {
  readonly sequence: number;
  readonly scope: CorpusScope;
  readonly recordedAt: string;
  readonly previousHash: string | null;
  readonly artifactHash: string;
};

export type CorpusAgentArtifactAppendResult = {
  readonly kind: 'committed';
  readonly artifact: StoredCorpusAgentArtifact;
  readonly idempotent: boolean;
};

export type CorpusAgentArtifactPage = {
  readonly kind: 'corpus_agent_artifact_page';
  readonly scope: CorpusScope;
  readonly afterSequence: number;
  readonly nextAfterSequence: number;
  readonly hasMore: boolean;
  readonly artifacts: readonly StoredCorpusAgentArtifact[];
};

export interface CorpusAgentArtifactRepository {
  readonly backend: 'sqlite' | 'postgresql';
  readonly databasePath: string;
  close(): void | Promise<void>;
  append(scope: CorpusScope, artifact: CorpusAgentArtifactInput, recordedAt?: string): CorpusAgentArtifactAppendResult | Promise<CorpusAgentArtifactAppendResult>;
  get(scope: CorpusScope, artifactId: string): StoredCorpusAgentArtifact | null | Promise<StoredCorpusAgentArtifact | null>;
  latestBuildAttestation(scope: CorpusScope, corpusBuildId: string): StoredCorpusAgentArtifact | null | Promise<StoredCorpusAgentArtifact | null>;
  page(options?: { readonly scope?: CorpusScope; readonly afterSequence?: number; readonly limit?: number }): CorpusAgentArtifactPage | Promise<CorpusAgentArtifactPage>;
  recent(options?: { readonly scope?: CorpusScope; readonly limit?: number }): readonly StoredCorpusAgentArtifact[] | Promise<readonly StoredCorpusAgentArtifact[]>;
}

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{2,255}$/;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

export function buildCorpusAgentResult(input: {
  readonly plan: CorpusRetrievalPlan;
  readonly agentContext: CorpusAgentContext;
  readonly spatial: CorpusSpatialResult;
}): CorpusAgentResult {
  if (input.plan.corpusBuildId !== input.agentContext.corpus.corpusBuildId ||
      input.plan.projectionDigest !== input.agentContext.corpus.projectionDigest ||
      input.agentContext.agentContextId !== input.spatial.agentContextId ||
      input.agentContext.corpus.corpusBuildId !== input.spatial.corpusBuildId) {
    throw new Error('CORPUS_AGENT_RESULT_INVALID: plan, context, and spatial result identify different state');
  }
  const basis = {
    schema: 'payload.corpus.agent-result.v1' as const,
    agentContextId: input.agentContext.agentContextId,
    corpusBuildId: input.agentContext.corpus.corpusBuildId,
    projectionDigest: input.agentContext.corpus.projectionDigest,
    evidenceLevel: input.agentContext.evidenceBudget.requestedLevel,
    requestDigest: corpusVerificationDigest(input.plan),
    output: {
      kind: 'corpus_agent_context' as const,
      plan: input.plan,
      agentContext: input.agentContext,
      spatial: input.spatial,
    },
  };
  return freeze({ ...basis, resultId: `corpus-result:${corpusVerificationDigest(basis)}` });
}

export function corpusAgentArtifactInput(input: StoredCorpusAgentArtifact): CorpusAgentArtifactInput {
  return freeze({
    artifactType: input.artifactType,
    artifactId: input.artifactId,
    corpusBuildId: input.corpusBuildId,
    payload: input.payload,
  } as CorpusAgentArtifactInput);
}

export function corpusAgentArtifactDefect(artifact: CorpusAgentArtifactInput): string | null {
  if (!ID.test(artifact.artifactId) || !ID.test(artifact.corpusBuildId)) return 'artifact identity is invalid';
  if (artifact.artifactType === 'agent_result') {
    const rebuilt = buildCorpusAgentResult(artifact.payload.output);
    if (artifact.payload.schema !== 'payload.corpus.agent-result.v1' ||
        artifact.payload.resultId !== artifact.artifactId ||
        rebuilt.resultId !== artifact.payload.resultId ||
        artifact.payload.corpusBuildId !== artifact.corpusBuildId ||
        artifact.payload.agentContextId !== artifact.payload.output.agentContext.agentContextId ||
        artifact.payload.corpusBuildId !== artifact.payload.output.agentContext.corpus.corpusBuildId ||
        artifact.payload.projectionDigest !== artifact.payload.output.agentContext.corpus.projectionDigest ||
        artifact.payload.evidenceLevel !== artifact.payload.output.agentContext.evidenceBudget.requestedLevel ||
        artifact.payload.output.spatial.agentContextId !== artifact.payload.agentContextId ||
        artifact.payload.output.spatial.corpusBuildId !== artifact.payload.corpusBuildId ||
        !HASH.test(artifact.payload.projectionDigest) || !HASH.test(artifact.payload.requestDigest)) return 'agent result metadata contradicts its payload';
  } else if (artifact.payload.schema !== 'payload.corpus.build-attestation.v1' ||
      artifact.payload.attestationId !== artifact.artifactId ||
      artifact.payload.statement.corpusBuildId !== artifact.corpusBuildId) return 'build attestation metadata contradicts its payload';
  return null;
}

export function corpusAgentArtifactHash(input: {
  readonly sequence: number;
  readonly scope: CorpusScope;
  readonly recordedAt: string;
  readonly previousHash: string | null;
  readonly artifact: CorpusAgentArtifactInput;
}): string {
  return createHash('sha256').update(canonicalCorpusJson({
    domain: 'payload.corpus.agent-artifact.record.v1',
    sequence: input.sequence,
    scope: input.scope,
    recordedAt: input.recordedAt,
    previousHash: input.previousHash,
    artifact: input.artifact,
  })).digest('hex');
}

export function verifyCorpusAgentArtifactSet(artifacts: readonly StoredCorpusAgentArtifact[]): void {
  const tails = new Map<CorpusScope, string | null>();
  const ids = new Set<string>();
  let priorSequence = 0;
  for (const artifact of [...artifacts].sort((left, right) => left.sequence - right.sequence)) {
    const input = corpusAgentArtifactInput(artifact);
    if (!Number.isSafeInteger(artifact.sequence) || artifact.sequence <= priorSequence ||
        ids.has(artifact.artifactId) || !corpusScopeValid(artifact.scope) ||
        !Number.isFinite(Date.parse(artifact.recordedAt)) ||
        artifact.previousHash !== (tails.get(artifact.scope) ?? null) ||
        !HASH.test(artifact.artifactHash) || artifact.artifactHash !== corpusAgentArtifactHash({
          sequence: artifact.sequence,
          scope: artifact.scope,
          recordedAt: artifact.recordedAt,
          previousHash: artifact.previousHash,
          artifact: input,
        }) || corpusAgentArtifactDefect(input)) {
      throw new Error(`CORPUS_AGENT_ARTIFACT_CORRUPT: artifact ${artifact.artifactId} failed its immutable sequence or hash chain`);
    }
    priorSequence = artifact.sequence;
    ids.add(artifact.artifactId);
    tails.set(artifact.scope, artifact.artifactHash);
  }
}

export function visibleCorpusAgentArtifactScopes(scope: CorpusScope): readonly CorpusScope[] {
  return corpusVisibleScopes(scope);
}
