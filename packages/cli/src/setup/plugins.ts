/**
 * Setup plugin contract.
 *
 * Each non-Claude AI runtime Archon supports plugs into `archon setup` via a
 * `SetupPlugin` implementation. The wizard iterates registered plugins after
 * Claude, prompts the user per-plugin (skippable), and collects optional env
 * lines + config-yaml snippets.
 *
 * Claude stays inline in setup.ts — its legacy SetupConfig shape is locked
 * in by existing tests, and the cost of refactoring it outweighs the
 * benefit. New runtimes (OpenCode, Pydantic AI) go through this interface.
 */

export interface SetupDetection {
  /** True if the binary/runtime is reachable on this machine. */
  found: boolean;
  /** Absolute path where the binary was found, when resolution is deterministic. */
  binaryPath?: string;
  /** Human-readable install hint shown when `found === false`. */
  installHint?: string;
}

export interface SetupPluginResult {
  /** `KEY=value` lines to append to the Archon-managed .env file. */
  envLines: string[];
  /**
   * Optional YAML snippet to print for the user to paste into their
   * `.archon/config.yaml`. We never mutate the repo's config.yaml silently —
   * users copy the snippet manually so the file stays fully under their
   * control.
   */
  configSnippet?: string;
  /** Optional post-setup note rendered as a `note()` after the .env write. */
  postNote?: { title: string; body: string };
}

export interface SetupPlugin {
  /** Unique provider id — matches the registered `IAgentProvider.getType()`. */
  id: string;
  /** Display name used in prompts and summaries. */
  displayName: string;
  /** Non-interactive probe — called before the prompts to tell the user what
   *  the wizard detected. Must not block on I/O or side-effect. */
  detect(): SetupDetection;
  /** Interactive collection. Returns null if the user declined to configure
   *  this runtime (wizard skips silently). */
  collect(detection: SetupDetection): Promise<SetupPluginResult | null>;
}
