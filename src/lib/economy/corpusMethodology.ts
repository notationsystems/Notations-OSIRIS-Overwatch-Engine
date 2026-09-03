/** Inspectable methodology and publication preflight for the Payload corpus. */

import { CORPUS_ENGINE_ID, CORPUS_ENGINE_VERSION } from './corpusDefinition';
import { CORPUS_KNOWLEDGE_INDEX_VERSION } from './corpusKnowledgeIndex';
import { CORPUS_POLICY_VERSION } from './corpusPolicy';
import { CORPUS_COMPILER_VERSION, CORPUS_RECORD_SCHEMA_VERSION } from './corpusProjection';
import { PAYLOAD_CORPUS_METHODOLOGY_VERSION, PAYLOAD_CORPUS_PREFLIGHT_VERSION } from './corpusMethodologyVersions';
import {
  CORPUS_ONTOLOGY_VERSION,
  PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION,
  PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID,
} from './payloadCorpusDefinition';
import { corpusVerificationDigest } from './corpusVerification';

export { PAYLOAD_CORPUS_METHODOLOGY_VERSION, PAYLOAD_CORPUS_PREFLIGHT_VERSION } from './corpusMethodologyVersions';

export type PayloadCapabilityMaturity = 'PRODUCTION' | 'BETA' | 'EXPERIMENTAL' | 'RESEARCH' | 'PLANNED';

export type PayloadCapabilityDeclaration = {
  readonly capabilityId: string;
  readonly status: PayloadCapabilityMaturity;
  readonly methodologyVersion: typeof PAYLOAD_CORPUS_METHODOLOGY_VERSION;
  readonly implementation: 'AVAILABLE' | 'PARTIAL' | 'NOT_IMPLEMENTED';
  readonly validatedAgainst: readonly string[];
  readonly limitations: readonly string[];
};

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const capability = (
  capabilityId: string,
  status: PayloadCapabilityMaturity,
  implementation: PayloadCapabilityDeclaration['implementation'],
  validatedAgainst: readonly string[],
  limitations: readonly string[],
): PayloadCapabilityDeclaration => freeze({ capabilityId, status, methodologyVersion: PAYLOAD_CORPUS_METHODOLOGY_VERSION, implementation, validatedAgainst: [...validatedAgainst], limitations: [...limitations] });

const capabilities = Object.freeze([
  capability('canonical-corpus', 'PRODUCTION', 'AVAILABLE', ['append/replay invariant suite', 'restart hash-chain verification', 'bitemporal query tests'], ['SQLite is the edge authority until PostgreSQL replay equivalence is accepted.']),
  capability('public-corpus-compiler', 'PRODUCTION', 'AVAILABLE', ['policy non-interference tests', 'projection replay tests', PAYLOAD_CORPUS_PREFLIGHT_VERSION], ['Only public/global projection is publishable in V0.']),
  capability('agent-result-sidecar', 'BETA', 'AVAILABLE', ['immutable artifact-journal tests', 'evidence-budget monotonicity tests'], ['The sidecar binds deterministic substrate outputs; free-form model prose is not zk-proven.']),
  capability('warrant-graph', 'BETA', 'AVAILABLE', ['Merkle membership tests', 'contradiction preservation tests'], ['No composite trust score is emitted.']),
  capability('dependency-mining', 'BETA', 'AVAILABLE', ['depth-1 shared fan-in fixtures', 'candidate non-promotion tests'], ['Only explicit depth-1 depends_on relationships are mined.']),
  capability('divergence-mining', 'EXPERIMENTAL', 'PARTIAL', ['economy divergence regression suite'], ['The physical-economy CorpusBuild does not yet expose a generalized cross-metric divergence program.']),
  capability('semantic-vector-index', 'BETA', 'PARTIAL', ['exact document-hash/model-version tests', 'cosine-boundary tests'], ['No embedding provider is configured by the corpus methodology; supplied vectors are external inputs.']),
  capability('internal-federation', 'PLANNED', 'NOT_IMPLEMENTED', [], ['The channel contract exists but has no separately governed projection compiler.']),
  capability('customer-federation', 'PLANNED', 'NOT_IMPLEMENTED', [], ['Tenant entitlements and customer projection compilers are not implemented.']),
  capability('corpus-build-zk-proof', 'RESEARCH', 'NOT_IMPLEMENTED', [], ['The pinned SP1 program proves operational event batches, not CorpusBuild correctness.']),
]);

