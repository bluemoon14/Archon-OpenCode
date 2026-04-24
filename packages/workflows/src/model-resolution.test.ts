/**
 * Tests for model-resolution — covers all 8 precedence tiers plus alias expansion,
 * inherit semantics, and merge ordering (bundled < global < project).
 */
import { describe, expect, test } from 'bun:test';
import type { ModelsFile } from './schemas/models';
import {
  expandAlias,
  mergeAliases,
  resolveAgentModel,
  resolveNodeModel,
  resolveSkillModel,
} from './model-resolution';

const bundledModels: ModelsFile = {
  version: 1,
  defaults: {
    node: 'sonnet',
    skill: 'anthropic/claude-haiku-4-5',
    agent: 'anthropic/claude-sonnet-4-5',
  },
  skills: {
    'systematic-debugging': 'anthropic/claude-haiku-4-5',
    brainstorming: 'anthropic/claude-haiku-4-5',
    'writing-skills': 'inherit',
  },
  agents: {
    'code-reviewer': 'anthropic/claude-opus-4-5',
  },
  aliases: {
    fast: 'anthropic/claude-haiku-4-5',
    smart: 'anthropic/claude-opus-4-5',
  },
};

const globalModels: ModelsFile = {
  version: 1,
  skills: {
    'systematic-debugging': 'openai/gpt-4o',
  },
  aliases: {
    fast: 'openai/gpt-4o-mini',
  },
};

const projectModels: ModelsFile = {
  version: 1,
  skills: {
    brainstorming: 'novita/deepseek/deepseek-r1',
  },
  agents: {
    'code-reviewer': 'fast',
  },
  aliases: {
    cheap: 'novita/deepseek/deepseek-r1',
  },
};

describe('expandAlias', () => {
  test('returns unchanged when key not in alias map', () => {
    expect(expandAlias('anthropic/claude-opus-4-5', { fast: 'x' })).toEqual({
      model: 'anthropic/claude-opus-4-5',
      expanded: false,
    });
  });

  test('expands one hop', () => {
    expect(expandAlias('fast', { fast: 'anthropic/claude-haiku-4-5' })).toEqual({
      model: 'anthropic/claude-haiku-4-5',
      expanded: true,
    });
  });

  test('does not chain — returns first hop only', () => {
    // alias pointing at another alias — we deliberately don't follow
    expect(expandAlias('outer', { outer: 'inner', inner: 'target' })).toEqual({
      model: 'inner',
      expanded: true,
    });
  });
});

describe('mergeAliases', () => {
  test('project overrides global overrides bundled', () => {
    const merged = mergeAliases(bundledModels, globalModels, projectModels);
    expect(merged.fast).toBe('openai/gpt-4o-mini'); // global wins over bundled
    expect(merged.smart).toBe('anthropic/claude-opus-4-5'); // from bundled
    expect(merged.cheap).toBe('novita/deepseek/deepseek-r1'); // from project
  });

  test('handles missing files', () => {
    expect(mergeAliases()).toEqual({});
    expect(mergeAliases(bundledModels)).toEqual(bundledModels.aliases ?? {});
  });
});

