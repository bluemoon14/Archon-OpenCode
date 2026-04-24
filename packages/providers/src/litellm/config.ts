/**
 * LiteLLM provider config parsing.
 *
 * Accepts the raw `assistants.litellm.*` block from `.archon/config.yaml` and
 * returns a normalized, typed view. Defaults:
 *   - port: 4000
 *   - masterKeyEnv: LITELLM_MASTER_KEY
 *   - configPath: ~/.archon/litellm_config.yaml  (resolved by caller)
 */
import type { LiteLLMProviderDefaults } from '../types';

export interface ParsedLiteLLMConfig {
  model?: string;
  litellmBinaryPath?: string;
  baseUrl?: string;
  configPath?: string;
  port: number;
  masterKeyEnv: string;
  providers: Record<string, { authTokenEnv?: string; apiBaseEnv?: string }>;
}

/**
 * Defaults that cover the OOTB `archon setup` scaffolding.
 */
const DEFAULTS = {
  port: 4000,
  masterKeyEnv: 'LITELLM_MASTER_KEY',
} as const;

export function parseLiteLLMConfig(raw: unknown): ParsedLiteLLMConfig {
  const cfg = (raw ?? {}) as LiteLLMProviderDefaults;
  const out: ParsedLiteLLMConfig = {
    port: DEFAULTS.port,
    masterKeyEnv: DEFAULTS.masterKeyEnv,
    providers: {},
  };

  if (typeof cfg.model === 'string') out.model = cfg.model;
  if (typeof cfg.litellmBinaryPath === 'string') out.litellmBinaryPath = cfg.litellmBinaryPath;
  if (typeof cfg.baseUrl === 'string') out.baseUrl = cfg.baseUrl;
  if (typeof cfg.configPath === 'string') out.configPath = cfg.configPath;
  if (typeof cfg.port === 'number' && cfg.port > 0) out.port = cfg.port;
  if (typeof cfg.masterKeyEnv === 'string' && cfg.masterKeyEnv.length > 0) {
    out.masterKeyEnv = cfg.masterKeyEnv;
  }

  if (cfg.providers !== undefined && typeof cfg.providers === 'object') {
    for (const [providerId, entryRaw] of Object.entries(cfg.providers)) {
      if (entryRaw === null || typeof entryRaw !== 'object') continue;
      const entry = entryRaw as { authTokenEnv?: unknown; apiBaseEnv?: unknown };
      const norm: { authTokenEnv?: string; apiBaseEnv?: string } = {};
      if (typeof entry.authTokenEnv === 'string' && entry.authTokenEnv.length > 0) {
        norm.authTokenEnv = entry.authTokenEnv;
      }
      if (typeof entry.apiBaseEnv === 'string' && entry.apiBaseEnv.length > 0) {
        norm.apiBaseEnv = entry.apiBaseEnv;
      }
      out.providers[providerId] = norm;
    }
  }

  return out;
}

/**
 * Which model prefixes this provider claims in the registry's
 * `isModelCompatible` check. Order matters at call sites that iterate
 * multiple providers — see packages/providers/src/registry.ts.
 *
 * Kept as a constant (not a regex) so tests can assert the exact set and new
 * upstream providers get added intentionally, not silently.
 */
export const LITELLM_MODEL_PREFIXES = [
  // Anthropic routed through LiteLLM (vs. Claude SDK direct). Users who have
  // the `claude` binary installed should prefer bare `sonnet`/`opus`/`haiku`
  // shorthand for Claude SDK; `anthropic/...` explicitly routes via LiteLLM.
  'anthropic/',
  'openai/',
  'azure/',
  'azure_ai/',
  'novita/',
] as const;

export function isLiteLLMModel(model: string): boolean {
  if (!model) return false;
  return LITELLM_MODEL_PREFIXES.some(p => model.startsWith(p));
}
