import { afterEach, describe, expect, it } from 'vitest';
import { CORPUS_MCP_TOOLS } from './corpusMcpTools';
import type { McpContext } from './mcpTools';

const oldToken = process.env.PAYLOAD_CORPUS_QUERY_TOKEN;

afterEach(() => {
  if (oldToken === undefined) delete process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
  else process.env.PAYLOAD_CORPUS_QUERY_TOKEN = oldToken;
});

describe('agent-facing corpus MCP package', () => {
  it('exposes retrieval, lineage, index, coverage, attestation, and Payload control-plane tools', () => {
    expect(CORPUS_MCP_TOOLS.map(tool => tool.name)).toEqual([
      'query_payload_corpus',
      'get_payload_corpus_result',
      'get_payload_corpus_warrant',
      'get_payload_corpus_attestation',
      'search_payload_corpus_index',
      'get_payload_corpus_index_coverage',
      'get_payload_control_plane',
      'get_payload_substrate_status',
      'get_payload_corpus_methodology',
    ]);
    expect(CORPUS_MCP_TOOLS[0].description).toContain('kepler.gl addDataToMap');
    expect(CORPUS_MCP_TOOLS[0].description).toContain('Neither state proves source truth');
  });

  it('exposes the same inspectable methodology contract to agents', async () => {
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    let path = '';
    const context: McpContext = { async fetchJson(value) { path = value; return { status: 200, body: { kind: 'payload_corpus_methodology' } }; } };
    const result = await CORPUS_MCP_TOOLS[8].handler({}, context);
    expect(path).toBe('/api/corpus/methodology?view=full');
    expect(result).toMatchObject({ kind: 'payload_corpus_methodology' });
  });

  it('exposes destination ingestion, acknowledgement, lag, and vector projection state', async () => {
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    let path = '';
    const context: McpContext = { async fetchJson(value) { path = value; return { status: 200, body: { kind: 'notation_substrate_status' } }; } };
    const result = await CORPUS_MCP_TOOLS[7].handler({}, context);
    expect(path).toBe('/api/corpus/substrate?view=status');
    expect(result).toMatchObject({ kind: 'notation_substrate_status' });
  });

  it('maps typed mining facets onto the build-bound index API', async () => {
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    let path = '';
    const context: McpContext = { async fetchJson(value) { path = value; return { status: 200, body: { kind: 'corpus_knowledge_index_search' } }; } };
    await CORPUS_MCP_TOOLS[4].handler({ query: 'polymer terminal', entityKinds: ['facility'], predicates: ['depends_on'], west: -80, south: 43, east: -79, north: 44, limit: 12 }, context);
    expect(path).toContain('/api/corpus/index?');
    expect(path).toContain('q=polymer+terminal');
    expect(path).toContain('entityKinds=facility');
    expect(path).toContain('predicates=depends_on');
    expect(path).toContain('limit=12');
    await CORPUS_MCP_TOOLS[5].handler({}, context);
    expect(path).toBe('/api/corpus/index?view=coverage');
  });

  it('maps an explicit knowledge state and evidence budget onto the authenticated retrieval route', async () => {
    process.env.PAYLOAD_CORPUS_QUERY_TOKEN = 'QUERY-TOKEN';
    let captured: { path: string; init?: { method?: string; body?: string; headers?: Readonly<Record<string, string>> } } | null = null;
    const context: McpContext = {
      async fetchJson(path, init) {
        captured = { path, init };
        return { status: 201, body: { kind: 'corpus_agent_context', resultId: 'corpus-result:test' } };
      },
    };
    const result = await CORPUS_MCP_TOOLS[0].handler({
      query: 'Which facilities depend on this port?',
      asOf: '2026-09-02T12:00:00.000Z',
      knowledgeMode: 'as_known_then',
      evidenceLevel: 'VERIFIED',
      entityIds: ['pe:port:test'],
      predicates: ['depends_on'],
      direction: 'inbound',
      maxHops: 2,
    }, context);
    expect(result).toMatchObject({ resultId: 'corpus-result:test' });
    expect(captured).toMatchObject({ path: '/api/corpus/retrieval', init: { method: 'POST', headers: { authorization: 'Bearer QUERY-TOKEN' } } });
    const body = JSON.parse(captured!.init!.body!);
    expect(body).toMatchObject({ mode: 'agent', evidenceLevel: 'VERIFIED', asOf: '2026-09-02T12:00:00.000Z', knownAt: '2026-09-02T12:00:00.000Z', traversal: { predicates: ['depends_on'], direction: 'inbound', maxHops: 2 } });
  });

  it('fails closed without forwarding a request when the query token is absent', async () => {
    delete process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
    let called = false;
    const context: McpContext = { async fetchJson() { called = true; return { status: 200, body: {} }; } };
    const result = await CORPUS_MCP_TOOLS[1].handler({ resultId: 'corpus-result:test' }, context);
    expect(result).toMatchObject({ kind: 'refusal', code: 'CORPUS_QUERY_NOT_CONFIGURED' });
    expect(called).toBe(false);
  });
});
