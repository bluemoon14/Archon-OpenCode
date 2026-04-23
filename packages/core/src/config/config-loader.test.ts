import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { homedir } from 'os';
import { join } from 'path';
import { createMockLogger } from '../test/mocks/logger';

const mockLogger = createMockLogger();
const archonHome = join(homedir(), '.archon');
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: mock(() => archonHome),
  getArchonConfigPath: mock(() => join(archonHome, 'config.yaml')),
  getArchonWorkspacesPath: mock(() => join(archonHome, 'workspaces')),
  getArchonWorktreesPath: mock(() => join(archonHome, 'worktrees')),
  getDefaultCommandsPath: mock(() => '/app/.archon/commands/defaults'),
  getDefaultWorkflowsPath: mock(() => '/app/.archon/workflows/defaults'),
}));

// Mock for reading/writing config files (replaces fs/promises mock)
const mockReadConfigFile = mock(() => Promise.resolve(''));
const mockWriteConfigFile = mock(() => Promise.resolve());

// Import real config-loader to spread its exports, then override readConfigFile/writeConfigFile
import * as realConfigLoader from './config-loader';
mock.module('./config-loader', () => ({
  ...realConfigLoader,
  readConfigFile: mockReadConfigFile,
  writeConfigFile: mockWriteConfigFile,
}));

import {
  loadGlobalConfig,
  loadRepoConfig,
  loadConfig,
  clearConfigCache,
  toSafeConfig,
  updateGlobalConfig,
} from './config-loader';

