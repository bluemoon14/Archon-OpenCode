/**
 * Translate an OpenAI chat.completions stream into Archon's MessageChunk
 * union.
 *
 * Surfaces:
 *   - `assistant` chunks for each content delta (progressive text).
 *   - `tool` chunks for each complete tool_call seen in the stream — we
 *     accumulate tool_call deltas (OpenAI emits the name + args incrementally)
 *     and emit a single `tool` chunk per call once the args JSON is well-
 *     formed or the stream settles with `finish_reason: tool_calls`.
 *   - `result` terminal chunk carrying token usage, stop reason, and
 *     optionally `structuredOutput` parsed from the final text when the
 *     caller set `expectsStructuredOutput: true`.
 *
 * Tool _result_ chunks are NOT produced here — OpenAI's tool-use flow
 * requires the host to execute the tool and feed the output back as a
 * follow-up assistant message. Archon's workflow executor does that via
 * its existing tool-result plumbing; the provider stops at emitting the
 * `tool` call chunk so the executor can hand it to the user's tool.
 */
import type OpenAI from 'openai';
import type { MessageChunk, TokenUsage } from '../types';

export interface StreamOptions {
  /** Requested model string — echoed into the result chunk's modelUsage map. */
  model: string;
  /**
   * When true, the translator accumulates assistant text chunks and parses
   * the final concatenation as JSON, attaching it to the terminal result's
   * `structuredOutput` field. Caller sets this when the request body
   * included `response_format: json_schema`.
   */
  expectsStructuredOutput?: boolean;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsJson: string;
  emitted: boolean;
}

/**
 * Consume an OpenAI stream and yield MessageChunks. Each content delta becomes
 * an `assistant` chunk; tool_call deltas accumulate into `tool` chunks; the
 * terminal chunk's usage becomes a `result`.
 */
export async function* translateOpenAIStream(
  stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
  opts: StreamOptions
): AsyncGenerator<MessageChunk> {
  let stopReason: string | undefined;
  let tokens: TokenUsage | undefined;
  let modelUsage: Record<string, unknown> | undefined;
  let emittedAny = false;
  const toolCallsByIndex = new Map<number, ToolCallAccumulator>();
  const assistantBuffer: string[] = [];

  for await (const chunk of stream) {
    // Assistant text delta. OpenAI emits content progressively; Archon's
    // MessageChunk assumes each `assistant` chunk is a fresh fragment to append.
    const delta = chunk.choices[0]?.delta.content;
    if (typeof delta === 'string' && delta.length > 0) {
      emittedAny = true;
      if (opts.expectsStructuredOutput === true) assistantBuffer.push(delta);
      yield { type: 'assistant', content: delta };
    }

    // Tool-call deltas. OpenAI sends these with index + partial fields across
    // multiple chunks. Accumulate per-index until the call is complete.
    const toolCallDeltas = chunk.choices[0]?.delta.tool_calls;
    if (toolCallDeltas !== undefined) {
      for (const tcd of toolCallDeltas) {
        const idx = tcd.index;
        let acc = toolCallsByIndex.get(idx);
        if (acc === undefined) {
          acc = { id: tcd.id ?? '', name: '', argsJson: '', emitted: false };
          toolCallsByIndex.set(idx, acc);
        }
        if (tcd.id !== undefined) acc.id = tcd.id;
        if (tcd.function?.name !== undefined) acc.name += tcd.function.name;
        if (tcd.function?.arguments !== undefined) acc.argsJson += tcd.function.arguments;
      }
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

  // Emit any fully-accumulated tool calls once the stream settles. Callers
  // (workflow executor) bind the tool_call_id on any follow-up tool_result
  // chunk so pairing is guaranteed even across parallel tool calls.
  for (const acc of toolCallsByIndex.values()) {
    if (acc.emitted) continue;
    if (acc.name.length === 0) continue; // malformed — skip
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs =
        acc.argsJson.length > 0 ? (JSON.parse(acc.argsJson) as Record<string, unknown>) : {};
    } catch {
      // The model sent invalid JSON args — surface the raw string so the
      // caller can decide whether to fail or retry.
      parsedArgs = { _rawArgs: acc.argsJson };
    }
    emittedAny = true;
    acc.emitted = true;
    yield {
      type: 'tool',
      toolName: acc.name,
      toolInput: parsedArgs,
      ...(acc.id.length > 0 ? { toolCallId: acc.id } : {}),
    };
  }

  // Parse structured output if requested.
  let structuredOutput: unknown;
  if (opts.expectsStructuredOutput === true && assistantBuffer.length > 0) {
    const joined = assistantBuffer.join('');
    try {
      structuredOutput = JSON.parse(joined);
    } catch {
      // Leave structuredOutput undefined; the isError flag below signals the parse failure.
    }
  }

  // Even if the stream had no content (rare — rate-limit + empty response),
  // emit a result so downstream can release the turn cleanly.
  yield {
    type: 'result',
    ...(tokens !== undefined ? { tokens } : {}),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(modelUsage !== undefined ? { modelUsage } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    isError:
      opts.expectsStructuredOutput === true && structuredOutput === undefined && emittedAny
        ? true
        : !emittedAny && stopReason !== 'stop' && stopReason !== undefined
          ? true
          : false,
  };
}
