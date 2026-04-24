/**
 * LiteLLM provider tests.
 *
 * Uses mock.module() to stub out the proxy subprocess and the OpenAI client
 * so tests run fully in-process. Per CLAUDE.md, mock.module() is process-
 * global and irreversible — this file MUST live in its own `bun test`
 * invocation (see package.json test script: `bun test src/litellm/`).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type OpenAI from 'openai';
import type { MessageChunk } from '../types';

// ──────────────────────────────────────────────────────────────────────────
// Mocks — set up BEFORE importing the provider module.
// ──────────────────────────────────────────────────────────────────────────

const mockProxyHandle = {
  baseUrl: 'http://127.0.0.1:4000',
  external: true,
  close: () => undefined,
};
const getOrStartProxyMock = mock(async () => mockProxyHandle);

mock.module('./proxy', () => ({
  getOrStartProxy: getOrStartProxyMock,
  resetProxySingleton: () => undefined,
}));

const chatCreateMock = mock((): Promise<unknown> => Promise.reject(new Error('not mocked')));

class MockOpenAI {
  constructor(_opts: { baseURL: string; apiKey: string }) {
    // no-op
  }
  chat = {
    completions: {
      create: chatCreateMock,
    },
  };
}

mock.module('openai', () => ({
  default: MockOpenAI,
}));

mock.module('@archon/paths', () => ({
  createLogger: () => ({
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
    fatal: () => undefined,
  }),
}));

// Dynamic import AFTER mocks are registered.
const { LiteLLMProvider } = await import('./provider');
const { ProviderError } = await import('../errors');

// ──────────────────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────────────────

async function* makeStream(
  chunks: Array<{ content?: string; finish?: string | null; usage?: OpenAI.CompletionUsage }>
): AsyncGenerator<OpenAI.Chat.Completions.ChatCompletionChunk> {
  for (const c of chunks) {
    yield {
      id: 'x',
      choices: [
        {
          index: 0,
          delta: c.content !== undefined ? { content: c.content } : {},
          finish_reason: (c.finish ??
            null) as OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'],
          logprobs: null,
        },
      ],
      created: 0,
      model: 'x',
      object: 'chat.completion.chunk',
      ...(c.usage ? { usage: c.usage } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
  }
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

// Preserve / restore the env var so tests don't leak across runs or between
// this file and the rest of the suite (running under `bun --filter`).
const ORIGINAL_MASTER_KEY = process.env.LITELLM_MASTER_KEY;

beforeEach(() => {
  chatCreateMock.mockReset();
  getOrStartProxyMock.mockClear();
  process.env.LITELLM_MASTER_KEY = 'test-master-key';
});

afterAll(() => {
  if (ORIGINAL_MASTER_KEY === undefined) {
    delete process.env.LITELLM_MASTER_KEY;
  } else {
    process.env.LITELLM_MASTER_KEY = ORIGINAL_MASTER_KEY;
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────

describe('LiteLLMProvider.sendQuery', () => {
  test('emits assistant chunks then result on a normal stream', async () => {
    chatCreateMock.mockImplementation(() =>
      Promise.resolve(
        makeStream([
          { content: 'Hello' },
          { content: ' there' },
          {
            content: '.',
            finish: 'stop',
            usage: {
              prompt_tokens: 5,
              completion_tokens: 3,
              total_tokens: 8,
            } as OpenAI.CompletionUsage,
          },
        ])
      )
    );

    const provider = new LiteLLMProvider();
    const out = await collect(
      provider.sendQuery('Say hi', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
    const assistantChunks = out.filter(c => c.type === 'assistant');
    expect(assistantChunks.map(c => (c.type === 'assistant' ? c.content : ''))).toEqual([
      'Hello',
      ' there',
      '.',
    ]);
    expect(out.at(-1)?.type).toBe('result');
  });

  test('throws when model is missing (no node model, no default)', async () => {
    const provider = new LiteLLMProvider();
    try {
      for await (const _ of provider.sendQuery('hi', '/tmp', undefined, {
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })) {
        // won't reach
      }
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toContain('LiteLLM requires a model');
    }
  });

  test('throws when master key env var is not set', async () => {
    delete process.env.LITELLM_MASTER_KEY;
    const provider = new LiteLLMProvider();
    try {
      for await (const _ of provider.sendQuery('hi', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })) {
        // won't reach
      }
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as Error).message).toContain('master key not found');
    }
  });

  test('injects resolvedSkills into the system message', async () => {
    chatCreateMock.mockImplementation((body: unknown) => {
      const b = body as { messages: Array<{ role: string; content: string }> };
      const system = b.messages.find(m => m.role === 'system');
      // Assertions on the body go here — sanity-check before returning stream.
      expect(system).toBeDefined();
      expect(system?.content).toContain('preloaded skills');
      expect(system?.content).toContain('systematic-debugging');
      expect(system?.content).toContain('the debugging body');
      return Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]));
    });

    const provider = new LiteLLMProvider();
    await collect(
      provider.sendQuery('Go', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
        resolvedSkills: [
          {
            name: 'systematic-debugging',
            description: 'Use when stuck',
            body: 'the debugging body',
            model: 'openai/gpt-4o',
          },
        ],
      })
    );
    expect(chatCreateMock).toHaveBeenCalledTimes(1);
  });

  test('forwards fallbackModel as LiteLLM fallbacks body param', async () => {
    chatCreateMock.mockImplementation((body: unknown) => {
      const b = body as { fallbacks?: string[] };
      expect(b.fallbacks).toEqual(['openai/gpt-4o-mini']);
      return Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]));
    });

    const provider = new LiteLLMProvider();
    await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        fallbackModel: 'openai/gpt-4o-mini',
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
    expect(chatCreateMock).toHaveBeenCalledTimes(1);
  });

  test('forwards maxBudgetUsd as LiteLLM max_budget body param', async () => {
    chatCreateMock.mockImplementation((body: unknown) => {
      const b = body as { max_budget?: number };
      expect(b.max_budget).toBe(0.25);
      return Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]));
    });

    const provider = new LiteLLMProvider();
    await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        maxBudgetUsd: 0.25,
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
  });

  test('outputFormat maps to response_format json_schema body param', async () => {
    chatCreateMock.mockImplementation((body: unknown) => {
      const b = body as {
        response_format?: {
          type: string;
          json_schema: { name: string; schema: unknown; strict: boolean };
        };
      };
      expect(b.response_format?.type).toBe('json_schema');
      expect(b.response_format?.json_schema.schema).toEqual({
        type: 'object',
        properties: { answer: { type: 'number' } },
      });
      expect(b.response_format?.json_schema.strict).toBe(true);
      return Promise.resolve(makeStream([{ content: '{"answer":42}', finish: 'stop' }]));
    });

    const provider = new LiteLLMProvider();
    const out = await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { answer: { type: 'number' } } },
        },
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
    const result = out.find(c => c.type === 'result');
    if (result?.type === 'result') {
      expect(result.structuredOutput).toEqual({ answer: 42 });
    }
  });

  test('allowed_tools translates to OpenAI tools array', async () => {
    chatCreateMock.mockImplementation((body: unknown) => {
      const b = body as { tools?: { type: string; function: { name: string } }[] };
      expect(b.tools).toHaveLength(2);
      expect(b.tools?.map(t => t.function.name)).toEqual(['Read', 'Grep']);
      return Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]));
    });

    const provider = new LiteLLMProvider();
    await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        nodeConfig: { allowed_tools: ['Read', 'Grep'] },
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
  });

  test('denied_tools without allowed_tools emits a system warning chunk', async () => {
    chatCreateMock.mockImplementation(() =>
      Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]))
    );

    const provider = new LiteLLMProvider();
    const out = await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        nodeConfig: { denied_tools: ['Write'] },
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })
    );
    const systemChunks = out.filter(c => c.type === 'system');
    expect(systemChunks.length).toBeGreaterThan(0);
    const combined = systemChunks.map(c => (c.type === 'system' ? c.content : '')).join('\n');
    expect(combined).toContain('denied_tools');
  });

  test('translates a 429 error to rate_limit ProviderError', async () => {
    chatCreateMock.mockImplementation(() => {
      const err = new Error('Rate limited') as Error & { status: number };
      err.status = 429;
      return Promise.reject(err);
    });

    const provider = new LiteLLMProvider();
    try {
      for await (const _ of provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        assistantConfig: { baseUrl: 'http://127.0.0.1:4000' },
      })) {
        // won't reach
      }
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as InstanceType<typeof ProviderError>).code).toBe('rate_limit');
    }
  });

  test('passes baseUrl to the proxy helper (external mode)', async () => {
    chatCreateMock.mockImplementation(() =>
      Promise.resolve(makeStream([{ content: 'ok', finish: 'stop' }]))
    );

    const provider = new LiteLLMProvider();
    await collect(
      provider.sendQuery('x', '/tmp', undefined, {
        model: 'openai/gpt-4o',
        assistantConfig: { baseUrl: 'http://my-proxy:9000' },
      })
    );
    expect(getOrStartProxyMock).toHaveBeenCalledTimes(1);
    const call = getOrStartProxyMock.mock.calls[0][0] as { baseUrl: string };
    expect(call.baseUrl).toBe('http://my-proxy:9000');
  });
});
