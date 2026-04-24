import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildArchonConfigSnippetForTests,
  defaultLitellmConfigPath,
  litellmSetupPlugin,
  readScaffoldedConfigForTests,
  scaffoldLitellmConfigForTests,
} from './litellm';

describe('litellmSetupPlugin', () => {
  test('exposes id + displayName', () => {
    expect(litellmSetupPlugin.id).toBe('litellm');
    expect(litellmSetupPlugin.displayName).toBe('LiteLLM');
  });

  test('detect() returns deterministic shape', () => {
    const res = litellmSetupPlugin.detect();
    expect(typeof res.found).toBe('boolean');
    if (res.found) {
      expect(typeof res.binaryPath).toBe('string');
      expect(res.binaryPath).toBeTruthy();
    } else {
      expect(res.installHint).toContain('astral.sh/uv');
    }
  });

  test('defaultLitellmConfigPath is under ~/.archon', () => {
    expect(defaultLitellmConfigPath()).toContain('.archon/litellm_config.yaml');
  });
});

describe('config scaffolding', () => {
  let tmp: string;
  let configPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'archon-litellm-setup-'));
    configPath = join(tmp, 'litellm_config.yaml');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  test('scaffolds a fresh config with every selected upstream', () => {
    const wrote = scaffoldLitellmConfigForTests(configPath, [
      'anthropic',
      'openai',
      'azure_ai',
      'novita',
    ]);
    expect(wrote).toBe(true);
    const content = readScaffoldedConfigForTests(configPath);

    expect(content).toContain('model_list:');
    expect(content).toContain('anthropic/claude-sonnet-4-5');
    expect(content).toContain('openai/gpt-4o');
    expect(content).toContain('azure_ai/claude-sonnet-4-5');
    expect(content).toContain('novita/deepseek/deepseek-r1-turbo');

    // Every key must come from an env var — no literal secrets.
    expect(content).toContain('api_key: os.environ/ANTHROPIC_API_KEY');
    expect(content).toContain('api_key: os.environ/OPENAI_API_KEY');
    expect(content).toContain('api_key: os.environ/AZURE_AI_API_KEY');
    expect(content).toContain('api_base: os.environ/AZURE_AI_API_BASE');
    expect(content).toContain('api_key: os.environ/NOVITA_API_KEY');
    expect(content).toContain('master_key: os.environ/LITELLM_MASTER_KEY');
  });

  test('does NOT overwrite existing config', () => {
    const first = scaffoldLitellmConfigForTests(configPath, ['anthropic']);
    expect(first).toBe(true);
    const before = readScaffoldedConfigForTests(configPath);

    const second = scaffoldLitellmConfigForTests(configPath, ['openai']);
    expect(second).toBe(false); // refused
    const after = readScaffoldedConfigForTests(configPath);
    expect(after).toBe(before);
  });

  test('omits Azure base env var for non-Azure upstreams', () => {
    scaffoldLitellmConfigForTests(configPath, ['anthropic', 'openai']);
    const content = readScaffoldedConfigForTests(configPath);
    expect(content).not.toContain('api_base:');
  });
});

describe('archon-config snippet', () => {
  test('emits assistants.litellm with configPath + port + masterKeyEnv', () => {
    const snippet = buildArchonConfigSnippetForTests('/home/u/.archon/litellm_config.yaml', [
      'anthropic',
      'openai',
    ]);
    expect(snippet).toContain('assistants:');
    expect(snippet).toContain('  litellm:');
    expect(snippet).toContain('    configPath: /home/u/.archon/litellm_config.yaml');
    expect(snippet).toContain('    port: 4000');
    expect(snippet).toContain('    masterKeyEnv: LITELLM_MASTER_KEY');
    expect(snippet).toContain('    providers:');
    expect(snippet).toContain('      anthropic:');
    expect(snippet).toContain('        authTokenEnv: ANTHROPIC_API_KEY');
    expect(snippet).toContain('      openai:');
    expect(snippet).toContain('        authTokenEnv: OPENAI_API_KEY');
  });

  test('includes apiBaseEnv only for azure_ai', () => {
    const snippet = buildArchonConfigSnippetForTests('/x.yaml', ['azure_ai']);
    expect(snippet).toContain('apiBaseEnv: AZURE_AI_API_BASE');

    const snippetNo = buildArchonConfigSnippetForTests('/x.yaml', ['openai']);
    expect(snippetNo).not.toContain('apiBaseEnv:');
  });

  test('omits providers: when no upstreams are selected', () => {
    const snippet = buildArchonConfigSnippetForTests('/x.yaml', []);
    expect(snippet).not.toContain('providers:');
  });
});
