import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinProviders } from '@archon/providers';
import type { ModelsFile } from '@archon/workflows/schemas/models';
import {
  applyModelsReset,
  applyModelsSet,
  modelsResetCommand,
  modelsSetCommand,
  modelsValidateCommand,
} from './models';

// Provider registry needs to be seeded so `modelsValidateCommand` can check
// model compatibility. Idempotent.
registerBuiltinProviders();

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'archon-models-cmd-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function readProjectModels(): ModelsFile {
  const path = join(repoRoot, '.archon', 'models.yaml');
  const content = readFileSync(path, 'utf-8');
  return Bun.YAML.parse(content) as ModelsFile;
}

function seedProjectModels(file: ModelsFile): void {
  const dir = join(repoRoot, '.archon');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'models.yaml'), Bun.YAML.stringify(file), 'utf-8');
}

// -----------------------------------------------------------------------------
// Pure helpers (applyModelsSet / applyModelsReset) — exercise branch coverage
// without hitting the filesystem.
// -----------------------------------------------------------------------------

describe('applyModelsSet', () => {
  test('creates the section when missing', () => {
    const out = applyModelsSet({ version: 1 }, 'skill', 'brainstorming', 'openai/gpt-4o');
    expect(out.skills).toEqual({ brainstorming: 'openai/gpt-4o' });
  });

  test('merges into an existing section without losing other keys', () => {
    const out = applyModelsSet({ version: 1, skills: { a: 'x', b: 'y' } }, 'skill', 'c', 'z');
    expect(out.skills).toEqual({ a: 'x', b: 'y', c: 'z' });
  });

  test('overwrites an existing key', () => {
    const out = applyModelsSet(
      { version: 1, skills: { brainstorming: 'haiku' } },
      'skill',
      'brainstorming',
      'opus'
    );
    expect(out.skills?.brainstorming).toBe('opus');
  });

  test('sets agent assignments', () => {
    const out = applyModelsSet({ version: 1 }, 'agent', 'code-reviewer', 'opus');
    expect(out.agents).toEqual({ 'code-reviewer': 'opus' });
  });

  test('sets category defaults', () => {
    const out = applyModelsSet({ version: 1 }, 'default', 'node', 'sonnet');
    expect(out.defaults).toEqual({ node: 'sonnet' });
  });

  test('sets aliases', () => {
    const out = applyModelsSet({ version: 1 }, 'alias', 'fast', 'haiku');
    expect(out.aliases).toEqual({ fast: 'haiku' });
  });
});

describe('applyModelsReset', () => {
  test('removes the target key, reports removed: true', () => {
    const { updated, removed } = applyModelsReset(
      { version: 1, skills: { a: 'x', b: 'y' } },
      'skill',
      'a'
    );
    expect(removed).toBe(true);
    expect(updated.skills).toEqual({ b: 'y' });
  });

  test('is a no-op when the key is absent, reports removed: false', () => {
    const { updated, removed } = applyModelsReset(
      { version: 1, skills: { a: 'x' } },
      'skill',
      'missing'
    );
    expect(removed).toBe(false);
    expect(updated.skills).toEqual({ a: 'x' });
  });

  test('leaves an empty section present (YAML churn avoidance)', () => {
    const { updated, removed } = applyModelsReset(
      { version: 1, skills: { only: 'x' } },
      'skill',
      'only'
    );
    expect(removed).toBe(true);
    // Empty object is still fine — the schema accepts it.
    expect(updated.skills).toEqual({});
  });
});

// -----------------------------------------------------------------------------
// CLI command end-to-end (file IO)
// -----------------------------------------------------------------------------

describe('modelsSetCommand', () => {
  test('creates .archon/models.yaml when missing and writes the assignment', async () => {
    const code = await modelsSetCommand({
      cwd: repoRoot,
      kind: 'skill',
      name: 'brainstorming',
      model: 'openai/gpt-4o-mini',
    });
    expect(code).toBe(0);
    const written = readProjectModels();
    expect(written.version).toBe(1);
    expect(written.skills).toEqual({ brainstorming: 'openai/gpt-4o-mini' });
  });

  test('merges into an existing file without clobbering other keys', async () => {
    seedProjectModels({
      version: 1,
      skills: { existing: 'anthropic/claude-opus-4-5' },
      defaults: { node: 'sonnet' },
    });
    const code = await modelsSetCommand({
      cwd: repoRoot,
      kind: 'skill',
      name: 'brainstorming',
      model: 'openai/gpt-4o',
    });
    expect(code).toBe(0);
    const written = readProjectModels();
    expect(written.skills).toEqual({
      existing: 'anthropic/claude-opus-4-5',
      brainstorming: 'openai/gpt-4o',
    });
    expect(written.defaults?.node).toBe('sonnet');
  });

  test('rejects an unknown kind', async () => {
    const code = await modelsSetCommand({
      cwd: repoRoot,
      kind: 'nonsense',
      name: 'x',
      model: 'y',
    });
    expect(code).toBe(1);
  });

  test('rejects an unknown default key', async () => {
    const code = await modelsSetCommand({
      cwd: repoRoot,
      kind: 'default',
      name: 'not-a-category',
      model: 'x',
    });
    expect(code).toBe(1);
  });

  test('writes a category default when kind=default + name=skill', async () => {
    const code = await modelsSetCommand({
      cwd: repoRoot,
      kind: 'default',
      name: 'skill',
      model: 'anthropic/claude-haiku-4-5',
    });
    expect(code).toBe(0);
    const written = readProjectModels();
    expect(written.defaults?.skill).toBe('anthropic/claude-haiku-4-5');
  });
});

describe('modelsResetCommand', () => {
  test('removes the key and rewrites the file', async () => {
    seedProjectModels({
      version: 1,
      skills: { a: 'x', b: 'y' },
    });
    const code = await modelsResetCommand({
      cwd: repoRoot,
      kind: 'skill',
      name: 'a',
    });
    expect(code).toBe(0);
    const written = readProjectModels();
    expect(written.skills).toEqual({ b: 'y' });
  });

  test('is a no-op (exit 0) when the key is absent', async () => {
    seedProjectModels({ version: 1, skills: { a: 'x' } });
    const code = await modelsResetCommand({
      cwd: repoRoot,
      kind: 'skill',
      name: 'missing',
    });
    expect(code).toBe(0);
    const written = readProjectModels();
    expect(written.skills).toEqual({ a: 'x' });
  });
});

describe('modelsValidateCommand', () => {
  test('reports OK when all model strings route to a registered provider', async () => {
    seedProjectModels({
      version: 1,
      skills: {
        s1: 'openai/gpt-4o',
        s2: 'anthropic/claude-sonnet-4-5',
        s3: 'sonnet',
      },
      aliases: { fast: 'haiku' },
      defaults: { node: 'sonnet' },
    });
    const code = await modelsValidateCommand({ cwd: repoRoot });
    expect(code).toBe(0);
  });

  test('accepts alias references (values that point at another alias key)', async () => {
    seedProjectModels({
      version: 1,
      skills: { s1: 'fast' }, // 'fast' is an alias, not a real provider model
      aliases: { fast: 'haiku' },
    });
    const code = await modelsValidateCommand({ cwd: repoRoot });
    expect(code).toBe(0);
  });

  test('accepts the `inherit` sentinel anywhere', async () => {
    seedProjectModels({
      version: 1,
      skills: { s1: 'inherit' },
    });
    const code = await modelsValidateCommand({ cwd: repoRoot });
    expect(code).toBe(0);
  });
});
