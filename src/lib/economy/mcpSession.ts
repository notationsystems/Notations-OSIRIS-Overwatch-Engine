/**
 * Sea Dog Terminal — MCP session log and route-around telemetry (final
 * order F-4).
 *
 * You cannot prevent an external model from ignoring a refusal and
 * answering from its training data. You CAN observe the signature: a
 * session that hits a refusal and then goes quiet answered from
 * somewhere else. This module logs, per MCP session, which tools were
 * called and how many refusals each call surfaced — and computes a
 * ROUTE-AROUND ESTIMATE from that record.
 *
 * THE ESTIMATE IS A PROXY AND SAYS SO IN ITS OWN PAYLOAD. "Went quiet
 * after a refusal" is consistent with routing around the refusal, with
 * the analyst being satisfied by the remedy, and with the session simply
 * ending. A proxy reported as a measurement is the defect this project
 * exists to refuse, so the method travels with the number.
 *
 * NO PARAMETER VALUES ARE EVER LOGGED — tool names, counts and
 * timestamps only. The vocabulary gate holds here by construction: free
 * text cannot leak into a log that never stores it.
 */

import { processSingleton } from './processSingleton';

export interface McpCallRecord {
  ts: string;
  /** Opaque per-process session id — one MCP server process is one session. */
  session: string;
  tool: string;
  /** Refusal-shaped content surfaced by this call: refusal rows, null-hhi
   *  blocks, withheld counts — counted by the tool layer, never inferred. */
  refusals: number;
}

/* In-memory record for the running process (one MCP session), on
 * globalThis: module-level state is severable by module duplication, and
 * a severed route-around log would compute its estimate over half the
 * calls while looking correct. See processSingleton.ts. */
const store = () => processSingleton('mcp-session', () => ({
  calls: [] as McpCallRecord[],
  sessionId: `mcp-${Math.random().toString(36).slice(2, 10)}`,
}));

export function recordMcpCall(tool: string, refusals: number): McpCallRecord {
  const s = store();
  const rec: McpCallRecord = { ts: new Date().toISOString(), session: s.sessionId, tool, refusals };
  s.calls.push(rec);
  void appendMcpLog(rec);
  return rec;
}

export function mcpSessionCalls(): McpCallRecord[] {
  return [...store().calls];
}

/** Test seam: a simulated session must start from zero. */
export function resetMcpSession(id?: string): void {
  const s = store();
  s.calls.length = 0;
  s.sessionId = id ?? `mcp-${Math.random().toString(36).slice(2, 10)}`;
}

/** Same env seams as the miss log / export log; suppressed under test
 *  unless the readiness seam forces the real write path. */
async function appendMcpLog(rec: McpCallRecord): Promise<void> {
  if (process.env.VITEST && process.env.SEA_DOG_FORCE_MISS_LOG !== '1') return;
  try {
    const fs = await import('node:fs/promises');
    const dir = process.env.SEA_DOG_MISS_LOG_DIR ?? `${process.cwd()}/data-archive`;
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(`${dir}/mcp-sessions.jsonl`, JSON.stringify(rec) + '\n');
  } catch { /* best-effort by design */ }
}

export interface RouteAroundEstimate {
  /** Sessions whose record contains at least one refusal-bearing call. */
  sessionsWithRefusals: number;
  /** Of those, sessions whose LAST call was refusal-bearing — the
   *  refuse-then-quiet signature. */
  quietAfterRefusal: number;
  /** quietAfterRefusal / sessionsWithRefusals, null when the denominator
   *  is zero — a rate over nothing is not a rate. */
  estimate: number | null;
  method: string;
}

/** Pure: computable over this process's calls or a parsed JSONL history. */
export function routeAroundEstimate(records: McpCallRecord[]): RouteAroundEstimate {
  const bySession = new Map<string, McpCallRecord[]>();
  for (const r of records) {
    const arr = bySession.get(r.session) ?? [];
    arr.push(r);
    bySession.set(r.session, arr);
  }
  let withRefusals = 0;
  let quiet = 0;
  for (const arr of bySession.values()) {
    arr.sort((a, b) => a.ts.localeCompare(b.ts));
    if (!arr.some(r => r.refusals > 0)) continue;
    withRefusals += 1;
    if (arr[arr.length - 1].refusals > 0) quiet += 1;
  }
  return {
    sessionsWithRefusals: withRefusals,
    quietAfterRefusal: quiet,
    estimate: withRefusals > 0 ? Number((quiet / withRefusals).toFixed(3)) : null,
    method: 'PROXY, not a measurement: a session whose last recorded tool call surfaced a refusal is counted as "went quiet after a refusal". That signature is consistent with routing around the refusal via training data, but also with the remedy having answered the question, or the session simply ending. Interpret as an upper bound on observable route-around, over sessions this log saw.',
  };
}
