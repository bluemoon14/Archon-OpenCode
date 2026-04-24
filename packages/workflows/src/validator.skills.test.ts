/**
 * Tests for the validator's skill-existence fallback chain. Validator at
 * validator.ts:408-449 walks 5 tiers to decide whether a `skills: [...]`
 * reference should warn:
 *
 *   1. BUNDLED_SKILLS (embedded superpowers defaults)
 *   2. <cwd>/.archon/skills/<name>/SKILL.md       (project Archon override)
 *   3. ~/.archon/skills/<name>/SKILL.md           (user Archon override)
 *   4. <cwd>/.claude/skills/<name>/SKILL.md       (legacy Claude project)
 *   5. ~/.claude/skills/<name>/SKILL.md           (legacy Claude home scope)
 *
 * Only emit a warning if ALL five tiers miss. These tests cover the three
 * cwd-relative tiers (1, 2, 4) + the unknown-skill warning. Tiers 3 + 5
 * (home-scope) rely on `os.homedir()` which Node caches per-process and
 * doesn't re-evaluate HOME env changes — covered via manual e2e smoke
 * testing only.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerBuiltinProviders } from '@archon/providers';
import type { WorkflowDefinition } from './schemas';
import { validateWorkflowResources } from './validator';

// Seed the provider registry so validator's provider lookups succeed.
registerBuiltinProviders();

let repoRoot: string;

function seedSkillFile(root: string, skillName: string, body = 'dummy body'): void {
  const dir = join(root, skillName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: test skill\n---\n${body}\n`,
    'utf-8'
  );
}

function makeWorkflowWithSkills(skills: string[]): WorkflowDefinition {
  return {
    name: 'test-workflow',
    description: 'test',
    nodes: [
      {
        id: 'n1',
        prompt: 'test prompt',
        skills,
      },
    ],
  } as WorkflowDefinition;
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'archon-validator-test-'));
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

function skillIssuesFor(issues: { field?: string; level: string }[]): number {
  return issues.filter(i => i.field === 'skills' && i.level === 'warning').length;
}

describe('validator — skill resolution fallback chain', () => {
  test('tier 1: bundled skill emits no warning', async () => {
    // `brainstorming` is one of the 14 vendored superpowers skills in
    // BUNDLED_SKILLS. No filesystem fixture needed.
    const issues = await validateWorkflowResources(
      makeWorkflowWithSkills(['brainstorming']),
      repoRoot,
      undefined,
      'claude'
    );
    expect(skillIssuesFor(issues)).toBe(0);
  });

  test('tier 2: archon project skill emits no warning', async () => {
    seedSkillFile(join(repoRoot, '.archon', 'skills'), 'my-project-skill');
    const issues = await validateWorkflowResources(
      makeWorkflowWithSkills(['my-project-skill']),
      repoRoot,
      undefined,
      'claude'
    );
    expect(skillIssuesFor(issues)).toBe(0);
  });

  test('tier 4: legacy claude project skill emits no warning', async () => {
    seedSkillFile(join(repoRoot, '.claude', 'skills'), 'legacy-project-skill');
    const issues = await validateWorkflowResources(
      makeWorkflowWithSkills(['legacy-project-skill']),
      repoRoot,
      undefined,
      'claude'
    );
    expect(skillIssuesFor(issues)).toBe(0);
  });

  test('unknown skill (absent from every tier) emits a single warning', async () => {
    const issues = await validateWorkflowResources(
      makeWorkflowWithSkills(['nonexistent-skill']),
      repoRoot,
      undefined,
      'claude'
    );
    expect(skillIssuesFor(issues)).toBe(1);
    const warning = issues.find(i => i.field === 'skills');
    expect(warning?.message).toContain('nonexistent-skill');
    // The rewritten message mentions the Archon path so users know where
    // to add the skill for the modern runtime.
    expect(warning?.message).toContain('.archon/skills/');
  });

  test('multiple unknown skills produce one warning per skill', async () => {
    const issues = await validateWorkflowResources(
      makeWorkflowWithSkills(['unknown-a', 'unknown-b', 'brainstorming']),
      repoRoot,
      undefined,
      'claude'
    );
    expect(skillIssuesFor(issues)).toBe(2);
  });
});
