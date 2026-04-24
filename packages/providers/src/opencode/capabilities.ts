import type { ProviderCapabilities } from '../types';

/**
 * OpenCode supports session resume, MCP servers, tool restrictions, structured
 * output (JSON schema), and env injection. Claude-specific features (hooks,
 * skills, inline sub-agents, extended thinking, effort budgets, cost caps,
 * fallback models, sandbox) are not exposed through the SDK today — declared
 * false so the executor emits capability warnings instead of silently ignoring.
 */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,
  mcp: true,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
