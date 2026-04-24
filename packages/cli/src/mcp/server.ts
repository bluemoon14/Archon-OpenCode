/**
 * Archon MCP server — exposes the skill / agent / models registry as tools
 * that Claude Code / OpenCode / any MCP-capable host can call natively.
 *
 * Scope (v1): 5 discovery tools.
 *   - archon_skills_list / archon_skills_show
 *   - archon_agents_list / archon_agents_show
 *   - archon_models_list
 *
 * Deferred to a follow-up commit:
 *   - Workflow control (run / status / resume) — needs workflow-store wiring.
 *   - Skill/agent one-shot invocation — needs provider+resolver wiring at
 *     tool-call time.
 *   - Models mutation (set / reset) — risk of silent routing changes from the
 *     outer AI; users drop to `archon models set` via shell for now.
 *
 * Transport: stdio only. Invoked via `archon mcp serve`. Clients add it to
 * their mcp.json with:
 *   { "mcpServers": { "archon": { "command": "archon", "args": ["mcp", "serve"] } } }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createLogger } from '@archon/paths';
import {
  gatherAgentDetail,
  gatherAgentsList,
  gatherModelsTable,
  gatherSkillDetail,
  gatherSkillsList,
} from '../commands/registry-data';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.mcp');
  return cachedLog;
}

export interface ArchonMcpServerOptions {
  /** Repo root passed to every registry read. Defaults to `process.cwd()`. */
  cwd?: string;
}

/**
 * Build an `McpServer` pre-registered with every Archon tool. Tests construct
 * one directly and exercise `_registeredTools` without starting a transport.
 */
export function createArchonMcpServer(opts: ArchonMcpServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const server = new McpServer({
    name: 'archon',
    version: '1.0.0',
  });

  server.registerTool(
    'archon_skills_list',
    {
      description:
        'List every skill resolvable from the Archon registry (bundled + global + project). ' +
        'Each entry includes resolved model + source tier.',
      inputSchema: {},
    },
    async () => {
      const rows = await gatherSkillsList(cwd);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ skills: rows }, null, 2) }],
      };
    }
  );

  server.registerTool(
    'archon_skills_show',
    {
      description:
        'Load a skill by name and return its full SKILL.md body + frontmatter + resolved model. ' +
        'Use after `archon_skills_list` to fetch specific content.',
      inputSchema: { name: z.string().describe('Skill name (kebab-case)') },
    },
    async ({ name }) => {
      try {
        const detail = await gatherSkillDetail(cwd, name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    }
  );

  server.registerTool(
    'archon_agents_list',
    {
      description:
        'List every agent resolvable from the Archon registry (bundled + global + project). ' +
        'Each entry includes resolved model + source tier.',
      inputSchema: {},
    },
    async () => {
      const rows = await gatherAgentsList(cwd);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ agents: rows }, null, 2) }],
      };
    }
  );

  server.registerTool(
    'archon_agents_show',
    {
      description:
        'Load an agent by name and return its full markdown body + frontmatter + resolved model.',
      inputSchema: { name: z.string().describe('Agent name (kebab-case)') },
    },
    async ({ name }) => {
      try {
        const detail = await gatherAgentDetail(cwd, name);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(detail, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: err instanceof Error ? err.message : String(err) },
          ],
        };
      }
    }
  );

  server.registerTool(
    'archon_models_list',
    {
      description:
        'Return the full model-assignment table: defaults, aliases, per-skill + per-agent ' +
        'resolved models with winning tier. One-shot alternative to reading models.yaml files.',
      inputSchema: {},
    },
    async () => {
      const table = await gatherModelsTable(cwd);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(table, null, 2) }],
      };
    }
  );

  return server;
}

/**
 * Start the MCP server over stdio. Blocks until the transport closes — MCP
 * clients keep the process alive, so this function only returns on a clean
 * shutdown (stdin close, SIGINT, SIGTERM).
 */
export async function runArchonMcpServer(opts: ArchonMcpServerOptions = {}): Promise<void> {
  const server = createArchonMcpServer(opts);
  const transport = new StdioServerTransport();
  getLog().info({ cwd: opts.cwd ?? process.cwd() }, 'mcp.server_starting');
  await server.connect(transport);
  getLog().info({}, 'mcp.server_ready');
}
