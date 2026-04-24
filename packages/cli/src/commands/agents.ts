/**
 * `archon agents list` / `archon agents show <name>` CLI commands.
 *
 * Same shape + conventions as `archon skills …` (see ./skills.ts). Outputs the
 * three-tier content merge with resolved model per agent.
 */
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';
import { resolveAgentModel } from '@archon/workflows/model-resolution';

export interface AgentsListOptions {
  cwd: string;
  json?: boolean;
}

export async function agentsListCommand(opts: AgentsListOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  const list = await registry.listAgents();
  const files = registry.modelsFiles();

  const enriched = await Promise.all(
    list.map(async entry => {
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
        name: entry.name,
        source: entry.source,
        description: agent.description,
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
    console.log('No agents found.');
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
        e.description.length > 60 ? e.description.slice(0, 57) + '...' : e.description,
      ].join('  ')
    );
  }
  return 0;
}

export interface AgentsShowOptions {
  cwd: string;
  name: string;
  json?: boolean;
}

export async function agentsShowCommand(opts: AgentsShowOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  let agent;
  try {
    agent = await registry.loadAgent(opts.name);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const files = registry.modelsFiles();
  const resolved = resolveAgentModel({
    agentName: opts.name,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: agent.model,
    defaultAssistantModel: 'sonnet',
  });

  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          name: agent.name,
          description: agent.description,
          source: agent.source,
          path: agent.path,
          frontmatterModel: agent.model,
          resolvedModel: resolved.model,
          resolvedModelSource: resolved.source,
          tools: agent.tools,
          maxTurns: agent.maxTurns,
          body: agent.body,
        },
        null,
        2
      )
    );
    return 0;
  }

  console.log(`Agent: ${agent.name}`);
  console.log(`Source: ${agent.source}${agent.path !== undefined ? ` (${agent.path})` : ''}`);
  console.log(`Description: ${agent.description}`);
  console.log(`Resolved model: ${resolved.model}  [source: ${resolved.source}]`);
  if (agent.tools !== undefined) console.log(`Tools: ${agent.tools.join(', ')}`);
  if (agent.maxTurns !== undefined) console.log(`Max turns: ${String(agent.maxTurns)}`);
  console.log('');
  console.log('--- Agent body (system prompt) ---');
  console.log(agent.body);
  return 0;
}
