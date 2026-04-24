/**
 * `archon mcp serve` — start the stdio MCP server.
 *
 * Thin wrapper around `runArchonMcpServer` from `../mcp/server.ts`. The
 * server takes over stdin/stdout for the protocol — all human-facing output
 * goes to stderr (or the logger, which routes to stderr by default) to
 * avoid corrupting the wire.
 */
import { runArchonMcpServer } from '../mcp/server';

export interface McpServeOptions {
  cwd: string;
}

export async function mcpServeCommand(opts: McpServeOptions): Promise<number> {
  await runArchonMcpServer({ cwd: opts.cwd });
  return 0;
}
