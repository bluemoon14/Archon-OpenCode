// Types (contract layer — re-exported for convenience)
export type {
  IAgentProvider,
  AgentRequestOptions,
  SendQueryOptions,
  NodeConfig,
  ProviderDefaults,
  ProviderDefaultsMap,
  ProviderCapabilities,
  ProviderRegistration,
  ProviderInfo,
  MessageChunk,
  TokenUsage,
  ResolvedSkillHandoff,
  ResolvedAgentHandoff,
} from './types';

// Registry
export {
  registerProvider,
  getAgentProvider,
  getRegistration,
  getProviderCapabilities,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  registerBuiltinProviders,
  clearRegistry,
} from './registry';

// Error
export { UnknownProviderError, ProviderError, type ProviderErrorCode } from './errors';

// Provider classes
export { ClaudeProvider } from './claude/provider';
export { OpenCodeProvider } from './opencode/provider';
export { PydanticProvider } from './pydantic/provider';

// Config parsers
export { parseClaudeConfig, type ClaudeProviderDefaults } from './claude/config';
export { parseOpenCodeConfig, parseOpenCodeModel, resolveOpencodeAuthEnv } from './opencode/config';
export { parsePydanticConfig, resolveAgentEntry } from './pydantic/config';
export type {
  OpenCodeProviderDefaults,
  PydanticProviderDefaults,
  LiteLLMProviderDefaults,
} from './types';

// Utilities (needed by consumers)
export { resolveClaudeBinaryPath, fileExists as claudeFileExists } from './claude/binary-resolver';
export {
  resolveOpencodeBinaryPath,
  fileExists as opencodeFileExists,
} from './opencode/binary-resolver';
export { resolveUvBinaryPath, fileExists as pydanticFileExists } from './pydantic/python-resolver';
