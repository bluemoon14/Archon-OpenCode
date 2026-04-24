import { describe, expect, test } from 'bun:test';
import { LITELLM_MODEL_PREFIXES, isLiteLLMModel, parseLiteLLMConfig } from './config';

describe('parseLiteLLMConfig', () => {
  test('applies defaults when raw is empty', () => {
    const out = parseLiteLLMConfig({});
    expect(out.port).toBe(4000);
    expect(out.masterKeyEnv).toBe('LITELLM_MASTER_KEY');
    expect(out.providers).toEqual({});
  });

  test('accepts undefined input (same as empty)', () => {
    const out = parseLiteLLMConfig(undefined);
    expect(out.port).toBe(4000);
    expect(out.masterKeyEnv).toBe('LITELLM_MASTER_KEY');
  });

  test('honors explicit port + masterKeyEnv', () => {
    const out = parseLiteLLMConfig({ port: 4100, masterKeyEnv: 'MY_KEY_VAR' });
    expect(out.port).toBe(4100);
    expect(out.masterKeyEnv).toBe('MY_KEY_VAR');
  });

  test('rejects non-positive port (falls through to default)', () => {
    const out = parseLiteLLMConfig({ port: 0 });
    expect(out.port).toBe(4000);
  });

  test('parses baseUrl + configPath + litellmBinaryPath + model', () => {
    const out = parseLiteLLMConfig({
      baseUrl: 'http://localhost:4000',
      configPath: '/etc/litellm.yaml',
      litellmBinaryPath: '/usr/local/bin/litellm',
      model: 'openai/gpt-4o',
    });
    expect(out.baseUrl).toBe('http://localhost:4000');
    expect(out.configPath).toBe('/etc/litellm.yaml');
    expect(out.litellmBinaryPath).toBe('/usr/local/bin/litellm');
    expect(out.model).toBe('openai/gpt-4o');
  });

  test('parses per-upstream provider entries (env var NAMES only)', () => {
    const out = parseLiteLLMConfig({
      providers: {
        anthropic: { authTokenEnv: 'ANTHROPIC_API_KEY' },
        azure_ai: { authTokenEnv: 'AZURE_AI_API_KEY', apiBaseEnv: 'AZURE_AI_API_BASE' },
        // Malformed entry — should be silently dropped without throwing.
        broken: 'not an object',
      },
    });
    expect(out.providers.anthropic).toEqual({ authTokenEnv: 'ANTHROPIC_API_KEY' });
    expect(out.providers.azure_ai).toEqual({
      authTokenEnv: 'AZURE_AI_API_KEY',
      apiBaseEnv: 'AZURE_AI_API_BASE',
    });
    expect(out.providers.broken).toBeUndefined();
  });
});

describe('isLiteLLMModel', () => {
  test('accepts every claimed prefix', () => {
    for (const prefix of LITELLM_MODEL_PREFIXES) {
      expect(isLiteLLMModel(`${prefix}some-model`)).toBe(true);
    }
  });

  test('accepts specific canonical examples', () => {
    expect(isLiteLLMModel('openai/gpt-4o')).toBe(true);
    expect(isLiteLLMModel('anthropic/claude-sonnet-4-5')).toBe(true);
    expect(isLiteLLMModel('azure_ai/claude-sonnet-4-5')).toBe(true);
    expect(isLiteLLMModel('azure/my-deployment')).toBe(true);
    expect(isLiteLLMModel('novita/deepseek/deepseek-r1-turbo')).toBe(true);
  });

  test('rejects Claude SDK shorthand + non-LiteLLM provider prefixes', () => {
    expect(isLiteLLMModel('sonnet')).toBe(false);
    expect(isLiteLLMModel('opus')).toBe(false);
    expect(isLiteLLMModel('haiku')).toBe(false);
    expect(isLiteLLMModel('claude-sonnet-4-5')).toBe(false);
    expect(isLiteLLMModel('inherit')).toBe(false);
    expect(isLiteLLMModel('opencode/gpt-4o')).toBe(false);
    expect(isLiteLLMModel('google/gemini-1.5')).toBe(false);
    expect(isLiteLLMModel('')).toBe(false);
  });
});
