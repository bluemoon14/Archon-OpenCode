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
import { workflowOperations, workflowDb, workflowEventDb } from '@archon/core';
import { createLogger } from '@archon/paths';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('mcp.tools.workflow');
  return cachedLog;
}

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

// ---------------------------------------------------------------------------
// Non-blocking alternative to `runWorkflow` (Phase 4C)
// ---------------------------------------------------------------------------

export interface WorkflowStartInput {
  name: string;
  args?: string;
  branchName?: string;
  noWorktree?: boolean;
  cwd?: string;
  /** Named parameter overrides forwarded to the workflow executor. */
  params?: Record<string, string>;
}

export interface WorkflowStartOutput {
  /**
   * The workflow run ID once the run record has been created. Always returned
   * — the actual node execution continues in the background after this tool
   * call resolves.
   */
  runId: string;
  workflowName: string;
  status: 'pending' | 'running';
  /**
   * When true, execution is detached — you poll status via
   * `archon_workflow_status(runId)` or fetch events via
   * `archon_workflow_events(runId)`. Disconnect mid-run is a known
   * limitation: the in-process promise dies with the MCP server. Use
   * `archon workflow resume <runId>` from a shell to recover.
   */
  detached: true;
}

/**
 * Fire-and-return equivalent of `runWorkflow`. The workflow starts in a
 * disowned promise that runs in the same Archon process as the MCP
 * server; the tool call returns `{runId}` as soon as the run record is
 * visible in the database, allowing long-running workflows to escape
 * MCP client tool-call timeouts.
 *
 * The disowned promise attaches only a logging `.catch` so throws surface
 * in the server's log stream (stderr under `archon mcp serve`) instead of
 * becoming unhandled rejections.
 */
export async function startWorkflow(
  input: WorkflowStartInput,
  defaultCwd: string
): Promise<WorkflowStartOutput> {
  const cwd = input.cwd ?? defaultCwd;

  // Snapshot the latest run ID for this workflow name, if any, so we can
  // distinguish the one we're about to kick off from earlier ones.
  const priorRuns = await workflowDb.listWorkflowRuns({ limit: 1 });
  const priorLatestId = priorRuns[0]?.id;

  // Kick off the run. Do NOT await — this is the whole point of the
  // non-blocking tool. `.catch` absorbs errors into the workflow store
  // (which the executor itself handles via failWorkflowRun); this is the
  // safety net for bugs in the CLI wrapper above executeWorkflow.
  void workflowRunCommand(cwd, input.name, input.args ?? '', {
    branchName: input.branchName,
    noWorktree: input.noWorktree,
    ...(input.params !== undefined ? { params: input.params } : {}),
  }).catch((err: unknown) => {
    getLog().error(
      { err: err as Error, workflow: input.name },
      'mcp.workflow_start_background_failed'
    );
  });

  // Poll for up to ~3 seconds waiting for the new run to appear. This is
  // tiny compared to a typical workflow's runtime; the worst case is the
  // run record is created but the first layer hasn't started yet.
  const deadline = Date.now() + 3000;
  let runId: string | undefined;
  while (Date.now() < deadline && runId === undefined) {
    const runs = await workflowDb.listWorkflowRuns({ limit: 1 });
    const latest = runs[0];
    if (latest?.workflow_name === input.name && latest.id !== priorLatestId) {
      runId = latest.id;
      break;
    }
    await new Promise(r => setTimeout(r, 100));
  }

  if (runId === undefined) {
    // Run record didn't appear — likely a CLI-layer failure before the
    // store write. Surface as a clear error rather than a bogus runId.
    throw new Error(
      `Workflow '${input.name}' did not register a run within 3s. ` +
        'Check `archon workflow list` for the workflow name and review server logs.'
    );
  }

  return {
    runId,
    workflowName: input.name,
    status: 'running',
    detached: true,
  };
}

export interface WorkflowEventsInput {
  runId: string;
  /**
   * When supplied, only events created after the given ISO timestamp are
   * returned — enables incremental polling without re-fetching history.
   */
  sinceIso?: string;
}

export interface WorkflowEventsOutput {
  runId: string;
  events: {
    id: string;
    type: string;
    stepName: string | null;
    stepIndex: number | null;
    data: Record<string, unknown>;
    createdAt: string;
  }[];
  /**
   * ISO timestamp of the most recent event returned. Use as the next
   * call's `sinceIso` for incremental polling.
   */
  latestIso: string | null;
}

/**
 * Stream workflow events for polling consumers. Pair with
 * `archon_workflow_start` to tail a non-blocking run.
 */
export async function workflowEvents(input: WorkflowEventsInput): Promise<WorkflowEventsOutput> {
  const since = input.sinceIso !== undefined ? new Date(input.sinceIso) : undefined;
  const rows = await workflowEventDb.listRecentEvents(input.runId, since);
  const events = rows.map(row => ({
    id: row.id,
    type: row.event_type,
    stepName: row.step_name ?? null,
    stepIndex: row.step_index ?? null,
    data: row.data ?? {},
    // created_at is a TEXT column (ISO string) in both SQLite and
    // PostgreSQL dialects; pass through as-is.
    createdAt: row.created_at,
  }));
  const latestIso = events.length > 0 ? events[events.length - 1].createdAt : null;
  return { runId: input.runId, events, latestIso };
}
