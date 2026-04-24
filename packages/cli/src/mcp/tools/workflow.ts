/**
 * MCP workflow-control tool handlers. Three operations:
 *   - archon_workflow_run(name, args, options)  → runs a workflow to completion
 *   - archon_workflow_status(runId?)             → status snapshot (all active or one run)
 *   - archon_workflow_resume(runId)              → resume a paused/failed run
 *
 * Each delegates to existing CLI / core functions so the MCP surface stays a
 * thin adapter — no duplicated workflow-execution logic.
 *
 * v1 note: `archon_workflow_run` is BLOCKING. The underlying
 * `workflowRunCommand` runs synchronously from the caller's perspective. MCP
 * hosts should set appropriate tool-call timeouts. Long-running workflows
 * are better kicked off via a shell tool (`archon workflow run ... &`) and
 * polled via `archon_workflow_status`.
 */
import { workflowRunCommand } from '../../commands/workflow';
import { workflowOperations, workflowDb } from '@archon/core';

export interface WorkflowRunInput {
  name: string;
  args?: string;
  /** Optional worktree branch override. */
  branchName?: string;
  /** Disable worktree isolation (run in the live checkout). */
  noWorktree?: boolean;
  /** Override the working directory the workflow runs in. */
  cwd?: string;
}

export interface WorkflowRunOutput {
  status: 'completed' | 'failed';
  workflowName: string;
  /** When the run completed successfully, the most recent matching run's ID. */
  runId?: string;
  /** Error message when status is 'failed'. */
  error?: string;
}

/**
 * Run a workflow and block until completion. Returns a structured status so
 * MCP clients can parse without scraping stdout. Works well for workflows
 * that complete in seconds to a couple minutes; long-running workflows
 * should be kicked off via shell + polled.
 */
export async function runWorkflow(
  input: WorkflowRunInput,
  defaultCwd: string
): Promise<WorkflowRunOutput> {
  const cwd = input.cwd ?? defaultCwd;
  try {
    await workflowRunCommand(cwd, input.name, input.args ?? '', {
      branchName: input.branchName,
      noWorktree: input.noWorktree,
    });
    // Success path — look up the most recent completed run for this workflow
    // name so the caller can hand the runId to `archon_workflow_status`.
    const runs = await workflowDb.listWorkflowRuns({ limit: 1 });
    const latest = runs[0];
    return {
      status: 'completed',
      workflowName: input.name,
      ...(latest?.workflow_name === input.name ? { runId: latest.id } : {}),
    };
  } catch (err) {
    return {
      status: 'failed',
      workflowName: input.name,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export interface WorkflowStatusInput {
  /** When omitted, returns every running + paused run. */
  runId?: string;
}

export interface WorkflowStatusOutput {
  runs: {
    id: string;
    workflowName: string;
    status: string;
    startedAt: string;
    updatedAt: string;
  }[];
}

/**
 * Return a snapshot of workflow run state. When runId is supplied, returns
 * that single run (error if not found). When omitted, returns every running
 * + paused run — the discovery shape that lets a host check "what's in
 * flight?".
 */
export async function statusWorkflow(input: WorkflowStatusInput): Promise<WorkflowStatusOutput> {
  if (input.runId !== undefined && input.runId.length > 0) {
    const run = await workflowDb.getWorkflowRun(input.runId);
    if (run === null) {
      throw new Error(`Workflow run not found: ${input.runId}`);
    }
    return {
      runs: [
        {
          id: run.id,
          workflowName: run.workflow_name,
          status: run.status,
          startedAt: run.started_at.toISOString(),
          updatedAt: (run.last_activity_at ?? run.started_at).toISOString(),
        },
      ],
    };
  }

  const { runs } = await workflowOperations.getWorkflowStatus();
  return {
    runs: runs.map(run => ({
      id: run.id,
      workflowName: run.workflow_name,
      status: run.status,
      startedAt: run.started_at.toISOString(),
      updatedAt: (run.last_activity_at ?? run.started_at).toISOString(),
    })),
  };
}

export interface WorkflowResumeInput {
  runId: string;
}

export interface WorkflowResumeOutput {
  /** runId of the resumed workflow (same as input). */
  runId: string;
  /** Workflow name. */
  workflowName: string;
  /** Status after resume (usually 'running'). */
  status: string;
}

/**
 * Resume a paused or failed workflow. Validates the run is resumable and
 * returns a confirmation shape. Does NOT block on completion — the caller
 * polls via archon_workflow_status.
 */
export async function resumeWorkflow(input: WorkflowResumeInput): Promise<WorkflowResumeOutput> {
  const run = await workflowOperations.resumeWorkflow(input.runId);
  return {
    runId: run.id,
    workflowName: run.workflow_name,
    status: run.status,
  };
}
