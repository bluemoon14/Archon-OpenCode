/**
 * Translate an OpenAI chat.completions stream into Archon's MessageChunk
 * union. Scope (MVP): text-only assistant output + a final `result` chunk
 * carrying usage data. Tool-call / function-call support is a follow-up —
 * the LiteLLM path runs text-first workflows today.
 */
import type OpenAI from 'openai';
import type { MessageChunk, TokenUsage } from '../types';

export interface StreamOptions {
  /** Requested model string — echoed into the result chunk's modelUsage map. */
  model: string;
}

/**
 * Consume an OpenAI stream and yield MessageChunks. Each content delta becomes
 * an `assistant` chunk; the terminal chunk's usage becomes a `result`.
 */
export async function* translateOpenAIStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  opts: StreamOptions
): AsyncGenerator<MessageChunk> {
  let stopReason: string | undefined;
  let tokens: TokenUsage | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let emittedAny = false;

  for await (const chunk of stream) {
    // Assistant text delta. OpenAI emits content progressively; Archon's
    // MessageChunk assumes each `assistant` chunk is a fresh fragment to append.
    const delta = chunk.choices[0]?.delta.content;
    if (typeof delta === 'string' && delta.length > 0) {
      emittedAny = true;
      yield { type: 'assistant', content: delta };
    }

    const finish = chunk.choices[0]?.finish_reason;
    if (finish !== undefined && finish !== null) {
      stopReason = finish;
    }

    // OpenAI sends usage only in the final chunk when `stream_options:
    // {include_usage: true}` is set. LiteLLM respects this.
    const usage = (chunk as { usage?: OpenAI.CompletionUsage | null }).usage;
    if (usage) {
      tokens = {
        input: usage.prompt_tokens,
        output: usage.completion_tokens,
        total: usage.total_tokens,
      };
      modelUsage = { [opts.model]: usage };
    }
  }

  // Even if the stream had no content (rare — rate-limit + empty response),
  // emit a result so downstream can release the turn cleanly.
  yield {
    type: 'result',
    ...(tokens !== undefined ? { tokens } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    isError: !emittedAny && stopReason !== 'stop' && stopReason !== undefined ? true : false,
  };
}
