import type { ProviderCapabilities } from '../types';

/**
 * Pydantic AI's Archon integration is BYO-agent: the user writes a Python
 * file exporting `agent: pydantic_ai.Agent`, and Archon invokes it via a
 * stdio bridge. The user's agent owns its own tool set, model selection,
 * system prompt, and state — so most per-node Archon knobs have no meaning
 * here. Structured output is the one feature we can always forward since
 * Pydantic AI shapes outputs into typed objects by design.
 */
export const PYDANTIC_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: false,
  structuredOutput: true,
  envInjection: true,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