describe('resolveSkillModel — precedence tiers', () => {
  test('tier 1: runtime override beats everything', () => {
    const out = resolveSkillModel({
      skillName: 'systematic-debugging',
      override: 'anthropic/claude-opus-4-5',
      bundled: bundledModels,
      global: globalModels,
      project: projectModels,
      frontmatter: 'frontmatter-model',
      ownerNodeModel: 'sonnet',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-opus-4-5');
    expect(out.source).toBe('override');
    expect(out.aliasExpanded).toBe(false);
    expect(out.inherited).toBe(false);
  });

  test('tier 2: project entry wins over global, bundled, frontmatter', () => {
    const out = resolveSkillModel({
      skillName: 'brainstorming',
      bundled: bundledModels,
      global: globalModels,
      project: projectModels,
      frontmatter: 'ignored',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('novita/deepseek/deepseek-r1');
    expect(out.source).toBe('project');
  });

  test('tier 3: global entry wins when project is empty', () => {
    const out = resolveSkillModel({
      skillName: 'systematic-debugging',
      bundled: bundledModels,
      global: globalModels,
      // no project entry for this skill
      project: { version: 1 },
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('openai/gpt-4o');
    expect(out.source).toBe('global');
  });

  test('tier 4: bundled entry wins when no global or project entry', () => {
    const out = resolveSkillModel({
      skillName: 'systematic-debugging',
      bundled: bundledModels,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-haiku-4-5');
    expect(out.source).toBe('bundled');
  });

  test('tier 5: frontmatter used when no file has an entry', () => {
    const out = resolveSkillModel({
      skillName: 'unknown-skill',
      bundled: bundledModels,
      frontmatter: 'anthropic/claude-sonnet-4-5',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-sonnet-4-5');
    expect(out.source).toBe('frontmatter');
  });

  test('tier 6: category default when no entry + no frontmatter', () => {
    const out = resolveSkillModel({
      skillName: 'unknown-skill',
      bundled: bundledModels,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-haiku-4-5'); // defaults.skill
    expect(out.source).toBe('default');
  });

  test('tier 7: owning node model when no entry + no frontmatter + no default', () => {
    const out = resolveSkillModel({
      skillName: 'unknown-skill',
      bundled: { version: 1 }, // no defaults
      ownerNodeModel: 'opus',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('opus');
    expect(out.source).toBe('inherit');
    expect(out.inherited).toBe(true);
  });

  test('tier 8: defaultAssistantModel is the ultimate fallback', () => {
    const out = resolveSkillModel({
      skillName: 'unknown-skill',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('sonnet');
    expect(out.source).toBe('assistant');
  });

  test('throws when no tier produces a value', () => {
    expect(() => resolveSkillModel({ skillName: 'nothing-anywhere' })).toThrow(
      /Cannot resolve model for skill/
    );
  });
});

describe('resolveSkillModel — inherit semantics', () => {
  test('literal `inherit` in a file resolves to ownerNodeModel', () => {
    const out = resolveSkillModel({
      skillName: 'writing-skills', // bundled value is 'inherit'
      bundled: bundledModels,
      ownerNodeModel: 'anthropic/claude-opus-4-5',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-opus-4-5');
    expect(out.source).toBe('inherit');
    expect(out.inherited).toBe(true);
    expect(out.raw).toBe('inherit');
  });

  test('literal `inherit` without an ownerNodeModel throws with a clear error', () => {
    expect(() =>
      resolveSkillModel({
        skillName: 'writing-skills',
        bundled: bundledModels,
        defaultAssistantModel: 'sonnet',
      })
    ).toThrow(/resolved to 'inherit' but no ownerNodeModel/);
  });

  test('inherit expands aliases on the owner value', () => {
    const out = resolveSkillModel({
      skillName: 'writing-skills',
      bundled: bundledModels,
      ownerNodeModel: 'fast', // alias for haiku
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-haiku-4-5');
    expect(out.aliasExpanded).toBe(true);
  });
});

describe('resolveSkillModel — alias expansion', () => {
  test('expands alias from project models.yaml', () => {
    const out = resolveAgentModel({
      agentName: 'code-reviewer',
      bundled: bundledModels,
      global: globalModels,
      project: projectModels, // code-reviewer: fast
      defaultAssistantModel: 'sonnet',
    });
    // project-level alias 'fast' doesn't override global-level; global wins
    expect(out.model).toBe('openai/gpt-4o-mini');
    expect(out.aliasExpanded).toBe(true);
    expect(out.source).toBe('project');
    expect(out.raw).toBe('fast');
  });

  test('alias merge order respects project > global > bundled', () => {
    // project defines 'cheap'; bundled has no 'cheap'
    const out = resolveSkillModel({
      skillName: 'unknown-skill',
      bundled: bundledModels,
      global: globalModels,
      project: projectModels,
      frontmatter: 'cheap',
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('novita/deepseek/deepseek-r1');
    expect(out.source).toBe('frontmatter');
    expect(out.aliasExpanded).toBe(true);
  });
});

describe('resolveAgentModel', () => {
  test('finds agent in bundled assignments', () => {
    const out = resolveAgentModel({
      agentName: 'code-reviewer',
      bundled: bundledModels,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-opus-4-5');
    expect(out.source).toBe('bundled');
  });

  test('falls back to category default when no entry', () => {
    const out = resolveAgentModel({
      agentName: 'unknown-agent',
      bundled: bundledModels,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('anthropic/claude-sonnet-4-5'); // defaults.agent
    expect(out.source).toBe('default');
  });
});

describe('resolveNodeModel', () => {
  test('explicit nodeModel wins', () => {
    const out = resolveNodeModel({
      nodeModel: 'opus',
      bundled: bundledModels,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.model).toBe('opus');
    expect(out.source).toBe('override');
  });

  test('falls to defaults.node from bundled', () => {
    const out = resolveNodeModel({
      bundled: bundledModels,
      defaultAssistantModel: 'assistant-sonnet',
    });
    expect(out.model).toBe('sonnet');
    expect(out.source).toBe('default');
  });

  test('falls to defaultAssistantModel when no models.yaml defines node default', () => {
    const out = resolveNodeModel({
      bundled: { version: 1 },
      defaultAssistantModel: 'assistant-sonnet',
    });
    expect(out.model).toBe('assistant-sonnet');
    expect(out.source).toBe('assistant');
  });

  test('throws when nothing is supplied', () => {
    expect(() => resolveNodeModel({})).toThrow(/Cannot resolve model for node/);
  });
});
