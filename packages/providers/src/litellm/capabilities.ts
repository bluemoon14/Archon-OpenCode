/**
 * Capability declaration for the LiteLLM provider.
 *
 * LiteLLM proxies OpenAI-compatible chat completions (and Responses API) to
 * every upstream it supports. From Archon's perspective it's a flat
 * translator: it speaks the OpenAI wire format, so features Claude SDK
 * exposes (`skills`, `agents`, `hooks`, MCP, thinking, effort, sandbox,
 * extended-thinking blocks, etc.) are not natively available. Skills and
 * agents are still usable on LiteLLM nodes — they're delivered as
 * system-prompt content via `resolvedSkills` / `resolvedAgents`, which is
 * handled at the executor level, not by this provider. Hence `skills` and
 * `agents` stay `false` in the capability matrix: this provider doesn't
 * implement the SDK-native path.
 */
import type { ProviderCapabilities } from '../types';

export const LITELLM_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false, // LiteLLM proxy is stateless — Archon manages history
  mcp: false,
  hooks: false,
  skills: false,
  agents: false,
  toolRestrictions: true, // OpenAI tool_choice/function allow-listing
  structuredOutput: true, // OpenAI response_format + JSON schema support
  envInjection: true,
  costControl: false, // LiteLLM tracks cost internally; per-request max cost TBD
  effortControl: false,
  thinkingControl: false,
  fallbackModel: true, // per-request "fallbacks" field routes to alt model_list entries
  sandbox: false,
};
