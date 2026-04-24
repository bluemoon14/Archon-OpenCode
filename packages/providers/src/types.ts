// CONTRACT LAYER — no SDK imports, no runtime deps.
// @archon/workflows and @archon/core import from this subpath (@archon/providers/types).
// HARD RULE: This file must never import SDK packages or other @archon/* packages.

// ─── Provider Config Defaults ──────────────────────────────────────────────
// Canonical definitions — @archon/core/config/config-types.ts imports from here.
// Single source of truth for provider-specific config shapes.

export interface ClaudeProviderDefaults {
  [key: string]: unknown;
  model?: string;
  /** Claude Code settingSources — controls which CLAUDE.md files are loaded.
   *  @default ['project']
   */
  settingSources?: ('project' | 'user')[];
  /** Absolute path to the Claude Code SDK's `cli.js`. Required in compiled
   *  Archon builds when `CLAUDE_BIN_PATH` is not set; optional in dev mode
   *  (SDK resolves from node_modules). */
  claudeBinaryPath?: string;
}

export interface OpenCodeProviderDefaults {
  [key: string]: unknown;
  model?: string;
  /** Absolute path to the `opencode` binary. Required in compiled Archon
   *  builds when `OPENCODE_BIN_PATH` is not set; optional in dev mode where
   *  autodetection covers the common install locations. */
  opencodeBinaryPath?: string;
  /** Escape hatch: point at an externally-managed `opencode serve` instance.
   *  When set, Archon does NOT spawn a child process and treats the URL as
   *  the SDK base URL. */
  baseUrl?: string;
  /** Per-upstream-provider credentials passed through to `opencode serve` at
   *  spawn time. Values are env-var NAMES (e.g. `OPENAI_API_KEY`), not the
   *  secrets themselves — no secrets in YAML. */
  providers?: Record<string, { authTokenEnv?: string }>;
}

export interface PydanticProviderDefaults {
  [key: string]: unknown;
  /** Absolute path to the `uv` binary (https://docs.astral.sh/uv). Required
   *  in compiled builds when `UV_BIN_PATH` is not set; optional in dev mode. */
  uvBinaryPath?: string;
  /** Directory (relative to repo root) scanned for agent entry files.
   *  @default '.archon/agents' */
  agentsDir?: string;
  /** Named Pydantic AI agents, each pointing at a user-authored Python file
   *  that exports an `agent: pydantic_ai.Agent`. Selected per-node via the
   *  `agent:` field on workflow YAML. */
  agents?: Record<string, { entry: string; deps?: string[] }>;
}

/**
 * LiteLLM provider defaults. LiteLLM runs as an external OpenAI-compatible
 * proxy (https://docs.litellm.ai/docs/simple_proxy). Archon points the OpenAI
 * SDK at it and routes canonical `provider/model` names to the configured
 * upstream list (Anthropic, OpenAI, Azure AI Foundry, Novita, ...).
 */
export interface LiteLLMProviderDefaults {
  [key: string]: unknown;
  /** Default model string when a node/workflow does not specify one. Should
   *  follow LiteLLM canonical form — e.g. `openai/gpt-4o`, `anthropic/claude-
   *  sonnet-4-5`, `azure_ai/claude-sonnet-4-5`, `novita/meta-llama/...`. */
  model?: string;
  /** Absolute path to the `litellm` binary (used when Archon spawns its own
   *  proxy). Optional in dev mode (PATH lookup handles common install paths). */
  litellmBinaryPath?: string;
  /** Escape hatch: point at an externally-managed LiteLLM proxy. When set,
   *  Archon does NOT spawn a subprocess and uses this URL as the OpenAI SDK
   *  base URL. Should include the `/v1` suffix only if your proxy requires it
   *  (the OpenAI SDK appends `/chat/completions` etc. automatically). */
  baseUrl?: string;
  /** Absolute path to the proxy's `litellm_config.yaml` (the `model_list`
   *  declaration). Default: `~/.archon/litellm_config.yaml`. */
  configPath?: string;
  /** TCP port for the spawned proxy. Default: 4000. */
  port?: number;
  /** Env var NAME that holds the master key used to authenticate against the
   *  proxy. Default: `LITELLM_MASTER_KEY`. Values are never stored in YAML —
   *  only the variable name is. */
  masterKeyEnv?: string;
  /** Per-upstream-provider credential mapping. Values are env var NAMES that
   *  hold each upstream's API key / base URL. Archon ensures they're present
   *  in the proxy's environment before spawning. */
  providers?: Record<
    string,
    {
      authTokenEnv?: string;
      apiBaseEnv?: string;
    }
  >;
}

