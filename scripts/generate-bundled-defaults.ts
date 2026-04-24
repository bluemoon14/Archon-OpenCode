#!/usr/bin/env bun
/**
 * Regenerates packages/workflows/src/defaults/bundled-defaults.generated.ts from
 * the on-disk defaults in .archon/commands/defaults/ and .archon/workflows/defaults/.
 *
 * Emits inline string literals (via JSON.stringify) rather than Bun's
 * `import X from '...' with { type: 'text' }` attributes so the module loads
 * in Node too. This fixes two problems at once:
 *   - bundle drift (hand-maintained import list in bundled-defaults.ts)
 *   - SDK blocker #2 (type: 'text' import attributes are Bun-specific)
 *
 * Determinism: filenames are sorted before emission so `bun run check:bundled`
 * (which regenerates into memory and compares to the committed file) catches
 * unregenerated changes. Wired into `bun run validate` and CI.
 *
 * Usage:
 *   bun run scripts/generate-bundled-defaults.ts           # write
 *   bun run scripts/generate-bundled-defaults.ts --check   # verify (exit 2 if stale)
 *
 * Exit codes:
 *   0  file generated (and unchanged, if --check)
 *   1  unexpected error (missing dir, unreadable source, invalid filename, etc.)
 *   2  --check was passed and the file would change
 */
import { access, readFile, readdir, stat, writeFile } from 'fs/promises';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const COMMANDS_DIR = join(REPO_ROOT, '.archon/commands/defaults');
const WORKFLOWS_DIR = join(REPO_ROOT, '.archon/workflows/defaults');
const SKILLS_DIR = join(REPO_ROOT, '.archon/skills/defaults');
const AGENTS_DIR = join(REPO_ROOT, '.archon/agents/defaults');
const MODELS_YAML_PATH = join(REPO_ROOT, '.archon/models.defaults.yaml');
const OUTPUT_PATH = join(
  REPO_ROOT,
  'packages/workflows/src/defaults/bundled-defaults.generated.ts'
);

const CHECK_ONLY = process.argv.includes('--check');

interface BundledFile {
  name: string;
  content: string;
}

async function ensureDir(dir: string, label: string): Promise<void> {
  try {
    await access(dir);
  } catch {
    throw new Error(
      `${label} directory not found: ${dir}\n` +
        `Run this script from the repo root (cwd was ${process.cwd()}), ` +
        'or verify the .archon/ tree exists.'
    );
  }
}

/** True if dir exists. Skills/agents/models-yaml are all optional — if the
 *  sync-superpowers script hasn't been run yet, or a fresh checkout doesn't
 *  have them, emit empty records instead of hard-failing.  */
async function dirExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function collectFiles(dir: string, extensions: readonly string[]): Promise<BundledFile[]> {
  const entries = await readdir(dir);
  const matched = entries
    .map(entry => {
      const ext = extensions.find(e => entry.endsWith(e));
      return ext ? { entry, ext } : undefined;
    })
    .filter((m): m is { entry: string; ext: string } => m !== undefined)
    .sort((a, b) => a.entry.localeCompare(b.entry));

  const files: BundledFile[] = [];
  const seen = new Set<string>();
  for (const { entry, ext } of matched) {
    const name = entry.slice(0, -ext.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `Bundled default has invalid filename "${entry}" in ${dir}. ` +
          'Names must be kebab-case (lowercase letters, digits, hyphens).'
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `Bundled default name collision: "${name}" appears with multiple extensions in ${dir}. ` +
          'Keep a single file per name (remove either the .yaml or .yml variant).'
      );
    }
    seen.add(name);
    const raw = await readFile(join(dir, entry), 'utf-8');
    // Normalize to LF so output is identical regardless of the checkout's
    // line-ending policy (e.g. Windows `core.autocrlf=true` yields CRLF).
    const content = raw.replace(/\r\n/g, '\n');
    if (!content.trim()) {
      throw new Error(`Bundled default "${entry}" in ${dir} is empty.`);
    }
    files.push({ name, content });
  }
  return files;
}

/**
 * Collect skills from a directory of the shape `<root>/<skill-name>/SKILL.md`.
 * Only the SKILL.md body is embedded (supporting files in the skill dir are
 * kept on disk for fidelity but are not consumed by the loader). Missing root
 * → empty list.
 */
async function collectSkills(dir: string): Promise<BundledFile[]> {
  if (!(await dirExists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const skillDirs = entries
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b));

  const files: BundledFile[] = [];
  for (const name of skillDirs) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new Error(
        `Bundled skill directory "${name}" in ${dir} is not kebab-case. ` +
          'Skills must be lowercase letters, digits, and hyphens.'
      );
    }
    const skillMd = join(dir, name, 'SKILL.md');
    if (!(await fileExists(skillMd))) {
      // Directory without a SKILL.md — probably supporting content (LICENSE,
      // ATTRIBUTION.md). Silently skip; these live in the vendored tree but
      // aren't skills.
      continue;
    }
    const raw = await readFile(skillMd, 'utf-8');
    const content = raw.replace(/\r\n/g, '\n');
    if (!content.trim()) {
      throw new Error(`Bundled skill "${name}" (${skillMd}) is empty.`);
    }
    files.push({ name, content });
  }
  return files;
}

