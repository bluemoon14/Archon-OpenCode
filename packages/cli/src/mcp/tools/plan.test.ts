/**
 * Tests for MCP plan.ts (Phase 4E). Runs against the REAL bundled skills so
 * the ranking exercise reflects what users will see; the test asserts well-
 * known bundled skills like `systematic-debugging` and `brainstorming` show
 * up for their expected prompts.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSession } from './plan';

describe('planSession — token-overlap ranking against bundled skills', () => {
  test('surfaces systematic-debugging for a goal using terms from its description', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-plan-'));
    try {
      // Tokens chosen to overlap the bundled description:
      // "Use when encountering any bug, test failure, or unexpected behavior".
      const out = await planSession(
        { goal: 'I hit a bug: the test failed with unexpected behavior' },
        cwd
      );
      const names = out.suggestions.map(s => s.name);
      expect(names).toContain('systematic-debugging');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('respects the limit argument', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-plan-'));
    try {
      const out = await planSession(
        { goal: 'test debug brainstorm plan write skill', limit: 2 },
        cwd
      );
      expect(out.suggestions.length).toBeLessThanOrEqual(2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('returns empty suggestions when goal has no usable tokens', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'archon-plan-'));
    try {
      const out = await planSession({ goal: 'the a an or of' }, cwd);
      // All tokens are stopwords — no real signal.
      expect(out.suggestions).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