/** Generic per-provider defaults bag used by config surfaces and UI. */
export type ProviderDefaults = Record<string, unknown>;

/** Provider-keyed defaults map. Built-ins may refine individual entries. */
export type ProviderDefaultsMap = Record<string, ProviderDefaults>;

/**
 * Token usage statistics from AI provider responses.
 */
export interface TokenUsage {
  input: number;
  output: number;
  total?: number;
  cost?: number;
}

/**
 * Message chunk from AI assistant.
 * Discriminated union with per-type required fields for type safety.
 */
export type MessageChunk =
  | {
      type: 'assistant';
      content: string;
      /** When true, batch-mode adapters flush pending content and this chunk
       *  to the platform immediately. */
      flush?: boolean;
    }
  | { type: 'system'; content: string }
  | { type: 'thinking'; content: string }
  | {
      type: 'result';
      sessionId?: string;
      tokens?: TokenUsage;
      structuredOutput?: unknown;
      isError?: boolean;
      errorSubtype?: string;
      /** SDK-provided error detail strings. Populated when isError is true. */
      errors?: string[];
      cost?: number;
      stopReason?: string;
      numTurns?: number;
      modelUsage?: Record<string, unknown>;
    }
  | { type: 'rate_limit'; rateLimitInfo: Record<string, unknown> }
  | {
      type: 'tool';
      toolName: string;
      toolInput?: Record<string, unknown>;
      /** Stable per-call ID from the underlying SDK (e.g. Claude `tool_use_id`).
       *  When present, the platform adapter uses it directly instead of generating
       *  one — guarantees `tool_call`/`tool_result` pair correctly even when
       *  multiple tools with the same name run concurrently. */
      toolCallId?: string;
    }
  | {
      type: 'tool_result';
      toolName: string;
      toolOutput: string;
      /** Matching ID for the originating `tool` chunk. See `tool` variant above. */
      toolCallId?: string;
    }
  | { type: 'workflow_dispatch'; workerConversationId: string; workflowName: string };

/**
 * Universal request options accepted by all providers.
 * Provider-specific fields go through `nodeConfig` and `assistantConfig` in SendQueryOptions.
 */
export interface AgentRequestOptions {
  model?: string;
  abortSignal?: AbortSignal;
  systemPrompt?: string;
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  env?: Record<string, string>;
  maxBudgetUsd?: number;
  fallbackModel?: string;
  /** Session fork flag — when true, copies prior session history before appending. */
  forkSession?: boolean;
  /** When false, skip writing session transcript to disk. */
  persistSession?: boolean;
}

/**
 * Raw node configuration from workflow YAML.
 * Providers translate fields they understand; unknown fields are ignored.
 */
export interface NodeConfig {
  mcp?: string;
  hooks?: unknown;
  skills?: string[];
  /**
   * Inline sub-agent definitions (keyed by kebab-case agent ID).
   *
   * Intentional hand-written duplicate of `agentDefinitionSchema` (authoritative
   * source: `@archon/workflows/schemas/dag-node`). Normally we follow the
   * project rule "derive types from Zod via `z.infer`, never write parallel
   * interfaces" — broken here on purpose: `@archon/providers/types` is the
   * contract subpath consumed by `@archon/workflows`, so importing from
   * `@archon/workflows` would create a circular dependency.
   *
   * Drift risk: when the schema gains a field, this shape must be updated
   * by hand. Follow-up work: extract the agent-definition contract to a
   * lower-tier package so `z.infer` can be used end-to-end (#1276).
   */
  agents?: Record<
    string,
    {
      description: string;
      prompt: string;
      model?: string;
      tools?: string[];
      disallowedTools?: string[];
      skills?: string[];
      maxTurns?: number;
    }
  >;
  allowed_tools?: string[];
  denied_tools?: string[];
  effort?: string;
  thinking?: unknown;
  sandbox?: unknown;
  betas?: string[];
  output_format?: Record<string, unknown>;
  maxBudgetUsd?: number;
  systemPrompt?: string;
  fallbackModel?: string;
  idle_timeout?: number;
  /** Named provider-scoped selector. Today only Pydantic AI uses it: the
   *  value names a pre-configured agent under `assistants.pydantic.agents`.
   *  Schema-level validator requires `provider: pydantic` when present. */
  agent?: string;
  [key: string]: unknown;
}

