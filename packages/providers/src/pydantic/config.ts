import { isAbsolute, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { PydanticProviderDefaults } from '../types';
import { ProviderError } from '../errors';

/**
 * Defensive parser for the `assistants.pydantic` config block. Unknown fields
 * are dropped; invalid shapes fall back to defaults. Missing-agent errors are
 * raised later, by `resolveAgentEntry`, so config loading itself never throws.
 */
export function parsePydanticConfig(raw: unknown): PydanticProviderDefaults {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  const out: PydanticProviderDefaults = {};

  if (typeof obj.uvBinaryPath === 'string' && obj.uvBinaryPath.trim()) {
    out.uvBinaryPath = obj.uvBinaryPath.trim();
  }

  if (typeof obj.agentsDir === 'string' && obj.agentsDir.trim()) {
    out.agentsDir = obj.agentsDir.trim();
  }

  if (obj.agents && typeof obj.agents === 'object' && !Array.isArray(obj.agents)) {
    const agents: Record<string, { entry: string; deps?: string[] }> = {};
    for (const [name, entry] of Object.entries(obj.agents as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      if (typeof e.entry !== 'string' || !e.entry.trim()) continue;
      const agentEntry: { entry: string; deps?: string[] } = { entry: e.entry.trim() };
      if (Array.isArray(e.deps) && e.deps.every(d => typeof d === 'string')) {
        agentEntry.deps = e.deps;
      }
      agents[name] = agentEntry;
    }
    if (Object.keys(agents).length > 0) out.agents = agents;
  }

  return out;
}

/**
 * Resolve a configured agent name to an absolute .py path. Relative `entry`
 * paths are anchored at `cwd` (repo root for workflow runs). Missing agent
 * names or missing files throw ProviderError so the provider surfaces a
 * clean, classified error to the user.
 */
export function resolveAgentEntry(
  cwd: string,
  agentName: string | undefined,
  cfg: PydanticProviderDefaults
): string {
  if (!agentName?.trim()) {
    throw new ProviderError(
      'pydantic',
      'agent_import_error',
      "Pydantic nodes require an 'agent:' field naming a configured agent"
    );
  }
  const entry = cfg.agents?.[agentName];
  if (!entry) {
    const registered = Object.keys(cfg.agents ?? {});
    throw new ProviderError(
      'pydantic',
      'agent_import_error',
      `Agent '${agentName}' is not configured. Add it under assistants.pydantic.agents.${agentName}.entry in .archon/config.yaml. ` +
        `Registered agents: ${registered.length > 0 ? registered.join(', ') : '(none)'}`
    );
  }
  const path = isAbsolute(entry.entry) ? entry.entry : resolve(cwd, entry.entry);
  if (!existsSync(path)) {
    throw new ProviderError(
      'pydantic',
      'agent_import_error',
      `Agent '${agentName}' entry file not found at ${path}`
    );
  }
  return path;
}
