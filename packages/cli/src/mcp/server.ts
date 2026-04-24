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
import { resumeWorkflow, runWorkflow, statusWorkflow } from './tools/workflow';
import { invokeAgent, invokeSkill } from './tools/invoke';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('cli.mcp');
  return cachedLog;
}

export interface ArchonMcpServerOptions {
  /** Repo root passed to every registry read. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Default assistant model for invoke tools when the resolver exhausts every
   *  other tier. Defaults to 'sonnet' (the Claude SDK back-compat shorthand). */
  defaultAssistant?: string;
}

/**
 * Build an `McpServer` pre-registered with every Archon tool. Tests construct
 * one directly and exercise `_registeredTools` without starting a transport.
 */
export function createArchonMcpServer(opts: ArchonMcpServerOptions = {}): McpServer {
  const cwd = opts.cwd ?? process.cwd();
  const defaultAssistant = opts.defaultAssistant ?? 'sonnet';
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

  server.registerTool(
    'archon_workflow_run',
    {
      description:
        'Run a workflow by name and block until completion. Returns {status, workflowName, ' +
        'runId?, error?}. BLOCKING — for long workflows prefer kicking off via a shell tool ' +
        '(`archon workflow run ... &`) and polling via `archon_workflow_status`.',
      inputSchema: {
        name: z.string().describe('Workflow name (matches `archon workflow list`)'),
        args: z.string().optional().describe('Positional argument string ($ARGUMENTS)'),
        branchName: z.string().optional().describe('Optional worktree branch override'),
        noWorktree: z.boolean().optional().describe('Disable worktree isolation'),
      },
    },
    async input => {
      try {
        const out = await runWorkflow(input, cwd);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
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
    'archon_workflow_status',
    {
      description:
        'Snapshot workflow run state. With no runId: returns every running + paused run. With ' +
        'a runId: returns that run. Use for polling long workflows kicked off via shell or ' +
        'earlier MCP calls.',
      inputSchema: {
        runId: z.string().optional().describe('Workflow run ID (UUID). Omit to list active runs.'),
      },
    },
    async input => {
      try {
        const out = await statusWorkflow(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
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
    'archon_skill_invoke',
    {
      description:
        'One-shot: run a named skill against a user prompt. The skill body is injected as a ' +
        'system-prompt contribution + the prompt is the user turn. Provider + model come from ' +
        'the 8-tier resolver (optionally overridden via `model`). Returns {assistantText, ' +
        'model, tokens, ...}.',
      inputSchema: {
        name: z.string().describe('Skill name (kebab-case)'),
        prompt: z.string().describe('User prompt to run the skill against'),
        model: z
          .string()
          .optional()
          .describe('Per-call model override (wins over models.yaml + frontmatter)'),
      },
    },
    async input => {
      try {
        const out = await invokeSkill(input, cwd, defaultAssistant);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
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
    'archon_agent_invoke',
    {
      description:
        'One-shot: run a named agent (e.g. `code-reviewer`) against a user prompt. Same shape ' +
        'as `archon_skill_invoke` but uses the agent body as the subagent system prompt and ' +
        "forwards the agent's tools + maxTurns when set.",
      inputSchema: {
        name: z.string().describe('Agent name (kebab-case)'),
        prompt: z.string().describe('User prompt to run the agent against'),
        model: z.string().optional().describe('Per-call model override'),
      },
    },
    async input => {
      try {
        const out = await invokeAgent(input, cwd, defaultAssistant);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
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
    'archon_workflow_resume',
    {
      description:
        'Resume a paused or failed workflow run. Validates the run is resumable and returns ' +
        '{runId, workflowName, status}. Does not block on completion — use `archon_workflow_status` ' +
        'to poll.',
      inputSchema: {
        runId: z.string().describe('Workflow run ID (UUID) to resume'),
      },
    },
    async input => {
      try {
        const out = await resumeWorkflow(input);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
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
