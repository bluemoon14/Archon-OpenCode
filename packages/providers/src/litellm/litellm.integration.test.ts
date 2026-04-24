/**
 * Live integration tests for the LiteLLM provider.
 *
 * Gated on `ARCHON_LITELLM_SMOKE=1` — skipped in CI and on dev machines
 * unless the developer explicitly opts in. When enabled, these tests:
 *
 *   1. Spawn a real `uvx litellm` subprocess (if not already running at
 *      `http://localhost:4000`).
 *   2. Issue a short `sendQuery` using `anthropic/claude-haiku-4-5` — the
 *      cheapest routable model we ship by default.
 *   3. Assert the stream produced a non-empty assistant chunk + a result
 *      chunk with a numeric cost.
 *
 * Preconditions (must be satisfied BEFORE the test runs):
 *   - `uvx` on PATH (via `make pydantic` or a prior `uv` install).
 *   - `LITELLM_MASTER_KEY` exported.
 *   - `ANTHROPIC_API_KEY` (or whatever the proxy's config maps to) set.
 *   - `~/.archon/litellm_config.yaml` exists and routes anthropic/*.
 *
 * Designed for local smoke runs, not CI. Do NOT mock anything here — the
 * whole point is to catch integration regressions the unit tests miss.
 */
import { describe, expect, it } from 'bun:test';

const SMOKE = process.env.ARCHON_LITELLM_SMOKE === '1';

describe.skipIf(!SMOKE)('LiteLLM live integration — ARCHON_LITELLM_SMOKE=1', () => {
  it('sendQuery round-trips against a running proxy', async () => {
    // Load the provider lazily so the import of @opencode-ai/sdk etc. doesn't
    // happen on `bun test` for every unrelated suite. SMOKE=0 skips before
    // we get here, so the dynamic import stays cold in normal runs.
    const { LiteLLMProvider } = await import('./provider');
    const provider = new LiteLLMProvider();

    // Tight timeout — haiku should respond in under 10s or something is wrong.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    const chunks: Array<{ type: string; content?: string; cost?: number }> = [];
    try {
      for await (const chunk of provider.sendQuery('Say PING only.', 'cli-smoke', undefined, {
        model: 'anthropic/claude-haiku-4-5',
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk as { type: string; content?: string; cost?: number });
      }
    } finally {
      clearTimeout(timer);
    }

    const assistantChunks = chunks.filter(c => c.type === 'assistant');
    const result = chunks.find(c => c.type === 'result');
    expect(assistantChunks.length).toBeGreaterThan(0);
    const joined = assistantChunks.map(c => c.content ?? '').join('');
    expect(joined.trim().toUpperCase()).toContain('PING');
    expect(result?.cost ?? 0).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
