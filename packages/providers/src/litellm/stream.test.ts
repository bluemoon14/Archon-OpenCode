import { describe, expect, test } from 'bun:test';
import type OpenAI from 'openai';
import type { MessageChunk } from '../types';
import { translateOpenAIStream } from './stream';

/** Helper: build an async iterable from a concrete array of SDK chunks. */
async function* iter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

function makeChunk(
  content?: string,
  finish_reason?: string | null,
  usage?: OpenAI.CompletionUsage | null
): OpenAI.Chat.Completions.ChatCompletionChunk {
  return {
    id: 'x',
    choices: [
      {
        index: 0,
        delta: content !== undefined ? { content } : {},
        finish_reason: (finish_reason ??
          null) as OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'],
        logprobs: null,
      },
    ],
    created: 0,
    model: 'x',
    object: 'chat.completion.chunk',
    ...(usage ? { usage } : {}),
  } as OpenAI.Chat.Completions.ChatCompletionChunk;
}

async function collect(gen: AsyncGenerator<MessageChunk>): Promise<MessageChunk[]> {
  const out: MessageChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe('translateOpenAIStream', () => {
  test('emits an assistant chunk per content delta + a terminal result', async () => {
    const chunks = [
      makeChunk('Hello'),
      makeChunk(' world'),
      makeChunk('!', 'stop', {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      } as OpenAI.CompletionUsage),
    ];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual({ type: 'assistant', content: 'Hello' });
    expect(out[1]).toEqual({ type: 'assistant', content: ' world' });
    expect(out[2]).toEqual({ type: 'assistant', content: '!' });
    const result = out[3];
    expect(result.type).toBe('result');
    if (result.type === 'result') {
      expect(result.tokens).toEqual({ input: 12, output: 3, total: 15 });
      expect(result.stopReason).toBe('stop');
      expect(result.modelUsage).toEqual({
        'openai/gpt-4o': { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      });
      expect(result.isError).toBe(false);
    }
  });

  test('drops empty deltas without emitting blank assistant chunks', async () => {
    const chunks = [makeChunk(''), makeChunk('ok'), makeChunk(undefined, 'stop')];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    expect(out.filter(c => c.type === 'assistant')).toHaveLength(1);
  });

  test('flags isError when stream ends without emitted content and a non-stop finish', async () => {
    const chunks = [makeChunk(undefined, 'content_filter')];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    expect(out).toHaveLength(1);
    if (out[0].type === 'result') {
      expect(out[0].isError).toBe(true);
      expect(out[0].stopReason).toBe('content_filter');
    }
  });

  test('emits a clean result even when the stream is completely empty', async () => {
    const out = await collect(translateOpenAIStream(iter([]), { model: 'openai/gpt-4o' }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('result');
  });
});

describe('translateOpenAIStream — tool calling', () => {
  function makeToolChunk(
    index: number,
    parts: { id?: string; name?: string; args?: string },
    finish?: string | null
  ): OpenAI.Chat.Completions.ChatCompletionChunk {
    const delta: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta = {
      tool_calls: [
        {
          index,
          ...(parts.id !== undefined ? { id: parts.id } : {}),
          type: 'function' as const,
          function: {
            ...(parts.name !== undefined ? { name: parts.name } : {}),
            ...(parts.args !== undefined ? { arguments: parts.args } : {}),
          },
        },
      ],
    };
    return {
      id: 'x',
      choices: [
        {
          index: 0,
          delta,
          finish_reason: (finish ??
            null) as OpenAI.Chat.Completions.ChatCompletionChunk.Choice['finish_reason'],
          logprobs: null,
        },
      ],
      created: 0,
      model: 'x',
      object: 'chat.completion.chunk',
    } as OpenAI.Chat.Completions.ChatCompletionChunk;
  }

  test('accumulates per-index tool_call deltas into one tool chunk', async () => {
    const chunks = [
      makeToolChunk(0, { id: 'call_abc', name: 'sea', args: '{"qu' }),
      makeToolChunk(0, { args: 'ery":"archon' }),
      makeToolChunk(0, { args: '"}' }, 'tool_calls'),
    ];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    const toolChunks = out.filter(c => c.type === 'tool');
    expect(toolChunks).toHaveLength(1);
    if (toolChunks[0].type === 'tool') {
      expect(toolChunks[0].toolName).toBe('sea');
      expect(toolChunks[0].toolInput).toEqual({ query: 'archon' });
      expect(toolChunks[0].toolCallId).toBe('call_abc');
    }
  });

  test('emits _rawArgs when tool_call arguments are invalid JSON', async () => {
    const chunks = [makeToolChunk(0, { id: 'c1', name: 'bad', args: 'not json' }, 'tool_calls')];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    const tool = out.find(c => c.type === 'tool');
    if (tool?.type === 'tool') {
      expect(tool.toolInput).toEqual({ _rawArgs: 'not json' });
    }
  });

  test('multiple parallel tool_calls each become separate tool chunks', async () => {
    const chunks = [
      makeToolChunk(0, { id: 'a', name: 'read', args: '{"path":"/x"}' }),
      makeToolChunk(1, { id: 'b', name: 'grep', args: '{"q":"y"}' }, 'tool_calls'),
    ];
    const out = await collect(translateOpenAIStream(iter(chunks), { model: 'openai/gpt-4o' }));
    const tools = out.filter(c => c.type === 'tool');
    expect(tools).toHaveLength(2);
  });
});

describe('translateOpenAIStream — structured output', () => {
  test('parses final JSON and attaches to result.structuredOutput', async () => {
    const chunks = [makeChunk('{"answer":'), makeChunk(' 42}', 'stop')];
    const out = await collect(
      translateOpenAIStream(iter(chunks), {
        model: 'openai/gpt-4o',
        expectsStructuredOutput: true,
      })
    );
    const result = out.find(c => c.type === 'result');
    if (result?.type === 'result') {
      expect(result.structuredOutput).toEqual({ answer: 42 });
      expect(result.isError).toBe(false);
    }
  });

  test('flags isError when expected JSON response is malformed', async () => {
    const chunks = [makeChunk('not json at all', 'stop')];
    const out = await collect(
      translateOpenAIStream(iter(chunks), {
        model: 'openai/gpt-4o',
        expectsStructuredOutput: true,
      })
    );
    const result = out.find(c => c.type === 'result');
    if (result?.type === 'result') {
      expect(result.structuredOutput).toBeUndefined();
      expect(result.isError).toBe(true);
    }
  });

  test('non-structured stream still parses cleanly (expectsStructuredOutput: false)', async () => {
    const chunks = [makeChunk('plain text', 'stop')];
    const out = await collect(
      translateOpenAIStream(iter(chunks), {
        model: 'openai/gpt-4o',
        expectsStructuredOutput: false,
      })
    );
    const result = out.find(c => c.type === 'result');
    if (result?.type === 'result') {
      expect(result.structuredOutput).toBeUndefined();
      expect(result.isError).toBe(false);
    }
  });
});