/** Read optional bundled models.yaml, normalized to LF. Missing → empty string. */
async function readOptionalText(path: string): Promise<string> {
  if (!(await fileExists(path))) return '';
  const raw = await readFile(path, 'utf-8');
  return raw.replace(/\r\n/g, '\n');
}

function renderRecord(comment: string, exportName: string, files: BundledFile[]): string {
  const entries = files
    .map(f => `  ${JSON.stringify(f.name)}: ${JSON.stringify(f.content)},`)
    .join('\n');
  return [
    `// ${comment} (${files.length} total)`,
    `export const ${exportName}: Record<string, string> = {`,
    entries,
    '};',
  ].join('\n');
}

function renderFile(
  commands: BundledFile[],
  workflows: BundledFile[],
  skills: BundledFile[],
  agents: BundledFile[],
  modelsYaml: string
): string {
  const header = [
    '/**',
    ' * AUTO-GENERATED — DO NOT EDIT.',
    ' *',
    ' * Regenerate with: bun run generate:bundled',
    ' * Verify up-to-date:  bun run check:bundled',
    ' *',
    ' * Source of truth:',
    ' *   .archon/commands/defaults/*.md',
    ' *   .archon/workflows/defaults/*.{yaml,yml}',
    ' *   .archon/skills/defaults/<name>/SKILL.md',
    ' *   .archon/agents/defaults/<name>.md',
    ' *   .archon/models.defaults.yaml',
    ' *',
    ' * Contents are inlined as plain string literals (JSON-escaped) so this',
    ' * module loads in both Bun and Node. Previous versions used',
    " * `import X from '...' with { type: 'text' }` which is Bun-specific.",
    ' */',
    '',
  ].join('\n');

  const modelsExport = [
    '// Bundled default models.yaml (empty string if no defaults file is present)',
    `export const BUNDLED_MODELS_YAML: string = ${JSON.stringify(modelsYaml)};`,
  ].join('\n');

  return [
    header,
    renderRecord('Bundled default commands', 'BUNDLED_COMMANDS', commands),
    '',
    renderRecord('Bundled default workflows', 'BUNDLED_WORKFLOWS', workflows),
    '',
    renderRecord('Bundled default skills', 'BUNDLED_SKILLS', skills),
    '',
    renderRecord('Bundled default agents', 'BUNDLED_AGENTS', agents),
    '',
    modelsExport,
    '',
  ].join('\n');
}

async function main(): Promise<void> {
  // Commands + workflows are required — these have always been bundled.
  await Promise.all([
    ensureDir(COMMANDS_DIR, 'Commands defaults'),
    ensureDir(WORKFLOWS_DIR, 'Workflows defaults'),
  ]);

  // Skills, agents, and models.defaults.yaml are optional — if the superpowers
  // sync hasn't been run yet they simply contribute empty maps.
  const [commands, workflows, skills, agents, modelsYaml] = await Promise.all([
    collectFiles(COMMANDS_DIR, ['.md']),
    collectFiles(WORKFLOWS_DIR, ['.yaml', '.yml']),
    collectSkills(SKILLS_DIR),
    (await dirExists(AGENTS_DIR)) ? collectFiles(AGENTS_DIR, ['.md']) : Promise.resolve([]),
    readOptionalText(MODELS_YAML_PATH),
  ]);

  const contents = renderFile(commands, workflows, skills, agents, modelsYaml);

  if (CHECK_ONLY) {
    let existing = '';
    try {
      const raw = await readFile(OUTPUT_PATH, 'utf-8');
      // Same LF normalization as collectFiles — the .ts itself may be
      // checked out with CRLF line endings on Windows.
      existing = raw.replace(/\r\n/g, '\n');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }
    if (existing !== contents) {
      console.error('bundled-defaults.generated.ts is stale.\n' + 'Run: bun run generate:bundled');
      process.exit(2);
    }
    console.log(
      `bundled-defaults.generated.ts is up to date (${commands.length} commands, ${workflows.length} workflows, ${skills.length} skills, ${agents.length} agents).`
    );
    return;
  }

  await writeFile(OUTPUT_PATH, contents, 'utf-8');
  console.log(
    `Wrote ${OUTPUT_PATH}\n  ${commands.length} commands, ${workflows.length} workflows, ${skills.length} skills, ${agents.length} agents.`
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
