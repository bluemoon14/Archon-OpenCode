/**
 * Zod schema for SKILL.md frontmatter.
 *
 * A skill is a markdown file with YAML frontmatter and a freeform body. The
 * frontmatter declares the skill's identity; the body is its system-prompt
 * contribution. Upstream (obra/superpowers, Anthropic) uses only `name` +
 * `description`. Archon additionally honors an optional `model:` field so
 * users who prefer per-file assignments over the central models.yaml manifest
 * can specify a preferred model inline. Central manifest still wins per the
 * 8-tier precedence in `model-resolution.ts`.
 */
import { z } from '@hono/zod-openapi';

/** Pattern matching the upstream superpowers convention: lowercase kebab-case. */
const skillNamePattern = /^[a-z][a-z0-9-]*$/;

export const skillFrontmatterSchema = z.object({
  /** Unique skill identifier (kebab-case). Must match the directory name. */
  name: z
    .string()
    .min(1)
    .regex(
      skillNamePattern,
      "skill 'name' must be lowercase kebab-case (e.g. 'systematic-debugging')"
    ),
  /** Third-person description starting with "Use when..." — used for skill discovery. */
  description: z.string().min(1),
  /**
   * Archon extension: preferred model for this skill. Accepts LiteLLM canonical
   * form (`anthropic/claude-sonnet-4-5`), Claude-SDK shorthand (`sonnet`), an
   * alias defined in models.yaml, or the literal `inherit`.
   */
  model: z.string().min(1).optional(),
  /**
   * Archon extension: free-form discovery tags. Surfaced by `archon skills
   * list` filtering and future `archon_plan_session` ranking. No schema
   * validation beyond "array of non-empty strings" — leave conventions to
   * the skill authors.
   */
  tags: z.array(z.string().min(1)).optional(),
  /**
   * Archon extension: other skills this one depends on. Resolution is honored
   * by `resolve-node-content.ts`: a skill in `requires` that's missing from
   * the node's `skills:` list is auto-appended with a warning; cycles throw.
   * Names are the kebab-case skill names (NOT full paths).
   */
  requires: z.array(z.string().min(1).regex(skillNamePattern)).optional(),
  /**
   * Archon extension: short usage examples displayed in `archon skills show`
   * and (eventually) used to hint `archon_plan_session`. Keep each entry to
   * a sentence or two — longer narratives belong in the skill body.
   */
  examples: z.array(z.string().min(1)).optional(),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

/**
 * A fully loaded skill — frontmatter + body, with source provenance for diagnostics.
 */
export interface ResolvedSkill {
  /** Skill name (from frontmatter, validated against the directory name). */
  name: string;
  /** Frontmatter discovery description. */
  description: string;
  /** Optional frontmatter-level model hint. */
  model?: string;
  /** Optional discovery tags (see schema). */
  tags?: string[];
  /** Optional dependency list (see schema). */
  requires?: string[];
  /** Optional usage examples (see schema). */
  examples?: string[];
  /** Markdown body (system-prompt contribution). */
  body: string;
  /** Which source tier provided this skill. */
  source: 'bundled' | 'global' | 'project';
  /** Absolute filesystem path (undefined for bundled). */
  path?: string;
}
