/**
 * LiteLLM agent provider — STUB.
 *
 * Scaffolding committed ahead of the full implementation so the provider can
 * register in the built-in registry and claim its model prefixes (see
 * registry.ts + ./config.ts LITELLM_MODEL_PREFIXES). This unblocks the
 * model-routing layer: workflows referencing `openai/gpt-4o`, `azure_ai/...`,
 * `novita/...`, or `anthropic/...` (when Claude SDK isn't preferred) can be
 * parsed and validated without the sendQuery runtime yet shipping.
 *
 * Remaining work (tracked on the integration plan):
 *   - Spawn + ref-count the `litellm` proxy subprocess (OpenCode pattern in
 *     provider.ts:52-104 is the closest analog).
 *   - Translate OpenAI chat/completions stream → MessageChunk union.
 *   - Wire `assistants.litellm.baseUrl` as the escape-hatch for externally
 *     managed proxies.
 *   - Honor `options.fallbackModel` via per-request `fallbacks:` param.
 *
 * Until sendQuery is implemented, invoking a LiteLLM-routed node throws a
 * clear `not_yet_implemented` error — the registry still honors the
 * isModelCompatible contract so schema validation / routing works.
 */
import type {
  IAgentProvider,
  MessageChunk,
  ProviderCapabilities,
  SendQueryOptions,
} from '../types';
import { ProviderError } from '../errors';
import { LITELLM_CAPABILITIES } from './capabilities';

export class LiteLLMProvider implements IAgentProvider {
  getType(): string {
    return 'litellm';
  }

  getCapabilities(): ProviderCapabilities {
    return LITELLM_CAPABILITIES;
  }

  // eslint-disable-next-line require-yield
  async *sendQuery(
    _prompt: string,
    _cwd: string,
    _resumeSessionId?: string,
    _options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    throw new ProviderError(
      'litellm',
      'subprocess_crash',
      'LiteLLM provider runtime not yet implemented. Scaffolding only — model ' +
        'routing + isModelCompatible work, but sendQuery will land in a follow-up. ' +
        "See ~/.claude/plans/resilient-coalescing-hickey.md §C ('Increment 3b')."
    );
  }
}
