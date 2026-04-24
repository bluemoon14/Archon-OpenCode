/**
 * OpenCode setup plugin.
 *
 * Detects the `opencode` binary via well-known install paths and PATH.
 * Prompts the user for an optional binary-path override (when detection
 * fails or the user wants to force a specific install), and lets them map
 * upstream provider auth to env-var NAMES. Secrets are never written to
 * YAML — the wizard only records which env-var names Archon should read
 * at runtime. The corresponding values must already be in the user's shell
 * environment (or exported via their existing auth flow).
 */
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { text, confirm, multiselect, isCancel, cancel, note } from '@clack/prompts';
import type { SetupDetection, SetupPlugin, SetupPluginResult } from '../plugins';

const OPENCODE_INSTALL_HINT =
  'Install with:\n' +
  '  curl -fsSL https://opencode.ai/install | bash\n' +
  'or `npm install -g opencode-ai`, then re-run `archon setup`.';

function whichOpenCode(): string | null {
  try {
    const out = execSync('which opencode', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function detect(): SetupDetection {
  const candidates = [
    join(homedir(), '.opencode', 'bin', 'opencode'),
    join(homedir(), '.local', 'bin', 'opencode'),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return { found: true, binaryPath: path };
  }
  const fromPath = whichOpenCode();
  if (fromPath && existsSync(fromPath)) {
    return { found: true, binaryPath: fromPath };
  }
  return { found: false, installHint: OPENCODE_INSTALL_HINT };
}

const UPSTREAM_CHOICES: { value: string; label: string; envVar: string }[] = [
  { value: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  { value: 'anthropic', label: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { value: 'google', label: 'Google (Gemini)', envVar: 'GEMINI_API_KEY' },
  { value: 'xai', label: 'xAI (Grok)', envVar: 'XAI_API_KEY' },
];

async function collect(detection: SetupDetection): Promise<SetupPluginResult | null> {
  const wants = await confirm({
    message: detection.found
      ? `OpenCode binary found at ${detection.binaryPath}. Configure OpenCode?`
      : 'OpenCode is not installed. Configure anyway (you can install it later)?',
    initialValue: detection.found,
  });
  if (isCancel(wants)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  if (!wants) return null;

  if (!detection.found && detection.installHint) {
    note(detection.installHint, 'OpenCode not found');
  }

  // Binary path override. Skipped when we auto-detected one and the user is
  // happy — saves them one prompt.
  let binaryPath: string | undefined;
  if (detection.found) {
    const overrideIt = await confirm({
      message: `Override the detected path ${detection.binaryPath}?`,
      initialValue: false,
    });
    if (isCancel(overrideIt)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (overrideIt) {
      binaryPath = await promptForBinaryPath();
    }
  } else {
    binaryPath = await promptForBinaryPath();
  }

  // Offer the LiteLLM fast-path first — one shared proxy + one master key
  // covers every upstream (Anthropic, OpenAI, Azure, Novita, ...) without
  // needing per-provider env vars on OpenCode's side.
  const useLiteLLM = await confirm({
    message:
      "Route OpenCode through your LiteLLM proxy? Uses one upstream surface for every provider — recommended if you've already run the LiteLLM setup.",
    initialValue: true,
  });
  if (isCancel(useLiteLLM)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const envLines: string[] = [];
  if (binaryPath !== undefined) envLines.push(`OPENCODE_BIN_PATH=${binaryPath}`);

  let configSnippet: string | undefined;
  let postBody: string;

  if (useLiteLLM) {
    configSnippet = buildLiteLLMConfigSnippet(binaryPath);
    postBody =
      (binaryPath !== undefined
        ? 'OPENCODE_BIN_PATH will be written to your Archon env file.\n'
        : 'Relying on PATH to locate `opencode`.\n') +
      'OpenCode is wired to use your LiteLLM proxy at http://localhost:4000. ' +
      'Ensure LITELLM_MASTER_KEY is set in your env; the proxy handles every upstream.';
  } else {
    // Per-upstream auth — map the provider IDs OpenCode supports to env-var names.
    const chosen = await multiselect({
      message:
        'Which upstream providers will OpenCode use? (env-var NAMES only — no secrets written)',
      options: UPSTREAM_CHOICES.map(c => ({
        value: c.value,
        label: `${c.label}  (${c.envVar})`,
      })),
      required: false,
    });
    if (isCancel(chosen)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }

    const providerMappings: Record<string, { authTokenEnv: string }> = {};
    for (const id of chosen) {
      const defaults = UPSTREAM_CHOICES.find(c => c.value === id);
      if (!defaults) continue;
      const custom = await text({
        message: `Env-var NAME for ${defaults.label} (press enter for ${defaults.envVar}):`,
        placeholder: defaults.envVar,
        defaultValue: defaults.envVar,
      });
      if (isCancel(custom)) {
        cancel('Setup cancelled.');
        process.exit(0);
      }
      providerMappings[id] = { authTokenEnv: custom?.trim() || defaults.envVar };
    }

    configSnippet = buildConfigSnippet(binaryPath, providerMappings);
    postBody =
      (binaryPath !== undefined
        ? 'OPENCODE_BIN_PATH will be written to your Archon env file.\n'
        : 'Relying on PATH to locate `opencode`.\n') +
      (Object.keys(providerMappings).length > 0
        ? 'Append the config snippet below to .archon/config.yaml — Archon will read the upstream API keys from the env-var names you configured.'
        : 'No upstream providers selected. OpenCode will use whatever auth its own config supplies.');
  }

  const postNote = { title: 'OpenCode configured', body: postBody };

  return { envLines, configSnippet, postNote };
}

async function promptForBinaryPath(): Promise<string | undefined> {
  const raw = await text({
    message: 'Absolute path to `opencode` (leave blank to skip):',
    placeholder: '/absolute/path/to/opencode',
  });
  if (isCancel(raw)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  const trimmed = (raw ?? '').trim();
  return trimmed || undefined;
}

function buildConfigSnippet(
  binaryPath: string | undefined,
  providers: Record<string, { authTokenEnv: string }>
): string | undefined {
  if (!binaryPath && Object.keys(providers).length === 0) return undefined;
  const lines: string[] = ['assistants:', '  opencode:'];
  if (binaryPath) lines.push(`    opencodeBinaryPath: ${binaryPath}`);
  if (Object.keys(providers).length > 0) {
    lines.push('    providers:');
    for (const [id, entry] of Object.entries(providers)) {
      lines.push(`      ${id}:`);
      lines.push(`        authTokenEnv: ${entry.authTokenEnv}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** LiteLLM fast-path: configure OpenCode to use the local LiteLLM proxy as
 *  an openai-compatible upstream. Users don't need per-provider env vars;
 *  LITELLM_MASTER_KEY + whatever the LiteLLM config exposes is enough. */
function buildLiteLLMConfigSnippet(binaryPath: string | undefined): string {
  const lines: string[] = ['assistants:', '  opencode:'];
  if (binaryPath !== undefined) lines.push(`    opencodeBinaryPath: ${binaryPath}`);
  lines.push('    # Route every OpenCode model through the LiteLLM proxy (openai-compatible).');
  lines.push('    # Change baseUrl to match your LiteLLM setup if you moved it off :4000.');
  lines.push('    baseUrl: http://localhost:4000');
  lines.push('    providers:');
  lines.push('      # OpenCode references this as its openai-compatible upstream.');
  lines.push('      # The `authTokenEnv` points at LITELLM_MASTER_KEY — the proxy fans out to');
  lines.push('      # Anthropic/Azure/Novita/etc via its own model_list.');
  lines.push('      litellm:');
  lines.push('        authTokenEnv: LITELLM_MASTER_KEY');
  return lines.join('\n') + '\n';
}

export const opencodeSetupPlugin: SetupPlugin = {
  id: 'opencode',
  displayName: 'OpenCode',
  detect,
  collect,
};
