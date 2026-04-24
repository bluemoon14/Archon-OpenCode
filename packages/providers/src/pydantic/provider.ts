/**
 * Pydantic AI provider: BYO Python agent via JSONL stdio bridge.
 *
 * Selection: node YAML sets `provider: pydantic` + `agent: <name>`. The
 * `<name>` is looked up in `assistants.pydantic.agents.<name>.entry` which
 * points at a user-authored Python file exporting a module-level
 * `agent: pydantic_ai.Agent`. Archon spawns one bridge per sendQuery via
 * `uv run --script archon_pydantic_bridge.py -- <entry>`.
 *
 * Capabilities are narrow (see `./capabilities.ts`) — the user's agent owns
 * its tools, model, and system prompt. Archon forwards the prompt, captures
 * the stream, and reports tokens/structured output on completion.
 */
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { ProviderError } from '../errors';
import { createLogger } from '@archon/paths';
import { parsePydanticConfig, resolveAgentEntry } from './config';
import { resolveUvBinaryPath } from './python-resolver';
import { PydanticBridge, defaultBridgeScriptPath, envelopeToMessageChunk } from './bridge-client';
import { PYDANTIC_CAPABILITIES } from './capabilities';
import { randomUUID } from 'node:crypto';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.pydantic');
  return cachedLog;
}

export class PydanticProvider implements IAgentProvider {
  getType(): string {
    return 'pydantic';
  }

  getCapabilities(): ProviderCapabilities {
    return PYDANTIC_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    _resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const cfg = parsePydanticConfig(options?.assistantConfig);
    const agentName = options?.nodeConfig?.agent;

    // Throws ProviderError('pydantic','agent_import_error', …) on missing name
    // or unresolved path.
    const agentEntryPath = resolveAgentEntry(cwd, agentName, cfg);
    const uvBinaryPath = resolveUvBinaryPath(cfg.uvBinaryPath);
    const bridgeScriptPath = defaultBridgeScriptPath();

    getLog().info({ agentName, agentEntryPath, uvBinaryPath }, 'pydantic.bridge_starting');

    const bridge = new PydanticBridge({
      uvBinaryPath,
      bridgeScriptPath,
      agentEntryPath,
      cwd,
      env: options?.env,
      // First-event timeout: uv cold-start can take 30s+ on first install,
      // and the user's agent may pull heavy deps. Keep this generous.
      readyTimeoutMs: 120_000,
    });

    // bridge.start() throws ProviderError directly; no wrapper needed.
    await bridge.start();

    const queryId = randomUUID();

    // Wire the abort signal: translate it to an in-band abort envelope, then
    // fall back to SIGTERM via shutdown() in the finally clause.
    const abortListener = (): void => {
      bridge.abort(queryId);
    };
    options?.abortSignal?.addEventListener('abort', abortListener);

    try {
      for await (const envelope of bridge.sendQuery(queryId, prompt, cwd, options?.env)) {
        if (envelope.kind === 'error') {
          const code = typeof envelope.code === 'string' ? envelope.code : 'unknown';
          const message =
            typeof envelope.message === 'string' ? envelope.message : 'pydantic agent failed';
          throw new ProviderError(
            'pydantic',
            code === 'agent_import_error'
              ? 'agent_import_error'
              : code === 'agent_runtime_error'
                ? 'agent_runtime_error'
                : 'unknown',
            message
          );
        }
        const chunk = envelopeToMessageChunk(envelope);
        if (chunk) yield chunk;
      }
    } finally {
      options?.abortSignal?.removeEventListener('abort', abortListener);
      await bridge.shutdown();
    }
  }
}
