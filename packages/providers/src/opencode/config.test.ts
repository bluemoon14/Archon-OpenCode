import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { parseOpenCodeConfig, parseOpenCodeModel, resolveOpencodeAuthEnv } from './config';

describe('parseOpenCodeConfig', () => {
  test('returns empty object for non-object input', () => {
    expect(parseOpenCodeConfig(undefined)).toEqual({});
    expect(parseOpenCodeConfig(null)).toEqual({});
    expect(parseOpenCodeConfig('string')).toEqual({});
  });

  test('extracts model, binary path, baseUrl', () => {
    const cfg = parseOpenCodeConfig({
      model: 'openai/gpt-4o-mini',
      opencodeBinaryPath: '/usr/local/bin/opencode',
      baseUrl: 'http://localhost:9999',
    });
    expect(cfg).toEqual({
      model: 'openai/gpt-4o-mini',
      opencodeBinaryPath: '/usr/local/bin/opencode',
      baseUrl: 'http://localhost:9999',
    });
  });

  test('trims whitespace', () => {
    const cfg = parseOpenCodeConfig({ model: '  openai/gpt-4  ' });
    expect(cfg.model).toBe('openai/gpt-4');
  });

  test('drops empty strings', () => {
    expect(parseOpenCodeConfig({ model: '   ' })).toEqual({});
  });

  test('extracts per-provider authTokenEnv mappings', () => {
    const cfg = parseOpenCodeConfig({
      providers: {
        openai: { authTokenEnv: 'OPENAI_API_KEY' },
        anthropic: { authTokenEnv: 'ANTHROPIC_API_KEY' },
      },
    });
    expect(cfg.providers).toEqual({
      openai: { authTokenEnv: 'OPENAI_API_KEY' },
      anthropic: { authTokenEnv: 'ANTHROPIC_API_KEY' },
    });
  });

  test('ignores providers entries without authTokenEnv', () => {
    const cfg = parseOpenCodeConfig({
      providers: { openai: { something_else: 'x' } },
    });
    expect(cfg.providers).toBeUndefined();
  });
});

describe('parseOpenCodeModel', () => {
  test('returns undefined for undefined / malformed', () => {
    expect(parseOpenCodeModel(undefined)).toBeUndefined();
    expect(parseOpenCodeModel('no-slash')).toBeUndefined();
    expect(parseOpenCodeModel('/leading-slash')).toBeUndefined();
    expect(parseOpenCodeModel('trailing-slash/')).toBeUndefined();
  });

  test('splits providerID/modelID', () => {
    expect(parseOpenCodeModel('openai/gpt-4o-mini')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
    });
  });

  test('strips leading opencode/ routing hint', () => {
    expect(parseOpenCodeModel('opencode/openai/gpt-4o-mini')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o-mini',
    });
  });

  test('splits only on first slash (preserves modelID paths)', () => {
    expect(parseOpenCodeModel('openai/gpt-4o/2024-08')).toEqual({
      providerID: 'openai',
      modelID: 'gpt-4o/2024-08',
    });
  });
});

describe('resolveOpencodeAuthEnv', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.TEST_OPENAI_KEY = process.env.TEST_OPENAI_KEY;
    savedEnv.TEST_MISSING_KEY = process.env.TEST_MISSING_KEY;
    process.env.TEST_OPENAI_KEY = 'sk-test-123';
    Reflect.deleteProperty(process.env, 'TEST_MISSING_KEY');
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = v;
    }
  });

  test('returns resolved values for env vars that are set', () => {
    const env = resolveOpencodeAuthEnv({
      providers: { openai: { authTokenEnv: 'TEST_OPENAI_KEY' } },
    });
    expect(env).toEqual({ TEST_OPENAI_KEY: 'sk-test-123' });
  });

  test('skips entries whose referenced env var is unset', () => {
    const env = resolveOpencodeAuthEnv({
      providers: { ghost: { authTokenEnv: 'TEST_MISSING_KEY' } },
    });
    expect(env).toEqual({});
  });

  test('returns empty for config without providers', () => {
    expect(resolveOpencodeAuthEnv({})).toEqual({});
  });
});
