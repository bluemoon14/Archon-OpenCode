/**
 * In-process tests of the Archon MCP server — construct the server, call
 * tool handlers via the registered-tools table, and assert output shape.
 * No stdio transport is started, so tests run synchronously without a
 * subprocess boundary.
 */
import { describe, expect, test } from 'bun:test';
import { createArchonMcpServer } from './server';

interface RegisteredTool {
  handler: (
    args: unknown,
    extra?: unknown
  ) => Promise<{
    isError?: boolean;
    content: { type: string; text: string }[];
  }>;
}

/** Grab the server's internal tool table. McpServer exposes `_registeredTools`
 *  as a private, but test-addressable map keyed by tool name. */
function getTools(server: unknown): Map<string, RegisteredTool> {
  const table = (server as { _registeredTools: Record<string, unknown> })._registeredTools;
  return new Map(Object.entries(table) as [string, RegisteredTool][]);
}

async function callTool(
  server: unknown,
  name: string,
  args: unknown = {}
): Promise<{ isError?: boolean; text: string }> {
  const tools = getTools(server);
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  // Minimal RequestHandlerExtra stub — the handler body here only reads args.
  const extra = {
    signal: new AbortController().signal,
    requestId: 'test-req',
    sendNotification: () => Promise.resolve(),
    sendRequest: () => Promise.resolve({} as never),
  };
  const res = await tool.handler(args, extra);
  return { isError: res.isError, text: res.content[0].text };
}

describe('createArchonMcpServer', () => {
  test('registers every documented discovery tool', () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const tools = getTools(server);
    for (const name of [
      'archon_skills_list',
      'archon_skills_show',
      'archon_agents_list',
      'archon_agents_show',
      'archon_models_list',
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  test('archon_skills_list returns the bundled superpowers skills', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_skills_list');
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as {
      skills: { name: string; source: string; model: string }[];
    };
    expect(parsed.skills.length).toBeGreaterThanOrEqual(14);
    expect(parsed.skills.map(s => s.name)).toContain('systematic-debugging');
    expect(parsed.skills.find(s => s.name === 'systematic-debugging')?.source).toBe('bundled');
  });

  test('archon_skills_show returns the full SKILL.md body', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_skills_show', {
      name: 'systematic-debugging',
    });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as {
      name: string;
      body: string;
      model: string;
    };
    expect(parsed.name).toBe('systematic-debugging');
    expect(parsed.body.length).toBeGreaterThan(100);
    expect(parsed.model).toBeTruthy();
  });

  test('archon_skills_show returns an error envelope for an unknown skill', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_skills_show', {
      name: 'no-such-skill',
    });
    expect(isError).toBe(true);
    expect(text).toContain('not found');
  });

  test('archon_agents_list returns the bundled code-reviewer agent', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_agents_list');
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { agents: { name: string; source: string }[] };
    expect(parsed.agents.map(a => a.name)).toContain('code-reviewer');
  });

  test('archon_agents_show returns the agent body + resolved model', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_agents_show', {
      name: 'code-reviewer',
    });
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as { name: string; model: string; body: string };
    expect(parsed.name).toBe('code-reviewer');
    expect(parsed.model).toBe('anthropic/claude-opus-4-5');
  });

  test('archon_models_list returns defaults + aliases + tables', async () => {
    const server = createArchonMcpServer({ cwd: process.cwd() });
    const { isError, text } = await callTool(server, 'archon_models_list');
    expect(isError).toBeFalsy();
    const parsed = JSON.parse(text) as {
      defaults: { node: string };
      aliases: Record<string, string>;
      skills: { name: string }[];
      agents: { name: string }[];
    };
    expect(parsed.defaults.node).toBeTruthy();
    expect(Object.keys(parsed.aliases)).toContain('fast');
    expect(Object.keys(parsed.aliases)).toContain('smart');
    expect(parsed.skills.length).toBeGreaterThanOrEqual(14);
    expect(parsed.agents.length).toBeGreaterThanOrEqual(1);
  });
});
