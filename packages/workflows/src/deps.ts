/**
 * Workflow dependency injection types.
 *
 * Defines narrow interfaces for what the workflow engine needs from external systems.
 * Callers in @archon/core satisfy these structurally — no adapter wrappers needed.
 *
 * Provider types are imported directly from @archon/providers/types (contract layer).
 * No more mirror copies — single source of truth for IAgentProvider, MessageChunk, etc.
 */
import type { IWorkflowStore } from './store';
import type {
  IAgentProvider,
  MessageChunk,
  TokenUsage,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaultsMap,
  ProviderCapabilities,
} from '@archon/providers/types';
import type { ResolvedSkill, ResolvedAgent, ModelsFile } from './schemas';

// Re-export provider types so existing workflow engine consumers don't break
export type {
  IAgentProvider,
  MessageChunk,
  TokenUsage,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaultsMap,
  ProviderCapabilities,
};

// Backwards compat alias — deprecated, prefer direct import from @archon/providers/types
export type WorkflowTokenUsage = TokenUsage;

// ---------------------------------------------------------------------------
// Platform-specific types (NOT mirrors — unique to workflow engine)
// ---------------------------------------------------------------------------

export interface WorkflowMessageMetadata {
  category?:
    | 'tool_call_formatted'
    | 'workflow_status'
    | 'workflow_dispatch_status'
    | 'isolation_context'
    | 'workflow_result';
  segment?: 'new' | 'auto';
  workflowDispatch?: { workerConversationId: string; workflowName: string };
  workflowResult?: { workflowName: string; runId: string };
}

// ---------------------------------------------------------------------------
// Narrow platform interface (subset of IPlatformAdapter)
// ---------------------------------------------------------------------------

export interface IWorkflowPlatform {
  sendMessage(
    conversationId: string,
    message: string,
    metadata?: WorkflowMessageMetadata
  ): Promise<void>;
  getStreamingMode(): 'stream' | 'batch';
  getPlatformType(): string;
  sendStructuredEvent?(conversationId: string, event: MessageChunk): Promise<void>;
  emitRetract?(conversationId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Narrow config interface (subset of MergedConfig)
// ---------------------------------------------------------------------------

export interface WorkflowConfig {
  /** Default assistant provider (validated against provider registry at runtime) */
  assistant: string;
  baseBranch?: string;
  docsPath?: string;
  envVars?: Record<string, string>;
  commands: { folder?: string };
  defaults?: {
    loadDefaultWorkflows?: boolean;
    loadDefaultCommands?: boolean;
  };
  // Intersection: generic map for third-party providers + typed built-in entries.
  assistants: ProviderDefaultsMap & {
    claude: {
      model?: string;
      settingSources?: ('project' | 'user')[];
    };
    opencode: {
      model?: string;
      opencodeBinaryPath?: string;
      baseUrl?: string;
      providers?: Record<string, { authTokenEnv?: string }>;
    };
    pydantic: {
      uvBinaryPath?: string;
      agentsDir?: string;
      agents?: Record<string, { entry: string; deps?: string[] }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Agent provider factory type
// ---------------------------------------------------------------------------

export type AgentProviderFactory = (provider: string) => IAgentProvider;

// ---------------------------------------------------------------------------
// Skill + agent content registry (runtime-agnostic content surface)
// ---------------------------------------------------------------------------

/**
 * Loaded skill/agent content the executor passes to any runtime. `model` is the
 * frontmatter hint only — the real winning model is computed by the resolver
 * using this value as one of eight tiers.
 */
export interface SkillAgentSummary {
  name: string;
  source: 'project' | 'global' | 'bundled';
}

/**
 * Content registry abstracting over the three source tiers (bundled, global,
 * project). Populated by @archon/core's config loader once loaders are wired
 * up, and injected into the workflow engine via `WorkflowDeps`.
 */
export interface SkillAgentRegistry {
  loadSkill(name: string): Promise<ResolvedSkill>;
  listSkills(): Promise<SkillAgentSummary[]>;
  loadAgent(name: string): Promise<ResolvedAgent>;
  listAgents(): Promise<SkillAgentSummary[]>;
  /** Merged models.yaml stacks — bundled/global/project — for the resolver. */
  modelsFiles(): { bundled?: ModelsFile; global?: ModelsFile; project?: ModelsFile };
}

// ---------------------------------------------------------------------------
// WorkflowDeps — the single injection point
// ---------------------------------------------------------------------------

export interface WorkflowDeps {
  store: IWorkflowStore;
  getAgentProvider: AgentProviderFactory;
  loadConfig: (cwd: string) => Promise<WorkflowConfig>;
  /**
   * Optional content registry. Undefined during the transition (Increment 1b
   * lands the interface, later increments populate it). When present, the
   * executor uses it to resolve `skills:` and `agents:` references on any
   * runtime — not just Claude SDK.
   */
  skillAgentRegistry?: SkillAgentRegistry;
}
