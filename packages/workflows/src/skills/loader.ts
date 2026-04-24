/**
 * Skill loader — reads SKILL.md files from bundled < global < project sources.
 *
 * A skill is a directory `<root>/<name>/SKILL.md` with YAML frontmatter (`name`,
 * `description`, optional `model`) and a markdown body used as system-prompt
 * contribution. Archon merges three sources with project winning over global
 * winning over bundled, matching the rest of the defaults system.
 *
 * Bundled content is passed in (not read from disk) so this module stays
 * decoupled from the `bundled-defaults.generated.ts` embedding strategy —
 * Increment 2 of the integration plan wires that up.
 */
import { access, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { parseFrontmatter } from '../frontmatter';
import type { ResolvedSkill, SkillFrontmatter } from '../schemas/skills';
import { skillFrontmatterSchema } from '../schemas/skills';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.skills');
  return cachedLog;
}

/**
 * Bundled skills map — populated from `bundled-defaults.generated.ts` once
 * Increment 2 lands. Values are raw SKILL.md contents (frontmatter + body).
 */
export type BundledSkills = Record<string, string>;

/**
 * Thrown by `loadSkill` when the named skill is absent from every source
 * (project / global / bundled). Callers that have a legitimate
 * "skip if not found" semantic (e.g. the DAG resolver falling back to raw
 * pass-through) should catch this narrow type and let any other error bubble
 * — load errors like malformed frontmatter or permission denials must
 * surface, not be silently swallowed.
 */
export class SkillNotFoundError extends Error {
  constructor(public readonly name: string) {
    super(`Skill '${name}' not found in any source (project, global, bundled).`);
    this.name = 'SkillNotFoundError';
  }
}

export interface SkillLoaderSources {
  /** Bundled SKILL.md contents keyed by skill name. */
  bundled?: BundledSkills;
  /** Absolute path to `~/.archon/skills/` (or equivalent global dir). Optional. */
  globalDir?: string;
  /** Absolute path to `<repo>/.archon/skills/`. Optional. */
  projectDir?: string;
}

/**
 * Load a skill by name, honoring project > global > bundled precedence. Throws
 * if the named skill is missing from every source, or if its frontmatter is
 * invalid in whichever source wins.
 */
export async function loadSkill(name: string, sources: SkillLoaderSources): Promise<ResolvedSkill> {
  // Project scope wins first.
  if (sources.projectDir !== undefined) {
    const resolved = await tryLoadFromDir(sources.projectDir, name, 'project');
    if (resolved !== undefined) return resolved;
  }
  if (sources.globalDir !== undefined) {
    const resolved = await tryLoadFromDir(sources.globalDir, name, 'global');
    if (resolved !== undefined) return resolved;
  }
  if (sources.bundled?.[name] !== undefined) {
    return parseSkillContent(name, sources.bundled[name], 'bundled', undefined);
  }

  throw new SkillNotFoundError(name);
}

/**
 * List every skill name resolvable from the given sources, deduplicated. A
 * project override for a bundled skill appears once (project wins). Returns a
 * simple summary — callers can `loadSkill()` to get bodies.
 */
export async function listSkills(
  sources: SkillLoaderSources
): Promise<{ name: string; source: 'project' | 'global' | 'bundled' }[]> {
  const seen = new Map<string, 'project' | 'global' | 'bundled'>();

  if (sources.projectDir !== undefined) {
    for (const name of await listSkillDirs(sources.projectDir)) {
      if (!seen.has(name)) seen.set(name, 'project');
    }
  }
  if (sources.globalDir !== undefined) {
    for (const name of await listSkillDirs(sources.globalDir)) {
      if (!seen.has(name)) seen.set(name, 'global');
    }
  }
  if (sources.bundled !== undefined) {
    for (const name of Object.keys(sources.bundled)) {
      if (!seen.has(name)) seen.set(name, 'bundled');
    }
  }

  return Array.from(seen, ([name, source]) => ({ name, source }));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function tryLoadFromDir(
  root: string,
  name: string,
  source: 'project' | 'global'
): Promise<ResolvedSkill | undefined> {
  const filePath = join(root, name, 'SKILL.md');
  try {
    await access(filePath);
  } catch {
    return undefined;
  }
  const content = await readFile(filePath, 'utf-8');
  return parseSkillContent(name, content, source, filePath);
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Only count a directory as a skill if it actually contains SKILL.md.
      const skillPath = join(root, entry.name, 'SKILL.md');
      try {
        const s = await stat(skillPath);
        if (s.isFile()) names.push(entry.name);
      } catch {
        // missing — skip
      }
    }
    return names;
  } catch {
    // Missing root dir is not an error — just means no skills at this scope.
    return [];
  }
}

function parseSkillContent(
  expectedName: string,
  content: string,
  source: ResolvedSkill['source'],
  path: string | undefined
): ResolvedSkill {
  const { data, body, hasFrontmatter } = parseFrontmatter(content);
  if (!hasFrontmatter) {
    throw new Error(
      `Skill '${expectedName}' (${source}${path !== undefined ? ` at ${path}` : ''}) has no YAML frontmatter.`
    );
  }

  const parsed = skillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Skill '${expectedName}' (${source}${path !== undefined ? ` at ${path}` : ''}) has invalid frontmatter: ${issues}`
    );
  }

  const fm: SkillFrontmatter = parsed.data;
  if (fm.name !== expectedName) {
    getLog().warn(
      { expected: expectedName, got: fm.name, source, path },
      'skill_frontmatter_name_mismatch'
    );
  }

  return {
    name: fm.name,
    description: fm.description,
    model: fm.model,
    tags: fm.tags,
    requires: fm.requires,
    examples: fm.examples,
    body: body.trimStart(),
    source,
    path,
  };
}
