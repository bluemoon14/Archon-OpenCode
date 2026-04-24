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
import { SkillNotFoundError } from './skills/loader';
import { AgentNotFoundError } from './agents/loader';
import type { ResolvedSkill } from './schemas/skills';

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
    // Pass 1 — load every requested skill, closure-over its `requires:` edges.
    // Skills absent from the registry are recorded but contribute no edges
    // (their requires list is unknown). Skills we auto-append because another
    // skill required them also go through this loader path so their own
    // requires transitively chain.
    const loaded = new Map<string, ResolvedSkill>();
    const missing = new Set<string>();
    const pending = [...input.skills];
    while (pending.length > 0) {
      // pending.length > 0 guarantees shift() returns a string, but TS can't
      // prove it — narrow explicitly instead of using `!`.
      const name = pending.shift();
      if (name === undefined) continue;
      if (loaded.has(name) || missing.has(name)) continue;
      try {
        const skill = await input.registry.loadSkill(name);
        loaded.set(name, skill);
        for (const req of skill.requires ?? []) {
          if (!loaded.has(req) && !missing.has(req) && !pending.includes(req)) {
            // Auto-append — warn if the user didn't list it explicitly so
            // implicit dependencies show up in logs without breaking.
            if (!input.skills.includes(req)) {
              getLog().warn(
                { skill: name, auto_added: req },
                'skills.auto_added_required_dependency'
              );
            }
            pending.push(req);
          }
        }
      } catch (err) {
        if (err instanceof SkillNotFoundError) {
          missing.add(name);
          getLog().debug({ skill: name }, 'skills.not_in_registry');
          continue;
        }
        // Any other error (malformed frontmatter, permission denied, etc.)
        // must surface — swallowing these masks real bugs.
        throw err;
      }
    }

    // Pass 2 — topological sort on the loaded subgraph. `requires` edges
    // mean "this skill must run after its deps," so sorted order goes
    // deps-first. Cycles throw with the offending chain in the message.
    const orderedNames = topologicalSortSkills(loaded);

    // Pass 3 — resolve model + emit ResolvedSkillHandoff in dependency order.
    for (const name of orderedNames) {
      const skill = loaded.get(name);
      if (skill === undefined) continue; // unreachable: orderedNames ⊆ loaded.keys()
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
        if (err instanceof AgentNotFoundError) {
          // Not in registry — agent is a pure user-inline definition. Leave it
          // on nodeConfig.agents for the provider to pass through unchanged.
          getLog().debug({ agent: id }, 'agents.not_in_registry');
          continue;
        }
        // Any other error must surface.
        throw err;
      }
    }
  }

  return { resolvedSkills, resolvedAgents };
}

// ---------------------------------------------------------------------------
// Skill ordering via `requires`
// ---------------------------------------------------------------------------

/**
 * Topologically sort a set of loaded skills so that every skill appears
 * after the skills it requires (DFS-based Kahn's algorithm variant).
 *
 * Only edges *within the provided set* are honored — if skill A requires
 * B and B isn't in the input map, A sorts against its other deps only.
 * This keeps resolution graceful when a `requires` entry points at a
 * skill that the registry doesn't have.
 *
 * Throws when a cycle is detected, with the offending chain in the message
 * so the user can find and fix the edge.
 */
export function topologicalSortSkills(loaded: Map<string, ResolvedSkill>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  function visit(name: string, path: string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycle = [...path.slice(path.indexOf(name)), name];
      throw new Error(`Skill requires cycle detected: ${cycle.join(' → ')}`);
    }
    const skill = loaded.get(name);
    if (skill === undefined) return; // not loaded — skip (missing deps don't block)
    visiting.add(name);
    for (const dep of skill.requires ?? []) {
      visit(dep, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
    result.push(name);
  }

  // Iterate in insertion order so the output is stable for callers.
  for (const name of loaded.keys()) visit(name, []);
  return result;
}
