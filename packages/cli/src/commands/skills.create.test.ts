/**
 * Tests for `archon skills create`. Uses tmpdir as the cwd so writes don't
 * leak into the repo.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { skillsCreateCommand } from './skills';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'archon-skills-create-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('skillsCreateCommand', () => {
  test('scaffolds a valid SKILL.md in <cwd>/.archon/skills/', () => {
    const rc = skillsCreateCommand({
      cwd,
      name: 'my-skill',
      description: 'Use when X happens',
    });
    expect(rc).toBe(0);
    const path = join(cwd, '.archon', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    const body = readFileSync(path, 'utf-8');
    expect(body).toContain('name: my-skill');
    expect(body).toContain('description: Use when X happens');
    // Commented extension fields are surfaced as discoverability hints.
    expect(body).toContain('# model:');
    expect(body).toContain('# tags:');
    expect(body).toContain('# requires:');
    expect(body).toContain('# examples:');
  });

  test('rejects non-kebab-case names', () => {
    const rc = skillsCreateCommand({
      cwd,
      name: 'MyCamelCase',
      description: 'x',
    });
    expect(rc).toBe(1);
    expect(existsSync(join(cwd, '.archon', 'skills', 'MyCamelCase'))).toBe(false);
  });

  test('refuses to overwrite an existing SKILL.md', () => {
    const first = skillsCreateCommand({
      cwd,
      name: 'dup-skill',
      description: 'first',
    });
    expect(first).toBe(0);
    const second = skillsCreateCommand({
      cwd,
      name: 'dup-skill',
      description: 'second',
    });
    expect(second).toBe(1);
    const body = readFileSync(join(cwd, '.archon', 'skills', 'dup-skill', 'SKILL.md'), 'utf-8');
    // First write survives — second was refused.
    expect(body).toContain('description: first');
  });

  test('rejects empty description', () => {
    const rc = skillsCreateCommand({ cwd, name: 'ok-name', description: '  ' });
    expect(rc).toBe(1);
    expect(existsSync(join(cwd, '.archon', 'skills', 'ok-name'))).toBe(false);
  });

  test('--global writes under the provided home dir', () => {
    // `os.homedir()` is Node-cached per-process and can't be redirected via
    // HOME env in-session — we pass the override through the command options
    // instead. CLI callers never set homeDir; tests do.
    const fakeHome = mkdtempSync(join(tmpdir(), 'archon-fakehome-'));
    try {
      const rc = skillsCreateCommand({
        cwd,
        name: 'global-skill',
        description: 'global test',
        global: true,
        homeDir: fakeHome,
      });
      expect(rc).toBe(0);
      const globalPath = join(fakeHome, '.archon', 'skills', 'global-skill', 'SKILL.md');
      expect(existsSync(globalPath)).toBe(true);
      // And nothing was written under cwd.
      expect(existsSync(join(cwd, '.archon', 'skills', 'global-skill'))).toBe(false);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
