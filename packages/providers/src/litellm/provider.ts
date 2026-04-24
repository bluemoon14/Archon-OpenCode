/**
 * LiteLLM agent provider.
 *
 * Routes requests through a LiteLLM proxy (OpenAI-compatible HTTP). Archon
 * spawns + reuses one proxy subprocess per process (see ./proxy.ts), or
 * points at a user-managed instance when `assistants.litellm.baseUrl` is set.
 *
 * Scope (MVP):
 *   - Plain text chat completions with streaming.
 *   - `resolvedSkills` + `resolvedAgents` from the registry are delivered as
 *     system-prompt content (no native subagent support on LiteLLM).
 *   - `options.systemPrompt` is honored.
 *   - `options.fallbackModel` is forwarded as LiteLLM's per-request
 *     `fallbacks: [<model>]` body extension.
 *
 * Deferred (tracked on the integration plan):
 *   - Tool / function calling (OpenAI function calls + structured tool_use
 *     translation to Archon's `tool` / `tool_result` chunks).
 *   - Structured output / JSON schema via response_format.
 *   - Per-request cost ceiling + max tokens.
 */
import OpenAI from 'openai';
import { createLogger } from '@archon/paths';
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  ResolvedAgentHandoff,
  ResolvedSkillHandoff,
  SendQueryOptions,
} from '../types';
import { ProviderError } from '../errors';
import { buildResolvedSystemPrompt } from '../resolved-content-prompt';
import { LITELLM_CAPABILITIES } from './capabilities';
import { parseLiteLLMConfig } from './config';
import { getOrStartProxy } from './proxy';
import { translateOpenAIStream } from './stream';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.litellm');
  return cachedLog;
}

export class LiteLLMProvider implements IAgentProvider {
  getType(): string {
    return 'litellm';
  }

  getCapabilities(): ProviderCapabilities {
    return LITELLM_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const cfg = parseLiteLLMConfig(options?.assistantConfig);
    const model = options?.model ?? cfg.model;
    if (model === undefined || model.length === 0) {
      throw new ProviderError(
        'litellm',
        'unknown',
        'LiteLLM requires a model — set `model:` on the workflow node or `assistants.litellm.model` in .archon/config.yaml.'
      );
    }

    // Bring the proxy online (or use external baseUrl). Throws ProviderError
    // on spawn failure with stderr tail attached.
    const proxy = await getOrStartProxy({
      configPath: cfg.configPath ?? defaultConfigPath(),
      port: cfg.port,
      binaryPath: cfg.litellmBinaryPath,
      baseUrl: cfg.baseUrl,
      env: options?.env,
    });

    const apiKey = process.env[cfg.masterKeyEnv];
    if (apiKey === undefined || apiKey.length === 0) {
      throw new ProviderError(
        'litellm',
        'auth',
        `LiteLLM master key not found in env var '${cfg.masterKeyEnv}'. Set it in ~/.archon/.env or export it before invoking archon.`
      );
    }

    const client = new OpenAI({ baseURL: proxy.baseUrl, apiKey });

    const messages = buildMessages({
      systemPrompt: options?.systemPrompt,
      userPrompt: prompt,
      resolvedSkills: options?.resolvedSkills,
      resolvedAgents: options?.resolvedAgents,
    });

    // LiteLLM passthrough: `fallbacks` is a first-class LiteLLM extension on
    // the standard OpenAI body. The OpenAI SDK forwards unknown fields.
    const body: Record<string, unknown> = {
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options?.fallbackModel) {
      body.fallbacks = [options.fallbackModel];
    }

    // Cost ceiling: LiteLLM supports `max_budget` as a per-request hard cap
    // (USD). The proxy enforces + returns a 400 when the inferred cost
    // would exceed it, which we bubble as `ProviderError('...', 'unknown')`.
    if (options?.maxBudgetUsd !== undefined) {
      body.max_budget = options.maxBudgetUsd;
    }

    // Structured output: map Archon's outputFormat → OpenAI's
    // response_format. Supported upstream by LiteLLM. The stream translator
    // parses the final assistant text as JSON and attaches the result to the
    // terminal `result` chunk's `structuredOutput` field.
    let expectsStructuredOutput = false;
    if (options?.outputFormat?.type === 'json_schema') {
      expectsStructuredOutput = true;
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'archon_response',
          schema: options.outputFormat.schema,
          strict: true,
        },
      };
    }

    // Tool-use: translate `nodeConfig.allowed_tools` → OpenAI function shape.
    // OpenAI doesn't have a native `denied_tools` concept — we warn (as a
    // system chunk) and only forward the allow-list. This is still useful
    // because many real-world workflow nodes use only allowed_tools.
    const allowedTools = options?.nodeConfig?.allowed_tools;
    const deniedTools = options?.nodeConfig?.denied_tools;
    const deniedToolsIgnored = deniedTools !== undefined && deniedTools.length > 0;
    if (allowedTools !== undefined && allowedTools.length > 0) {
      body.tools = allowedTools.map(name => ({
        type: 'function' as const,
        function: { name, description: '', parameters: { type: 'object', properties: {} } },
      }));
    }

    getLog().info(
      {
        model,
        fallback: options?.fallbackModel,
        skills: options?.resolvedSkills?.map(s => s.name),
        agents: options?.resolvedAgents?.map(a => a.id),
      },
      'litellm.query_started'
    );

    let stream: Awaited<ReturnType<typeof client.chat.completions.create>>;
    try {
      stream = await client.chat.completions.create(
        body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        { signal: options?.abortSignal }
      );
    } catch (err) {
      throw toProviderError(err);
    }

    if (deniedToolsIgnored) {
      yield {
        type: 'system' as const,
        content:
          '⚠️ LiteLLM does not support `denied_tools`. Only `allowed_tools` is forwarded ' +
          '— if your upstream provider offers a different tool gating mechanism, ' +
          'configure it on the provider directly.',
      };
    }

    try {
      yield* translateOpenAIStream(
        stream as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
        { model, expectsStructuredOutput }
      );
    } catch (err) {
      throw toProviderError(err);
    } finally {
      getLog().info({ model }, 'litellm.query_completed');
    }
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface BuildMessagesInput {
  systemPrompt?: string;
  userPrompt: string;
  resolvedSkills?: ResolvedSkillHandoff[];
  resolvedAgents?: ResolvedAgentHandoff[];
}

function buildMessages(
  input: BuildMessagesInput
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  const systemContent = buildResolvedSystemPrompt({
    systemPrompt: input.systemPrompt,
    resolvedSkills: input.resolvedSkills,
    resolvedAgents: input.resolvedAgents,
  });
  if (systemContent !== undefined) {
    messages.push({ role: 'system', content: systemContent });
  }
  messages.push({ role: 'user', content: input.userPrompt });
  return messages;
}

function defaultConfigPath(): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  return `${home}/.archon/litellm_config.yaml`;
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? err : undefined;

  // OpenAI SDK typed errors
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) {
      return new ProviderError('litellm', 'auth', message, cause);
    }
    if (status === 429) {
      return new ProviderError('litellm', 'rate_limit', message, cause);
    }
  }

  if (err instanceof Error && err.name === 'AbortError') {
    return new ProviderError('litellm', 'timeout', message, err);
  }

  return new ProviderError('litellm', 'unknown', message, cause);
}