const methodologyBasis = {
  schema: 'payload.corpus.methodology.v1' as const,
  methodologyId: 'payload:methodology:physical-economy' as const,
  methodologyVersion: PAYLOAD_CORPUS_METHODOLOGY_VERSION,
  corpusEngine: { id: CORPUS_ENGINE_ID, version: CORPUS_ENGINE_VERSION },
  scope: {
    corpus: 'Machine-queryable, provenance-preserving physical-economy state.',
    domains: ['organizations', 'facilities', 'commodities', 'suppliers', 'trade', 'logistics', 'ports', 'vessels', 'infrastructure', 'markets', 'flows', 'events'],
    publication: 'Policy-filtered public/global records only.',
  },
  versions: {
    corpusDefinition: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionId,
    corpusDefinitionFingerprint: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.definitionFingerprint,
    ontology: CORPUS_ONTOLOGY_VERSION,
    recordSchema: CORPUS_RECORD_SCHEMA_VERSION,
    sourcePolicy: CORPUS_POLICY_VERSION,
    extraction: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.extractionRules,
    entityResolution: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.resolutionRules,
    validation: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.validationRules,
    compiler: CORPUS_COMPILER_VERSION,
    knowledgeIndex: CORPUS_KNOWLEDGE_INDEX_VERSION,
    mining: [PAYLOAD_SHARED_DEPENDENCY_MINING_PROGRAM_ID],
    contextCompiler: 'notation:agent-context-compiler@1.0.0',
    preflight: PAYLOAD_CORPUS_PREFLIGHT_VERSION,
  },
  sourceClasses: PAYLOAD_PHYSICAL_ECONOMY_CORPUS_DEFINITION.sourceRegistry.sourceClasses,
  process: {
    ingestion: 'Append-only typed records; missing classifications and broken evidence closure are refused.',
    extraction: 'Extraction identity, version, locator, content hash, and optional uncalibrated extractor score remain attached.',
    normalization: 'Units and bases remain explicit; incompatible bases are not silently combined.',
    entityResolution: 'Canonical ID or evidenced alias only; name similarity never mutates canonical identity.',
    temporalSemantics: 'valid-time and knownAt are distinct; as-known-then queries cannot use later knowledge.',
    evidence: 'Assertions retain observation, evidence-unit, artifact, and source lineage.',
    contradictions: 'Conflicting observations remain visible and are not averaged away.',
    graphConstruction: 'Typed canonical relationships form the logical graph; renderer adjacency is not a surveyed route.',
    spatial: 'OGC:CRS84 longitude/latitude with explicit precision; missing geometry remains unobserved.',
    licensing: 'Every emitted object passes purpose, visibility, license, redistribution, derivation, and dependency policy.',
    verification: 'Provenance is universal; reproducibility and cryptographic verification are added only where implemented.',
  },
  uncertaintySemantics: [
    { object: 'reported_fact', representation: 'source disagreement and contradiction state' },
    { object: 'statistical_estimate', representation: 'interval or distribution when the estimator supplies one' },
    { object: 'entity_resolution', representation: 'candidate set and review state; no generic confidence scalar' },
    { object: 'mined_pattern', representation: 'support, stability, program version, and validation state' },
    { object: 'spatial_estimate', representation: 'coordinate precision and geometric uncertainty' },
  ],
  deliberateNonClaims: [
    'Payload does not infer supplier relationships solely from spatial proximity.',
    'Payload does not present modeled capacity as reported capacity.',
    'Payload does not equate corporate ownership with operational control.',
    'Payload does not interpret missing observations as zero.',
    'Payload does not treat vector similarity as truth, confidence, causality, or materiality.',
    'Payload does not claim that a valid computation proves its source observations are empirically true.',
    'Payload does not publish planned capability as an available feature.',
  ],
  knownLimitations: [
    'Automated broad-source acquisition and generalized entity-resolution review are incomplete.',
    'Internal and customer federation projections are not implemented.',
    'Corpus-build SP1 proof generation is not implemented.',
    'A generalized corpus-native divergence miner and challenge registry remain future work.',
  ],
  capabilities,
  changelog: [{ version: PAYLOAD_CORPUS_METHODOLOGY_VERSION, changedAt: '2026-09-02', changes: ['Initial inspectable methodology contract.', 'Capability maturity and deliberate non-claim vocabulary.', 'Publication preflight definition.'] }],
};

export const PAYLOAD_CORPUS_METHODOLOGY = freeze({
  ...methodologyBasis,
  methodologyDigest: corpusVerificationDigest(methodologyBasis),
});
