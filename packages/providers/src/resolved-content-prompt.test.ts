import { describe, expect, test } from 'bun:test';
import { buildResolvedSystemPrompt } from './resolved-content-prompt';

describe('buildResolvedSystemPrompt', () => {
  test('returns undefined when there is nothing to contribute', () => {
    expect(buildResolvedSystemPrompt({})).toBeUndefined();
    expect(
      buildResolvedSystemPrompt({ systemPrompt: '', resolvedSkills: [], resolvedAgents: [] })
    ).toBeUndefined();
  });

  test('passes through systemPrompt unchanged when no resolved content', () => {
    const out = buildResolvedSystemPrompt({ systemPrompt: 'You are Archon.' });
    expect(out).toBe('You are Archon.');
  });

  test('injects a skills section when resolvedSkills is non-empty', () => {
    const out = buildResolvedSystemPrompt({
      resolvedSkills: [
        {
          name: 'systematic-debugging',
          description: 'Use when stuck',
          body: 'Find the polluter.',
          model: 'x',
        },
      ],
    });
    expect(out).toContain('preloaded skills');
    expect(out).toContain('## Skill: systematic-debugging');
    expect(out).toContain('Find the polluter.');
  });

  test('injects an agents section when resolvedAgents is non-empty', () => {
    const out = buildResolvedSystemPrompt({
      resolvedAgents: [
        {
          id: 'code-reviewer',
          description: 'Reviews code',
          prompt: 'Be fair but thorough.',
          model: 'x',
        },
      ],
    });
    expect(out).toContain('sub-agent personas');
    expect(out).toContain('## Available sub-agent: code-reviewer');
    expect(out).toContain('Be fair but thorough.');
  });

  test('concatenates systemPrompt + skills + agents with separators', () => {
    const out = buildResolvedSystemPrompt({
      systemPrompt: 'BASE',
      resolvedSkills: [{ name: 'skill-a', description: 'desc', body: 'body', model: 'x' }],
      resolvedAgents: [{ id: 'agent-a', description: 'desc', prompt: 'prompt', model: 'x' }],
    });
    expect(out).toContain('BASE');
    expect(out).toContain('## Skill: skill-a');
    expect(out).toContain('## Available sub-agent: agent-a');
    // Sections are separated by the divider.
    const dividerCount = (out ?? '').split('\n\n---\n\n').length - 1;
    expect(dividerCount).toBeGreaterThanOrEqual(2);
  });

  test('multiple skills are joined by a divider inside the skills section', () => {
    const out = buildResolvedSystemPrompt({
      resolvedSkills: [
        { name: 'a', description: 'desc', body: 'body-a', model: 'x' },
        { name: 'b', description: 'desc', body: 'body-b', model: 'x' },
      ],
    });
    expect(out).toContain('body-a');
    expect(out).toContain('body-b');
    expect(out).toContain('## Skill: a');
    expect(out).toContain('## Skill: b');
  });
});
