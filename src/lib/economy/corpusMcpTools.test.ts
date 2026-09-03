import { afterEach, describe, expect, it } from 'vitest';
import { CORPUS_MCP_TOOLS } from './corpusMcpTools';
import type { McpContext } from './mcpTools';

const oldToken = process.env.PAYLOAD_CORPUS_QUERY_TOKEN;

afterEach(() => {
  if (oldToken === undefined) delete process.env.PAYLOAD_CORPUS_QUERY_TOKEN;
  else process.env.PAYLOAD_CORPUS_QUERY_TOKEN = oldToken;
});

describe('agent-facing corpus MCP package', () => {
  it('exposes bounded query, result, warrant, attestation, and Payload control-plane tools', () => {
    expect(CORPUS_MCP_TOOLS.map(tool => tool.name)).toEqual([
      'query_payload_corpus',
      'get_payload_corpus_result',
      'get_payload_corpus_warrant',
      'get_payload_corpus_attestation',
      'get_payload_control_plane',
    ]);
    expect(CORPUS_MCP_TOOLS[0].description).toContain('kepler.gl addDataToMap');
    expect(CORPUS_MCP_TOOLS[0].description).toContain('Neither state proves source truth');
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
