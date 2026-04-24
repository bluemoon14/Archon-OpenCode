import type { OpenCodeProviderDefaults } from '../types';

/**
 * Defensive parser for the `assistants.opencode` config block.
 *
 * Mirrors `parseClaudeConfig` in shape: unknown fields are dropped, bad types
 * are ignored with a silent fallback to defaults. Invalid config never throws
 * — the workflow executor surfaces missing-binary / server-start failures
 * with classified errors instead.
 */
export function parseOpenCodeConfig(raw: unknown): OpenCodeProviderDefaults {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const out: OpenCodeProviderDefaults = {};

  if (typeof obj.model === 'string' && obj.model.trim()) {
    out.model = obj.model.trim();
  }

  if (typeof obj.opencodeBinaryPath === 'string' && obj.opencodeBinaryPath.trim()) {
    out.opencodeBinaryPath = obj.opencodeBinaryPath.trim();
  }

  if (typeof obj.baseUrl === 'string' && obj.baseUrl.trim()) {
    out.baseUrl = obj.baseUrl.trim();
  }

  if (obj.providers && typeof obj.providers === 'object' && !Array.isArray(obj.providers)) {
    const providers: Record<string, { authTokenEnv?: string }> = {};
    for (const [id, entry] of Object.entries(obj.providers as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.authTokenEnv === 'string' && e.authTokenEnv.trim()) {
        providers[id] = { authTokenEnv: e.authTokenEnv.trim() };
      }
    }
    if (Object.keys(providers).length > 0) out.providers = providers;
  }

  return out;
}

/**
 * Parse a model string in OpenCode's `providerID/modelID` form. Accepts
 * optional leading `opencode/` prefix that inferProviderFromModel uses as a
 * routing hint; strips it before parsing. Returns undefined for malformed
 * input — caller falls back to OpenCode's server-side default.
 */
export function parseOpenCodeModel(
  model: string | undefined
): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const stripped = model.startsWith('opencode/') ? model.slice('opencode/'.length) : model;
  const slash = stripped.indexOf('/');
  if (slash <= 0 || slash === stripped.length - 1) return undefined;
  return {
    providerID: stripped.slice(0, slash),
    modelID: stripped.slice(slash + 1),
  };
}

/**
 * Resolve authTokenEnv references in the config to concrete env-var values.
 * Returns a plain env dict suitable for merging into spawn env. Skips entries
 * whose referenced env var is unset — missing upstream creds are OpenCode's
 * problem to surface, not ours to paper over.
 */
export function resolveOpencodeAuthEnv(cfg: OpenCodeProviderDefaults): Record<string, string> {
  if (!cfg.providers) return {};
  const env: Record<string, string> = {};
  for (const entry of Object.values(cfg.providers)) {
    const name = entry?.authTokenEnv;
    if (!name) continue;
    const val = process.env[name];
    if (typeof val === 'string' && val.length > 0) {
      env[name] = val;
    }
  }
  return env;
}
