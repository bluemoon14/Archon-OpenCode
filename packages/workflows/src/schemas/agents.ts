/**
 * Zod schema for agent markdown frontmatter.
 *
 * Agents are single-file markdown definitions (unlike skills which own a
 * directory). Frontmatter mirrors the Claude Code subagent format: `name`,
 * `description`, `model` (commonly `inherit`), with optional `tools` and
 * `maxTurns`. The body becomes the agent's system prompt.
 */
import { z } from '@hono/zod-openapi';

const agentNamePattern = /^[a-z][a-z0-9-]*$/;

export const agentFrontmatterSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(agentNamePattern, "agent 'name' must be lowercase kebab-case (e.g. 'code-reviewer')"),
  description: z.string().min(1),
  /**
   * Preferred model — LiteLLM canonical, Claude-SDK shorthand, alias, or the
   * literal `inherit` (meaning "use the owning node's model"). Central
   * models.yaml still takes precedence per the resolver's 8-tier order.
   */
  model: z.string().min(1).optional(),
  /** Optional allow-list of tool names the agent may use. */
  tools: z.array(z.string().min(1)).optional(),
  /** Optional bound on agent sub-turns (Claude SDK Task tool semantics). */
  maxTurns: z.number().int().positive().optional(),
});

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface ResolvedAgent {
  name: string;
  description: string;
  model?: string;
  tools?: string[];
  maxTurns?: number;
  /** Markdown body → system prompt. */
  body: string;
  source: 'bundled' | 'global' | 'project';
  path?: string;
}
