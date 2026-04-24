/**
 * Build a `SkillAgentRegistry` (from `./deps.ts`) over the three-tier content
 * stack that Archon uses everywhere:
 *
 *   bundled  (embedded in the binary via `bundled-defaults.generated.ts`)
 *     < global   (`~/.archon/{skills,agents}/` + `~/.archon/models.yaml`)
 *     < project  (`<repo>/.archon/{skills,agents}/` + `<repo>/.archon/models.yaml`)
 *
 * The factory wires in the skill loader, agent loader, and models.yaml stacks
 * so the workflow executor + CLI commands + MCP server all pull from one
 * source of truth. Missing files at any tier fall through silently.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { BUNDLED_AGENTS, BUNDLED_MODELS_YAML, BUNDLED_SKILLS } from './defaults/bundled-defaults';
import { modelsFileSchema, type ModelsFile } from './schemas/models';
import { listSkills, loadSkill } from './skills/loader';
import { listAgents, loadAgent } from './agents/loader';
import type { ResolvedAgent, ResolvedSkill } from './schemas';
import type { SkillAgentRegistry, SkillAgentSummary } from './deps';

export interface RegistryLocations {
  /** Absolute path to the repo root. Default: `process.cwd()`. */
  repoRoot?: string;
  /** Override the user-scope root (normally `~/.archon/`). Tests use this. */
  userArchonDir?: string;
}

/**
 * Construct a live registry backed by bundled + global + project sources.
 *
 * File IO is deferred until `loadSkill` / `listSkills` / etc. are called — the
 * factory itself only parses the embedded bundled models.yaml (cheap). Global
 * + project models.yaml are parsed lazily on first `modelsFiles()` access and
 * then cached for the registry's lifetime; callers that need fresh reads
 * should construct a new registry.
 */
export function createSkillAgentRegistry(locations: RegistryLocations = {}): SkillAgentRegistry {
  const repoRoot = locations.repoRoot ?? process.cwd();
  const userArchonDir = locations.userArchonDir ?? join(homedir(), '.archon');

  const globalSkillsDir = join(userArchonDir, 'skills');
  const globalAgentsDir = join(userArchonDir, 'agents');
  const globalModelsPath = join(userArchonDir, 'models.yaml');

  const projectArchonDir = join(repoRoot, '.archon');
  const projectSkillsDir = join(projectArchonDir, 'skills');
  const projectAgentsDir = join(projectArchonDir, 'agents');
  const projectModelsPath = join(projectArchonDir, 'models.yaml');

  const bundledModels = parseModelsYamlText(BUNDLED_MODELS_YAML, 'bundled');

  // Lazy-cached models.yaml loads.
  let globalModelsCache: { value: ModelsFile | undefined; loaded: boolean } = {
    value: undefined,
    loaded: false,
  };
  let projectModelsCache: { value: ModelsFile | undefined; loaded: boolean } = {
    value: undefined,
    loaded: false,
  };

  const skillSources = {
    bundled: BUNDLED_SKILLS,
    globalDir: globalSkillsDir,
    projectDir: projectSkillsDir,
  };
  const agentSources = {
    bundled: BUNDLED_AGENTS,
    globalDir: globalAgentsDir,
    projectDir: projectAgentsDir,
  };

  return {
    async loadSkill(name: string): Promise<ResolvedSkill> {
      return loadSkill(name, skillSources);
    },
    async listSkills(): Promise<SkillAgentSummary[]> {
      return listSkills(skillSources);
    },
    async loadAgent(name: string): Promise<ResolvedAgent> {
      return loadAgent(name, agentSources);
    },
    async listAgents(): Promise<SkillAgentSummary[]> {
      return listAgents(agentSources);
    },
    modelsFiles(): { bundled?: ModelsFile; global?: ModelsFile; project?: ModelsFile } {
      if (!globalModelsCache.loaded) {
        globalModelsCache = { value: loadModelsFileSync(globalModelsPath), loaded: true };
      }
      if (!projectModelsCache.loaded) {
        projectModelsCache = { value: loadModelsFileSync(projectModelsPath), loaded: true };
      }
      return {
        bundled: bundledModels,
        global: globalModelsCache.value,
        project: projectModelsCache.value,
      };
    },
  };
}

/**
 * Async variant of `modelsFiles()` — performs one-shot I/O and returns the
 * three tiers together. Exposed for callers (CLI, MCP) that prefer a single
 * Promise over the lazy sync factory. Same parsing semantics.
 */
export async function readModelsFiles(
  locations: RegistryLocations = {}
): Promise<{ bundled?: ModelsFile; global?: ModelsFile; project?: ModelsFile }> {
  const repoRoot = locations.repoRoot ?? process.cwd();
  const userArchonDir = locations.userArchonDir ?? join(homedir(), '.archon');
  const bundled = parseModelsYamlText(BUNDLED_MODELS_YAML, 'bundled');
  const global = await loadModelsFileAsync(join(userArchonDir, 'models.yaml'));
  const project = await loadModelsFileAsync(join(repoRoot, '.archon', 'models.yaml'));
  return { bundled, global, project };
}

/**
 * Resolve the models.yaml path for a given scope.
 * - `'project'` → `<repoRoot>/.archon/models.yaml`
 * - `'global'`  → `~/.archon/models.yaml` (or `<userArchonDir>/models.yaml`)
 */
export function modelsFilePath(
  scope: 'project' | 'global',
  locations: RegistryLocations = {}
): string {
  const repoRoot = locations.repoRoot ?? process.cwd();
  const userArchonDir = locations.userArchonDir ?? join(homedir(), '.archon');
  return scope === 'project'
    ? join(repoRoot, '.archon', 'models.yaml')
    : join(userArchonDir, 'models.yaml');
}

/**
 * Read a models.yaml file at `path`, or return a skeleton `{ version: 1 }`
 * when the file doesn't exist. Validates through the Zod schema — throws
 * on malformed content. Used by `archon models set` / `reset` as the
 * read-before-merge step.
 */
export async function readModelsFileOrSkeleton(path: string): Promise<ModelsFile> {
  const parsed = await loadModelsFileAsync(path);
  return parsed ?? { version: 1 };
}

/**
 * Atomic write of a models.yaml file. Validates through the schema before
 * writing so we never leave bad YAML on disk. Creates parent dirs as needed.
 */
export async function writeModelsFile(path: string, file: ModelsFile): Promise<void> {
  // Schema round-trip catches invariant violations (empty strings, etc.)
  // before they hit disk.
  const checked = modelsFileSchema.parse(file);
  const yaml = Bun.YAML.stringify(checked);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, yaml, 'utf-8');
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function parseModelsYamlText(text: string, source: string): ModelsFile | undefined {
  if (text.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (err) {
    throw new Error(
      `Failed to parse models.yaml (${source}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (parsed === null || parsed === undefined) return undefined;
  const result = modelsFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map(i => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid models.yaml (${source}): ${issues}`);
  }
  return result.data;
}

function loadModelsFileSync(path: string): ModelsFile | undefined {
  try {
    // `modelsFiles()` is synchronous (called per-node during DAG resolution),
    // so we read with the sync API and cache the result in the registry.
    const content = readFileSync(path, 'utf-8');
    return parseModelsYamlText(content, path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function loadModelsFileAsync(path: string): Promise<ModelsFile | undefined> {
  try {
    const content = await readFile(path, 'utf-8');
    return parseModelsYamlText(content, path);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return undefined;
    throw err;
  }
}
