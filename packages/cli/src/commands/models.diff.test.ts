/**
 * Unit tests for `diffModelsFiles` — the pure diff helper behind
 * `archon models diff`. IO-free — tests construct ModelsFile values
 * directly.
 */
import { describe, expect, test } from 'bun:test';
import type { ModelsFile } from '@archon/workflows/schemas/models';
import { diffModelsFiles } from './models';

function base(): ModelsFile {
  return {
    version: 1,
    defaults: { node: 'sonnet', skill: 'haiku', agent: 'sonnet' },
    aliases: { fast: 'haiku', smart: 'opus' },
    skills: { 'systematic-debugging': 'haiku', brainstorming: 'haiku' },
    agents: { 'code-reviewer': 'opus' },
  };
}

describe('diffModelsFiles', () => {
  test('empty diff when both sides equal', () => {
    const diff = diffModelsFiles(base(), base());
    expect(diff.defaults).toEqual({ aOnly: [], bOnly: [], changes: [] });
    expect(diff.aliases).toEqual({ aOnly: [], bOnly: [], changes: [] });
    expect(diff.skills).toEqual({ aOnly: [], bOnly: [], changes: [] });
    expect(diff.agents).toEqual({ aOnly: [], bOnly: [], changes: [] });
  });

  test('reports entries only in a', () => {
    const a = base();
    const b: ModelsFile = { version: 1 };
    const diff = diffModelsFiles(a, b);
    expect(diff.skills.aOnly).toEqual([
      { name: 'brainstorming', value: 'haiku' },
      { name: 'systematic-debugging', value: 'haiku' },
    ]);
    expect(diff.skills.bOnly).toEqual([]);
    expect(diff.aliases.aOnly).toEqual([
      { name: 'fast', value: 'haiku' },
      { name: 'smart', value: 'opus' },
    ]);
  });

  test('reports entries only in b', () => {
    const a: ModelsFile = { version: 1 };
    const b = base();
    const diff = diffModelsFiles(a, b);
    expect(diff.skills.bOnly).toEqual([
      { name: 'brainstorming', value: 'haiku' },
      { name: 'systematic-debugging', value: 'haiku' },
    ]);
    expect(diff.skills.aOnly).toEqual([]);
  });

  test('reports value changes when both sides have the key', () => {
    const a = base();
    const b = base();
    b.skills = { ...b.skills, 'systematic-debugging': 'opus' };
    b.defaults = { ...b.defaults, node: 'opus' };
    const diff = diffModelsFiles(a, b);
    expect(diff.skills.changes).toEqual([{ name: 'systematic-debugging', a: 'haiku', b: 'opus' }]);
    expect(diff.skills.aOnly).toEqual([]);
    expect(diff.skills.bOnly).toEqual([]);
    expect(diff.defaults.changes).toEqual([{ name: 'node', a: 'sonnet', b: 'opus' }]);
  });

  test('mixed — some added, some removed, some changed', () => {
    const a: ModelsFile = {
      version: 1,
      skills: { keep: 'haiku', change: 'haiku', aonly: 'sonnet' },
    };
    const b: ModelsFile = {
      version: 1,
      skills: { keep: 'haiku', change: 'opus', bonly: 'sonnet' },
    };
    const diff = diffModelsFiles(a, b);
    expect(diff.skills.aOnly).toEqual([{ name: 'aonly', value: 'sonnet' }]);
    expect(diff.skills.bOnly).toEqual([{ name: 'bonly', value: 'sonnet' }]);
    expect(diff.skills.changes).toEqual([{ name: 'change', a: 'haiku', b: 'opus' }]);
  });
});
