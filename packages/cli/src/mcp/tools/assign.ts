/**
 * MCP tools for assigning models to skills / agents (Phase 4D).
 *
 * These are deliberately guarded by a required `confirm: true` parameter.
 * The outer AI (Claude Code, OpenCode, etc.) may not silently rewrite the
 * user's routing table; any call without `confirm=true` returns a preview
 * of the intended change so the host's human-in-the-loop can review and
 * re-issue the call. This pattern threads the needle between "let AI
 * mutate state" and "make every mutation auditable."
 *
 * Delegates to the existing `applyModelsSet` helper so we share exactly
 * the same validation + write path as `archon models set`.
 */
import { applyModelsSet, type ModelsKind } from '../../commands/models';
import {
  modelsFilePath,
  readModelsFileOrSkeleton,
  writeModelsFile,
} from '@archon/workflows/skill-agent-registry';

export interface AssignInput {
  /** Kebab-case skill or agent name to reassign. */
  name: string;
  /** Target model string (LiteLLM canonical, Claude shorthand, or alias). */
  model: string;
  /** Required to persist — any other value returns a preview only. */
  confirm?: boolean;
  /** Target scope. Default: 'project' (.archon/models.yaml). */
  scope?: 'project' | 'global';
}

export interface AssignOutput {
  kind: 'skill' | 'agent';
  name: string;
  /** The target file the change would write to (or wrote to). */
  path: string;
  /** Previous model (undefined if the entry didn't exist). */
  from: string | undefined;
  /** New model (as-supplied). */
  to: string;
  /** True when the change was actually written to disk. */
  applied: boolean;
  /** Human-readable hint if `applied=false`. */
  note?: string;
}

async function doAssign(
  kind: 'skill' | 'agent',
  input: AssignInput,
  cwd: string
): Promise<AssignOutput> {
  const scope: 'project' | 'global' = input.scope ?? 'project';
  const path = modelsFilePath(scope, { repoRoot: cwd });
  const file = await readModelsFileOrSkeleton(path);

  const group: ModelsKind = kind;
  const priorMap = kind === 'skill' ? file.skills : file.agents;
  const from = priorMap?.[input.name];

  if (input.confirm !== true) {
    return {
      kind,
      name: input.name,
      path,
      from,
      to: input.model,
      applied: false,
      note: `Preview only — to apply, re-issue with confirm: true. Target: ${path}`,
    };
  }

  const updated = applyModelsSet(file, group, input.name, input.model);
  await writeModelsFile(path, updated);

  return {
    kind,
    name: input.name,
    path,
    from,
    to: input.model,
    applied: true,
  };
}

export async function assignSkillModel(input: AssignInput, cwd: string): Promise<AssignOutput> {
  return doAssign('skill', input, cwd);
}

export async function assignAgentModel(input: AssignInput, cwd: string): Promise<AssignOutput> {
  return doAssign('agent', input, cwd);
}
