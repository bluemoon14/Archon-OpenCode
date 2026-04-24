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
