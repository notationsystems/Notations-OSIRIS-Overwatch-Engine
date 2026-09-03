/** Agent-facing MCP package over the authenticated corpus HTTP contracts. */

import { z } from 'zod';
import type { McpContext } from './mcpTools';
import { env } from './envCompat';

export type CorpusMcpToolDef = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodTypeAny>;
  readonly handler: (args: Record<string, unknown>, context: McpContext) => Promise<unknown>;
};

const id = z.string().min(3).max(256);
const instant = z.string().datetime({ offset: true });
const evidenceLevel = z.enum(['FAST', 'GROUNDED', 'AUDIT', 'VERIFIED']);
const recordType = z.enum(['evidence', 'evidence_unit', 'entity', 'alias', 'relationship', 'observation', 'assertion']);
const entityKind = z.enum(['organization', 'facility', 'material', 'commodity', 'supplier', 'port', 'vessel', 'infrastructure', 'process', 'network', 'market', 'flow', 'event', 'geography']);
const predicate = z.enum(['operated_by', 'owned_by', 'located_in', 'produces', 'consumes', 'transforms', 'supplies', 'connects_to', 'ships_via', 'trades_in', 'substitutes_for', 'depends_on', 'calls_at', 'carries', 'loads_at', 'unloads_at', 'moves_between', 'routes_via', 'affected_by', 'observed_at', 'priced_by']);

function authHeaders(): Readonly<Record<string, string>> | null {
  const token = env('PAYLOAD_CORPUS_QUERY_TOKEN')?.trim();
  return token ? { authorization: `Bearer ${token}` } : null;
}

function notConfigured() {
  return {
    kind: 'refusal',
    code: 'CORPUS_QUERY_NOT_CONFIGURED',
    detail: 'The MCP corpus package is fail-closed until PAYLOAD_CORPUS_QUERY_TOKEN is configured.',
    remedy: 'Attach a dedicated query token to the MCP server process; do not reuse compiler or ingestion credentials.',
  };
}

async function query(context: McpContext, path: string, init?: { readonly method?: string; readonly body?: string }): Promise<unknown> {
  const headers = authHeaders();
  if (!headers) return notConfigured();
  const response = await context.fetchJson(path, { ...init, headers });
  return response.body;
}

function knownAt(args: Record<string, unknown>): string | undefined {
  return args.knowledgeMode === 'as_known_then' ? String(args.asOf) : undefined;
}

