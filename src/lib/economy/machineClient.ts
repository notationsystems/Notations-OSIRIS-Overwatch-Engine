/**
 * Sea Dog Terminal — machine-client segregation (final order F-2/F-6).
 *
 * The S-7 continue criterion is FROZEN and its three demand instruments
 * (miss log, refusals digest, session telemetry — and the export log it
 * reads) were defined over researcher sessions before any machine client
 * existed. A request carrying this header is served identically but
 * counted separately: it never increments the human session counters,
 * never writes the miss log or the export log, and is observed instead
 * by the MCP session log (mcpSession.ts). This is not the F-6 exposure
 * decision — it is the engineering default that preserves the frozen
 * criterion's meaning; folding machine traffic INTO the demand signals
 * would be the decision, and that one is the operator's at S-9.
 */

export const MACHINE_CLIENT_HEADER = 'x-sea-dog-client';

export function isMachineClient(request: Request): boolean {
  return request.headers.get(MACHINE_CLIENT_HEADER) === 'machine';
}
