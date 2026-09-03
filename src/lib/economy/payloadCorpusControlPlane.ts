/** Payload-specific control-plane projection over the physical-economy stack. */

import type { CorpusAgentArtifactPage, StoredCorpusAgentArtifact } from './corpusAgentArtifacts';
import type { CompiledCorpusProjection } from './corpusProjection';
import type { CorpusProjectionSource } from './physicalEconomyCorpus';
import type { Sp1ProgramIdentity } from './sp1ProgramIdentity';
import type { CorpusSpatialResult } from './corpusSpatialResult';
import { corpusVerificationDigest } from './corpusVerification';

export type PayloadControlHealth = 'healthy' | 'stale' | 'blocked' | 'unobserved';

type UnobservedMetric = {
  readonly status: 'UNOBSERVED';
  readonly reason: string;
};

type PayloadCapability = {
  readonly capabilityId: string;
  readonly mode: 'observe' | 'propose' | 'execute';
  readonly approval: {
    readonly requirement: 'automatic' | 'compiler_credential' | 'operator';
    readonly state: 'not_required' | 'not_requested' | 'approval_required';
  };
  readonly health: PayloadControlHealth;
  readonly latency: UnobservedMetric;
  readonly cost: UnobservedMetric;
  readonly provenanceRefs: readonly string[];
};

type PayloadTopologyNode = {
  readonly nodeId: string;
  readonly kind: 'canonical_corpus' | 'read_model' | 'api' | 'artifact_journal' | 'operational_ledger' | 'mcp_tool' | 'visual_dock' | 'data_source' | 'proof_program' | 'build_signer';
  readonly label: string;
  readonly health: {
    readonly status: PayloadControlHealth;
    readonly observedAt: string | null;
    readonly detail: string;
  };
  readonly capabilities: readonly PayloadCapability[];
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
};

export type PayloadCorpusControlPlaneSnapshot = {
  readonly schema: 'payload.corpus.control-plane.v1';
  readonly ecosystemId: 'payload:physical-economy';
  readonly revision: string;
  readonly generatedAt: string;
  readonly freshnessPolicy: { readonly projectionStaleAfterMs: number };
  readonly topology: {
    readonly nodes: readonly PayloadTopologyNode[];
    readonly relations: readonly {
      readonly relationId: string;
      readonly sourceNodeId: string;
      readonly targetNodeId: string;
      readonly kind: 'ingests_from' | 'projects' | 'serves' | 'persists_to' | 'packages' | 'visualizes' | 'attests' | 'proves';
    }[];
  };
  readonly timeline: {
    readonly afterSequence: number;
    readonly nextAfterSequence: number;
    readonly hasMore: boolean;
    readonly events: readonly {
      readonly sequence: number;
      readonly eventId: string;
      readonly occurredAt: string;
      readonly changed: 'agent_context_persisted' | 'corpus_build_attested';
      readonly why: string;
      readonly requestedBy: { readonly id: 'payload:role:corpus-query' | 'payload:role:corpus-compiler'; readonly basis: 'AUTHENTICATED_ROLE' };
      readonly dispatched: false;
      readonly artifactId: string;
      readonly corpusBuildId: string;
      readonly artifactHash: string;
    }[];
  };
  readonly dock: {
    readonly temporal: {
      readonly corpusBuildId: string | null;
      readonly compiledAt: string | null;
      readonly knowledgeCutoff: string | null;
      readonly latestEventAt: string | null;
    };
    readonly spatial:
      | {
          readonly status: 'READY';
          readonly resultId: string;
          readonly spatialResultId: string;
          readonly asOf: string;
          readonly knownAt: string;
          readonly keplerGl: CorpusSpatialResult['keplerGl'];
        }
      | {
          readonly status: 'UNOBSERVED';
          readonly code: 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED';
          readonly detail: string;
        };
  };
  readonly operator: {
    readonly counts: Readonly<Record<PayloadControlHealth, number>>;
    readonly healthy: readonly string[];
    readonly stale: readonly string[];
    readonly blocked: readonly string[];
    readonly unobserved: readonly string[];
    readonly needsApproval: readonly { readonly nodeId: string; readonly capabilityId: string; readonly state: 'approval_required' }[];
    readonly attention: readonly { readonly code: string; readonly detail: string; readonly remedy: string }[];
  };
};

