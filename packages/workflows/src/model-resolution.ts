/**
 * Model resolution — turns a skill/agent/node reference into a concrete model string
 * with source transparency, honoring the bundled < global < project override chain
 * and the 8-tier precedence documented in the vision plan.
 *
 * Pure functions. No filesystem access, no provider registry access — callers
 * load the models.yaml files and pass them in. Provider routing (Claude SDK vs
 * LiteLLM) happens downstream in `inferProviderFromModel()`.
 *
 * Precedence for a skill/agent resolution (highest wins):
 *   1. caller-supplied `override`       (e.g. per-invocation node-level override)
 *   2. project models.yaml entry        (`.archon/models.yaml`)
 *   3. global models.yaml entry         (`~/.archon/models.yaml`)
 *   4. bundled models.yaml entry        (shipped with the binary)
 *   5. frontmatter `model:` in the skill/agent file itself
 *   6. category default (`defaults.skill` / `defaults.agent`) merged across the 3 files
 *   7. owning node's model (only when the resolved value is literal `inherit`)
 *   8. caller-supplied `defaultAssistantModel` fallback
 *
 * Aliases are expanded in a separate final step (after the tier winner is chosen)
 * so you can write `skills.systematic-debugging: fast` and have `fast` resolve
 * via `aliases: { fast: anthropic/claude-haiku-4-5 }`.
 */
import type { ModelsFile } from './schemas/models';
import { INHERIT_MODEL, isInheritModel } from './schemas/models';

/**
 * Which file the winning assignment came from.
 * `override` is synthetic — a runtime node-level override, not a file.
 * `frontmatter` is synthetic — the skill/agent file's own YAML header.
 * `default` means a category default (defaults.{node,skill,agent}) from any file.
 * `inherit` means the owning node's model (used when a lower tier said `inherit`).
 * `assistant` means the caller's `defaultAssistantModel` fallback.
 */
export type AssignmentSource =
  | 'override'
  | 'project'
  | 'global'
  | 'bundled'
  | 'frontmatter'
  | 'default'
  | 'inherit'
  | 'assistant';

export interface ResolvedModel {
  /** The final model string, with aliases expanded. */
  model: string;
  /** Which precedence tier won. */
  source: AssignmentSource;
  /** True if the winning value was a literal `inherit` resolved to the owner. */
  inherited: boolean;
  /** True if an alias was expanded to produce `model`. */
  aliasExpanded: boolean;
  /** The raw value before alias expansion — useful for diagnostics. */
  raw: string;
}

export interface SkillModelContext {
  /** The skill's unique name (key under `skills:` in models.yaml). */
  skillName: string;
  /**
   * Highest-priority runtime override — a per-invocation model chosen by the
   * workflow node itself (e.g. `skills: [{name, model}]` sugar). Wins over
   * every file.
   */
  override?: string;
  /** Loaded `.archon/models.yaml` (project scope). */
  project?: ModelsFile;
  /** Loaded `~/.archon/models.yaml` (global/user scope). */
  global?: ModelsFile;
  /** Loaded bundled models.yaml (shipped with the binary). */
  bundled?: ModelsFile;
  /** Frontmatter `model:` declared in the skill's SKILL.md. */
  frontmatter?: string;
  /** Owning node's model, consulted when a winning tier says `inherit`. */
  ownerNodeModel?: string;
  /** Last-resort fallback (usually the workflow's default assistant model). */
  defaultAssistantModel?: string;
}

export interface AgentModelContext {
  agentName: string;
  override?: string;
  project?: ModelsFile;
  global?: ModelsFile;
  bundled?: ModelsFile;
  frontmatter?: string;
  ownerNodeModel?: string;
  defaultAssistantModel?: string;
}

export interface NodeModelContext {
  /** Node-level model declared in the workflow YAML (`node.model`). */
  nodeModel?: string;
  project?: ModelsFile;
  global?: ModelsFile;
  bundled?: ModelsFile;
  defaultAssistantModel?: string;
}

/**
 * Merge alias tables across the three file scopes (project wins).
 * Missing inputs are treated as empty. Keys are case-sensitive.
 */
export function mergeAliases(
  bundled?: ModelsFile,
  global?: ModelsFile,
  project?: ModelsFile
): Record<string, string> {
  return {
    ...(bundled?.aliases ?? {}),
    ...(global?.aliases ?? {}),
    ...(project?.aliases ?? {}),
  };
}

