/**
 * Workflow named parameter resolution.
 *
 * Takes the workflow-level `parameters:` declaration plus a `--param key=value`
 * map from the CLI and produces the flat `namedParams` record consumed by the
 * DAG executor's variable substitution. Validates that every `required: true`
 * parameter has either a `default` or a CLI value — missing required params
 * throw before the run starts, so users get a crisp error at invocation
 * instead of mid-run.
 *
 * Pure + no IO. Lives in its own module so CLI (workflow run), MCP
 * (archon_workflow_start), and tests all share the same resolution logic.
 */
import type { WorkflowDefinition } from './schemas/workflow';

export class WorkflowParameterError extends Error {
  constructor(
    message: string,
    public readonly missingRequired: string[] = []
  ) {
    super(message);
    this.name = 'WorkflowParameterError';
  }
}

/**
 * Resolve the effective `namedParams` for a workflow invocation.
 *
 * Precedence (highest wins):
 *   1. `cliParams[name]` — `--param name=value` from CLI or API caller
 *   2. `parameters[name].default`
 *
 * If a parameter declares `required: true` and neither tier supplies a
 * value, throws `WorkflowParameterError` listing every missing param so
 * the user can fix them all in one go.
 *
 * Parameter names declared in the workflow but never referenced in node
 * text are still included in the output — `$PARAM_<name>` just happens to
 * not appear. This keeps the resolution independent of prompt text.
 */
export function resolveWorkflowParameters(
  workflow: Pick<WorkflowDefinition, 'parameters'>,
  cliParams: Record<string, string> = {}
): Record<string, string> {
  const decl = workflow.parameters;
  const result: Record<string, string> = {};
  const missing: string[] = [];

  // Accept CLI params that aren't declared, too — forward-compatible with
  // workflow definitions that gain new parameters. Undeclared CLI params
  // still substitute; they just don't benefit from default/required checks.
  for (const [name, value] of Object.entries(cliParams)) {
    result[name] = value;
  }

  if (decl !== undefined) {
    for (const [name, spec] of Object.entries(decl)) {
      if (result[name] !== undefined) continue; // CLI override already set
      if (spec.default !== undefined) {
        result[name] = spec.default;
        continue;
      }
      if (spec.required === true) {
        missing.push(name);
      } else {
        // Non-required with no default: resolve to empty string so
        // `$PARAM_<name>` references render cleanly.
        result[name] = '';
      }
    }
  }

  if (missing.length > 0) {
    throw new WorkflowParameterError(
      `Missing required workflow parameter(s): ${missing.join(', ')}. ` +
        'Pass with `--param <name>=<value>` or declare a `default:` in the workflow.',
      missing
    );
  }

  return result;
}

/**
 * Parse CLI `--param` flag values of the form `key=value` into a record.
 * Duplicate keys: later wins. Malformed entries (no `=` separator) throw.
 */
export function parseCliParamFlags(flagValues: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of flagValues) {
    const idx = raw.indexOf('=');
    if (idx <= 0) {
      throw new Error(
        `Invalid --param value '${raw}'. Expected 'key=value' (e.g. --param target_branch=dev).`
      );
    }
    const key = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --param key '${key}'. Parameter names must be valid identifiers.`);
    }
    out[key] = value;
  }
  return out;
}
