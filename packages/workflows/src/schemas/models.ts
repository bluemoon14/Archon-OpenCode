/**
 * Zod schema for the central model-assignment manifest (`models.yaml`).
 *
 * A single human-editable file that maps every skill and agent to an LLM model,
 * with an optional alias layer. Three locations stack with bundled < global < project
 * precedence (matching the rest of Archon's defaults):
 *   - bundled:  `.archon/models/defaults.yaml` embedded in the binary
 *   - global:   `~/.archon/models.yaml`
 *   - project:  `.archon/models.yaml`
 *
 * The resolver (packages/workflows/src/model-resolution.ts) honors an 8-tier
 * precedence order so frontmatter `model:` stays a supported fallback but the
 * manifest is the single source of truth for vendored superpowers content.
 */
import { z } from '@hono/zod-openapi';

/**
 * Category defaults applied when a specific skill/agent name has no entry.
 * `node` is the default model for workflow nodes that don't specify one.
 */
export const modelsFileDefaultsSchema = z.object({
  node: z.string().min(1).optional(),
  skill: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
});

export type ModelsFileDefaults = z.infer<typeof modelsFileDefaultsSchema>;

/**
 * Parsed shape of a models.yaml file.
 *
 * All value strings are either:
 *   - a LiteLLM canonical model name (`anthropic/claude-sonnet-4-5`, `openai/gpt-4o`, ...)
 *   - a legacy Claude-SDK shorthand (`sonnet`, `opus`, `haiku`, `claude-*`)
 *   - an alias key present in `aliases`
 *   - the literal `inherit` (meaning "use the owning node's model")
 *
 * Validation of the model *value* (provider compatibility) happens downstream in
 * the resolver via `@archon/providers` — schema-level we only enforce non-empty.
 */
export const modelsFileSchema = z.object({
  version: z.literal(1, {
    errorMap: () => ({ message: "models.yaml must declare 'version: 1'" }),
  }),
  defaults: modelsFileDefaultsSchema.optional(),
  skills: z.record(z.string().min(1), z.string().min(1)).optional(),
  agents: z.record(z.string().min(1), z.string().min(1)).optional(),
  aliases: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export type ModelsFile = z.infer<typeof modelsFileSchema>;

/**
 * Sentinel value meaning "use the owning node's model at resolve time."
 * Recognized in `skills.<name>`, `agents.<name>`, and frontmatter `model:` fields.
 */
export const INHERIT_MODEL = 'inherit' as const;
export type InheritModel = typeof INHERIT_MODEL;

export function isInheritModel(value: string): value is InheritModel {
  return value === INHERIT_MODEL;
}