const corpusMcpTools: CorpusMcpToolDef[] = [
  {
    name: 'query_payload_corpus',
    description: 'Compile and durably record a bounded Payload physical-economy context for an agent. Requires an explicit valid-time instant, knowledge mode, and evidence budget. Returns canonical assertions, provenance, typed unknowns, a stable resultId, and a renderer-neutral spatial projection with a kepler.gl addDataToMap payload. VERIFIED means Merkle membership; it becomes ATTESTED only when the exact CorpusBuild has a valid stored Ed25519 signature. Neither state proves source truth.',
    inputSchema: {
      query: z.string().min(2).max(500).describe('Research question or entity phrase.'),
      asOf: instant.describe('REQUIRED valid-time instant for the physical-world state.'),
      knowledgeMode: z.enum(['best_known', 'as_known_then']).describe('REQUIRED. best_known uses the current build; as_known_then requires a projection compiled at that exact knowledge time.'),
      evidenceLevel: evidenceLevel.describe('FAST, GROUNDED, AUDIT, or VERIFIED. Higher levels add evidence without changing assertion identity.'),
      entityIds: z.array(id).max(20).optional().describe('Optional canonical Payload entity IDs.'),
      propertyKeys: z.array(z.string().min(1).max(128)).max(50).optional().describe('Optional assertion property keys.'),
      predicates: z.array(z.string().min(1).max(64)).max(12).optional().describe('Optional typed relationship predicates.'),
      direction: z.enum(['outbound', 'inbound', 'both']).optional().describe('Traversal direction; defaults outbound when predicates are present.'),
      maxHops: z.number().int().min(1).max(4).optional().describe('Traversal depth, bounded to 1..4.'),
      evidenceQuery: z.string().min(2).max(500).optional().describe('Optional evidence search phrase.'),
    },
    async handler(args, context) {
      const predicates = Array.isArray(args.predicates) ? args.predicates : [];
      const body = {
        mode: 'agent',
        query: args.query,
        asOf: args.asOf,
        ...(knownAt(args) ? { knownAt: knownAt(args) } : {}),
        evidenceLevel: args.evidenceLevel,
        ...(Array.isArray(args.entityIds) ? { entityIds: args.entityIds } : {}),
        ...(Array.isArray(args.propertyKeys) ? { propertyKeys: args.propertyKeys } : {}),
        ...(predicates.length ? { traversal: { predicates, ...(args.direction ? { direction: args.direction } : {}), ...(args.maxHops ? { maxHops: args.maxHops } : {}) } } : {}),
        ...(args.evidenceQuery ? { evidenceQuery: args.evidenceQuery } : {}),
      };
      return query(context, '/api/corpus/retrieval', { method: 'POST', body: JSON.stringify(body) });
    },
  },
  {
    name: 'get_payload_corpus_result',
    description: 'Retrieve one immutable agent result by its stable resultId. The result includes the original retrieval plan, evidence-budgeted context, spatial/kepler.gl projection, journal sequence, and artifact hash.',
    inputSchema: { resultId: id.describe('Stable corpus-result: identifier returned by query_payload_corpus.') },
    handler: (args, context) => query(context, `/api/corpus/retrieval?resultId=${encodeURIComponent(String(args.resultId))}`),
  },
  {
    name: 'get_payload_corpus_warrant',
    description: 'Walk the score-free provenance graph for exactly one canonical record or entity. Contradictions remain separate edges; no composite trust score is produced.',
    inputSchema: {
      recordId: id.optional().describe('Exactly one canonical record ID.'),
      entityId: id.optional().describe('Exactly one canonical entity ID.'),
      maximumRecords: z.number().int().min(1).max(500).optional().describe('Maximum provenance records to return.'),
    },
    handler(args, context) {
      const params = new URLSearchParams();
      if (args.recordId) params.set('recordId', String(args.recordId));
      if (args.entityId) params.set('entityId', String(args.entityId));
      if (args.maximumRecords) params.set('maximumRecords', String(args.maximumRecords));
      return query(context, `/api/corpus/warrants?${params}`);
    },
  },
  {
    name: 'get_payload_corpus_attestation',
    description: 'Retrieve the latest Ed25519 signature for a CorpusBuild and the separately scoped production SP1 program identity. The response explicitly states that the operational event-batch SP1 key does not prove this corpus build.',
    inputSchema: { corpusBuildId: id.describe('Exact corpus-build: identifier.') },
    handler: (args, context) => query(context, `/api/corpus/attestations?corpusBuildId=${encodeURIComponent(String(args.corpusBuildId))}`),
  },
  {
    name: 'search_payload_corpus_index',
    description: 'Search the exact current policy-filtered CorpusBuild through its deterministic lexical and faceted index. Results retain canonical records and provenance references. The score is lexical relevance only—not truth, confidence, materiality, or investment quality.',
    inputSchema: {
      query: z.string().min(2).max(500).describe('Lexical search query.'),
      recordTypes: z.array(recordType).max(7).optional(),
      entityKinds: z.array(entityKind).max(16).optional(),
      predicates: z.array(predicate).max(25).optional(),
      sourceIds: z.array(id).max(50).optional(),
      asOf: instant.optional().describe('Optional valid-time ceiling.'),
      knownAt: instant.optional().describe('Optional knowledge-time ceiling.'),
      west: z.number().min(-180).max(180).optional(),
      south: z.number().min(-90).max(90).optional(),
      east: z.number().min(-180).max(180).optional(),
      north: z.number().min(-90).max(90).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    handler(args, context) {
      const params = new URLSearchParams({ q: String(args.query) });
      for (const key of ['recordTypes', 'entityKinds', 'predicates', 'sourceIds'] as const) if (Array.isArray(args[key])) params.set(key, args[key].map(String).join(','));
      for (const key of ['asOf', 'knownAt', 'west', 'south', 'east', 'north', 'limit'] as const) if (args[key] !== undefined) params.set(key, String(args[key]));
      return query(context, `/api/corpus/index?${params}`);
    },
  },
  {
    name: 'get_payload_corpus_index_coverage',
    description: 'Inspect typed record, entity, relationship, observation, source, temporal, and spatial coverage for the exact current index. A coverage gap means unobserved in this CorpusBuild, never absent from the physical world.',
    inputSchema: {},
    handler: (_args, context) => query(context, '/api/corpus/index?view=coverage'),
  },
  {
    name: 'get_payload_control_plane',
    description: 'Inspect this Payload node: canonical corpus, projection/index/federation freshness, APIs, MCP tools, evidence sources, persistent agent-result timeline, Kepler dock, build signatures, and the separately scoped SP1 program. Health, latency, cost, approval, and dispatch states remain typed and are never inferred from configuration alone.',
    inputSchema: {
      afterSequence: z.number().int().min(0).optional().describe('Optional immutable artifact-journal cursor.'),
      limit: z.number().int().min(1).max(500).optional().describe('Maximum timeline events to return.'),
    },
    handler(args, context) {
      const params = new URLSearchParams();
      if (args.afterSequence !== undefined) params.set('afterSequence', String(args.afterSequence));
      if (args.limit !== undefined) params.set('limit', String(args.limit));
      return query(context, `/api/corpus/control-plane${params.size ? `?${params}` : ''}`);
    },
  },
  {
    name: 'get_payload_substrate_status',
    description: 'Inspect the durable Notation destination: global identity and record counts, public-channel ingestion and upstream acknowledgement cursors, exact lag, semantic-document coverage, and observed vector model/version projections. An unobserved embedding provider or zero vector count is returned explicitly rather than inferred.',
    inputSchema: {},
    handler: (_args, context) => query(context, '/api/corpus/substrate?view=status'),
  },
];

export const CORPUS_MCP_TOOLS: readonly CorpusMcpToolDef[] = Object.freeze(corpusMcpTools);
