/**
 * `archon skills list|show|create` CLI commands.
 *
 * `list` / `show` surface the SkillAgentRegistry's content — always reading
 * the 3-tier stack (bundled < global < project) so users see what's
 * actually installed + what would run for their current repo.
 *
 * `create` scaffolds a new SKILL.md from a template (Phase 2A). Refuses
 * to overwrite existing files so repeated runs are safe.
 *
 * Format is plain text by default; `--json` flips to a stable machine
 * shape so scripts / MCP tools can reuse the same data path.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';
import { resolveSkillModel } from '@archon/workflows/model-resolution';

/** Mirrors packages/workflows/src/schemas/skills.ts — kept local to avoid a
 *  cross-package import just for one regex. Keep in sync. */
const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export interface SkillsListOptions {
  cwd: string;
  json?: boolean;
}

export async function skillsListCommand(opts: SkillsListOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  const list = await registry.listSkills();
  const files = registry.modelsFiles();

  // Enrich each entry with its resolved model (what would actually run).
  const enriched = await Promise.all(
    list.map(async entry => {
      const skill = await registry.loadSkill(entry.name);
      const resolved = resolveSkillModel({
        skillName: entry.name,
        bundled: files.bundled,
        global: files.global,
        project: files.project,
        frontmatter: skill.model,
        defaultAssistantModel: 'sonnet',
      });
      return {
        name: entry.name,
        source: entry.source,
        description: skill.description,
        model: resolved.model,
        modelSource: resolved.source,
      };
    })
  );
  enriched.sort((a, b) => a.name.localeCompare(b.name));

  if (opts.json === true) {
    console.log(JSON.stringify(enriched, null, 2));
    return 0;
  }

  if (enriched.length === 0) {
    console.log(
      'No skills found. Bundled superpowers content should always be available — ' +
        'run `bun run generate:bundled` from the repo root to refresh if you expected content.'
    );
    return 0;
  }

  const nameW = Math.max(4, ...enriched.map(e => e.name.length));
  const srcW = Math.max(6, ...enriched.map(e => e.source.length));
  const modelW = Math.max(5, ...enriched.map(e => e.model.length));
  const header = [
    'NAME'.padEnd(nameW),
    'SOURCE'.padEnd(srcW),
    'MODEL'.padEnd(modelW),
    'DESCRIPTION',
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const e of enriched) {
    console.log(
      [
        e.name.padEnd(nameW),
        e.source.padEnd(srcW),
        e.model.padEnd(modelW),
        // Truncate description for readability — full text via `skills show`.
        e.description.length > 60 ? e.description.slice(0, 57) + '...' : e.description,
      ].join('  ')
    );
  }
  return 0;
}

export interface SkillsShowOptions {
  cwd: string;
  name: string;
  json?: boolean;
}

export async function skillsShowCommand(opts: SkillsShowOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  let skill;
  try {
    skill = await registry.loadSkill(opts.name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const files = registry.modelsFiles();
  const resolved = resolveSkillModel({
    skillName: opts.name,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: skill.model,
    defaultAssistantModel: 'sonnet',
  });

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          name: skill.name,
          description: skill.description,
          source: skill.source,
          path: skill.path,
          frontmatterModel: skill.model,
          resolvedModel: resolved.model,
          resolvedModelSource: resolved.source,
          body: skill.body,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(`Skill: ${skill.name}`);
  console.log(`Source: ${skill.source}${skill.path !== undefined ? ` (${skill.path})` : ''}`);
  console.log(`Description: ${skill.description}`);
  console.log(`Resolved model: ${resolved.model}  [source: ${resolved.source}]`);
  console.log('');
  console.log('--- SKILL.md body ---');
  console.log(skill.body);
  return 0;
}

export interface SkillsCreateOptions {
  cwd: string;
  name: string;
  description: string;
  /** Write to `~/.archon/skills/` instead of `<cwd>/.archon/skills/`. */
  global?: boolean;
  /**
   * Optional override for the user home dir used when `global === true`.
   * Exists because `os.homedir()` is Node-cached per-process and cannot be
   * redirected via HOME env after process start — tests pass a synthetic
   * dir here. CLI callers never set it.
   */
  homeDir?: string;
}

/**
 * Scaffold a new SKILL.md. Deliberately minimal: creates the directory +
 * file with a commented-out stub showing every optional frontmatter field.
 * Callers can then `$EDITOR` the file to fill in the body.
 */
export function skillsCreateCommand(opts: SkillsCreateOptions): number {
  if (!SKILL_NAME_PATTERN.test(opts.name)) {
    console.error(
      `Invalid skill name '${opts.name}'. Must be lowercase kebab-case ` +
        `matching ${SKILL_NAME_PATTERN} (e.g. 'systematic-debugging').`
    );
    return 1;
  }
  if (opts.description.trim().length === 0) {
    console.error("Skill 'description' is required and must be non-empty.");
    return 1;
  }

  const skillsRoot =
    opts.global === true
      ? join(opts.homeDir ?? homedir(), '.archon', 'skills')
      : join(opts.cwd, '.archon', 'skills');
  const skillDir = join(skillsRoot, opts.name);
  const skillPath = join(skillDir, 'SKILL.md');

  if (existsSync(skillPath)) {
    console.error(
      `Refusing to overwrite existing skill at ${skillPath}.\n` +
        'Delete the file first or choose a different name.'
    );
    return 1;
  }

  mkdirSync(skillDir, { recursive: true });

  // Commented optional fields make the extension surface discoverable
  // without forcing the user to look up the schema. `description` is
  // required and written unquoted so YAML parsing is simplest.
  const template = `---
name: ${opts.name}
description: ${opts.description}
# Optional — uncomment any of these to customize:
# model: inherit          # or anthropic/claude-opus-4-5, sonnet, a models.yaml alias, etc.
# tags:
#   - discovery-hint-a
#   - discovery-hint-b
# requires:
#   - other-skill-name
# examples:
#   - "Use when …"
---

<!-- Describe what this skill does. The body becomes part of the system
prompt when this skill is selected by a workflow node. Keep it focused —
skills are composable. -->
`;

  writeFileSync(skillPath, template, 'utf-8');
  console.log(`Created ${skillPath}`);
  console.log('Edit the body, then reference this skill from a workflow node.');
  return 0;
}
