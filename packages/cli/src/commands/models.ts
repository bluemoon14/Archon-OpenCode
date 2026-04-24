/**
 * `archon models list` — prints the full skill + agent assignment table with
 * the resolver's winning tier next to each entry. The single place to audit
 * "which model will this skill / agent actually use?" without reading YAML.
 *
 * Deferred (follow-up): `models set|reset|validate` subcommands. Today users
 * edit `.archon/models.yaml` directly — the resolver picks up changes on the
 * next run. A guided setter is pure convenience.
 */
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';
import {
  resolveAgentModel,
  resolveNodeModel,
  resolveSkillModel,
} from '@archon/workflows/model-resolution';

export interface ModelsListOptions {
  cwd: string;
  json?: boolean;
}

export async function modelsListCommand(opts: ModelsListOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  const files = registry.modelsFiles();

  const skills = await registry.listSkills();
  const agents = await registry.listAgents();

  const skillRows = await Promise.all(
    skills.map(async entry => {
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
        kind: 'skill' as const,
        name: entry.name,
        contentSource: entry.source,
        model: resolved.model,
        modelSource: resolved.source,
        aliasExpanded: resolved.aliasExpanded,
      };
    })
  );

  const agentRows = await Promise.all(
    agents.map(async entry => {
      const agent = await registry.loadAgent(entry.name);
      const resolved = resolveAgentModel({
        agentName: entry.name,
        bundled: files.bundled,
        global: files.global,
        project: files.project,
        frontmatter: agent.model,
        defaultAssistantModel: 'sonnet',
      });
      return {
        kind: 'agent' as const,
        name: entry.name,
        contentSource: entry.source,
        model: resolved.model,
        modelSource: resolved.source,
        aliasExpanded: resolved.aliasExpanded,
      };
    })
  );

  const nodeDefault = resolveNodeModel({
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    defaultAssistantModel: 'sonnet',
  });

  const defaults = {
    node: nodeDefault.model,
    nodeSource: nodeDefault.source,
    skillDefault:
      files.project?.defaults?.skill ??
      files.global?.defaults?.skill ??
      files.bundled?.defaults?.skill,
    agentDefault:
      files.project?.defaults?.agent ??
      files.global?.defaults?.agent ??
      files.bundled?.defaults?.agent,
  };

  const aliases = {
    ...(files.bundled?.aliases ?? {}),
    ...(files.global?.aliases ?? {}),
    ...(files.project?.aliases ?? {}),
  };

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          defaults,
          aliases,
          skills: [...skillRows].sort((a, b) => a.name.localeCompare(b.name)),
          agents: [...agentRows].sort((a, b) => a.name.localeCompare(b.name)),
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log('Defaults');
  console.log(`  node:  ${defaults.node}  [source: ${defaults.nodeSource}]`);
  console.log(`  skill: ${defaults.skillDefault ?? '(unset)'}`);
  console.log(`  agent: ${defaults.agentDefault ?? '(unset)'}`);
  console.log('');

  if (Object.keys(aliases).length > 0) {
    console.log('Aliases');
    for (const [k, v] of Object.entries(aliases).sort()) {
      console.log(`  ${k} → ${v}`);
    }
    console.log('');
  }

  const allRows = [...skillRows, ...agentRows].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind)
  );
  const nameW = Math.max(4, ...allRows.map(r => r.name.length));
  const kindW = Math.max(5, ...allRows.map(r => r.kind.length));
  const modelW = Math.max(5, ...allRows.map(r => r.model.length));
  const header = [
    'KIND'.padEnd(kindW),
    'NAME'.padEnd(nameW),
    'MODEL'.padEnd(modelW),
    'SOURCE',
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of allRows) {
    console.log(
      [
        r.kind.padEnd(kindW),
        r.name.padEnd(nameW),
        r.model.padEnd(modelW),
        r.modelSource + (r.aliasExpanded ? ' (alias)' : ''),
      ].join('  ')
    );
  }
  return 0;
}
