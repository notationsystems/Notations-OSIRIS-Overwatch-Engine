/**
 * Payload Terminal — MCP server entry (final order F-2).
 *
 * Run:  PAYLOAD_URL=http://localhost:3000 npm run mcp
 * (stdio transport — configure in a client as command "npm", args
 * ["run","mcp"], cwd this repo, with the terminal serving on PAYLOAD_URL.)
 *
 * The server is a THIN CONTRACT LAYER over the running terminal's own
 * HTTP routes — one logic path, nothing to drift. It carries the
 * machine-client header on every request, so machine traffic never
 * lands in the frozen S-7 demand instruments; it is observed instead by
 * the MCP session log (F-4). Stdio transport means attaching requires
 * local access to the machine running the terminal: the external
 * EXPOSURE decision (auth, machine licensing) stays untaken, as F-6
 * requires — this file opens no port.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MCP_TOOLS, httpContext, runMcpTool } from '../lib/economy/mcpTools';
import { VERSION } from '../lib/identity';
import { env } from '../lib/economy/envCompat';
import { CORPUS_MCP_TOOLS } from '../lib/economy/corpusMcpTools';

const ctx = httpContext();

// The name an external model client sees when it attaches: an outbound
// identity, so it comes from the same module the User-Agents do.
const server = new McpServer({ name: 'payload-terminal', version: VERSION });

for (const def of MCP_TOOLS) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, desc] of Object.entries(def.params)) {
    if (key === 'asOf') shape[key] = z.string().describe(desc);
    else if (key === 'mode') shape[key] = z.enum(['best_known', 'as_known_then']).describe(desc);
    else if (key === 'events') shape[key] = z.array(z.record(z.string(), z.unknown())).optional().describe(desc);
    else if (key === 'record_ids') shape[key] = z.array(z.string()).optional().describe(desc);
    else shape[key] = z.string().optional().describe(desc);
  }
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: shape },
    async (args: Record<string, unknown>) => {
      try {
        const res = await runMcpTool(def, args, ctx);
        return { content: [{ type: 'text' as const, text: JSON.stringify(res, null, 2) }] };
      } catch (e) {
        // Parameter errors only — a REFUSAL is a successful return with
        // refusalType and remedy, never an error (contract 3).
        return {
          content: [{ type: 'text' as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  );
}

for (const def of CORPUS_MCP_TOOLS) {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.inputSchema },
    async (args: Record<string, unknown>) => {
      try {
        const result = await def.handler(args, ctx);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
      }
    },
  );
}

// No top-level await: this repository is CommonJS (package.json declares no
// "type": "module"), so tsx transpiles this file to CJS and a top-level
// await is a hard transform error — `npm run mcp` would not start at all.
// Found by running the real client against the real server, not by reading.
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr, never stdout: stdout IS the protocol channel on this transport.
  console.error('[payload-terminal] MCP server on stdio; terminal at', env('PAYLOAD_URL') ?? 'http://localhost:3000');
}

main().catch((e: unknown) => {
  console.error('[payload-terminal] MCP server failed to start:', e);
  process.exit(1);
});
