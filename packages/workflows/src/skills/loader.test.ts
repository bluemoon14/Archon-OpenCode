import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSkills, loadSkill } from './loader';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'archon-skills-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function writeSkill(root: string, name: string, content: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'SKILL.md');
  await writeFile(path, content, 'utf-8');
  return path;
}

const SAMPLE = (name = 'systematic-debugging', description = 'Use when stuck') =>
  `---
name: ${name}
description: ${description}
---
Body for ${name}`;

describe('loadSkill', () => {
  test('loads from project dir when present', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const path = await writeSkill(projectDir, 'systematic-debugging', SAMPLE());
    const out = await loadSkill('systematic-debugging', { projectDir });
    expect(out.source).toBe('project');
    expect(out.name).toBe('systematic-debugging');
    expect(out.description).toBe('Use when stuck');
    expect(out.body).toBe('Body for systematic-debugging');
    expect(out.path).toBe(path);
  });

  test('project overrides global', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const globalDir = join(tmpRoot, 'global');
    await writeSkill(projectDir, 'brainstorming', SAMPLE('brainstorming', 'project version'));
    await writeSkill(globalDir, 'brainstorming', SAMPLE('brainstorming', 'global version'));
    const out = await loadSkill('brainstorming', { projectDir, globalDir });
    expect(out.source).toBe('project');
    expect(out.description).toBe('project version');
  });

  test('global overrides bundled', async () => {
    const globalDir = join(tmpRoot, 'global');
    await writeSkill(globalDir, 'brainstorming', SAMPLE('brainstorming', 'global version'));
    const out = await loadSkill('brainstorming', {
      globalDir,
      bundled: { brainstorming: SAMPLE('brainstorming', 'bundled version') },
    });
    expect(out.source).toBe('global');
    expect(out.description).toBe('global version');
  });

  test('falls through to bundled when no project or global entry', async () => {
    const out = await loadSkill('brainstorming', {
      bundled: { brainstorming: SAMPLE('brainstorming') },
    });
    expect(out.source).toBe('bundled');
    expect(out.path).toBeUndefined();
  });

  test('throws when skill is not found in any source', async () => {
    await expect(loadSkill('no-such-skill', {})).rejects.toThrow(/not found in any source/);
  });

  test('throws on missing frontmatter', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const dir = join(projectDir, 'bad');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '# no frontmatter here', 'utf-8');
    await expect(loadSkill('bad', { projectDir })).rejects.toThrow(/no YAML frontmatter/);
  });

  test('throws on invalid frontmatter shape', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeSkill(projectDir, 'bad-name', '---\nname: BadName\ndescription: x\n---\nbody');
    await expect(loadSkill('bad-name', { projectDir })).rejects.toThrow(/kebab-case/);
  });

  test('parses optional model field', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeSkill(
      projectDir,
      'fancy-skill',
      `---
name: fancy-skill
description: demo
model: anthropic/claude-opus-4-5
---
body`
    );
    const out = await loadSkill('fancy-skill', { projectDir });
    expect(out.model).toBe('anthropic/claude-opus-4-5');
  });

  test('parses optional tags/requires/examples fields', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeSkill(
      projectDir,
      'rich-skill',
      `---
name: rich-skill
description: demo
tags: [testing, scaffolding]
requires: [brainstorming]
examples:
  - Use when starting a new feature
  - Use when ripping out dead code
---
body`
    );
    const out = await loadSkill('rich-skill', { projectDir });
    expect(out.tags).toEqual(['testing', 'scaffolding']);
    expect(out.requires).toEqual(['brainstorming']);
    expect(out.examples).toEqual([
      'Use when starting a new feature',
      'Use when ripping out dead code',
    ]);
  });

  test('skill without new optional fields still parses (back-compat)', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeSkill(projectDir, 'plain-skill', SAMPLE('plain-skill'));
    const out = await loadSkill('plain-skill', { projectDir });
    expect(out.tags).toBeUndefined();
    expect(out.requires).toBeUndefined();
    expect(out.examples).toBeUndefined();
  });

  test('rejects non-kebab-case requires entries', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await writeSkill(
      projectDir,
      'bad-requires',
      `---
name: bad-requires
description: x
requires: [UpperCase]
---
body`
    );
    await expect(loadSkill('bad-requires', { projectDir })).rejects.toThrow();
  });
});

describe('listSkills', () => {
  test('merges all three sources, project wins on duplicates', async () => {
    const projectDir = join(tmpRoot, 'proj');
    const globalDir = join(tmpRoot, 'global');
    await writeSkill(projectDir, 'brainstorming', SAMPLE('brainstorming'));
    await writeSkill(projectDir, 'only-project', SAMPLE('only-project'));
    await writeSkill(globalDir, 'brainstorming', SAMPLE('brainstorming'));
    await writeSkill(globalDir, 'only-global', SAMPLE('only-global'));

    const list = await listSkills({
      projectDir,
      globalDir,
      bundled: {
        brainstorming: SAMPLE('brainstorming'),
        'only-bundled': SAMPLE('only-bundled'),
      },
    });

    const byName = new Map(list.map(s => [s.name, s.source]));
    expect(byName.get('brainstorming')).toBe('project');
    expect(byName.get('only-project')).toBe('project');
    expect(byName.get('only-global')).toBe('global');
    expect(byName.get('only-bundled')).toBe('bundled');
    expect(list).toHaveLength(4);
  });

  test('skips directories without SKILL.md', async () => {
    const projectDir = join(tmpRoot, 'proj');
    await mkdir(join(projectDir, 'empty-dir'), { recursive: true });
    await writeSkill(projectDir, 'real-skill', SAMPLE('real-skill'));
    const list = await listSkills({ projectDir });
    expect(list.map(s => s.name)).toEqual(['real-skill']);
  });

  test('handles missing dirs gracefully', async () => {
    const list = await listSkills({
      projectDir: join(tmpRoot, 'nowhere'),
      globalDir: join(tmpRoot, 'alsonowhere'),
    });
    expect(list).toEqual([]);
  });
});
