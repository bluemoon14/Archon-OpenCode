/**
 * Orchestrator - Main conversation handler
 * Routes slash commands and AI messages appropriately
 */
import { readFile as fsReadFile, access as fsAccess } from 'fs/promises';

// Wrapper function for reading files - allows mocking without polluting fs/promises globally
export async function readCommandFile(path: string): Promise<string> {
  return fsReadFile(path, 'utf-8');
}
export async function commandFileExists(path: string): Promise<boolean> {
  try {
    await fsAccess(path);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      return false;
    }
    // Unexpected errors (permissions, I/O) should not be swallowed
    getLog().error({ err, path, code: err.code }, 'command_file_access_error');
    throw new Error(`Cannot access command file at ${path}: ${err.message}`);
  }
}
import { createLogger } from '@archon/paths';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger) */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('orchestrator');
  return cachedLog;
}
import { IPlatformAdapter, Conversation, Codebase, ConversationNotFoundError } from '../types';
import type { IsolationHints, IsolationEnvironmentRow } from '@archon/isolation';
import {
  IsolationBlockedError,
  IsolationResolver,
  configureIsolation,
  getIsolationProvider,
} from '@archon/isolation';
import * as db from '../db/conversations';
import { createIsolationStore } from '../db/isolation-environments';
import { toError } from '../utils/error';
import {
  cleanupToMakeRoom,
  getWorktreeStatusBreakdown,
  STALE_THRESHOLD_DAYS,
} from '../services/cleanup-service';
import { loadRepoConfig } from '../config/config-loader';

type IsolationResolution =
  | { status: 'existing'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'new'; cwd: string; env: IsolationEnvironmentRow }
  | { status: 'none'; cwd: string; env: null };

// Lazy resolver singleton
let resolver: IsolationResolver | null = null;
let isolationConfigured = false;

function ensureIsolationConfigured(): void {
  if (!isolationConfigured) {
    configureIsolation(async (repoPath: string) => {
      const config = await loadRepoConfig(repoPath);
      return config?.worktree ?? null;
    });
    isolationConfigured = true;
  }
}

function getResolver(): IsolationResolver {
  ensureIsolationConfigured();
  if (!resolver) {
    resolver = new IsolationResolver({
      store: createIsolationStore(),
      provider: getIsolationProvider(),
      cleanup: {
        makeRoom: async (codebaseId, repoPath): Promise<{ removedCount: number }> => {
          const result = await cleanupToMakeRoom(codebaseId, repoPath);
          return { removedCount: result.removed.length };
        },
        getBreakdown: getWorktreeStatusBreakdown,
      },
      staleThresholdDays: STALE_THRESHOLD_DAYS,
    });
  }
  return resolver;
}

/** Export for use by CLI and other consumers that need config initialized */
export { ensureIsolationConfigured };

/**
 * Validate existing isolation reference and coordinate creation of new isolation if needed.
 * Delegates resolution logic to IsolationResolver; handles messaging and conversation updates.
 *
 * @throws {IsolationBlockedError} When isolation is required but blocked (user already notified)
 */
export async function validateAndResolveIsolation(
  conversation: Conversation,
  codebase: Codebase | null,
  platform: IPlatformAdapter,
  conversationId: string,
  hints?: IsolationHints,
  _isRetry = false
): Promise<IsolationResolution> {
  const result = await getResolver().resolve({
    existingEnvId: conversation.isolation_env_id,
    codebase: codebase
      ? { id: codebase.id, defaultCwd: codebase.default_cwd, name: codebase.name }
      : null,
    hints,
    platformType: platform.getPlatformType(),
  });

  switch (result.status) {
    case 'resolved': {
      // Link env to conversation
      try {
        await db.updateConversation(conversation.id, {
          isolation_env_id: result.env.id,
          cwd: result.cwd,
        });
      } catch (updateError) {
        const err = toError(updateError);
        getLog().error(
          { err, conversationId: conversation.id, isolationEnvId: result.env.id },
          'isolation_link_failed'
        );
        try {
          await createIsolationStore().updateStatus(result.env.id, 'destroyed');
        } catch (rollbackError) {
          getLog().error(
            { err: toError(rollbackError), isolationEnvId: result.env.id },
            'isolation_rollback_failed'
          );
        }
        throw err;
      }
      // Send contextual messages
      if (result.method.type === 'linked_issue_reuse') {
        await platform.sendMessage(
          conversationId,
          `Reusing worktree from issue #${String(result.method.issueNumber)}`
        );
      }
      if (result.method.type === 'created' && result.method.autoCleanedCount) {
        await platform.sendMessage(
          conversationId,
          `Cleaned up ${String(result.method.autoCleanedCount)} merged worktree(s) to make room.`
        );
      }
      // Surface any non-fatal warnings from environment creation
      if (result.warnings && result.warnings.length > 0) {
        for (const warning of result.warnings) {
          await platform.sendMessage(conversationId, `Warning: ${warning}`).catch(e => {
            getLog().error({ err: toError(e), conversationId }, 'isolation_warning_send_failed');
          });
        }
      }
      return {
        status: result.method.type === 'existing' ? 'existing' : 'new',
        cwd: result.cwd,
        env: result.env,
      };
    }

    case 'stale_cleaned': {
      // Clear stale reference
      await db.updateConversation(conversation.id, { isolation_env_id: null }).catch(e => {
        if (!(toError(e) instanceof ConversationNotFoundError)) {
          getLog().error(
            { err: toError(e), conversationId: conversation.id },
            'stale_isolation_clear_failed'
          );
        }
      });
      const staleMsg = codebase
        ? 'Detected a stale isolated workspace reference and cleared it. Creating a new isolated workspace now.'
        : 'Detected a stale isolated workspace reference and cleared it. Continuing without an isolated workspace.';
      await platform.sendMessage(conversationId, staleMsg).catch(e => {
        getLog().error({ err: toError(e), conversationId }, 'stale_isolation_notice_failed');
      });
      // Retry without existing env (guard against infinite recursion)
      if (!codebase) return { status: 'none', cwd: conversation.cwd ?? '/workspace', env: null };
      if (_isRetry) {
        throw new Error(
          `Isolation resolution stuck in stale_cleaned loop for conversation ${conversation.id}`
        );
      }
      return validateAndResolveIsolation(
        { ...conversation, isolation_env_id: null },
        codebase,
        platform,
        conversationId,
        hints,
        true
      );
    }

    case 'none':
      return { status: 'none', cwd: result.cwd, env: null };

    case 'blocked':
      await platform.sendMessage(conversationId, result.userMessage);
      throw new IsolationBlockedError(
        'Isolation environment required but could not be created',
        result.reason
      );
  }
}

/**
 * Wraps command content with execution context to signal the AI should execute immediately.
 * @param commandName - The name of the command being invoked (e.g., 'create-pr')
 * @param content - The command template content after variable substitution
 * @returns The content wrapped with instructions that tell the AI to execute immediately
 *          without asking for confirmation (used for explicit user command invocations)
 */
export function wrapCommandForExecution(commandName: string, content: string): string {
  return `The user invoked the \`/${commandName}\` command. Execute the following instructions immediately without asking for confirmation:

---

${content}

---

Remember: The user already decided to run this command. Take action now.`;
}
