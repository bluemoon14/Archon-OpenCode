/**
 * Data-gathering functions shared between the CLI `skills|agents|models list`
 * commands and the MCP server's tool handlers. Pure async functions that
 * return structured data — the CLI wraps them in formatted `console.log`
 * output, the MCP tools serialize them to JSON for the host model.
 *
 * Why extracted: when both sides (interactive CLI + programmatic MCP) need
 * the same view of the SkillAgentRegistry, duplicating the data-gathering
 * loop creates drift risk. Single source here, thin presenters on both
 * sides.
 */
import { createSkillAgentRegistry } from '@archon/workflows/skill-agent-registry';
import {
  resolveAgentModel,
  resolveNodeModel,
  resolveSkillModel,
} from '@archon/workflows/model-resolution';

export interface SkillRowData {
  name: string;
  source: 'project' | 'global' | 'bundled';
  description: string;
  model: string;
  modelSource: string;
  aliasExpanded: boolean;
}

export interface AgentRowData extends SkillRowData {
  tools?: string[];
  maxTurns?: number;
}

export interface SkillDetailData extends SkillRowData {
  path?: string;
  frontmatterModel?: string;
  body: string;
}

export interface AgentDetailData extends AgentRowData {
  path?: string;
  frontmatterModel?: string;
  body: string;
}

export interface ModelsTableData {
  defaults: {
    node: string;
    nodeSource: string;
    skillDefault?: string;
    agentDefault?: string;
  };
  aliases: Record<string, string>;
  skills: SkillRowData[];
  agents: AgentRowData[];
}

export async function gatherSkillsList(cwd: string): Promise<SkillRowData[]> {
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const list = await registry.listSkills();
  const files = registry.modelsFiles();
  const rows = await Promise.all(
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
        aliasExpanded: resolved.aliasExpanded,
      };
    })
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export async function gatherSkillDetail(cwd: string, name: string): Promise<SkillDetailData> {
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const skill = await registry.loadSkill(name);
  const files = registry.modelsFiles();
  const resolved = resolveSkillModel({
    skillName: name,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: skill.model,
    defaultAssistantModel: 'sonnet',
  });
  return {
    name: skill.name,
    source: skill.source,
    description: skill.description,
    model: resolved.model,
    modelSource: resolved.source,
    aliasExpanded: resolved.aliasExpanded,
    ...(skill.path !== undefined ? { path: skill.path } : {}),
    ...(skill.model !== undefined ? { frontmatterModel: skill.model } : {}),
    body: skill.body,
  };
}

export async function gatherAgentsList(cwd: string): Promise<AgentRowData[]> {
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const list = await registry.listAgents();
  const files = registry.modelsFiles();
  const rows = await Promise.all(
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
        aliasExpanded: resolved.aliasExpanded,
        ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
        ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
      };
    })
  );
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

export async function gatherAgentDetail(cwd: string, name: string): Promise<AgentDetailData> {
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const agent = await registry.loadAgent(name);
  const files = registry.modelsFiles();
  const resolved = resolveAgentModel({
    agentName: name,
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    frontmatter: agent.model,
    defaultAssistantModel: 'sonnet',
  });
  return {
    name: agent.name,
    source: agent.source,
    description: agent.description,
    model: resolved.model,
    modelSource: resolved.source,
    aliasExpanded: resolved.aliasExpanded,
    ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
    ...(agent.maxTurns !== undefined ? { maxTurns: agent.maxTurns } : {}),
    ...(agent.path !== undefined ? { path: agent.path } : {}),
    ...(agent.model !== undefined ? { frontmatterModel: agent.model } : {}),
    body: agent.body,
  };
}

export async function gatherModelsTable(cwd: string): Promise<ModelsTableData> {
  const registry = createSkillAgentRegistry({ repoRoot: cwd });
  const files = registry.modelsFiles();
  const [skills, agents] = await Promise.all([gatherSkillsList(cwd), gatherAgentsList(cwd)]);
  const nodeDefault = resolveNodeModel({
    bundled: files.bundled,
    global: files.global,
    project: files.project,
    defaultAssistantModel: 'sonnet',
  });
  return {
    defaults: {
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
    },
    aliases: {
      ...(files.bundled?.aliases ?? {}),
      ...(files.global?.aliases ?? {}),
      ...(files.project?.aliases ?? {}),
    },
    skills,
    agents,
  };
}
