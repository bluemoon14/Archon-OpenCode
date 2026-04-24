import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSkillAgentRegistry } from './skill-agent-registry';

let repoRoot: string;
let userArchonDir: string;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'archon-registry-repo-'));
  userArchonDir = mkdtempSync(join(tmpdir(), 'archon-registry-user-'));
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(userArchonDir, { recursive: true, force: true });
});

function writeSkill(root: string, name: string): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} skill\n---\nBody for ${name}\n`,
    'utf-8'
  );
}

function writeAgent(root: string, name: string): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, `${name}.md`),
    `---\nname: ${name}\ndescription: ${name} agent\n---\nAgent body\n`,
    'utf-8'
  );
}

function writeModels(path: string, yaml: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, yaml, 'utf-8');
}

describe('createSkillAgentRegistry — loadSkill', () => {
  test('bundled content is visible with no filesystem overrides', async () => {
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const out = await reg.loadSkill('systematic-debugging');
    expect(out.source).toBe('bundled');
    expect(out.name).toBe('systematic-debugging');
    expect(out.body.length).toBeGreaterThan(100);
  });

  test('project skill shadows bundled on the same name', async () => {
    const projSkills = join(repoRoot, '.archon', 'skills');
    writeSkill(projSkills, 'systematic-debugging');
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const out = await reg.loadSkill('systematic-debugging');
    expect(out.source).toBe('project');
    expect(out.body).toContain('Body for systematic-debugging');
  });

  test('global skill shadows bundled but not project', async () => {
    const globalSkills = join(userArchonDir, 'skills');
    writeSkill(globalSkills, 'brainstorming');
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const out = await reg.loadSkill('brainstorming');
    expect(out.source).toBe('global');
  });
});

describe('createSkillAgentRegistry — listSkills', () => {
  test('merges bundled + global + project with project wins', async () => {
    const projSkills = join(repoRoot, '.archon', 'skills');
    writeSkill(projSkills, 'systematic-debugging'); // shadows bundled
    writeSkill(projSkills, 'only-project');

    const globalSkills = join(userArchonDir, 'skills');
    writeSkill(globalSkills, 'only-global');

    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const list = await reg.listSkills();
    const byName = new Map(list.map(s => [s.name, s.source]));
    expect(byName.get('systematic-debugging')).toBe('project');
    expect(byName.get('only-project')).toBe('project');
    expect(byName.get('only-global')).toBe('global');
    // Bundled skills are present too (from the vendored superpowers defaults).
    expect(byName.get('brainstorming')).toBe('bundled');
  });
});

describe('createSkillAgentRegistry — loadAgent / listAgents', () => {
  test('bundled code-reviewer is available without overrides', async () => {
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const out = await reg.loadAgent('code-reviewer');
    expect(out.source).toBe('bundled');
    expect(out.name).toBe('code-reviewer');
  });

  test('project agent shadows bundled on the same name', async () => {
    writeAgent(join(repoRoot, '.archon', 'agents'), 'code-reviewer');
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const out = await reg.loadAgent('code-reviewer');
    expect(out.source).toBe('project');
  });
});

describe('modelsFiles', () => {
  test('bundled models.yaml is always present', () => {
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const { bundled } = reg.modelsFiles();
    expect(bundled).toBeDefined();
    expect(bundled?.version).toBe(1);
    expect(bundled?.defaults?.node).toBe('sonnet');
  });

  test('global models.yaml is loaded + cached', () => {
    writeModels(join(userArchonDir, 'models.yaml'), `version: 1\nskills:\n  foo: openai/gpt-4o\n`);
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const { global } = reg.modelsFiles();
    expect(global?.skills?.foo).toBe('openai/gpt-4o');
    // Second call returns the same cached parse.
    const { global: again } = reg.modelsFiles();
    expect(again).toBe(global);
  });

  test('project models.yaml is loaded', () => {
    writeModels(
      join(repoRoot, '.archon', 'models.yaml'),
      `version: 1\nagents:\n  reviewer: anthropic/claude-opus-4-5\n`
    );
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const { project } = reg.modelsFiles();
    expect(project?.agents?.reviewer).toBe('anthropic/claude-opus-4-5');
  });

  test('missing models.yaml is undefined — not an error', () => {
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    const { global, project } = reg.modelsFiles();
    expect(global).toBeUndefined();
    expect(project).toBeUndefined();
  });

  test('invalid models.yaml throws a clear error that includes the full file path', () => {
    const badPath = join(userArchonDir, 'models.yaml');
    writeModels(badPath, `version: 1\nskills: "not a record"\n`);
    const reg = createSkillAgentRegistry({ repoRoot, userArchonDir });
    // Error must include the FULL path so users know which file to fix,
    // not just a scope label like 'global' or 'project'.
    try {
      reg.modelsFiles();
      throw new Error('expected modelsFiles to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain('Invalid models.yaml');
      expect(msg).toContain(badPath);
      expect(msg).toContain('skills');
    }
  });
});
