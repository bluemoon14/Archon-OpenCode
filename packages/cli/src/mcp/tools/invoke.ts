/**
 * MCP skill + agent one-shot invocation handlers.
 *
 *   - archon_skill_invoke(name, prompt, model?) → runs the skill body as a
 *     system prompt + user prompt through the resolver-picked provider.
 *   - archon_agent_invoke(name, prompt, model?) → same pattern for agents.
 *
 * Each invocation is independent — no session, no workflow run record. The
 * provider spawns its normal subprocess or proxy; teardown is by-process.
 * Tool call blocks until the stream settles, then returns the concatenated
 * assistant text + usage + stop reason. Use for "run code-reviewer on this
 * diff" one-off calls that don't warrant a whole workflow.
 */
import { getAgentProvider } from '@archon/providers';
import type { MessageChunk, SendQueryOptions } from '@archon/providers/types';
import { inferProviderFromModel } from '@archon/workflows/model-validation';
import { resolveAgentModel, resolveSkillModel } from '@archon/workflows/model-resolution';
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';

export interface SkillInvokeInput {
  name: string;
  prompt: string;
  /** Optional per-call model override (highest precedence tier). */
  model?: string;
  /** Optional cwd override. Defaults to the MCP server's cwd. */
  cwd?: string;
}

export interface InvokeOutput {
  assistantText: string;
  model: string;
  modelSource: string;
  provider: string;
  /** Parsed structured output when the underlying stream produced one. */
  structuredOutput?: unknown;
  cost?: number;
  tokens?: { input: number; output: number; total?: number };
  stopReason?: string;
  /** True when the stream ended with an error state. */
  isError?: boolean;
}

export async function invokeSkill(
  input: SkillInvokeInput,
  defaultCwd: string,
  defaultAssistant: string
): Promise<InvokeOutput> {
  const cwd = input.cwd ?? defaultCwd;
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const skill = await registry.loadSkill(input.name);
  const files = registry.modelsFiles();
  const resolved = resolveSkillModel({
    skillName: input.name,
    override: input.model,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: skill.model,
    defaultAssistantModel: defaultAssistant,
  });

  const provider = inferProviderFromModel(resolved.model, defaultAssistant);
  const aiClient = getAgentProvider(provider);

  const options: SendQueryOptions = {
    model: resolved.model,
    resolvedSkills: [
      {
        name: skill.name,
        description: skill.description,
        body: skill.body,
        model: resolved.model,
      },
    ],
  };

  return collectSendQuery(aiClient.sendQuery(input.prompt, cwd, undefined, options), {
    model: resolved.model,
    modelSource: resolved.source,
    provider,
  });
}

export interface AgentInvokeInput {
  name: string;
  prompt: string;
  model?: string;
  cwd?: string;
}

export async function invokeAgent(
  input: AgentInvokeInput,
  defaultCwd: string,
  defaultAssistant: string
): Promise<InvokeOutput> {
  const cwd = input.cwd ?? defaultCwd;
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const agent = await registry.loadAgent(input.name);
  const files = registry.modelsFiles();
  const resolved = resolveAgentModel({
    agentName: input.name,
    override: input.model,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: agent.model,
    defaultAssistantModel: defaultAssistant,
  });

  const provider = inferProviderFromModel(resolved.model, defaultAssistant);
  const aiClient = getAgentProvider(provider);

  const options: SendQueryOptions = {
    model: resolved.model,
    resolvedAgents: [
      {
        id: agent.name,
        description: agent.description,
        prompt: agent.body,
        model: resolved.model,
        ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
        ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
      },
    ],
  };

  return collectSendQuery(aiClient.sendQuery(input.prompt, cwd, undefined, options), {
    model: resolved.model,
    modelSource: resolved.source,
    provider,
  });
}

/**
 * Consume a MessageChunk async iterator and fold it into a single
 * `InvokeOutput`. Assistant text accumulates; the terminal result chunk
 * contributes usage + stop reason + structuredOutput.
 */
async function collectSendQuery(
  gen: AsyncIterable<MessageChunk>,
  meta: { model: string; modelSource: string; provider: string }
): Promise<InvokeOutput> {
  const parts: string[] = [];
  let tokens: InvokeOutput['tokens'];
  let stopReason: string | undefined;
  let cost: number | undefined;
  let structuredOutput: unknown;
  let isError = false;

  for await (const chunk of gen) {
    if (chunk.type === 'assistant') {
      parts.push(chunk.content);
    } else if (chunk.type === 'result') {
      if (chunk.tokens !== undefined) tokens = chunk.tokens;
      if (chunk.stopReason !== undefined) stopReason = chunk.stopReason;
      if (chunk.cost !== undefined) cost = chunk.cost;
      if (chunk.structuredOutput !== undefined) structuredOutput = chunk.structuredOutput;
      if (chunk.isError === true) isError = true;
    }
  }

  return {
    assistantText: parts.join(''),
    model: meta.model,
    modelSource: meta.modelSource,
    provider: meta.provider,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(isError ? { isError: true } : {}),
  };
}
