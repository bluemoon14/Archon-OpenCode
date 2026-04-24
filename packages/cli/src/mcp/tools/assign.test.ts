/**
 * Tests for MCP assign.ts (Phase 4D). Uses tmpdir so writes stay scoped to
 * the test + don't touch the real ~/.archon/.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assignAgentModel, assignSkillModel } from './assign';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'archon-assign-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe('assignSkillModel', () => {
  test('preview (no confirm) returns intended change without writing', async () => {
    const out = await assignSkillModel({ name: 'brainstorming', model: 'opus' }, cwd);
    expect(out.applied).toBe(false);
    expect(out.note).toContain('Preview only');
    expect(out.to).toBe('opus');
    expect(existsSync(join(cwd, '.archon', 'models.yaml'))).toBe(false);
  });

  test('confirm=true writes the assignment to models.yaml', async () => {
    const out = await assignSkillModel(
      { name: 'brainstorming', model: 'opus', confirm: true },
      cwd
    );
    expect(out.applied).toBe(true);
    const path = join(cwd, '.archon', 'models.yaml');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('brainstorming: opus');
  });

  test('`from` reflects prior value on second assignment', async () => {
    await assignSkillModel({ name: 'brainstorming', model: 'sonnet', confirm: true }, cwd);
    const out = await assignSkillModel(
      { name: 'brainstorming', model: 'opus', confirm: true },
      cwd
    );
    expect(out.from).toBe('sonnet');
    expect(out.to).toBe('opus');
    expect(out.applied).toBe(true);
  });

  test('confirm=false surfaces the same `from` so the preview is useful', async () => {
    await assignSkillModel({ name: 'brainstorming', model: 'sonnet', confirm: true }, cwd);
    const preview = await assignSkillModel({ name: 'brainstorming', model: 'opus' }, cwd);
    expect(preview.applied).toBe(false);
    expect(preview.from).toBe('sonnet');
    expect(preview.to).toBe('opus');
  });
});

describe('assignAgentModel', () => {
  test('writes under agents: (not skills:)', async () => {
    const out = await assignAgentModel(
      { name: 'code-reviewer', model: 'opus', confirm: true },
      cwd
    );
    expect(out.applied).toBe(true);
    expect(out.kind).toBe('agent');
    const content = readFileSync(join(cwd, '.archon', 'models.yaml'), 'utf-8');
    expect(content).toContain('code-reviewer: opus');
    // sanity: not stored under skills
    expect(/skills:\s*\n\s+code-reviewer/.test(content)).toBe(false);
  });
});
