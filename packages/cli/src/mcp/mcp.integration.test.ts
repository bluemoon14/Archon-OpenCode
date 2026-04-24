/**
 * Live integration test for `archon mcp serve`.
 *
 * Gated on `ARCHON_MCP_SMOKE=1` — spawns the CLI as a subprocess, sends
 * a single JSON-RPC `tools/list` request over stdio, and asserts the
 * expected tool set is registered.
 *
 * Designed for local smoke only — not in CI. Catches regressions where
 * the MCP server either stops registering a tool or fails to start
 * cleanly (see PR #3 for a past instance of the latter).
 */
import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const SMOKE = process.env.ARCHON_MCP_SMOKE === '1';

describe.skipIf(!SMOKE)('archon mcp serve — ARCHON_MCP_SMOKE=1', () => {
  it('registers the expected 10 tools and responds to tools/list', async () => {
    const cliEntry = resolve(__dirname, '..', 'cli.ts');
    const child = spawn('bun', [cliEntry, 'mcp', 'serve'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => stdoutChunks.push(b));
    child.stderr.on('data', (b: Buffer) => stderrChunks.push(b));

    // Init handshake + tools/list. MCP spec requires initialize before any
    // other request; the server will reject tools/list without it.
    const initMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'archon-smoke', version: '0.0.1' },
      },
    });
    const listMsg = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    child.stdin.write(initMsg + '\n');
    child.stdin.write(listMsg + '\n');

    // Give it a second to respond, then gracefully shut down.
    await new Promise(r => setTimeout(r, 1500));
    child.kill('SIGTERM');

    const stdout = Buffer.concat(stdoutChunks).toString('utf-8');
    // Pull out every JSON-RPC response line that matches id=2.
    const lines = stdout.split('\n').filter(l => l.trim().startsWith('{'));
    const listResponse = lines
      .map(l => {
        try {
          return JSON.parse(l) as { id?: number; result?: { tools?: { name: string }[] } };
        } catch {
          return undefined;
        }
      })
      .find(r => r?.id === 2);

    expect(listResponse).toBeDefined();
    const toolNames = (listResponse?.result?.tools ?? []).map(t => t.name).sort();
    // Lock the v1 tool set. Update this list if tools are added/removed.
    expect(toolNames.length).toBeGreaterThanOrEqual(10);
    expect(toolNames).toContain('archon_skills_list');
    expect(toolNames).toContain('archon_skill_invoke');
    expect(toolNames).toContain('archon_workflow_run');
  }, 30_000);
});
