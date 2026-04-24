/**
 * Provider Registry
 *
 * Built-ins: Claude (Anthropic), OpenCode (spawned `opencode serve`), and
 * Pydantic AI (BYO Python agent over a JSONL stdio bridge). Third-party
 * providers register via `registerProvider()` before any lookups.
 *
 * Bootstrap: callers must call registerBuiltinProviders() at process
 * entrypoints (CLI init) before any provider lookups.
 */
import type {
  IAgentProvider,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
} from './types';
import { ClaudeProvider } from './claude/provider';
import { CLAUDE_CAPABILITIES } from './claude/capabilities';
import { OpenCodeProvider } from './opencode/provider';
import { OPENCODE_CAPABILITIES } from './opencode/capabilities';
import { PydanticProvider } from './pydantic/provider';
import { PYDANTIC_CAPABILITIES } from './pydantic/capabilities';
import { LiteLLMProvider } from './litellm/provider';
import { LITELLM_CAPABILITIES } from './litellm/capabilities';
import { isLiteLLMModel } from './litellm/config';
import { UnknownProviderError } from './errors';
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.registry');
  return cachedLog;
}

/** Backing store for registered providers. */
const registry = new Map<string, ProviderRegistration>();

/**
 * Register a provider. Throws on duplicate registration.
 */
export function registerProvider(entry: ProviderRegistration): void {
  if (registry.has(entry.id)) {
    throw new Error(`Provider '${entry.id}' is already registered`);
  }
  registry.set(entry.id, entry);
  getLog().debug({ provider: entry.id, builtIn: entry.builtIn }, 'provider.registered');
}

/**
 * Get an instantiated agent provider by ID.
 * @throws UnknownProviderError if not registered
 */
export function getAgentProvider(id: string): IAgentProvider {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  getLog().debug({ provider: id }, 'provider_selected');
  return entry.factory();
}

/**
 * Get the full registration entry for a provider.
 * @throws UnknownProviderError if not registered
 */
export function getRegistration(id: string): ProviderRegistration {
  const entry = registry.get(id);
  if (!entry) {
    throw new UnknownProviderError(id, [...registry.keys()]);
  }
  return entry;
}

/**
 * Get provider capabilities without instantiating a provider.
 * @throws UnknownProviderError if not registered
 */
export function getProviderCapabilities(id: string): ProviderCapabilities {
  return getRegistration(id).capabilities;
}

/**
 * Get all registered providers.
 */
export function getRegisteredProviders(): ProviderRegistration[] {
  return [...registry.values()];
}

/**
 * Get API-safe provider info (excludes factory and isModelCompatible).
 */
export function getProviderInfoList(): ProviderInfo[] {
  return getRegisteredProviders().map(({ id, displayName, capabilities, builtIn }) => ({
    id,
    displayName,
    capabilities,
    builtIn,
  }));
}

/**
 * Check if a provider is registered.
 */
export function isRegisteredProvider(id: string): boolean {
  return registry.has(id);
}

/**
 * Register built-in providers. Idempotent — skips already-registered IDs.
 * Must be called at process entrypoints (server, CLI) before any provider lookups.
 */
export function registerBuiltinProviders(): void {
  const builtins: ProviderRegistration[] = [
    {
      id: 'claude',
      displayName: 'Claude (Anthropic)',
      factory: () => new ClaudeProvider(),
      capabilities: CLAUDE_CAPABILITIES,
      isModelCompatible: (model: string): boolean => {
        const aliases = ['sonnet', 'opus', 'haiku'];
        return aliases.includes(model) || model.startsWith('claude-') || model === 'inherit';
      },
      builtIn: true,
    },
    {
      id: 'litellm',
      displayName: 'LiteLLM (proxy)',
      factory: () => new LiteLLMProvider(),
      capabilities: LITELLM_CAPABILITIES,
      // Claim the canonical LiteLLM upstream prefixes: anthropic/, openai/,
      // azure/, azure_ai/, novita/. See ./litellm/config.ts for the full list.
      //
      // `anthropic/*` routing: both Claude and LiteLLM accept these prefixes.
      // inferProviderFromModel() returns the FIRST built-in match and Claude
      // is registered first — so Claude SDK wins by default (which matches the
      // "prefer Claude SDK when the binary is installed" guidance). Users who
      // want to force LiteLLM routing set `provider: litellm` on the workflow
      // node, overriding the inference.
      isModelCompatible: (model: string): boolean => isLiteLLMModel(model),
      builtIn: true,
    },
    {
      id: 'opencode',
      displayName: 'OpenCode',
      factory: () => new OpenCodeProvider(),
      capabilities: OPENCODE_CAPABILITIES,
      isModelCompatible: (model: string): boolean => {
        // Explicit opencode/ prefix is the inference hint. Anthropic-native
        // aliases (sonnet/opus/haiku) and bare claude-* stay reserved so the
        // Claude provider wins by default. LiteLLM's prefixes (anthropic/,
        // openai/, azure/, azure_ai/, novita/) are also reserved so LiteLLM
        // claims them. Otherwise we accept any `providerID/modelID` shape
        // (OpenCode fronts many upstreams).
        if (!model) return false;
        if (model.startsWith('opencode/')) return true;
        if (['sonnet', 'opus', 'haiku'].includes(model)) return false;
        if (model.startsWith('claude-') || model === 'inherit') return false;
        if (isLiteLLMModel(model)) return false;
        return /^[a-z][a-z0-9_-]*\/.+/i.test(model);
      },
      builtIn: true,
    },
    {
      id: 'pydantic',
      displayName: 'Pydantic AI (BYO)',
      factory: () => new PydanticProvider(),
      capabilities: PYDANTIC_CAPABILITIES,
      // Selection must be explicit via `provider: pydantic` + `agent: <name>`.
      // No model-name routing — Pydantic agents pick their own upstream.
      isModelCompatible: (): boolean => false,
      builtIn: true,
    },
  ];

  for (const entry of builtins) {
    if (!registry.has(entry.id)) {
      registry.set(entry.id, entry);
      getLog().debug({ provider: entry.id }, 'builtin_provider.registered');
    }
  }
}

/** @internal Test-only — clears the registry. Not for production use. */
export function clearRegistry(): void {
  registry.clear();
}