/**
 * Skill content pre-loaded by Archon's SkillAgentRegistry and handed to the
 * provider as a ready-to-use system-prompt contribution. Providers should
 * inject `body` as instruction for the owning agent rather than expecting the
 * underlying SDK to look up the skill by name. `model` is already resolved
 * through the 8-tier precedence — no further resolution needed.
 *
 * When `resolvedSkills` is empty or absent, providers fall back to the raw
 * `nodeConfig.skills: string[]` array (SDK-native lookup for Claude, no-op
 * for OpenCode/Pydantic). This preserves back-compat with `~/.claude/skills/`.
 */
export interface ResolvedSkillHandoff {
  name: string;
  description: string;
  body: string;
  /** Final model string (LiteLLM canonical, Claude shorthand, or alias). */
  model: string;
}

/**
 * Agent content merged by the DAG executor from the SkillAgentRegistry +
 * inline workflow-YAML override. Providers treat this as authoritative and
 * install it in their SDK's agent slot. Inline overrides (from
 * `nodeConfig.agents[id]`) have already won over registry defaults — no
 * further merging on the provider side.
 */
export interface ResolvedAgentHandoff {
  /** The key used under `nodeConfig.agents` — provider's SDK agent slot name. */
  id: string;
  description: string;
  prompt: string;
  model: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  maxTurns?: number;
}

/**
 * Extended options for sendQuery, adding workflow-specific context.
 * The orchestrator path uses base AgentRequestOptions fields only.
 * The workflow path additionally passes nodeConfig and assistantConfig.
 */
export interface SendQueryOptions extends AgentRequestOptions {
  /** Raw YAML node config — provider translates internally to SDK-specific options. */
  nodeConfig?: NodeConfig;
  /** Per-provider defaults from .archon/config.yaml assistants section. */
  assistantConfig?: Record<string, unknown>;
  /**
   * Pre-resolved skill content from Archon's SkillAgentRegistry. When present,
   * providers use these bodies directly instead of relying on SDK-side lookup.
   * Populated by the DAG executor when a skill-agent registry is configured.
   */
  resolvedSkills?: ResolvedSkillHandoff[];
  /** Pre-resolved agent content with registry defaults + inline overrides merged. */
  resolvedAgents?: ResolvedAgentHandoff[];
}

/**
 * Provider capability flags. The dag-executor uses these for capability warnings
 * when a node specifies features the target provider doesn't support.
 */
export interface ProviderCapabilities {
  sessionResume: boolean;
  mcp: boolean;
  hooks: boolean;
  skills: boolean;
  /** Whether the provider supports inline sub-agent definitions (Claude SDK's options.agents). */
  agents: boolean;
  toolRestrictions: boolean;
  structuredOutput: boolean;
  envInjection: boolean;
  costControl: boolean;
  effortControl: boolean;
  thinkingControl: boolean;
  fallbackModel: boolean;
  sandbox: boolean;
}

/**
 * Registration entry for a provider in the provider registry.
 * Each entry carries metadata, a factory, and model-compatibility logic.
 * The registry is the source of truth for provider identity, capabilities, and display.
 */
export interface ProviderRegistration {
  /** Unique provider identifier — used in YAML, config, DB */
  id: string;

  /** Human-readable name for UI display */
  displayName: string;

  /** Instantiate a provider */
  factory: () => IAgentProvider;

  /** Static capability declaration — used for dag-executor warnings */
  capabilities: ProviderCapabilities;

  /**
   * Model compatibility check. Returns true if the model string
   * is valid for this provider. Used by workflow validation and
   * provider inference from model names.
   */
  isModelCompatible: (model: string) => boolean;

  /** Whether this is a built-in (maintained by core team) or community provider */
  builtIn: boolean;
}

/**
 * API-safe projection of ProviderRegistration (excludes non-serializable fields).
 * Used by GET /api/providers and consumed by the Web UI.
 */
export interface ProviderInfo {
  id: string;
  displayName: string;
  capabilities: ProviderCapabilities;
  builtIn: boolean;
}

/**
 * Generic agent provider interface. Built-ins: Claude, OpenCode, Pydantic AI.
 */
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk>;

  getType(): string;

  getCapabilities(): ProviderCapabilities;
}
