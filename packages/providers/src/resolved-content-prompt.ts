/**
 * Shared helper: fold `resolvedSkills` + `resolvedAgents` (from the SkillAgent-
 * Registry) into a single system-prompt string. Used by every provider that
 * does NOT have native skill/agent SDK hooks — today that's LiteLLM and
 * OpenCode. The Claude provider uses `AgentDefinition.prompt` instead, so it
 * builds its own shape (see claude/provider.ts:432).
 *
 * Format is deliberately boring: a short preamble, then each skill / agent
 * as a `## <Kind>: <name>` block separated by `\n\n---\n\n`. Upstream models
 * see enough structure to parse without the content becoming noise.
 */
import type { ResolvedAgentHandoff, ResolvedSkillHandoff } from './types';

export interface BuildSystemPromptInput {
  /** The node-level systemPrompt option. Included first, above the resolved content. */
  systemPrompt?: string;
  resolvedSkills?: ResolvedSkillHandoff[];
  resolvedAgents?: ResolvedAgentHandoff[];
}

/**
 * Returns `undefined` when there's nothing to contribute (no systemPrompt +
 * no resolved content) — callers can then skip the `system:` field entirely.
 */
export function buildResolvedSystemPrompt(input: BuildSystemPromptInput): string | undefined {
  const parts: string[] = [];

  if (input.systemPrompt !== undefined && input.systemPrompt.length > 0) {
    parts.push(input.systemPrompt);
  }

  if (input.resolvedSkills !== undefined && input.resolvedSkills.length > 0) {
    const skillsBlock = input.resolvedSkills
      .map(s => `## Skill: ${s.name}\n\n${s.description}\n\n${s.body}`)
      .join('\n\n---\n\n');
    parts.push(
      `You have the following preloaded skills. Use them when relevant to the task:\n\n${skillsBlock}`
    );
  }

  if (input.resolvedAgents !== undefined && input.resolvedAgents.length > 0) {
    const agentsBlock = input.resolvedAgents
      .map(a => `## Available sub-agent: ${a.id}\n\n${a.description}\n\n${a.prompt}`)
      .join('\n\n---\n\n');
    parts.push(
      `The following sub-agent personas are available. Incorporate their perspectives when appropriate:\n\n${agentsBlock}`
    );
  }

  if (parts.length === 0) return undefined;
  return parts.join('\n\n---\n\n');
}