export type PayloadCorpusControlPlaneInput = {
  readonly generatedAt: string;
  readonly projectionStaleAfterMs: number;
  readonly canonical: { readonly backend: 'sqlite' | 'postgresql'; readonly source: CorpusProjectionSource } | null;
  readonly projection: CompiledCorpusProjection | null;
  readonly projectionCurrent: boolean;
  readonly artifactBackend: 'sqlite' | 'postgresql' | null;
  readonly artifactPage: CorpusAgentArtifactPage;
  readonly recentArtifacts: readonly StoredCorpusAgentArtifact[];
  readonly currentBuildAttestation: StoredCorpusAgentArtifact | null;
  readonly sp1: Sp1ProgramIdentity;
  readonly faults?: readonly { readonly component: 'canonical' | 'projection' | 'artifacts'; readonly code: string }[];
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const latency = (): UnobservedMetric => ({ status: 'UNOBSERVED', reason: 'No capability latency observation has been persisted yet.' });
const cost = (): UnobservedMetric => ({ status: 'UNOBSERVED', reason: 'No capability cost observation has been persisted yet.' });

function capability(
  capabilityId: string,
  mode: PayloadCapability['mode'],
  approvalRequirement: PayloadCapability['approval']['requirement'],
  health: PayloadControlHealth,
  provenanceRefs: readonly string[],
): PayloadCapability {
  return freeze({
    capabilityId,
    mode,
    approval: {
      requirement: approvalRequirement,
      state: approvalRequirement === 'automatic' ? 'not_required' as const : 'not_requested' as const,
    },
    health,
    latency: latency(),
    cost: cost(),
    provenanceRefs: [...provenanceRefs],
  });
}

function node(
  nodeId: string,
  kind: PayloadTopologyNode['kind'],
  label: string,
  status: PayloadControlHealth,
  observedAt: string | null,
  detail: string,
  capabilities: readonly PayloadCapability[],
  metadata: PayloadTopologyNode['metadata'] = {},
): PayloadTopologyNode {
  return freeze({ nodeId, kind, label, health: { status, observedAt, detail }, capabilities: [...capabilities], metadata: { ...metadata } });
}

function artifactEvent(artifact: StoredCorpusAgentArtifact): PayloadCorpusControlPlaneSnapshot['timeline']['events'][number] {
  if (artifact.artifactType === 'agent_result') {
    return freeze({
      sequence: artifact.sequence,
      eventId: `payload-control:${artifact.artifactHash}`,
      occurredAt: artifact.recordedAt,
      changed: 'agent_context_persisted' as const,
      why: artifact.payload.output.plan.query,
      requestedBy: { id: 'payload:role:corpus-query' as const, basis: 'AUTHENTICATED_ROLE' as const },
      dispatched: false as const,
      artifactId: artifact.artifactId,
      corpusBuildId: artifact.corpusBuildId,
      artifactHash: artifact.artifactHash,
    });
  }
  return freeze({
    sequence: artifact.sequence,
    eventId: `payload-control:${artifact.artifactHash}`,
    occurredAt: artifact.recordedAt,
    changed: 'corpus_build_attested' as const,
    why: `Authenticate exact commitment ${artifact.payload.statement.commitmentId}.`,
    requestedBy: { id: 'payload:role:corpus-compiler' as const, basis: 'AUTHENTICATED_ROLE' as const },
    dispatched: false as const,
    artifactId: artifact.artifactId,
    corpusBuildId: artifact.corpusBuildId,
    artifactHash: artifact.artifactHash,
  });
}

/**
 * Project the operating state of Payload itself. This is deliberately not a
 * generic control-room schema: its nodes and relations name real Payload
 * corpus components and proof boundaries.
 */
export function buildPayloadCorpusControlPlane(input: PayloadCorpusControlPlaneInput): PayloadCorpusControlPlaneSnapshot {
  if (!Number.isFinite(Date.parse(input.generatedAt)) || !Number.isSafeInteger(input.projectionStaleAfterMs) || input.projectionStaleAfterMs < 60_000) {
    throw new Error('PAYLOAD_CONTROL_PLANE_INPUT_INVALID: time or freshness policy is invalid');
  }
  const faults = new Map((input.faults ?? []).map(fault => [fault.component, fault.code]));
  const projection = input.projection;
  const projectionAge = projection ? Date.parse(input.generatedAt) - Date.parse(projection.manifest.compiledAt) : Number.POSITIVE_INFINITY;
  const projectionStatus: PayloadControlHealth = faults.has('projection') || !projection
    ? 'blocked'
    : !input.projectionCurrent || projectionAge > input.projectionStaleAfterMs || projectionAge < -60_000
      ? 'stale'
      : 'healthy';
  const canonicalStatus: PayloadControlHealth = faults.has('canonical') || !input.canonical ? 'blocked' : 'healthy';
  const artifactStatus: PayloadControlHealth = faults.has('artifacts') || !input.artifactBackend ? 'blocked' : 'healthy';
  const queryStatus: PayloadControlHealth = projectionStatus === 'blocked' || artifactStatus === 'blocked'
    ? 'blocked'
    : projectionStatus === 'stale' ? 'stale' : 'healthy';
  const currentAttestation = input.currentBuildAttestation?.artifactType === 'build_attestation'
    && input.currentBuildAttestation.corpusBuildId === projection?.manifest.corpusBuildId
    ? input.currentBuildAttestation
    : null;
  const latestResult = [...input.recentArtifacts].reverse().find(artifact => artifact.artifactType === 'agent_result');
  const latestSpatial = latestResult?.artifactType === 'agent_result' ? latestResult.payload.output.spatial : null;

  const nodes: PayloadTopologyNode[] = [
    node('payload:corpus:canonical', 'canonical_corpus', 'Canonical physical-economy corpus', canonicalStatus, input.generatedAt,
      input.canonical ? `${input.canonical.backend} canonical state is readable at sequence ${input.canonical.source.sourceSequence}.` : faults.get('canonical') ?? 'Canonical corpus is not configured.',
      [capability('corpus.observe', 'observe', 'automatic', canonicalStatus, input.canonical ? [input.canonical.source.sourceDigest] : [])],
      { backend: input.canonical?.backend ?? null, sourceSequence: input.canonical?.source.sourceSequence ?? null }),
    node('payload:corpus:projection', 'read_model', 'Public corpus projection', projectionStatus, projection?.manifest.compiledAt ?? null,
      !projection ? faults.get('projection') ?? 'No public projection is available.' : !input.projectionCurrent ? 'Projection does not match current canonical source state.' : projectionAge < -60_000 ? 'Projection compile time is ahead of the control-plane clock.' : projectionAge > input.projectionStaleAfterMs ? 'Projection exceeds the configured freshness window.' : 'Projection matches canonical state and is within the freshness window.',
      [capability('projection.observe', 'observe', 'automatic', projectionStatus, projection ? [projection.manifest.projectionDigest, projection.manifest.policyLineageId] : [])],
      { corpusBuildId: projection?.manifest.corpusBuildId ?? null, recordCount: projection?.manifest.recordCount ?? 0, excludedRecords: projection?.manifest.excludedRecords ?? 0 }),
    node('payload:api:corpus-retrieval', 'api', 'Evidence-budgeted corpus retrieval API', queryStatus, input.generatedAt,
      queryStatus === 'healthy' ? 'Authenticated retrieval and durable result storage are available.' : 'Retrieval is constrained by projection or artifact-store state.',
      [capability('agent-context.observe', 'observe', 'automatic', queryStatus, projection ? [projection.manifest.projectionDigest] : [])]),
    node('payload:journal:agent-artifacts', 'artifact_journal', 'Immutable agent result and attestation journal', artifactStatus, input.artifactPage.artifacts.at(-1)?.recordedAt ?? null,
      input.artifactBackend ? `${input.artifactBackend} journal is readable; returned events retain dispatch=false.` : faults.get('artifacts') ?? 'Agent artifact journal is not configured.',
      [capability('agent-result.persist', 'execute', 'automatic', artifactStatus, input.artifactPage.artifacts.map(artifact => artifact.artifactHash))],
      { backend: input.artifactBackend, nextAfterSequence: input.artifactPage.nextAfterSequence, hasMore: input.artifactPage.hasMore }),
    node('payload:mcp:query', 'mcp_tool', 'query_payload_corpus', queryStatus, null, 'MCP tool packages the authenticated retrieval contract; MCP process latency is not yet observed.',
      [capability('agent-context.observe', 'observe', 'automatic', queryStatus, ['payload.corpus.agent-result.v1'])]),
    node('payload:mcp:result', 'mcp_tool', 'get_payload_corpus_result', artifactStatus, null, 'MCP tool recovers immutable results by stable identity; MCP process latency is not yet observed.',
      [capability('agent-result.observe', 'observe', 'automatic', artifactStatus, ['payload.corpus.agent-result.v1'])]),
    node('payload:mcp:warrant', 'mcp_tool', 'get_payload_corpus_warrant', projectionStatus, null, 'MCP tool walks score-free evidence lineage over the current projection.',
      [capability('warrant.observe', 'observe', 'automatic', projectionStatus, projection ? [projection.manifest.projectionDigest] : [])]),
    node('payload:mcp:attestation', 'mcp_tool', 'get_payload_corpus_attestation', artifactStatus, null, 'MCP tool reads build signatures and preserves the separate SP1 proof scope.',
      [capability('attestation.observe', 'observe', 'automatic', artifactStatus, currentAttestation ? [currentAttestation.artifactHash] : [])]),
    node('payload:dock:kepler', 'visual_dock', 'Kepler spatial/temporal dock', latestSpatial ? 'healthy' : 'unobserved', latestResult?.recordedAt ?? null,
      latestSpatial ? 'Latest persisted agent result contains a kepler.gl addDataToMap payload.' : 'No persisted spatial result has been observed yet.',
      [capability('physical-topology.visualize', 'observe', 'automatic', latestSpatial ? 'healthy' : 'unobserved', latestSpatial ? [latestSpatial.spatialResultId] : [])]),
    node('payload:attestation:ed25519', 'build_signer', 'CorpusBuild Ed25519 signer', currentAttestation ? 'healthy' : 'unobserved', currentAttestation?.recordedAt ?? null,
      currentAttestation ? 'Current CorpusBuild has a verified stored signature.' : 'Current CorpusBuild has no stored signature; signer availability is not inferred.',
      [capability('corpus-build.attest', 'execute', 'compiler_credential', currentAttestation ? 'healthy' : 'unobserved', currentAttestation ? [currentAttestation.artifactHash] : [])]),
    node('payload:operations:event-ledger', 'operational_ledger', 'Authorized operational event ledger', 'unobserved', null,
      'This corpus surface does not inspect the operational event ledger; its current health, latency, and proof backlog remain unobserved.',
      [capability('authorized-event-batch.observe', 'observe', 'automatic', 'unobserved', ['payload_event_batch_v1'])]),
    node('payload:proof:payload-event-batch-v1', 'proof_program', input.sp1.program, 'unobserved', input.sp1.ceremony.generatedAt,
      'The verification key is ceremonially pinned; current Linux prover health, latency, and cost are not observed by this corpus surface.',
      [capability('authorized-event-batch.prove', 'execute', 'operator', 'unobserved', [input.sp1.verificationKey, input.sp1.ceremony.sourceCommit])],
      { sp1Version: input.sp1.sp1Version, appliesToCorpusBuild: false, proofScope: 'authorized_operational_event_batches' }),
  ];

  const sourceIds = new Map<string, string[]>();
  for (const record of projection?.records ?? []) {
    if (record.recordType !== 'evidence') continue;
    const refs = sourceIds.get(record.sourceId) ?? [];
    refs.push(record.recordId);
    sourceIds.set(record.sourceId, refs);
  }
  for (const [sourceId, recordRefs] of [...sourceIds].sort(([left], [right]) => left.localeCompare(right))) {
    nodes.push(node(`payload:source:${sourceId}`, 'data_source', sourceId, 'unobserved', null,
      'The source is present in corpus evidence, but live source health, latency, and cost have not been observed.',
      [capability('source.observe', 'observe', 'automatic', 'unobserved', recordRefs)],
      { evidenceRecordCount: recordRefs.length }));
  }

  const relations: PayloadCorpusControlPlaneSnapshot['topology']['relations'][number][] = [
    { relationId: 'canonical-projects-public', sourceNodeId: 'payload:corpus:canonical', targetNodeId: 'payload:corpus:projection', kind: 'projects' },
    { relationId: 'projection-serves-retrieval', sourceNodeId: 'payload:corpus:projection', targetNodeId: 'payload:api:corpus-retrieval', kind: 'serves' },
    { relationId: 'retrieval-persists-artifacts', sourceNodeId: 'payload:api:corpus-retrieval', targetNodeId: 'payload:journal:agent-artifacts', kind: 'persists_to' },
    { relationId: 'mcp-packages-retrieval', sourceNodeId: 'payload:mcp:query', targetNodeId: 'payload:api:corpus-retrieval', kind: 'packages' },
    { relationId: 'mcp-recovers-results', sourceNodeId: 'payload:mcp:result', targetNodeId: 'payload:journal:agent-artifacts', kind: 'serves' },
    { relationId: 'mcp-walks-projection', sourceNodeId: 'payload:mcp:warrant', targetNodeId: 'payload:corpus:projection', kind: 'serves' },
    { relationId: 'mcp-reads-attestations', sourceNodeId: 'payload:mcp:attestation', targetNodeId: 'payload:journal:agent-artifacts', kind: 'serves' },
    { relationId: 'kepler-visualizes-results', sourceNodeId: 'payload:journal:agent-artifacts', targetNodeId: 'payload:dock:kepler', kind: 'visualizes' },
    { relationId: 'signer-attests-projection', sourceNodeId: 'payload:attestation:ed25519', targetNodeId: 'payload:corpus:projection', kind: 'attests' },
    { relationId: 'sp1-proves-event-batches', sourceNodeId: 'payload:proof:payload-event-batch-v1', targetNodeId: 'payload:operations:event-ledger', kind: 'proves' },
    ...[...sourceIds.keys()].sort().map(sourceId => ({ relationId: `corpus-ingests-${corpusVerificationDigest(sourceId).slice(0, 16)}`, sourceNodeId: 'payload:corpus:canonical', targetNodeId: `payload:source:${sourceId}`, kind: 'ingests_from' as const })),
  ];

  const timelineEvents = input.artifactPage.artifacts.map(artifactEvent);
  const byHealth = (status: PayloadControlHealth) => nodes.filter(entry => entry.health.status === status).map(entry => entry.nodeId);
  const attention: PayloadCorpusControlPlaneSnapshot['operator']['attention'][number][] = [];
  if (projectionStatus === 'stale') attention.push({ code: 'CORPUS_PROJECTION_STALE', detail: 'The public projection is behind canonical state or outside its freshness window.', remedy: 'Run the authenticated corpus compiler and verify replay equivalence before replacing the read model.' });
  if (projection && !currentAttestation) attention.push({ code: 'CORPUS_BUILD_UNSIGNED', detail: `CorpusBuild ${projection.manifest.corpusBuildId} has no stored Ed25519 attestation.`, remedy: 'After reviewing the exact commitment, use the compiler-authenticated attestation endpoint.' });
  if (!latestSpatial) attention.push({ code: 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED', detail: 'No persisted agent result currently feeds the Kepler dock.', remedy: 'Run an evidence-budgeted corpus query whose entities carry observed coordinates.' });
  for (const [component, code] of faults) attention.push({ code, detail: `${component} could not be inspected without exposing deployment details.`, remedy: 'Inspect the protected service logs and restore the configured dependency.' });

  const basis = {
    schema: 'payload.corpus.control-plane.v1' as const,
    ecosystemId: 'payload:physical-economy' as const,
    generatedAt: input.generatedAt,
    freshnessPolicy: { projectionStaleAfterMs: input.projectionStaleAfterMs },
    topology: { nodes, relations },
    timeline: {
      afterSequence: input.artifactPage.afterSequence,
      nextAfterSequence: input.artifactPage.nextAfterSequence,
      hasMore: input.artifactPage.hasMore,
      events: timelineEvents,
    },
    dock: {
      temporal: {
        corpusBuildId: projection?.manifest.corpusBuildId ?? null,
        compiledAt: projection?.manifest.compiledAt ?? null,
        knowledgeCutoff: projection?.manifest.knowledgeCutoff ?? null,
        latestEventAt: input.recentArtifacts.at(-1)?.recordedAt ?? null,
      },
      spatial: latestResult?.artifactType === 'agent_result' && latestSpatial
        ? {
            status: 'READY' as const,
            resultId: latestResult.artifactId,
            spatialResultId: latestSpatial.spatialResultId,
            asOf: latestResult.payload.output.plan.asOf,
            knownAt: latestResult.payload.output.plan.knownAt,
            keplerGl: latestSpatial.keplerGl,
          }
        : {
            status: 'UNOBSERVED' as const,
            code: 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED' as const,
            detail: 'No durable spatial result is available; coordinates and flows are not fabricated for the dock.',
          },
    },
    operator: {
      counts: {
        healthy: byHealth('healthy').length,
        stale: byHealth('stale').length,
        blocked: byHealth('blocked').length,
        unobserved: byHealth('unobserved').length,
      },
      healthy: byHealth('healthy'),
      stale: byHealth('stale'),
      blocked: byHealth('blocked'),
      unobserved: byHealth('unobserved'),
      needsApproval: nodes.flatMap(entry => entry.capabilities
        .filter(item => item.approval.state === 'approval_required')
        .map(item => ({ nodeId: entry.nodeId, capabilityId: item.capabilityId, state: 'approval_required' as const }))),
      attention,
    },
  };
  return freeze({ ...basis, revision: `payload-control:${corpusVerificationDigest(basis)}` });
}
