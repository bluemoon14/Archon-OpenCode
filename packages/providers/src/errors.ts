/**
 * Standardized error for unknown provider types.
 * Thrown by getAgentProvider() — all surfaces (CLI, server, orchestrator, workflows)
 * get the same error shape and message format.
 */
export class UnknownProviderError extends Error {
  constructor(
    public readonly requestedProvider: string,
    public readonly registeredProviders: string[]
  ) {
    super(`Unknown provider: '${requestedProvider}'. Available: ${registeredProviders.join(', ')}`);
    this.name = 'UnknownProviderError';
  }
}

/**
 * Normalized failure codes across providers. `error-formatter.ts` dispatches
 * on these to produce actionable, provider-aware messages.
 */
export type ProviderErrorCode =
  | 'binary_not_found'
  | 'subprocess_crash'
  | 'port_in_use'
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'agent_import_error'
  | 'agent_runtime_error'
  | 'unknown';

/**
 * Thrown by provider implementations on fatal paths. Carries the provider ID
 * and a normalized code so downstream formatters can render install hints,
 * auth prompts, or retry guidance without stringly-typed pattern matching
 * against upstream SDK messages.
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    message: string,
    public readonly cause?: Error
  ) {
    super(`[provider:${provider}] ${code}: ${message}`);
    this.name = 'ProviderError';
  }
}
