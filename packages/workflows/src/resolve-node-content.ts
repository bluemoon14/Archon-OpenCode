/**
 * Resolve a workflow node's `skills:` and `agents:` references against the
 * SkillAgentRegistry, producing `ResolvedSkillHandoff` / `ResolvedAgentHandoff`
 * arrays that providers consume directly — no per-provider registry lookup.
 *
 * Called by the DAG executor once the node is about to run. Skills or agent
 * IDs not present in the registry are silently skipped here; the provider
 * still sees the raw `nodeConfig.skills` + `nodeConfig.agents` arrays and can
 * fall back to SDK-native lookup for those (preserves the Claude SDK
 * `settingSources` pathway for user-authored `~/.claude/skills/`).
 */
import { createLogger } from '@archon/paths';
import type {
  NodeConfig,
  ResolvedAgentHandoff,
  ResolvedSkillHandoff,
} from '@archon/providers/types';
import { resolveAgentModel, resolveSkillModel } from './model-resolution';
import type { SkillAgentRegistry } from './deps';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.resolve-node');
  return cachedLog;
}

export interface ResolveNodeContentInput {
  /** Node-level `skills: string[]` from workflow YAML. */
  skills?: string[];
  /** Node-level `agents: Record<id, inline-definition>` from workflow YAML. */
  agents?: NodeConfig['agents'];
  /** The owning node's resolved model (for `inherit` semantics). */
  nodeModel?: string;
  /** Last-resort fallback used by the resolver's tier 8. */
  defaultAssistantModel: string;
  /** Registry providing content + models.yaml stacks. */
  registry: SkillAgentRegistry;
}

export interface ResolveNodeContentOutput {
  resolvedSkills: ResolvedSkillHandoff[];
  resolvedAgents: ResolvedAgentHandoff[];
}

export async function resolveNodeContent(
  input: ResolveNodeContentInput
): Promise<ResolveNodeContentOutput> {
  const files = input.registry.modelsFiles();
  const resolvedSkills: ResolvedSkillHandoff[] = [];
  const resolvedAgents: ResolvedAgentHandoff[] = [];

  if (input.skills) {
    for (const name of input.skills) {
      try {
        const skill = await input.registry.loadSkill(name);
        const resolved = resolveSkillModel({
          skillName: name,
          bundled: files.bundled,
          global: files.global,
          project: files.project,
          frontmatter: skill.model,
          ownerNodeModel: input.nodeModel,
          defaultAssistantModel: input.defaultAssistantModel,
        });
        resolvedSkills.push({
          name: skill.name,
          description: skill.description,
          body: skill.body,
          model: resolved.model,
        });
        getLog().debug(
          {
            skill: skill.name,
            source: skill.source,
            modelSource: resolved.source,
            model: resolved.model,
          },
          'skills.resolved'
        );
      } catch (err) {
        // Skill not in registry — provider falls back to nodeConfig.skills pass-through.
        getLog().debug(
          { skill: name, error: err instanceof Error ? err.message : String(err) },
          'skills.not_in_registry'
        );
      }
    }
  }

  if (input.agents) {
    for (const [id, inline] of Object.entries(input.agents)) {
      try {
        const agent = await input.registry.loadAgent(id);
        const resolved = resolveAgentModel({
          agentName: id,
          override: inline.model,
          bundled: files.bundled,
          global: files.global,
          project: files.project,
          frontmatter: agent.model,
          ownerNodeModel: input.nodeModel,
          defaultAssistantModel: input.defaultAssistantModel,
        });
        // Inline overrides (from workflow YAML) win over registry values on a
        // per-field basis. The agent's body becomes the prompt unless the user
        // supplied an inline prompt.
        resolvedAgents.push({
          id,
          description: inline.description || agent.description,
          prompt: inline.prompt || agent.body,
          model: resolved.model,
          tools: inline.tools ?? agent.tools,
          disallowedTools: inline.disallowedTools,
          skills: inline.skills,
          maxTurns: inline.maxTurns ?? agent.maxTurns,
        });
        getLog().debug(
          {
            agent: id,
            source: agent.source,
            modelSource: resolved.source,
            model: resolved.model,
          },
          'agents.resolved'
        );
      } catch (err) {
        // Not in registry — agent is a pure user-inline definition. Leave it
        // on nodeConfig.agents for the provider to pass through unchanged.
        getLog().debug(
          { agent: id, error: err instanceof Error ? err.message : String(err) },
          'agents.not_in_registry'
        );
      }
    }
  }

  return { resolvedSkills, resolvedAgents };
}