/** Maximum alias-chain depth. Longer chains are almost certainly a mistake. */
export const ALIAS_CHAIN_DEPTH_CAP = 8;

/**
 * Thrown when alias resolution walks into a cycle or exceeds the depth cap.
 * Surfaces the chain so the user can find the offending edge.
 */
export class AliasResolutionError extends Error {
  constructor(
    message: string,
    public readonly chain: string[]
  ) {
    super(`${message} (chain: ${chain.join(' → ')})`);
    this.name = 'AliasResolutionError';
  }
}

/**
 * Expand an alias to its canonical model, following chains up to
 * `ALIAS_CHAIN_DEPTH_CAP` hops. Throws `AliasResolutionError` on cycle or
 * depth overflow — both are user errors in the merged models.yaml.
 *
 * Returns `{model, expanded, chain}` where `chain` is the expansion path
 * starting from `value` (at least 1 entry; 2+ if expansion happened). The
 * `chain` is useful for `archon models why` and similar diagnostics.
 */
export function expandAlias(
  value: string,
  aliases: Record<string, string>
): { model: string; expanded: boolean; chain: string[] } {
  const chain: string[] = [value];
  const seen = new Set<string>([value]);
  let current = value;
  for (let hop = 0; hop < ALIAS_CHAIN_DEPTH_CAP; hop++) {
    const target = aliases[current];
    if (target === undefined) {
      return { model: current, expanded: chain.length > 1, chain };
    }
    if (seen.has(target)) {
      chain.push(target);
      throw new AliasResolutionError('alias cycle detected', chain);
    }
    chain.push(target);
    seen.add(target);
    current = target;
  }
  throw new AliasResolutionError(
    `alias chain exceeded depth cap (${ALIAS_CHAIN_DEPTH_CAP})`,
    chain
  );
}

/** Picks the first file in project→global→bundled order that has an entry for `name`. */
function pickAssignment(
  name: string,
  group: 'skills' | 'agents',
  project?: ModelsFile,
  global?: ModelsFile,
  bundled?: ModelsFile
): { value: string; source: 'project' | 'global' | 'bundled' } | undefined {
  const p = project?.[group]?.[name];
  if (p !== undefined) return { value: p, source: 'project' };
  const g = global?.[group]?.[name];
  if (g !== undefined) return { value: g, source: 'global' };
  const b = bundled?.[group]?.[name];
  if (b !== undefined) return { value: b, source: 'bundled' };
  return undefined;
}

/** Picks the first file that has a matching category default. */
function pickDefault(
  category: 'node' | 'skill' | 'agent',
  project?: ModelsFile,
  global?: ModelsFile,
  bundled?: ModelsFile
): string | undefined {
  return (
    project?.defaults?.[category] ?? global?.defaults?.[category] ?? bundled?.defaults?.[category]
  );
}

/**
 * Resolve a skill's model. See precedence list in the module docstring.
 *
 * Throws only if no tier produces a value — the caller is expected to always
 * provide a `defaultAssistantModel`, which guarantees a fallback.
 */
export function resolveSkillModel(ctx: SkillModelContext): ResolvedModel {
  const aliases = mergeAliases(ctx.bundled, ctx.global, ctx.project);

  // Tier 1: explicit runtime override.
  if (ctx.override !== undefined) {
    return finalize(ctx.override, 'override', ctx.ownerNodeModel, aliases);
  }

  // Tiers 2-4: models.yaml entries.
  const assignment = pickAssignment(ctx.skillName, 'skills', ctx.project, ctx.global, ctx.bundled);
  if (assignment !== undefined) {
    return finalize(assignment.value, assignment.source, ctx.ownerNodeModel, aliases);
  }

  // Tier 5: frontmatter.
  if (ctx.frontmatter !== undefined && ctx.frontmatter.length > 0) {
    return finalize(ctx.frontmatter, 'frontmatter', ctx.ownerNodeModel, aliases);
  }

  // Tier 6: category default.
  const def = pickDefault('skill', ctx.project, ctx.global, ctx.bundled);
  if (def !== undefined) {
    return finalize(def, 'default', ctx.ownerNodeModel, aliases);
  }

  // Tier 7: owning node model as a convenience fallback when nothing else was set.
  // (Semantically this is the same as an implicit `inherit` — the skill/agent
  // runs with the same model as its containing node.)
  if (ctx.ownerNodeModel !== undefined && ctx.ownerNodeModel.length > 0) {
    return finalizeInherited(ctx.ownerNodeModel, aliases);
  }

  // Tier 8: default assistant.
  return finalizeAssistant(ctx.defaultAssistantModel, ctx.skillName, 'skill', aliases);
}

