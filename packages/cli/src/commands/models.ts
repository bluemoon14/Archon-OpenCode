/**
 * `archon models list|set|reset|validate` — read + write surface over the
 * models.yaml manifest. Read-only `list` audits the resolver's winning tier
 * per entry. The write subcommands (`set`, `reset`) target project scope by
 * default (`.archon/models.yaml`); pass `--global` to target `~/.archon/
 * models.yaml`. `validate` parses all three tiers through the Zod schema
 * and checks every model string is routable.
 */
import { resolve } from 'node:path';
import {
  createSkillAgentRegistry,
  modelsFilePath,
  readModelsFileOrSkeleton,
  writeModelsFile,
} from '@archon/workflows/skill-agent-registry';
import {
  resolveAgentModel,
  resolveNodeModel,
  resolveSkillModel,
  traceAgentModel,
  traceSkillModel,
  type TierCheck,
} from '@archon/workflows/model-resolution';
import { modelsFileSchema, type ModelsFile } from '@archon/workflows/schemas/models';
import { inferProviderFromModel, isModelCompatible } from '@archon/workflows/model-validation';

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

// ---------------------------------------------------------------------------
// set / reset / validate
// ---------------------------------------------------------------------------

export type ModelsKind = 'skill' | 'agent' | 'default' | 'alias';

const VALID_DEFAULT_NAMES = new Set(['node', 'skill', 'agent']);

function kindIsValid(kind: string): kind is ModelsKind {
  return kind === 'skill' || kind === 'agent' || kind === 'default' || kind === 'alias';
}

export interface ModelsSetOptions {
  cwd: string;
  kind: string;
  name: string;
  model: string;
  global?: boolean;
}

export async function modelsSetCommand(opts: ModelsSetOptions): Promise<number> {
  if (!kindIsValid(opts.kind)) {
    console.error(`Unknown kind '${opts.kind}'. Must be one of: skill, agent, default, alias.`);
    return 1;
  }
  if (opts.kind === 'default' && !VALID_DEFAULT_NAMES.has(opts.name)) {
    console.error(`Unknown default key '${opts.name}'. Must be one of: node, skill, agent.`);
    return 1;
  }
  if (opts.name.length === 0 || opts.model.length === 0) {
    console.error('Both <name> and <model> are required.');
    return 1;
  }

  const scope: 'project' | 'global' = opts.global === true ? 'global' : 'project';
  const path = modelsFilePath(scope, { repoRoot: opts.cwd });
  const file = await readModelsFileOrSkeleton(path);
  const updated = applyModelsSet(file, opts.kind, opts.name, opts.model);
  await writeModelsFile(path, updated);

  console.log(`✓ Wrote ${path}`);
  console.log(`  ${renderKey(opts.kind, opts.name)}: ${opts.model}`);
  return 0;
}

export interface ModelsResetOptions {
  cwd: string;
  kind: string;
  name: string;
  global?: boolean;
}

export async function modelsResetCommand(opts: ModelsResetOptions): Promise<number> {
  if (!kindIsValid(opts.kind)) {
    console.error(`Unknown kind '${opts.kind}'. Must be one of: skill, agent, default, alias.`);
    return 1;
  }

  const scope: 'project' | 'global' = opts.global === true ? 'global' : 'project';
  const path = modelsFilePath(scope, { repoRoot: opts.cwd });
  const file = await readModelsFileOrSkeleton(path);
  const { updated, removed } = applyModelsReset(file, opts.kind, opts.name);
  if (!removed) {
    console.log(`No ${renderKey(opts.kind, opts.name)} assignment in ${path} — nothing to reset.`);
    return 0;
  }
  await writeModelsFile(path, updated);
  console.log(`✓ Removed ${renderKey(opts.kind, opts.name)} from ${path}`);
  return 0;
}

export interface ModelsValidateOptions {
  cwd: string;
  json?: boolean;
}

interface ValidationIssue {
  scope: 'bundled' | 'global' | 'project';
  key: string;
  value: string;
  message: string;
}