describe('config-loader', () => {
  const originalEnv: Record<string, string | undefined> = {};
  const envVars = [
    'DEFAULT_AI_ASSISTANT',
    'MAX_CONCURRENT_CONVERSATIONS',
    'WORKSPACE_PATH',
    'WORKTREE_BASE',
    'ARCHON_HOME',
  ];

  beforeEach(() => {
    clearConfigCache();
    mockReadConfigFile.mockReset();
    mockWriteConfigFile.mockReset();

    // Save original env vars
    envVars.forEach(key => {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    });
  });

  afterEach(() => {
    // Restore env vars
    envVars.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });

    // No need to restore - we're mocking at config-loader level, not fs/promises
    mockReadConfigFile.mockClear();
    mockWriteConfigFile.mockClear();
  });

  describe('loadGlobalConfig', () => {
    test('returns empty object when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadGlobalConfig();
      expect(config).toEqual({});
    });

    test('parses valid YAML config', async () => {
      mockReadConfigFile.mockResolvedValue(`
defaultAssistant: claude
concurrency:
  maxConversations: 5
`);

      const config = await loadGlobalConfig();
      expect(config.defaultAssistant).toBe('claude');
      expect(config.concurrency?.maxConversations).toBe(5);
    });

    test('caches config on subsequent calls', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig();

      // Should only read file once
      expect(mockReadConfigFile).toHaveBeenCalledTimes(1);
    });

    test('reloads config when forceReload is true', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: claude');

      await loadGlobalConfig();
      await loadGlobalConfig(true);

      expect(mockReadConfigFile).toHaveBeenCalledTimes(2);
    });

    test('logs error for invalid YAML syntax', async () => {
      mockLogger.error.mockClear();

      // Simulate YAML parse error (SyntaxError has no .code property)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadGlobalConfig();

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: syntaxError }),
        'config_invalid_yaml'
      );
    });

    test('logs error for permission denied', async () => {
      mockLogger.error.mockClear();

      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockReadConfigFile.mockRejectedValue(permError);

      const config = await loadGlobalConfig();

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: permError, code: 'EACCES' }),
        'config_permission_denied'
      );
    });
  });

  describe('loadRepoConfig', () => {
    test('loads from .archon/config.yaml', async () => {
      mockReadConfigFile.mockResolvedValue('assistant: claude');

      const config = await loadRepoConfig('/test/repo');
      expect(config.assistant).toBe('claude');
    });

    test('returns empty object when no config found', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadRepoConfig('/test/repo');
      expect(config).toEqual({});
    });

    test('logs error for invalid YAML syntax', async () => {
      mockLogger.error.mockClear();

      // Simulate YAML parse error (SyntaxError has no .code property)
      const syntaxError = new SyntaxError('YAML Parse error: Multiline implicit key');
      mockReadConfigFile.mockRejectedValue(syntaxError);

      const config = await loadRepoConfig('/test/repo');

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: syntaxError }),
        'config_invalid_yaml'
      );
    });

    test('logs error for permission denied', async () => {
      mockLogger.error.mockClear();

      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockReadConfigFile.mockRejectedValue(permError);

      const config = await loadRepoConfig('/test/repo');

      // Should fall back to empty config
      expect(config).toEqual({});

      // Should log error via structured logger
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: permError, code: 'EACCES' }),
        'config_permission_denied'
      );
    });
  });

  describe('loadConfig', () => {
    test('returns defaults when no configs exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.assistant).toBe('claude');
      // Built-ins always present; check the registered built-in (claude) explicitly.
      expect(config.assistants.claude).toEqual({});
      expect(config.concurrency.maxConversations).toBe(10);
    });

    test('throws on unknown DEFAULT_AI_ASSISTANT env var', async () => {
      mockReadConfigFile.mockResolvedValue('');
      process.env.DEFAULT_AI_ASSISTANT = 'nonexistent-provider';

      await expect(loadConfig()).rejects.toThrow(/not a registered provider/);
    });

    test('throws on unknown defaultAssistant in global config', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: nonexistent-provider');

      await expect(loadConfig()).rejects.toThrow(/not a registered provider/);
    });

    test('throws on unknown assistant in repo config', async () => {
      mockReadConfigFile.mockImplementation(async (path: string) => {
        const normalized = path.replace(/\\/g, '/');
        if (normalized.includes('/tmp/test-repo/.archon/config.yaml')) {
          return 'assistant: nonexistent-provider';
        }
        return '';
      });

      await expect(loadConfig('/tmp/test-repo')).rejects.toThrow(/not a registered provider/);
    });

    test('repo config overrides global config', async () => {
      // Helper to check path in cross-platform way (handles both / and \ separators)
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockReadConfigFile.mockImplementation(async (path: string) => {
        // First check for repo-specific config path (contains /repo/.archon/)
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return 'assistants:\n  claude:\n    model: opus\n';
        }
        // Then check for global config (just .archon/config.yaml but not under /repo/)
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return 'assistants:\n  claude:\n    model: sonnet\n';
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistants.claude.model).toBe('opus');
    });

    test('merges assistant defaults from global and repo config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `assistants:\n  claude:\n    model: opus\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return `assistants:\n  claude:\n    model: sonnet\n`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      // Repo overrides global
      expect(config.assistants.claude.model).toBe('opus');
    });

    test('propagates baseBranch from repo worktree config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: develop
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('develop');
    });

    test('trims whitespace from baseBranch', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
worktree:
  baseBranch: "  staging  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBe('staging');
    });

    test('baseBranch is undefined when not configured', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.baseBranch).toBeUndefined();
    });

    test('propagates docsPath from repo docs config', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
docs:
  path: packages/docs-web/src/content/docs
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBe('packages/docs-web/src/content/docs');
    });

    test('trims whitespace from docsPath', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
docs:
  path: "  custom/docs/  "
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBe('custom/docs/');
    });

    test('docsPath is undefined when docs config is absent', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.docsPath).toBeUndefined();
    });

    test('propagates env vars from repo config', async () => {
      const pathMatches = (path: string, pattern: string): boolean =>
        path.replace(/\\/g, '/').includes(pattern);

      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `
env:
  MY_TOKEN: abc123
  API_BASE: https://api.example.com
`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.envVars).toEqual({ MY_TOKEN: 'abc123', API_BASE: 'https://api.example.com' });
    });

    test('envVars is undefined when repo config has no env section', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig('/test/repo');
      expect(config.envVars).toBeUndefined();
    });

    test('paths use archon defaults', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      const config = await loadConfig();

      expect(config.paths.workspaces).toBe(join(homedir(), '.archon', 'workspaces'));
      expect(config.paths.worktrees).toBe(join(homedir(), '.archon', 'worktrees'));
    });
  });

  describe('settingSources config', () => {
    test('merges settingSources from global config', async () => {
      mockReadConfigFile.mockResolvedValue(`
assistants:
  claude:
    settingSources:
      - project
      - user
`);
      const config = await loadConfig();
      expect(config.assistants.claude.settingSources).toEqual(['project', 'user']);
    });

    test('defaults to undefined settingSources when not configured', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const config = await loadConfig();
      expect(config.assistants.claude.settingSources).toBeUndefined();
    });

    test('repo settingSources overrides global', async () => {
      const pathMatches = (path: string, pattern: string): boolean => {
        const normalizedPath = path.replace(/\\/g, '/');
        return normalizedPath.includes(pattern);
      };

      let globalConfigRead = false;
      mockReadConfigFile.mockImplementation(async (path: string) => {
        if (pathMatches(path, '/repo/.archon/config.yaml')) {
          return `assistants:\n  claude:\n    settingSources:\n      - project\n`;
        }
        if (pathMatches(path, '.archon/config.yaml') && !globalConfigRead) {
          globalConfigRead = true;
          return `assistants:\n  claude:\n    settingSources:\n      - project\n      - user\n`;
        }
        const error = new Error('ENOENT') as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      });

      const config = await loadConfig('/test/repo');
      expect(config.assistants.claude.settingSources).toEqual(['project']);
    });

    test('toSafeConfig does not expose settingSources (server-internal field)', async () => {
      mockReadConfigFile.mockResolvedValue(`
assistants:
  claude:
    settingSources:
      - project
      - user
`);
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe.assistants.claude).not.toHaveProperty('settingSources');
    });
  });

  describe('updateGlobalConfig', () => {
    test('merges assistant config into existing file', async () => {
      mockReadConfigFile.mockResolvedValue(`
defaultAssistant: claude
assistants:
  claude:
    model: sonnet
`);

      await updateGlobalConfig({
        assistants: { claude: { model: 'opus' } },
      });

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockWriteConfigFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('opus');
    });

    test('preserves existing non-updated fields', async () => {
      mockReadConfigFile.mockResolvedValue(`
defaultAssistant: claude
botName: MyBot
assistants:
  claude:
    model: sonnet
`);

      await updateGlobalConfig({
        defaultAssistant: 'claude',
      });

      expect(mockWriteConfigFile).toHaveBeenCalledTimes(1);
      const writtenContent = mockWriteConfigFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('claude');
      expect(writtenContent).toContain('MyBot');
    });

    test('creates config when file does not exist', async () => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadConfigFile.mockRejectedValue(error);

      await updateGlobalConfig({
        defaultAssistant: 'claude',
      });

      expect(mockWriteConfigFile).toHaveBeenCalled();
      const writtenContent = mockWriteConfigFile.mock.calls[0]?.[1] as string;
      expect(writtenContent).toContain('claude');
    });

    test('throws on permission errors', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const permError = new Error('Permission denied') as NodeJS.ErrnoException;
      permError.code = 'EACCES';
      mockWriteConfigFile.mockRejectedValue(permError);

      await expect(updateGlobalConfig({ defaultAssistant: 'claude' })).rejects.toThrow(
        'Permission denied'
      );
    });
  });

  describe('toSafeConfig', () => {
    test('strips paths from MergedConfig', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('paths');
    });

    test('strips entire commands object from MergedConfig', async () => {
      mockReadConfigFile.mockResolvedValue('');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(safe).not.toHaveProperty('commands');
    });

    test('preserves non-sensitive fields', async () => {
      mockReadConfigFile.mockResolvedValue('defaultAssistant: claude');
      const config = await loadConfig();
      const safe = toSafeConfig(config);
      expect(typeof safe.botName).toBe('string');
      expect(safe.assistant).toBe('claude');
      expect(safe.concurrency).toBeDefined();
      expect(safe.defaults).toBeDefined();
      expect(safe.assistants).toBeDefined();
      expect(safe.assistants.claude).toBeDefined();
    });
  });
});