/**
 * Resolve an agent's model. Same precedence as skills, but keyed under `agents:`.
 */
export function resolveAgentModel(ctx: AgentModelContext): ResolvedModel {
  const aliases = mergeAliases(ctx.bundled, ctx.global, ctx.project);

  if (ctx.override !== undefined) {
    return finalize(ctx.override, 'override', ctx.ownerNodeModel, aliases);
  }

  const assignment = pickAssignment(ctx.agentName, 'agents', ctx.project, ctx.global, ctx.bundled);
  if (assignment !== undefined) {
    return finalize(assignment.value, assignment.source, ctx.ownerNodeModel, aliases);
  }

  if (ctx.frontmatter !== undefined && ctx.frontmatter.length > 0) {
    return finalize(ctx.frontmatter, 'frontmatter', ctx.ownerNodeModel, aliases);
  }

  const def = pickDefault('agent', ctx.project, ctx.global, ctx.bundled);
  if (def !== undefined) {
    return finalize(def, 'default', ctx.ownerNodeModel, aliases);
  }

  if (ctx.ownerNodeModel !== undefined && ctx.ownerNodeModel.length > 0) {
    return finalizeInherited(ctx.ownerNodeModel, aliases);
  }

  return finalizeAssistant(ctx.defaultAssistantModel, ctx.agentName, 'agent', aliases);
}

/**
 * Resolve a workflow-node model. Node resolution is simpler because `inherit`
 * and frontmatter don't apply (there's no parent node to inherit from, and
 * workflow YAML is not frontmatter-backed).
 */
export function resolveNodeModel(ctx: NodeModelContext): ResolvedModel {
  const aliases = mergeAliases(ctx.bundled, ctx.global, ctx.project);

  if (ctx.nodeModel !== undefined && ctx.nodeModel.length > 0) {
    return finalize(ctx.nodeModel, 'override', undefined, aliases);
  }

  const def = pickDefault('node', ctx.project, ctx.global, ctx.bundled);
  if (def !== undefined) {
    return finalize(def, 'default', undefined, aliases);
  }

  return finalizeAssistant(ctx.defaultAssistantModel, '(node)', 'node', aliases);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function finalize(
  raw: string,
  source: AssignmentSource,
  ownerNodeModel: string | undefined,
  aliases: Record<string, string>
): ResolvedModel {
  // `inherit` routes to the owning node's model if one was supplied.
  if (isInheritModel(raw)) {
    if (ownerNodeModel === undefined || ownerNodeModel.length === 0) {
      throw new Error(
        `Model resolved to '${INHERIT_MODEL}' but no ownerNodeModel was provided — ` +
          'skill/agent was invoked outside a workflow node or the node has no model.'
      );
    }
    const { model, expanded } = expandAlias(ownerNodeModel, aliases);
    return { model, source: 'inherit', inherited: true, aliasExpanded: expanded, raw };
  }

  const { model, expanded } = expandAlias(raw, aliases);
  return { model, source, inherited: false, aliasExpanded: expanded, raw };
}

/** Tier 7 helper: use the owner node's model as a convenience fallback. */
function finalizeInherited(ownerNodeModel: string, aliases: Record<string, string>): ResolvedModel {
  const { model, expanded } = expandAlias(ownerNodeModel, aliases);
  return {
    model,
    source: 'inherit',
    inherited: true,
    aliasExpanded: expanded,
    raw: ownerNodeModel,
  };
}

function finalizeAssistant(
  defaultAssistantModel: string | undefined,
  what: string,
  kind: 'skill' | 'agent' | 'node',
  aliases: Record<string, string>
): ResolvedModel {
  if (defaultAssistantModel === undefined || defaultAssistantModel.length === 0) {
    throw new Error(
      `Cannot resolve model for ${kind} '${what}': no models.yaml entry, no frontmatter, ` +
        'no category default, and no defaultAssistantModel provided.'
    );
  }
  const { model, expanded } = expandAlias(defaultAssistantModel, aliases);
  return {
    model,
    source: 'assistant',
    inherited: false,
    aliasExpanded: expanded,
    raw: defaultAssistantModel,
  };
}
