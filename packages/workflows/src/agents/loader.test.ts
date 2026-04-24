import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listAgents, loadAgent } from './loader';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'archon-agents-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeAgent(root: string, name: string, content: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const path = join(root, `${name}.md`);
  await writeFile(path, content, 'utf-8');
  return path;
}

const SAMPLE = (name = 'code-reviewer', description = 'reviews code') =>
  `---
name: ${name}
description: ${description}
model: inherit
---
System prompt body for ${name}`;

describe('loadAgent', () => {
  test('loads from project dir', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const path = await writeAgent(projectDir, 'code-reviewer', SAMPLE());
    const out = await loadAgent('code-reviewer', { projectDir });
    expect(out.source).toBe('project');
    expect(out.name).toBe('code-reviewer');
    expect(out.description).toBe('reviews code');
    expect(out.model).toBe('inherit');
    expect(out.body).toBe('System prompt body for code-reviewer');
    expect(out.path).toBe(path);
  });

  test('project overrides global overrides bundled', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const globalDir = join(tmpRoot, 'global');
    await writeAgent(projectDir, 'code-reviewer', SAMPLE('code-reviewer', 'project'));
    await writeAgent(globalDir, 'code-reviewer', SAMPLE('code-reviewer', 'global'));
    const out = await loadAgent('code-reviewer', {
      projectDir,
      globalDir,
      bundled: { 'code-reviewer': SAMPLE('code-reviewer', 'bundled') },
    });
    expect(out.source).toBe('project');
    expect(out.description).toBe('project');
  });

  test('falls through to bundled when no files', async () => {
    const out = await loadAgent('code-reviewer', {
      bundled: { 'code-reviewer': SAMPLE() },
    });
    expect(out.source).toBe('bundled');
    expect(out.path).toBeUndefined();
  });

  test('throws when agent not found', async () => {
    await expect(loadAgent('missing', {})).rejects.toThrow(/not found in any source/);
  });

  test('parses optional tools + maxTurns', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeAgent(
      projectDir,
      'powered-agent',
      `---
name: powered-agent
description: has tools
model: anthropic/claude-opus-4-5
tools: [Read, Bash]
maxTurns: 5
---
body`
    );
    const out = await loadAgent('powered-agent', { projectDir });
    expect(out.tools).toEqual(['Read', 'Bash']);
    expect(out.maxTurns).toBe(5);
    expect(out.model).toBe('anthropic/claude-opus-4-5');
  });

  test('throws on missing frontmatter', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeAgent(projectDir, 'bare', 'no frontmatter');
    await expect(loadAgent('bare', { projectDir })).rejects.toThrow(/no YAML frontmatter/);
  });

  test('throws on invalid frontmatter fields', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeAgent(projectDir, 'bad', '---\nname: Bad\ndescription: x\n---\nbody');
    await expect(loadAgent('bad', { projectDir })).rejects.toThrow(/kebab-case/);
  });
});

describe('listAgents', () => {
  test('merges sources with project winning on duplicates', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const globalDir = join(tmpRoot, 'global');
    await writeAgent(projectDir, 'code-reviewer', SAMPLE('code-reviewer'));
    await writeAgent(globalDir, 'code-reviewer', SAMPLE('code-reviewer'));
    await writeAgent(globalDir, 'global-only', SAMPLE('global-only'));

    const list = await listAgents({
      projectDir,
      globalDir,
      bundled: {
        'code-reviewer': SAMPLE('code-reviewer'),
        'bundled-only': SAMPLE('bundled-only'),
      },
    });
    const byName = new Map(list.map(a => [a.name, a.source]));
    expect(byName.get('code-reviewer')).toBe('project');
    expect(byName.get('global-only')).toBe('global');
    expect(byName.get('bundled-only')).toBe('bundled');
    expect(list).toHaveLength(3);
  });

  test('ignores non-markdown files in the agents dir', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, 'code-reviewer.md'), SAMPLE('code-reviewer'), 'utf-8');
    await writeFile(join(projectDir, 'smoke.py'), 'print("hi")', 'utf-8');
    await writeFile(join(projectDir, 'README.txt'), 'docs', 'utf-8');

    const list = await listAgents({ projectDir });
    expect(list.map(a => a.name)).toEqual(['code-reviewer']);
  });
});
