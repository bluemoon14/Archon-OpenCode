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
import {
  gatherAgentDetail,
  gatherAgentsList,
  gatherModelsTable,
  gatherSkillDetail,
  gatherSkillsList,
} from '../commands/registry-data';
import {
  resumeWorkflow,
  runWorkflow,
  startWorkflow,
  statusWorkflow,
  workflowEvents,
} from './tools/workflow';
import { invokeAgent, invokeSkill } from './tools/invoke';
import { assignAgentModel, assignSkillModel } from './tools/assign';
import { planSession } from './tools/plan';

// NOTE: no `@archon/paths.createLogger` here — the Pino logger writes to
// stdout by default, which MCP reserves for JSON-RPC framing. Diagnostics
// from this module go to stderr via `process.stderr.write` instead.

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
    'archon_workflow_start',
    {
      description:
        'Non-blocking variant of `archon_workflow_run`. Kicks off a workflow in the background ' +
        'and returns {runId, status: "running", detached: true} as soon as the run record ' +
        'exists (~100ms). Long-running workflows no longer hit MCP tool-call timeouts. ' +
        'Poll via `archon_workflow_status(runId)` or tail events via `archon_workflow_events(runId)`. ' +
        'Known limitation: if the MCP server disconnects mid-run the in-process execution dies — ' +
        'recover with `archon workflow resume <runId>` from a shell.',
      inputSchema: {
        name: z.string().describe('Workflow name (matches `archon workflow list`)'),
        args: z.string().optional().describe('Positional argument string ($ARGUMENTS)'),
        branchName: z.string().optional().describe('Optional worktree branch override'),
        noWorktree: z.boolean().optional().describe('Disable worktree isolation'),
        params: z
          .record(z.string(), z.string())
          .optional()
          .describe('Named workflow parameters (equivalent to --param key=value on the CLI)'),
      },
    },
    async input => {
      try {
        const out = await startWorkflow(input, cwd);
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
    'archon_workflow_events',
    {
      description:
        'Tail events for a workflow run (polling). Returns {events[], latestIso}. Pass ' +
        '`sinceIso` from the prior call to skip already-seen events. Event types include ' +
        '`node_started`, `node_completed`, `workflow_completed`, etc.',
      inputSchema: {
        runId: z.string().describe('Workflow run ID'),
        sinceIso: z
          .string()
          .optional()
          .describe('ISO timestamp — only events after this are returned'),
      },
    },
    async input => {
      try {
        const out = await workflowEvents(input);
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

  // ---------------------------------------------------------------------------
  // Models-mutation tools (Phase 4D) — require `confirm: true` to actually
  // write. Without confirm, returns a preview — pattern protects against the
  // outer AI silently rewriting the user's routing table.
  // ---------------------------------------------------------------------------

  server.registerTool(
    'archon_skills_assign',
    {
      description:
        "Assign a skill's model. Writes to `.archon/models.yaml` (project) or `~/.archon/" +
        "models.yaml` (scope='global'). REQUIRES `confirm: true` to persist — without it, " +
        'returns a preview of the intended change. Use this when the user explicitly asks to ' +
        "reroute a skill; don't call it speculatively.",
      inputSchema: {
        name: z.string().describe('Skill name (kebab-case)'),
        model: z.string().describe('Target model (LiteLLM canonical, Claude shorthand, or alias)'),
        scope: z.enum(['project', 'global']).optional().describe('Default: project'),
        confirm: z.boolean().optional().describe('Must be true to actually write'),
      },
    },
    async input => {
      try {
        const out = await assignSkillModel(input, cwd);
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
    'archon_agents_assign',
    {
      description:
        "Assign an agent's model. Same shape as `archon_skills_assign` — REQUIRES " +
        '`confirm: true` to persist.',
      inputSchema: {
        name: z.string().describe('Agent name (kebab-case)'),
        model: z.string().describe('Target model'),
        scope: z.enum(['project', 'global']).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async input => {
      try {
        const out = await assignAgentModel(input, cwd);
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
    'archon_plan_session',
    {
      description:
        'Rank skills by relevance to a stated goal. Token-overlap scoring against each ' +
        "skill's description (v1 — no LLM call). Use this BEFORE invoking skills so you " +
        "pick the right ones; e.g. given 'my auth middleware is broken' it surfaces " +
        "'systematic-debugging' + 'test-driven-development' before the user has to know " +
        'they exist.',
      inputSchema: {
        goal: z.string().describe('What the user is trying to do (free-form, 1-3 sentences)'),
        limit: z.number().int().positive().optional().describe('Max results (default 5)'),
      },
    },
    async input => {
      try {
        const out = await planSession(input, cwd);
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
 * Start the MCP server over stdio and block until the transport closes.
 * Returns only on clean shutdown (stdin EOF, SIGINT, SIGTERM) so cli.ts's
 * final `process.exit(code)` doesn't kill the server's stdin listener
 * mid-session.
 *
 * IMPORTANT: MCP stdio protocol reserves process.stdout for JSON-RPC framing.
 * Any other writer to stdout corrupts the stream and crashes the client.
 * Archon's structured logger (Pino) defaults to stdout, so we write
 * diagnostics directly to stderr here. Do not call `getLog()` or any other
 * stdout-bound writer from the MCP runtime path — anything emitted after
 * `server.connect(transport)` must go through the server's sendLoggingMessage
 * protocol or directly to stderr.
 */
export async function runArchonMcpServer(opts: ArchonMcpServerOptions = {}): Promise<void> {
  const server = createArchonMcpServer(opts);
  const transport = new StdioServerTransport();
  const cwd = opts.cwd ?? process.cwd();
  process.stderr.write(`[mcp] starting server (cwd=${cwd})\n`);
  await server.connect(transport);
  process.stderr.write('[mcp] server ready — listening for JSON-RPC on stdio\n');

  // Block until the client closes stdin or a term signal arrives. Without
  // this, cli.ts calls process.exit(0) as soon as this function resolves,
  // which kills the server's stdin listener before any request lands.
  await new Promise<void>(resolve => {
    const done = (): void => {
      resolve();
    };
    transport.onclose = done;
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
  process.stderr.write('[mcp] transport closed — shutting down\n');
}
