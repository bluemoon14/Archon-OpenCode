/**
 * `archon skills list` / `archon skills show <name>` CLI commands.
 *
 * Surfaces the SkillAgentRegistry's content to the user. Always reads the
 * 3-tier stack (bundled < global < project) so users see what's actually
 * installed + what would run for their current repo.
 *
 * Format is plain text by default; `--json` flips to a stable machine shape
 * so scripts / the MCP tools (Increment 5b) can reuse the same data path.
 */
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';
import { resolveSkillModel } from '@archon/workflows/model-resolution';

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
