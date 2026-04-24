/**
 * Agent loader — reads `<name>.md` files from bundled < global < project sources.
 *
 * Agents are single-file markdown definitions with YAML frontmatter (`name`,
 * `description`, optional `model`/`tools`/`maxTurns`) and a body used as the
 * agent's system prompt. Mirrors the skill loader but operates on flat files
 * under the agents/ root instead of skill directories.
 */
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@archon/paths';
import { parseFrontmatter } from '../frontmatter';
import type { AgentFrontmatter, ResolvedAgent } from '../schemas/agents';
import { agentFrontmatterSchema } from '../schemas/agents';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('workflow.agents');
  return cachedLog;
}

/** Bundled agents map — keyed by agent name (filename without `.md`). */
export type BundledAgents = Record<string, string>;

export interface AgentLoaderSources {
  bundled?: BundledAgents;
  globalDir?: string;
  projectDir?: string;
}

export async function loadAgent(name: string, sources: AgentLoaderSources): Promise<ResolvedAgent> {
  if (sources.projectDir !== undefined) {
    const resolved = await tryLoadFromDir(sources.projectDir, name, 'project');
    if (resolved !== undefined) return resolved;
  }
  if (sources.globalDir !== undefined) {
    const resolved = await tryLoadFromDir(sources.globalDir, name, 'global');
    if (resolved !== undefined) return resolved;
  }
  if (sources.bundled?.[name] !== undefined) {
    return parseAgentContent(name, sources.bundled[name], 'bundled', undefined);
  }

  throw new Error(`Agent '${name}' not found in any source (project, global, bundled).`);
}

export async function listAgents(
  sources: AgentLoaderSources
): Promise<{ name: string; source: 'project' | 'global' | 'bundled' }[]> {
  const seen = new Map<string, 'project' | 'global' | 'bundled'>();

  if (sources.projectDir !== undefined) {
    for (const name of await listAgentFiles(sources.projectDir)) {
      if (!seen.has(name)) seen.set(name, 'project');
    }
  }
  if (sources.globalDir !== undefined) {
    for (const name of await listAgentFiles(sources.globalDir)) {
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
): Promise<ResolvedAgent | undefined> {
  const filePath = join(root, `${name}.md`);
  try {
    await access(filePath);
  } catch {
    return undefined;
  }
  const content = await readFile(filePath, 'utf-8');
  return parseAgentContent(name, content, source, filePath);
}

async function listAgentFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const names: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith('.md')) continue;
      names.push(entry.name.slice(0, -'.md'.length));
    }
    return names;
  } catch {
    return [];
  }
}

function parseAgentContent(
  expectedName: string,
  content: string,
  source: ResolvedAgent['source'],
  path: string | undefined
): ResolvedAgent {
  const { data, body, hasFrontmatter } = parseFrontmatter(content);
  if (!hasFrontmatter) {
    throw new Error(
      `Agent '${expectedName}' (${source}${path !== undefined ? ` at ${path}` : ''}) has no YAML frontmatter.`
    );
  }

  const parsed = agentFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(
      `Agent '${expectedName}' (${source}${path !== undefined ? ` at ${path}` : ''}) has invalid frontmatter: ${issues}`
    );
  }

  const fm: AgentFrontmatter = parsed.data;
  if (fm.name !== expectedName) {
    getLog().warn(
      { expected: expectedName, got: fm.name, source, path },
      'agent_frontmatter_name_mismatch'
    );
  }

  return {
    name: fm.name,
    description: fm.description,
    model: fm.model,
    tools: fm.tools,
    maxTurns: fm.maxTurns,
    body: body.trimStart(),
    source,
    path,
  };
}
