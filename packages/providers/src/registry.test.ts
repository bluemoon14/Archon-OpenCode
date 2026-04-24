import { describe, test, expect, beforeEach } from 'bun:test';
import {
  getAgentProvider,
  getProviderCapabilities,
  registerProvider,
  getRegistration,
  getRegisteredProviders,
  getProviderInfoList,
  isRegisteredProvider,
  registerBuiltinProviders,
  clearRegistry,
} from './registry';
import { UnknownProviderError } from './errors';
import type { ProviderRegistration, IAgentProvider } from './types';

/** Minimal mock provider for testing registration. */
function makeMockProvider(id: string): IAgentProvider {
  return {
    getType: () => id,
    getCapabilities: () => ({
      sessionResume: false,
      mcp: false,
      hooks: false,
      skills: false,
      agents: false,
      toolRestrictions: false,
      structuredOutput: false,
      envInjection: false,
      costControl: false,
      effortControl: false,
      thinkingControl: false,
      fallbackModel: false,
      sandbox: false,
    }),
    async *sendQuery() {
      yield { type: 'result' as const };
    },
  };
}

function makeMockRegistration(
  id: string,
  overrides?: Partial<ProviderRegistration>
): ProviderRegistration {
  return {
    id,
    displayName: `Mock ${id}`,
    factory: () => makeMockProvider(id),
    capabilities: makeMockProvider(id).getCapabilities(),
    isModelCompatible: () => true,
    builtIn: false,
    ...overrides,
  };
}

