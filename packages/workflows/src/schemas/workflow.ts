/**
 * Zod schemas for workflow definition types, plus result types for
 * workflow loading and execution (non-schema hand-written discriminated unions).
 */
import { z } from '@hono/zod-openapi';
import {
  dagNodeSchema,
  effortLevelSchema,
  thinkingConfigSchema,
  sandboxSettingsSchema,
} from './dag-node';

// ---------------------------------------------------------------------------
// Workflow-level worktree policy
// ---------------------------------------------------------------------------

/**
 * Per-workflow worktree policy. Pins whether a run uses isolation regardless of
 * how it was invoked (CLI flags, web UI, chat). When the field is omitted the
 * caller's default applies — worktree for task/issue/pr, etc.
 *
 * Currently one field (`enabled`). Other worktree-shaped settings (copyFiles,
 * initSubmodules, path, baseBranch) live in repo-level `.archon/config.yaml`
 * because they are repo-wide, not per-workflow. This block is deliberately
 * narrow to avoid re-expressing the repo-level knobs here.
 */
export const workflowWorktreePolicySchema = z.object({
  /**
   * Pin worktree isolation on or off for this workflow.
   * - `true`  — always run inside a worktree; CLI `--no-worktree` hard-errors
   * - `false` — always run in the live checkout; CLI `--branch` / `--from`
   *             hard-error, orchestrator skips isolation resolution
   * - omitted — caller decides (current default = worktree for most types)
   */
  enabled: z.boolean().optional(),
});

export type WorkflowWorktreePolicy = z.infer<typeof workflowWorktreePolicySchema>;

// ---------------------------------------------------------------------------
// WorkflowBase — common fields shared by all workflow types
// ---------------------------------------------------------------------------

export const workflowBaseSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  provider: z.string().trim().min(1).optional(),
  model: z.string().optional(),
  additionalDirectories: z.array(z.string()).optional(),
  interactive: z.boolean().optional(),
  effort: effortLevelSchema.optional(),
  thinking: thinkingConfigSchema.optional(),
  fallbackModel: z.string().min(1).optional(),
  betas: z.array(z.string().min(1)).nonempty("'betas' must be a non-empty array").optional(),
  sandbox: sandboxSettingsSchema.optional(),
  worktree: workflowWorktreePolicySchema.optional(),
  /**
   * Whole-workflow cost cap in USD. Accumulates across every node in the
   * run; as soon as the running total exceeds this value, the run fails
   * with a clear error. Per-node `maxBudgetUsd` (on DAG nodes) is orthogonal
   * — a node can have its own cap and the whole-workflow cap wins whichever
   * is tighter at any given moment.
   */
  maxWorkflowCostUsd: z.number().positive().optional(),
  /**
   * Named workflow parameters. Each entry declares a parameter accessible
   * as `$PARAM_<key>` in any node's prompt / bash / script text. The CLI's
   * `--param key=value` flag supplies values at invocation time. If a
   * parameter declares `required: true` and no value is provided (via CLI
   * or `default`), the workflow fails to start with a clear error.
   *
   * Kept flat on purpose — nested `parameters.<name>.type/enum/choices`
   * can come later; v1 is strings only.
   */
  parameters: z
    .record(
      z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'parameter name must be a valid identifier'),
      z.object({
        description: z.string().min(1).optional(),
        required: z.boolean().optional(),
        default: z.string().optional(),
      })
    )
    .optional(),
});

export type WorkflowBase = z.infer<typeof workflowBaseSchema>;

// ---------------------------------------------------------------------------
// WorkflowDefinition — DAG-based workflow with nodes
// ---------------------------------------------------------------------------

/**
 * Workflow definition parsed from YAML.
 * All workflows use DAG-based execution with `nodes`.
 */
export const workflowDefinitionSchema = workflowBaseSchema.extend({
  nodes: z.array(dagNodeSchema),
});

/** Workflow definition with fully typed nodes (DagNode[]) derived from the schema. */
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema> & { prompt?: never };

// ---------------------------------------------------------------------------
// LoadCommandResult — discriminated union for command load outcomes
// ---------------------------------------------------------------------------

/**
 * Result of loading a command prompt - discriminated union for specific error handling
 *
 * On success, `content` is non-empty (enforced at load time in executor-shared.ts, not by the type).
 */
export type LoadCommandResult =
  | { success: true; content: string }
  | {
      success: false;
      reason: 'invalid_name' | 'empty_file' | 'not_found' | 'permission_denied' | 'read_error';
      message: string;
    };

// ---------------------------------------------------------------------------
// WorkflowExecutionResult — discriminated union for execution outcomes
// ---------------------------------------------------------------------------

/**
 * Result of workflow execution - allows callers to detect success/failure
 */
export type WorkflowExecutionResult =
  | { success: true; workflowRunId: string; summary?: string }
  | { success: false; workflowRunId?: string; error: string }
  | { success: true; paused: true; workflowRunId: string };

// ---------------------------------------------------------------------------
// WorkflowLoadError / WorkflowLoadResult — workflow discovery results
// ---------------------------------------------------------------------------

/**
 * Workflow origin:
 * - `bundled` — embedded in the Archon binary / bundled defaults
 * - `global`  — user-level, discovered at `~/.archon/workflows/` (applies to every repo)
 * - `project` — repo-local, discovered at `<repoRoot>/.archon/workflows/`
 *
 * Precedence for same-named files: `bundled` < `global` < `project`.
 */
export type WorkflowSource = 'bundled' | 'global' | 'project';

/** A workflow definition paired with its discovery source. */
export interface WorkflowWithSource {
  readonly workflow: WorkflowDefinition;
  readonly source: WorkflowSource;
}

/**
 * Error encountered while loading a workflow file
 */
export interface WorkflowLoadError {
  readonly filename: string;
  readonly error: string;
  readonly errorType: 'read_error' | 'parse_error' | 'validation_error';
}

/**
 * Result of workflow discovery - includes both successful loads and errors
 */
export interface WorkflowLoadResult {
  readonly workflows: readonly WorkflowWithSource[];
  readonly errors: readonly WorkflowLoadError[];
}
