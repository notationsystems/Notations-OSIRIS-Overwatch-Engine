/** Payload-specific control-plane projection over the physical-economy stack. */

import type { CorpusAgentArtifactPage, StoredCorpusAgentArtifact } from './corpusAgentArtifacts';
import type { CorpusKnowledgeIndexManifest } from './corpusKnowledgeIndex';
import { PAYLOAD_CORPUS_METHODOLOGY } from './corpusMethodology';
import type { CompiledCorpusProjection } from './corpusProjection';
import type { CorpusProjectionSource } from './physicalEconomyCorpus';
import type { Sp1ProgramIdentity } from './sp1ProgramIdentity';
import type { CorpusSpatialResult } from './corpusSpatialResult';
import type { NotationSubstrateStatus } from './notationSubstrateStore';
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
    readonly requirement: 'automatic' | 'compiler_credential' | 'projector_credential' | 'operator';
    readonly state: 'not_required' | 'not_requested' | 'approval_required';
  };
  readonly health: PayloadControlHealth;
  readonly latency: UnobservedMetric;
  readonly cost: UnobservedMetric;
  readonly provenanceRefs: readonly string[];
};

type PayloadTopologyNode = {
  readonly nodeId: string;
  readonly kind: 'canonical_corpus' | 'read_model' | 'knowledge_index' | 'api' | 'artifact_journal' | 'operational_ledger' | 'mcp_tool' | 'visual_dock' | 'data_source' | 'proof_program' | 'build_signer' | 'sync_worker' | 'federation_target';
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
      readonly kind: 'ingests_from' | 'projects' | 'serves' | 'persists_to' | 'packages' | 'visualizes' | 'attests' | 'proves' | 'synchronizes_to' | 'governs';
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
  readonly index: { readonly backend: 'sqlite'; readonly manifest: CorpusKnowledgeIndexManifest; readonly current: boolean } | null;
  readonly artifactBackend: 'sqlite' | 'postgresql' | null;
  readonly artifactPage: CorpusAgentArtifactPage;
  readonly recentArtifacts: readonly StoredCorpusAgentArtifact[];
  readonly currentBuildAttestation: StoredCorpusAgentArtifact | null;
  readonly substrate?: NotationSubstrateStatus | null;
  readonly sp1: Sp1ProgramIdentity;
  readonly faults?: readonly { readonly component: 'canonical' | 'projection' | 'index' | 'artifacts' | 'substrate'; readonly code: string }[];
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
  const indexStatus: PayloadControlHealth = faults.has('index') || !input.index ? 'blocked' : input.index.current ? 'healthy' : 'stale';
  const queryStatus: PayloadControlHealth = projectionStatus === 'blocked' || artifactStatus === 'blocked'
    ? 'blocked'
    : projectionStatus === 'stale' ? 'stale' : 'healthy';
  const substrateChannel = input.substrate?.channels.find(channel => channel.channelId === 'payload:public:global') ?? null;
  const substrateStatus: PayloadControlHealth = faults.has('substrate') || !input.substrate
    ? 'blocked'
    : !substrateChannel
      ? 'unobserved'
      : substrateChannel.acknowledgementLag > 0
        ? 'stale'
        : 'healthy';
  const substrateSourceSequence = projection?.manifest.sourceSequence ?? substrateChannel?.sourceSequence ?? null;
  const substrateSequenceLag = substrateChannel && substrateSourceSequence !== null ? Math.max(0, substrateSourceSequence - substrateChannel.lastIngestedSequence) : null;
  const substrateSyncStatus: PayloadControlHealth = projectionStatus === 'blocked' || substrateStatus === 'blocked'
    ? 'blocked'
    : projectionStatus === 'stale' || substrateStatus === 'stale' || (substrateSequenceLag ?? 0) > 0
      ? 'stale'
      : substrateStatus;
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
      [
        capability('projection.observe', 'observe', 'automatic', projectionStatus, projection ? [projection.manifest.projectionDigest, projection.manifest.policyLineageId] : []),
        capability('projection.preflight', 'execute', 'compiler_credential', projectionStatus, [PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest]),
      ],
      { corpusBuildId: projection?.manifest.corpusBuildId ?? null, recordCount: projection?.manifest.recordCount ?? 0, excludedRecords: projection?.manifest.excludedRecords ?? 0 }),
    node('payload:api:corpus-methodology', 'api', 'Inspectable corpus methodology API', 'healthy', input.generatedAt,
      'The immutable methodology contract exposes component versions, maturity, uncertainty, limitations, and deliberate non-claims.',
      [capability('methodology.observe', 'observe', 'automatic', 'healthy', [PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest])],
      { methodologyVersion: PAYLOAD_CORPUS_METHODOLOGY.methodologyVersion, methodologyDigest: PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest, capabilityCount: PAYLOAD_CORPUS_METHODOLOGY.capabilities.length }),
    node('payload:index:knowledge', 'knowledge_index', 'Build-bound corpus knowledge index', indexStatus, input.index?.manifest.builtAt ?? null,
      !input.index ? faults.get('index') ?? 'No corpus knowledge index is available.' : !input.index.current ? 'Index belongs to another public CorpusBuild and is refused for queries.' : 'Lexical, entity, relation, source, temporal, and spatial facets match the current CorpusBuild.',
      [
        capability('knowledge-index.search', 'observe', 'automatic', indexStatus, input.index ? [input.index.manifest.indexDigest] : []),
        capability('knowledge-index.coverage', 'observe', 'automatic', indexStatus, input.index ? [input.index.manifest.indexDigest] : []),
        capability('knowledge-index.rebuild', 'execute', 'compiler_credential', indexStatus, projection ? [projection.manifest.projectionDigest] : []),
      ],
      { backend: input.index?.backend ?? null, indexId: input.index?.manifest.indexId ?? null, documentCount: input.index?.manifest.documentCount ?? 0, postingCount: input.index?.manifest.postingCount ?? 0 }),
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
    node('payload:mcp:index-search', 'mcp_tool', 'search_payload_corpus_index', indexStatus, null, 'MCP tool searches the exact current knowledge index; lexical rank is not a trust score.',
      [capability('knowledge-index.search', 'observe', 'automatic', indexStatus, input.index ? [input.index.manifest.indexDigest] : [])]),
    node('payload:mcp:index-coverage', 'mcp_tool', 'get_payload_corpus_index_coverage', indexStatus, null, 'MCP tool returns typed observed and unobserved coverage for the indexed CorpusBuild.',
      [capability('knowledge-index.coverage', 'observe', 'automatic', indexStatus, input.index ? [input.index.manifest.indexDigest] : [])]),
    node('payload:mcp:methodology', 'mcp_tool', 'get_payload_corpus_methodology', 'healthy', null, 'MCP tool exposes the same versioned trust contract used by result sidecars and compiler preflight.',
      [capability('methodology.observe', 'observe', 'automatic', 'healthy', [PAYLOAD_CORPUS_METHODOLOGY.methodologyDigest])]),
    node('payload:api:notation-federation', 'api', 'Notation Data Substrate federation API', projectionStatus, projection?.manifest.compiledAt ?? null,
      projectionStatus === 'healthy' ? 'Ordered public sync envelopes are available from the exact current CorpusBuild.' : 'Federation is constrained by public projection state.',
      [
        capability('notation-sync.observe', 'observe', 'automatic', projectionStatus, projection ? [projection.manifest.projectionDigest] : []),
        capability('notation-sync.checkpoint', 'execute', 'projector_credential', projectionStatus, projection ? [projection.manifest.corpusBuildId] : []),
      ],
      { sourceNodeUri: 'notation://node/payload', destinationNodeUri: 'notation://node/substrate', scope: 'public/global', consumerCheckpointState: 'UNOBSERVED' }),
    node('payload:worker:notation-substrate-sync', 'sync_worker', 'Notation substrate ingestion worker', substrateSyncStatus, substrateChannel?.lastIngestedAt ?? null,
      !input.substrate ? faults.get('substrate') ?? 'The destination store is not configured.' : !substrateChannel ? 'The destination is readable, but no public federation page has been ingested.' : substrateSyncStatus === 'blocked' ? 'The public federation source or durable destination is unavailable.' : substrateSyncStatus === 'stale' ? 'Destination ingestion or source-checkpoint acknowledgement is behind the current public projection.' : 'Destination ingestion and source acknowledgement are current for the public channel.',
      [capability('notation-substrate.ingest', 'execute', 'automatic', substrateSyncStatus, substrateChannel ? [substrateChannel.projectionDigest] : [])],
      { channelId: substrateChannel?.channelId ?? 'payload:public:global', publicProjectionSequenceLag: substrateSequenceLag, acknowledgementLag: substrateChannel?.acknowledgementLag ?? null }),
    node('notation:substrate', 'federation_target', 'Notation Data Substrate', substrateStatus, substrateChannel?.lastIngestedAt ?? null,
      !input.substrate ? faults.get('substrate') ?? 'The destination store is not configured.' : !substrateChannel ? 'The store is available, but its public/global federation state is unobserved.' : substrateStatus === 'stale' ? 'The durable destination exposes an exact, non-zero ingestion or acknowledgement lag.' : 'Global identities, source records, semantic documents, acknowledgements, and lag telemetry are durable and current.',
      [
        capability('semantic-document.observe', 'observe', 'automatic', substrateStatus, substrateChannel ? [substrateChannel.projectionDigest] : []),
        capability('vector-projection.write', 'execute', 'projector_credential', substrateStatus, input.substrate?.vectorModels.map(model => `${model.modelId}@${model.modelVersion}`) ?? []),
        capability('vector-search.observe', 'observe', 'automatic', substrateStatus, input.substrate?.vectorModels.map(model => `${model.modelId}@${model.modelVersion}`) ?? []),
      ],
      { nodeUri: 'notation://node/substrate', authorityModel: 'one_logical_identity_space_many_physical_representations', identityCount: input.substrate?.counts.identities ?? 0, semanticDocumentCount: input.substrate?.counts.semanticDocuments ?? 0, vectorProjectionCount: input.substrate?.counts.vectorProjections ?? 0, vectorModelCount: input.substrate?.vectorModels.length ?? 0, embeddingProviderStatus: input.substrate?.boundaries.embeddingProviderStatus ?? 'UNOBSERVED' }),
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
    { relationId: 'projection-projects-index', sourceNodeId: 'payload:corpus:projection', targetNodeId: 'payload:index:knowledge', kind: 'projects' },
    { relationId: 'projection-serves-retrieval', sourceNodeId: 'payload:corpus:projection', targetNodeId: 'payload:api:corpus-retrieval', kind: 'serves' },
    { relationId: 'retrieval-persists-artifacts', sourceNodeId: 'payload:api:corpus-retrieval', targetNodeId: 'payload:journal:agent-artifacts', kind: 'persists_to' },
    { relationId: 'mcp-packages-retrieval', sourceNodeId: 'payload:mcp:query', targetNodeId: 'payload:api:corpus-retrieval', kind: 'packages' },
    { relationId: 'mcp-recovers-results', sourceNodeId: 'payload:mcp:result', targetNodeId: 'payload:journal:agent-artifacts', kind: 'serves' },
    { relationId: 'mcp-walks-projection', sourceNodeId: 'payload:mcp:warrant', targetNodeId: 'payload:corpus:projection', kind: 'serves' },
    { relationId: 'mcp-reads-attestations', sourceNodeId: 'payload:mcp:attestation', targetNodeId: 'payload:journal:agent-artifacts', kind: 'serves' },
    { relationId: 'mcp-searches-index', sourceNodeId: 'payload:mcp:index-search', targetNodeId: 'payload:index:knowledge', kind: 'serves' },
    { relationId: 'mcp-reads-index-coverage', sourceNodeId: 'payload:mcp:index-coverage', targetNodeId: 'payload:index:knowledge', kind: 'serves' },
    { relationId: 'mcp-reads-methodology', sourceNodeId: 'payload:mcp:methodology', targetNodeId: 'payload:api:corpus-methodology', kind: 'serves' },
    { relationId: 'methodology-governs-projection', sourceNodeId: 'payload:api:corpus-methodology', targetNodeId: 'payload:corpus:projection', kind: 'governs' },
    { relationId: 'projection-serves-federation', sourceNodeId: 'payload:corpus:projection', targetNodeId: 'payload:api:notation-federation', kind: 'serves' },
    { relationId: 'federation-serves-substrate-worker', sourceNodeId: 'payload:api:notation-federation', targetNodeId: 'payload:worker:notation-substrate-sync', kind: 'synchronizes_to' },
    { relationId: 'substrate-worker-persists-destination', sourceNodeId: 'payload:worker:notation-substrate-sync', targetNodeId: 'notation:substrate', kind: 'persists_to' },
    { relationId: 'kepler-visualizes-results', sourceNodeId: 'payload:journal:agent-artifacts', targetNodeId: 'payload:dock:kepler', kind: 'visualizes' },
    { relationId: 'signer-attests-projection', sourceNodeId: 'payload:attestation:ed25519', targetNodeId: 'payload:corpus:projection', kind: 'attests' },
    { relationId: 'sp1-proves-event-batches', sourceNodeId: 'payload:proof:payload-event-batch-v1', targetNodeId: 'payload:operations:event-ledger', kind: 'proves' },
    ...[...sourceIds.keys()].sort().map(sourceId => ({ relationId: `corpus-ingests-${corpusVerificationDigest(sourceId).slice(0, 16)}`, sourceNodeId: 'payload:corpus:canonical', targetNodeId: `payload:source:${sourceId}`, kind: 'ingests_from' as const })),
  ];

  const timelineEvents = input.artifactPage.artifacts.map(artifactEvent);
  const byHealth = (status: PayloadControlHealth) => nodes.filter(entry => entry.health.status === status).map(entry => entry.nodeId);
  const attention: PayloadCorpusControlPlaneSnapshot['operator']['attention'][number][] = [];
  if (projectionStatus === 'stale') attention.push({ code: 'CORPUS_PROJECTION_STALE', detail: 'The public projection is behind canonical state or outside its freshness window.', remedy: 'Run the authenticated corpus compiler and verify replay equivalence before replacing the read model.' });
  if (indexStatus === 'blocked') attention.push({ code: faults.get('index') ?? 'CORPUS_INDEX_NOT_BUILT', detail: 'The build-bound corpus knowledge index is unavailable.', remedy: 'Use compiler authority to rebuild the disposable index from the exact current public CorpusBuild.' });
  if (indexStatus === 'stale') attention.push({ code: 'CORPUS_INDEX_STALE', detail: 'The knowledge index does not identify the current public CorpusBuild.', remedy: 'Replace it atomically from the current projection; do not merge index generations.' });
  if (substrateSyncStatus === 'blocked') attention.push({ code: faults.get('substrate') ?? 'NOTATION_SUBSTRATE_SYNC_BLOCKED', detail: 'The public federation source or durable Notation destination cannot support synchronization.', remedy: 'Restore the current public projection, configure PAYLOAD_NOTATION_SUBSTRATE_DATABASE_PATH on persistent storage, and start the authenticated sync worker.' });
  if (substrateSyncStatus === 'stale') attention.push({ code: 'NOTATION_SUBSTRATE_SYNC_LAG', detail: `The public channel has ${substrateSequenceLag ?? 0} un-ingested projected records and ${substrateChannel?.acknowledgementLag ?? 0} destination acknowledgements not checkpointed upstream.`, remedy: 'Inspect the worker, restore source connectivity, and allow idempotent pull/ack recovery; do not advance either cursor manually.' });
  if (substrateStatus === 'unobserved') attention.push({ code: 'NOTATION_SUBSTRATE_CHANNEL_UNOBSERVED', detail: 'The destination store is available but has not observed the public/global channel.', remedy: 'Run one authenticated substrate synchronization cycle.' });
  if (projection && !currentAttestation) attention.push({ code: 'CORPUS_BUILD_UNSIGNED', detail: `CorpusBuild ${projection.manifest.corpusBuildId} has no stored Ed25519 attestation.`, remedy: 'After reviewing the exact commitment, use the compiler-authenticated attestation endpoint.' });
  if (!latestSpatial) attention.push({ code: 'PAYLOAD_SPATIAL_RESULT_UNOBSERVED', detail: 'No persisted agent result currently feeds the Kepler dock.', remedy: 'Run an evidence-budgeted corpus query whose entities carry observed coordinates.' });
  for (const [component, code] of faults) {
    if (component === 'index' || component === 'substrate') continue; // already carry component-specific remedies above
    attention.push({ code, detail: `${component} could not be inspected without exposing deployment details.`, remedy: 'Inspect the protected service logs and restore the configured dependency.' });
  }

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