describe('registry', () => {
  beforeEach(() => {
    clearRegistry();
    registerBuiltinProviders();
  });

  describe('getAgentProvider', () => {
    test('returns ClaudeProvider for claude type', () => {
      const provider = getAgentProvider('claude');

      expect(provider).toBeDefined();
      expect(provider.getType()).toBe('claude');
      expect(typeof provider.sendQuery).toBe('function');
    });

    test('throws UnknownProviderError for unknown type', () => {
      expect(() => getAgentProvider('unknown')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('unknown')).toThrow(
        "Unknown provider: 'unknown'. Available: claude"
      );
    });

    test('throws UnknownProviderError for empty string', () => {
      expect(() => getAgentProvider('')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('')).toThrow("Unknown provider: ''");
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getAgentProvider('Claude')).toThrow(UnknownProviderError);
      expect(() => getAgentProvider('Claude')).toThrow("Unknown provider: 'Claude'");
    });

    test('each call returns new instance', () => {
      const provider1 = getAgentProvider('claude');
      const provider2 = getAgentProvider('claude');

      expect(provider1).not.toBe(provider2);
    });

    test('providers expose getCapabilities', () => {
      const claude = getAgentProvider('claude');

      expect(typeof claude.getCapabilities).toBe('function');

      const claudeCaps = claude.getCapabilities();
      expect(claudeCaps.mcp).toBe(true);
      expect(claudeCaps.hooks).toBe(true);
    });
  });

  describe('getProviderCapabilities', () => {
    test('returns Claude capabilities without instantiation', () => {
      const caps = getProviderCapabilities('claude');
      expect(caps.mcp).toBe(true);
      expect(caps.hooks).toBe(true);
      expect(caps.envInjection).toBe(true);
    });

    test('matches runtime getCapabilities for Claude', () => {
      const staticCaps = getProviderCapabilities('claude');
      const runtimeCaps = getAgentProvider('claude').getCapabilities();
      expect(staticCaps).toEqual(runtimeCaps);
    });

    test('throws UnknownProviderError for unknown type', () => {
      expect(() => getProviderCapabilities('unknown')).toThrow(UnknownProviderError);
    });

    test('throws UnknownProviderError for empty string', () => {
      expect(() => getProviderCapabilities('')).toThrow(UnknownProviderError);
    });

    test('is case sensitive - Claude throws', () => {
      expect(() => getProviderCapabilities('Claude')).toThrow(UnknownProviderError);
    });
  });

  describe('registerProvider', () => {
    test('registers a new provider', () => {
      const entry = makeMockRegistration('my-llm');
      registerProvider(entry);

      expect(isRegisteredProvider('my-llm')).toBe(true);
      const provider = getAgentProvider('my-llm');
      expect(provider.getType()).toBe('my-llm');
    });

    test('throws on duplicate registration', () => {
      expect(() => registerProvider(makeMockRegistration('claude'))).toThrow(
        "Provider 'claude' is already registered"
      );
    });
  });

  describe('getRegistration', () => {
    test('returns full registration entry', () => {
      const reg = getRegistration('claude');
      expect(reg.id).toBe('claude');
      expect(reg.displayName).toBe('Claude (Anthropic)');
      expect(reg.builtIn).toBe(true);
      expect(typeof reg.factory).toBe('function');
      expect(typeof reg.isModelCompatible).toBe('function');
    });

    test('throws for unknown provider', () => {
      expect(() => getRegistration('nope')).toThrow(UnknownProviderError);
    });
  });

  describe('getRegisteredProviders', () => {
    test('returns all registered providers', () => {
      const all = getRegisteredProviders();
      expect(all.length).toBe(4);
      expect(all.map(r => r.id)).toContain('claude');
      expect(all.map(r => r.id)).toContain('opencode');
      expect(all.map(r => r.id)).toContain('pydantic');
      expect(all.map(r => r.id)).toContain('litellm');
    });

    test('includes additional providers after registration', () => {
      registerProvider(makeMockRegistration('my-llm'));
      const all = getRegisteredProviders();
      expect(all.length).toBe(5);
    });
  });

  describe('getProviderInfoList', () => {
    test('returns API-safe projection without factory', () => {
      const infos = getProviderInfoList();
      expect(infos.length).toBe(4);
      for (const info of infos) {
        expect(info).toHaveProperty('id');
        expect(info).toHaveProperty('displayName');
        expect(info).toHaveProperty('capabilities');
        expect(info).toHaveProperty('builtIn');
        expect(info).not.toHaveProperty('factory');
        expect(info).not.toHaveProperty('isModelCompatible');
      }
    });
  });

  describe('isRegisteredProvider', () => {
    test('returns true for registered providers', () => {
      expect(isRegisteredProvider('claude')).toBe(true);
    });

    test('returns false for unknown providers', () => {
      expect(isRegisteredProvider('unknown')).toBe(false);
      expect(isRegisteredProvider('')).toBe(false);
    });
  });

  describe('registerBuiltinProviders', () => {
    test('is idempotent', () => {
      registerBuiltinProviders();
      registerBuiltinProviders();
      const all = getRegisteredProviders();
      expect(all.length).toBe(4);
    });
  });

  describe('clearRegistry', () => {
    test('empties the registry', () => {
      clearRegistry();
      expect(getRegisteredProviders()).toEqual([]);
      expect(isRegisteredProvider('claude')).toBe(false);
    });
  });

  describe('built-in model compatibility', () => {
    test('Claude registration matches Claude model patterns', () => {
      const reg = getRegistration('claude');
      expect(reg.isModelCompatible('sonnet')).toBe(true);
      expect(reg.isModelCompatible('opus')).toBe(true);
      expect(reg.isModelCompatible('haiku')).toBe(true);
      expect(reg.isModelCompatible('inherit')).toBe(true);
      expect(reg.isModelCompatible('claude-3.5-sonnet')).toBe(true);
      expect(reg.isModelCompatible('gpt-4')).toBe(false);
    });

    test('LiteLLM registration matches canonical upstream prefixes', () => {
      const reg = getRegistration('litellm');
      expect(reg.isModelCompatible('anthropic/claude-sonnet-4-5')).toBe(true);
      expect(reg.isModelCompatible('openai/gpt-4o')).toBe(true);
      expect(reg.isModelCompatible('azure/my-deployment')).toBe(true);
      expect(reg.isModelCompatible('azure_ai/claude-sonnet-4-5')).toBe(true);
      expect(reg.isModelCompatible('novita/meta-llama/llama-3.1')).toBe(true);
      expect(reg.isModelCompatible('sonnet')).toBe(false);
      expect(reg.isModelCompatible('opencode/gpt-4o')).toBe(false);
      expect(reg.isModelCompatible('google/gemini-1.5')).toBe(false);
    });

    test('OpenCode does NOT claim LiteLLM prefixes anymore', () => {
      // Regression guard: before Increment 3, OpenCode matched any
      // `<provider>/<model>` shape and would have stolen anthropic/, openai/,
      // azure_ai/, novita/ routing from LiteLLM.
      const reg = getRegistration('opencode');
      expect(reg.isModelCompatible('anthropic/claude-sonnet-4-5')).toBe(false);
      expect(reg.isModelCompatible('openai/gpt-4o')).toBe(false);
      expect(reg.isModelCompatible('azure/whatever')).toBe(false);
      expect(reg.isModelCompatible('azure_ai/claude')).toBe(false);
      expect(reg.isModelCompatible('novita/anything')).toBe(false);
      // Still accepts its own prefix and other non-LiteLLM routes.
      expect(reg.isModelCompatible('opencode/gpt-4o')).toBe(true);
      expect(reg.isModelCompatible('google/gemini-1.5')).toBe(true);
    });

    test('registering built-ins includes litellm', () => {
      const all = getRegisteredProviders();
      expect(all.map(r => r.id)).toContain('litellm');
    });
  });
});
