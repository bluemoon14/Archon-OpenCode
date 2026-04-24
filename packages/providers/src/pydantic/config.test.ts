import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parsePydanticConfig, resolveAgentEntry } from './config';
import { ProviderError } from '../errors';

describe('parsePydanticConfig', () => {
  test('returns empty object for non-object input', () => {
    expect(parsePydanticConfig(undefined)).toEqual({});
    expect(parsePydanticConfig('str')).toEqual({});
  });

  test('extracts top-level keys', () => {
    const cfg = parsePydanticConfig({
      uvBinaryPath: '/opt/uv',
      agentsDir: 'agents',
      agents: {
        smoke: { entry: 'smoke.py', deps: ['pydantic-ai'] },
      },
    });
    expect(cfg).toEqual({
      uvBinaryPath: '/opt/uv',
      agentsDir: 'agents',
      agents: { smoke: { entry: 'smoke.py', deps: ['pydantic-ai'] } },
    });
  });

  test('ignores agents entries without entry string', () => {
    const cfg = parsePydanticConfig({
      agents: {
        missing_entry: { deps: ['x'] },
      },
    });
    expect(cfg.agents).toBeUndefined();
  });

  test('drops non-string deps', () => {
    const cfg = parsePydanticConfig({
      agents: { smoke: { entry: 'smoke.py', deps: ['ok', 42] } },
    });
    expect(cfg.agents?.smoke?.deps).toBeUndefined();
  });
});

describe('resolveAgentEntry', () => {
  test('throws when agent name missing', () => {
    expect(() => resolveAgentEntry('/tmp', undefined, {})).toThrow(ProviderError);
    expect(() => resolveAgentEntry('/tmp', '  ', {})).toThrow(ProviderError);
  });

  test('throws with helpful message when agent unknown', () => {
    try {
      resolveAgentEntry('/tmp', 'ghost', {
        agents: { smoke: { entry: '/tmp/smoke.py' } },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      const message = (err as ProviderError).message;
      expect(message).toContain("'ghost'");
      expect(message).toContain('smoke');
    }
  });

  test('throws when entry file does not exist', () => {
    expect(() =>
      resolveAgentEntry('/tmp', 'x', { agents: { x: { entry: '/nope/never/does-not-exist.py' } } })
    ).toThrow(ProviderError);
  });

  test('resolves relative entry against cwd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pa-'));
    try {
      writeFileSync(join(dir, 'agent.py'), '# test agent\n');
      const resolved = resolveAgentEntry(dir, 'x', { agents: { x: { entry: 'agent.py' } } });
      expect(resolved).toBe(join(dir, 'agent.py'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps absolute entry path as-is', () => {
    const dir = mkdtempSync(join(tmpdir(), 'archon-pa-'));
    try {
      const abs = join(dir, 'agent.py');
      writeFileSync(abs, '# test agent\n');
      const resolved = resolveAgentEntry('/unrelated/cwd', 'x', {
        agents: { x: { entry: abs } },
      });
      expect(resolved).toBe(abs);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
