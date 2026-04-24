import { describe, expect, test } from 'bun:test';
import type { ResolvedAgent, ResolvedSkill } from './schemas';
import type { SkillAgentRegistry } from './deps';
import { resolveNodeContent } from './resolve-node-content';
import { SkillNotFoundError } from './skills/loader';
import { AgentNotFoundError } from './agents/loader';

/**
 * Build a stub SkillAgentRegistry over in-memory fixtures. Skill/agent names
 * not in the fixtures throw "not found" — matching the real loaders' semantics.
 */
function makeRegistry(params: {
  skills?: Record<string, Partial<ResolvedSkill>>;
  agents?: Record<string, Partial<ResolvedAgent>>;
  bundledModelsYaml?: { skills?: Record<string, string>; agents?: Record<string, string> };
}): SkillAgentRegistry {
  const skills = params.skills ?? {};
  const agents = params.agents ?? {};
  return {
    loadSkill: async name => {
      const s = skills[name];
      if (s === undefined) throw new SkillNotFoundError(name);
      return {
        name,
        description: s.description ?? `desc for ${name}`,
        body: s.body ?? `body for ${name}`,
        source: s.source ?? 'bundled',
        ...(s.model !== undefined ? { model: s.model } : {}),
        ...(s.path !== undefined ? { path: s.path } : {}),
      };
    },
    listSkills: async () => Object.keys(skills).map(name => ({ name, source: 'bundled' as const })),
    loadAgent: async name => {
      const a = agents[name];
      if (a === undefined) throw new AgentNotFoundError(name);
      return {
        name,
        description: a.description ?? `desc for ${name}`,
        body: a.body ?? `body for ${name}`,
        source: a.source ?? 'bundled',
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.tools !== undefined ? { tools: a.tools } : {}),
        ...(a.maxTurns !== undefined ? { maxTurns: a.maxTurns } : {}),
      };
    },
    listAgents: async () => Object.keys(agents).map(name => ({ name, source: 'bundled' as const })),
    modelsFiles: () => ({
      bundled: {
        version: 1,
        skills: params.bundledModelsYaml?.skills,
        agents: params.bundledModelsYaml?.agents,
      },
    }),
  };
}

describe('resolveNodeContent', () => {
  test('resolves a single skill with registry body + models.yaml model', async () => {
    const registry = makeRegistry({
      skills: { 'systematic-debugging': { body: 'the systematic debugging body' } },
      bundledModelsYaml: { skills: { 'systematic-debugging': 'anthropic/claude-opus-4-5' } },
    });
    const out = await resolveNodeContent({
      skills: ['systematic-debugging'],
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedSkills).toHaveLength(1);
    expect(out.resolvedSkills[0]).toMatchObject({
      name: 'systematic-debugging',
      body: 'the systematic debugging body',
      model: 'anthropic/claude-opus-4-5',
    });
    expect(out.resolvedAgents).toEqual([]);
  });

  test('skips skills that are not in the registry (falls back to pass-through)', async () => {
    const registry = makeRegistry({ skills: { known: { body: 'x' } } });
    const out = await resolveNodeContent({
      skills: ['known', 'unknown-skill'],
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedSkills.map(s => s.name)).toEqual(['known']);
  });

  test('frontmatter model wins over category default when no assignment', async () => {
    const registry = makeRegistry({
      skills: { demo: { body: 'x', model: 'openai/gpt-4o' } },
      bundledModelsYaml: { skills: {} }, // no assignment for 'demo'
    });
    const out = await resolveNodeContent({
      skills: ['demo'],
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedSkills[0].model).toBe('openai/gpt-4o');
  });

  test('resolves agents with registry body as prompt and inline fields winning', async () => {
    const registry = makeRegistry({
      agents: {
        'code-reviewer': {
          body: 'registry prompt',
          description: 'registry description',
          tools: ['Read'],
        },
      },
      bundledModelsYaml: { agents: { 'code-reviewer': 'anthropic/claude-opus-4-5' } },
    });
    const out = await resolveNodeContent({
      agents: {
        'code-reviewer': {
          description: 'inline description wins',
          prompt: '', // empty inline prompt falls through to registry body
        },
      },
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedAgents).toHaveLength(1);
    expect(out.resolvedAgents[0]).toMatchObject({
      id: 'code-reviewer',
      description: 'inline description wins',
      prompt: 'registry prompt', // empty inline prompt falls through
      model: 'anthropic/claude-opus-4-5',
      tools: ['Read'],
    });
  });

  test('inline model on agent wins over registry (tier 1 override)', async () => {
    const registry = makeRegistry({
      agents: { reviewer: { body: 'x', model: 'anthropic/claude-opus-4-5' } },
    });
    const out = await resolveNodeContent({
      agents: { reviewer: { description: 'd', prompt: 'p', model: 'openai/gpt-4o' } },
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedAgents[0].model).toBe('openai/gpt-4o');
  });

  test('unknown agent id falls through (left in nodeConfig.agents for provider pass-through)', async () => {
    const registry = makeRegistry({ agents: {} });
    const out = await resolveNodeContent({
      agents: { 'user-inline-only': { description: 'd', prompt: 'p' } },
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedAgents).toEqual([]);
  });

  test('empty skills + empty agents returns empty arrays (no-op)', async () => {
    const registry = makeRegistry({});
    const out = await resolveNodeContent({
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedSkills).toEqual([]);
    expect(out.resolvedAgents).toEqual([]);
  });

  test('ownerNodeModel is used for inherit resolution', async () => {
    const registry = makeRegistry({
      skills: { 'inherit-skill': { body: 'x' } },
      bundledModelsYaml: { skills: { 'inherit-skill': 'inherit' } },
    });
    const out = await resolveNodeContent({
      skills: ['inherit-skill'],
      nodeModel: 'opus',
      registry,
      defaultAssistantModel: 'sonnet',
    });
    expect(out.resolvedSkills[0].model).toBe('opus');
  });
});

describe('resolveNodeContent — error bubble semantics', () => {
  test('bubbles non-NotFound errors from loadSkill (e.g. malformed frontmatter)', async () => {
    const registry: SkillAgentRegistry = {
      loadSkill: async () => {
        throw new Error('skill file has malformed YAML frontmatter');
      },
      listSkills: async () => [],
      loadAgent: async () => {
        throw new AgentNotFoundError('unused');
      },
      listAgents: async () => [],
      modelsFiles: () => ({ bundled: { version: 1 } }),
    };
    await expect(
      resolveNodeContent({
        skills: ['corrupted'],
        registry,
        defaultAssistantModel: 'sonnet',
      })
    ).rejects.toThrow(/malformed YAML/);
  });

  test('bubbles non-NotFound errors from loadAgent (e.g. permission denied)', async () => {
    const registry: SkillAgentRegistry = {
      loadSkill: async () => {
        throw new SkillNotFoundError('unused');
      },
      listSkills: async () => [],
      loadAgent: async () => {
        throw new Error('EACCES: permission denied reading agent file');
      },
      listAgents: async () => [],
      modelsFiles: () => ({ bundled: { version: 1 } }),
    };
    await expect(
      resolveNodeContent({
        agents: { corrupted: { description: 'd', prompt: 'p' } },
        registry,
        defaultAssistantModel: 'sonnet',
      })
    ).rejects.toThrow(/EACCES/);
  });
});