export async function modelsValidateCommand(opts: ModelsValidateOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  let files: ReturnType<typeof registry.modelsFiles>;
  try {
    files = registry.modelsFiles();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const issues: ValidationIssue[] = [];
  const report: {
    scope: string;
    status: 'ok' | 'missing' | 'invalid';
    counts?: Record<string, number>;
  }[] = [];

  for (const scope of ['bundled', 'global', 'project'] as const) {
    const file = files[scope];
    if (!file) {
      report.push({ scope, status: 'missing' });
      continue;
    }
    const counts = {
      skills: Object.keys(file.skills ?? {}).length,
      agents: Object.keys(file.agents ?? {}).length,
      aliases: Object.keys(file.aliases ?? {}).length,
    };
    const aliasKeys = new Set(Object.keys(file.aliases ?? {}));
    // Collect every model string used in this file, plus the key path.
    const refs: { key: string; value: string }[] = [];
    for (const [key, val] of Object.entries(file.defaults ?? {})) {
      if (typeof val === 'string') refs.push({ key: `defaults.${key}`, value: val });
    }
    for (const [name, val] of Object.entries(file.skills ?? {})) {
      refs.push({ key: `skills.${name}`, value: val });
    }
    for (const [name, val] of Object.entries(file.agents ?? {})) {
      refs.push({ key: `agents.${name}`, value: val });
    }
    // Aliases themselves point at concrete model names; check the target.
    for (const [name, val] of Object.entries(file.aliases ?? {})) {
      refs.push({ key: `aliases.${name}`, value: val });
    }

    for (const { key, value } of refs) {
      // `inherit` + alias references + bare shorthand + canonical form all
      // count as "routable". Report anything that fails every check.
      if (value === 'inherit') continue;
      if (aliasKeys.has(value)) continue;
      const provider = inferProviderFromModel(value, 'claude');
      if (
        provider === 'claude' &&
        !['sonnet', 'opus', 'haiku'].includes(value) &&
        !value.startsWith('claude-')
      ) {
        // inferProviderFromModel falls back to claude for unknown — verify compatibility.
        if (!isModelCompatible('claude', value)) {
          issues.push({ scope, key, value, message: `no provider accepts model '${value}'` });
          continue;
        }
      }
      if (!isModelCompatible(provider, value)) {
        issues.push({
          scope,
          key,
          value,
          message: `model '${value}' not compatible with inferred provider '${provider}'`,
        });
      }
    }
    report.push({
      scope,
      status: issues.some(i => i.scope === scope) ? 'invalid' : 'ok',
      counts,
    });
  }

  if (opts.json === true) {
    console.log(JSON.stringify({ report, issues }, null, 2));
    return issues.length > 0 ? 1 : 0;
  }

  for (const r of report) {
    if (r.status === 'missing') {
      console.log(`  ${r.scope.padEnd(7)} models.yaml not present — skipped`);
    } else if (r.status === 'ok') {
      const c = r.counts ?? { skills: 0, agents: 0, aliases: 0 };
      console.log(
        `✓ ${r.scope.padEnd(7)} schema OK (${String(c.skills)} skills, ${String(c.agents)} agents, ${String(c.aliases)} aliases)`
      );
    } else {
      console.log(`✗ ${r.scope.padEnd(7)} has validation issues`);
    }
  }

  if (issues.length > 0) {
    console.log('');
    console.log('Issues:');
    for (const issue of issues) {
      console.log(`  [${issue.scope}] ${issue.key} = ${issue.value} — ${issue.message}`);
    }
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function renderKey(kind: string, name: string): string {
  if (kind === 'default') return `defaults.${name}`;
  return `${kind}s.${name}`;
}

function omitStringKey(obj: Record<string, string>, key: string): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

function omitDefaultsKey(
  obj: NonNullable<ModelsFile['defaults']>,
  key: string
): NonNullable<ModelsFile['defaults']> {
  const out: NonNullable<ModelsFile['defaults']> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === key) continue;
    if (k === 'node' || k === 'skill' || k === 'agent') {
      out[k] = v;
    }
  }
  return out;
}

export function applyModelsSet(
  file: ModelsFile,
  kind: ModelsKind,
  name: string,
  value: string
): ModelsFile {
  const next: ModelsFile = { ...file, version: 1 };
  if (kind === 'skill') {
    next.skills = { ...(file.skills ?? {}), [name]: value };
  } else if (kind === 'agent') {
    next.agents = { ...(file.agents ?? {}), [name]: value };
  } else if (kind === 'alias') {
    next.aliases = { ...(file.aliases ?? {}), [name]: value };
  } else {
    next.defaults = { ...(file.defaults ?? {}), [name]: value };
  }
  // Round-trip through the schema to catch any shape drift.
  return modelsFileSchema.parse(next);
}

// ---------------------------------------------------------------------------
// `archon models diff <other>` — compare two models.yaml manifests.
// ---------------------------------------------------------------------------

/**
 * Structured diff between two models.yaml manifests. Grouped by section so
 * callers can render per-section tables or summaries. `changes` lists
 * entries where both sides have the key but values differ; `aOnly` lists
 * keys present only in `a`; `bOnly` only in `b`.
 */
export interface ModelsFileDiffSection {
  aOnly: { name: string; value: string }[];
  bOnly: { name: string; value: string }[];
  changes: { name: string; a: string; b: string }[];
}

export interface ModelsFileDiff {
  /** `defaults` is a fixed-shape object, diffed field-by-field. */
  defaults: ModelsFileDiffSection;
  aliases: ModelsFileDiffSection;
  skills: ModelsFileDiffSection;
  agents: ModelsFileDiffSection;
}

/** Compare two records string→string. Used for every section except `defaults`. */
function diffRecord(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): ModelsFileDiffSection {
  const section: ModelsFileDiffSection = { aOnly: [], bOnly: [], changes: [] };
  const keys = new Set<string>([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const name of [...keys].sort()) {
    const av = a?.[name];
    const bv = b?.[name];
    if (av !== undefined && bv === undefined) section.aOnly.push({ name, value: av });
    else if (av === undefined && bv !== undefined) section.bOnly.push({ name, value: bv });
    else if (av !== undefined && bv !== undefined && av !== bv)
      section.changes.push({ name, a: av, b: bv });
  }
  return section;
}

/** Diff the `defaults` object — only three possible keys, but the shape is fixed. */
function diffDefaults(
  a?: ModelsFile['defaults'],
  b?: ModelsFile['defaults']
): ModelsFileDiffSection {
  return diffRecord(
    a as Record<string, string> | undefined,
    b as Record<string, string> | undefined
  );
}

/**
 * Pure diff function — no IO. Given two ModelsFile values, return the
 * structured diff. Useful for tests + for programmatic consumers (MCP?)
 * separately from the CLI's text/JSON rendering.
 */
export function diffModelsFiles(a: ModelsFile, b: ModelsFile): ModelsFileDiff {
  return {
    defaults: diffDefaults(a.defaults, b.defaults),
    aliases: diffRecord(a.aliases, b.aliases),
    skills: diffRecord(a.skills, b.skills),
    agents: diffRecord(a.agents, b.agents),
  };
}

export interface ModelsDiffOptions {
  cwd: string;
  /** Path to the other models.yaml (repo root OR explicit file). */
  other: string;
  /** Optional scope override for the *a* side. Default: project. */
  scope?: 'project' | 'global';
  json?: boolean;
}

/**
 * Resolve a user-supplied "other" target. If it looks like a models.yaml
 * file, use it directly; otherwise treat it as a repo root and point at
 * `<root>/.archon/models.yaml`.
 */
function resolveOtherPath(other: string): string {
  const abs = resolve(other);
  return abs.endsWith('.yaml') || abs.endsWith('.yml')
    ? abs
    : resolve(abs, '.archon', 'models.yaml');
}

export async function modelsDiffCommand(opts: ModelsDiffOptions): Promise<number> {
  const scope = opts.scope ?? 'project';
  const aPath = modelsFilePath(scope, { repoRoot: opts.cwd });
  const bPath = resolveOtherPath(opts.other);

  let a: ModelsFile;
  let b: ModelsFile;
  try {
    a = await readModelsFileOrSkeleton(aPath);
    b = await readModelsFileOrSkeleton(bPath);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const diff = diffModelsFiles(a, b);

  if (opts.json === true) {
    console.log(JSON.stringify({ a: aPath, b: bPath, diff }, null, 2));
    return 0;
  }

  console.log('Comparing:');
  console.log(`  a: ${aPath}`);
  console.log(`  b: ${bPath}`);
  console.log('');

  const sections: { label: string; section: ModelsFileDiffSection }[] = [
    { label: 'defaults', section: diff.defaults },
    { label: 'aliases', section: diff.aliases },
    { label: 'skills', section: diff.skills },
    { label: 'agents', section: diff.agents },
  ];

  let totalDiffs = 0;
  for (const { label, section } of sections) {
    const count = section.aOnly.length + section.bOnly.length + section.changes.length;
    totalDiffs += count;
    if (count === 0) continue;

    console.log(`[${label}]`);
    for (const e of section.aOnly) console.log(`  - ${e.name}: ${e.value}`);
    for (const e of section.bOnly) console.log(`  + ${e.name}: ${e.value}`);
    for (const e of section.changes) console.log(`  ~ ${e.name}: ${e.a} → ${e.b}`);
    console.log('');
  }

  if (totalDiffs === 0) {
    console.log('(no differences)');
  }
  return 0;
}

// ---------------------------------------------------------------------------
// `archon models why <skill-or-agent>` — trace the 8-tier resolver.
// ---------------------------------------------------------------------------

export interface ModelsWhyOptions {
  cwd: string;
  name: string;
  kind: 'skill' | 'agent';
  json?: boolean;
}

/** Render a single tier as a table row for text output. */
function formatTraceRow(t: TierCheck, nameW: number, srcW: number): string {
  const marker = t.winner ? '* ' : '  ';
  const value = t.value ?? '(not set)';
  return `${marker}${String(t.tier).padEnd(2)}  ${t.source.padEnd(srcW)}  ${t.label.padEnd(nameW)}  ${value}`;
}

export async function modelsWhyCommand(opts: ModelsWhyOptions): Promise<number> {
  const registry = createSkillAgentRegistry({ repoRoot: opts.cwd });
  const files = registry.modelsFiles();

  try {
    if (opts.kind === 'skill') {
      const skill = await registry.loadSkill(opts.name);
      const trace = traceSkillModel({
        skillName: opts.name,
        bundled: files.bundled,
        global: files.global,
        project: files.project,
        frontmatter: skill.model,
        defaultAssistantModel: 'sonnet',
      });
      renderTrace(trace, opts);
    } else {
      const agent = await registry.loadAgent(opts.name);
      const trace = traceAgentModel({
        agentName: opts.name,
        bundled: files.bundled,
        global: files.global,
        project: files.project,
        frontmatter: agent.model,
        defaultAssistantModel: 'sonnet',
      });
      renderTrace(trace, opts);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

function renderTrace(trace: ReturnType<typeof traceSkillModel>, opts: ModelsWhyOptions): void {
  if (opts.json === true) {
    console.log(
      JSON.stringify(
        {
          name: opts.name,
          kind: opts.kind,
          model: trace.model,
          source: trace.source,
          raw: trace.raw,
          aliasExpanded: trace.aliasExpanded,
          trace: trace.trace,
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`Resolution trace for ${opts.kind} '${opts.name}':`);
  console.log('');
  const labelW = Math.max(...trace.trace.map(t => t.label.length), 30);
  const srcW = Math.max(...trace.trace.map(t => t.source.length), 10);
  console.log(`    TIER  SOURCE      ${'TIER LABEL'.padEnd(labelW)}  VALUE`);
  console.log(`    ${'-'.repeat(labelW + srcW + 20)}`);
  for (const t of trace.trace) console.log(formatTraceRow(t, labelW, srcW));
  console.log('');
  console.log(`Resolved model: ${trace.model}`);
  console.log(`Winning tier:   ${trace.source}`);
  if (trace.aliasExpanded) console.log(`Alias expanded: ${trace.raw} → ${trace.model}`);
}

export function applyModelsReset(
  file: ModelsFile,
  kind: ModelsKind,
  name: string
): { updated: ModelsFile; removed: boolean } {
  const next: ModelsFile = { ...file, version: 1 };
  let removed = false;
  if (kind === 'skill' && file.skills?.[name] !== undefined) {
    next.skills = omitStringKey(file.skills, name);
    removed = true;
  } else if (kind === 'agent' && file.agents?.[name] !== undefined) {
    next.agents = omitStringKey(file.agents, name);
    removed = true;
  } else if (kind === 'alias' && file.aliases?.[name] !== undefined) {
    next.aliases = omitStringKey(file.aliases, name);
    removed = true;
  } else if (
    kind === 'default' &&
    file.defaults?.[name as 'node' | 'skill' | 'agent'] !== undefined
  ) {
    next.defaults = omitDefaultsKey(file.defaults, name);
    removed = true;
  }
  return { updated: modelsFileSchema.parse(next), removed };
}
