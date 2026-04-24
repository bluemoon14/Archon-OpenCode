/**
 * Pydantic AI setup plugin.
 *
 * Detects `uv` (Astral's Python package + runtime manager) and optionally
 * scans `.archon/agents/` for Python files. If the user opts in, the plugin
 * prints a config-yaml snippet mapping each discovered file to a Pydantic
 * agent name — the user pastes it into `.archon/config.yaml` themselves.
 * Never writes to the repo config (per the plan's "no silent repo mutations"
 * rule).
 *
 * No auth prompt — Pydantic agents own their upstream credentials; any env
 * they need lives in the user's shell environment, not Archon's .env file.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { text, confirm, isCancel, cancel, note } from '@clack/prompts';
import type { SetupDetection, SetupPlugin, SetupPluginResult } from '../plugins';

const UV_INSTALL_HINT =
  'Install with:\n' +
  '  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
  '  # or\n' +
  '  brew install uv\n' +
  'then re-run `archon setup`.';

function whichUv(): string | null {
  try {
    const out = execSync('which uv', {
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
    join(homedir(), '.local', 'bin', 'uv'),
    join(homedir(), '.cargo', 'bin', 'uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ];
  for (const path of candidates) {
    if (existsSync(path)) return { found: true, binaryPath: path };
  }
  const fromPath = whichUv();
  if (fromPath && existsSync(fromPath)) return { found: true, binaryPath: fromPath };
  return { found: false, installHint: UV_INSTALL_HINT };
}

async function collect(detection: SetupDetection): Promise<SetupPluginResult | null> {
  const wants = await confirm({
    message: detection.found
      ? `uv found at ${detection.binaryPath}. Configure Pydantic AI (BYO agents)?`
      : 'uv is not installed. Configure Pydantic AI anyway (you can install uv later)?',
    initialValue: detection.found,
  });
  if (isCancel(wants)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  if (!wants) return null;

  if (!detection.found && detection.installHint) {
    note(detection.installHint, 'uv not found');
  }

  // Optional binary-path override.
  let binaryPath: string | undefined;
  if (detection.found) {
    const overrideIt = await confirm({
      message: `Override the detected uv at ${detection.binaryPath}?`,
      initialValue: false,
    });
    if (isCancel(overrideIt)) {
      cancel('Setup cancelled.');
      process.exit(0);
    }
    if (overrideIt) binaryPath = await promptForBinaryPath();
  } else {
    binaryPath = await promptForBinaryPath();
  }

  // Discover agents under .archon/agents/ in the current repo. Silent skip
  // when the dir doesn't exist — the user may choose to create it later.
  const repoPath = process.cwd();
  const agentsDir = join(repoPath, '.archon', 'agents');
  let discovered: string[] = [];
  if (existsSync(agentsDir) && statSync(agentsDir).isDirectory()) {
    try {
      discovered = readdirSync(agentsDir)
        .filter(name => name.endsWith('.py') && name !== '__init__.py')
        .sort();
    } catch {
      // Directory exists but unreadable — surface as "none found" rather than
      // crashing the wizard.
      discovered = [];
    }
  }

  const envLines: string[] = [];
  if (binaryPath) envLines.push(`UV_BIN_PATH=${binaryPath}`);

  const configSnippet = buildConfigSnippet(binaryPath, discovered);
  const postNote: { title: string; body: string } = {
    title: 'Pydantic AI configured',
    body: buildPostNote(binaryPath, discovered),
  };

  return { envLines, configSnippet, postNote };
}

async function promptForBinaryPath(): Promise<string | undefined> {
  const raw = await text({
    message: 'Absolute path to `uv` (leave blank to skip):',
    placeholder: '/absolute/path/to/uv',
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
  agentFiles: string[]
): string | undefined {
  if (!binaryPath && agentFiles.length === 0) return undefined;
  const lines: string[] = ['assistants:', '  pydantic:'];
  if (binaryPath) lines.push(`    uvBinaryPath: ${binaryPath}`);
  if (agentFiles.length > 0) {
    lines.push('    agents:');
    for (const file of agentFiles) {
      const name = file.replace(/\.py$/, '');
      lines.push(`      ${name}: { entry: .archon/agents/${file} }`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildPostNote(binaryPath: string | undefined, agentFiles: string[]): string {
  const parts: string[] = [];
  if (binaryPath) {
    parts.push('UV_BIN_PATH will be written to your Archon env file.');
  } else {
    parts.push('Relying on PATH to locate `uv`.');
  }
  if (agentFiles.length > 0) {
    parts.push(
      `Found ${agentFiles.length} Python file(s) under .archon/agents/: ${agentFiles.join(', ')}.`
    );
    parts.push(
      'Paste the snippet below into .archon/config.yaml to register them as Pydantic agents.'
    );
  } else {
    parts.push(
      'No agent files found under .archon/agents/. Create one that exports `agent: pydantic_ai.Agent`, then rerun setup or register it manually.'
    );
  }
  parts.push(
    'Tip: to route your Pydantic agent through the LiteLLM proxy, construct the ' +
      'model with its base_url: `OpenAIModel("gpt-4o", base_url=os.environ["LITELLM_BASE_URL"], ' +
      'api_key=os.environ["LITELLM_MASTER_KEY"])`. Set LITELLM_BASE_URL=http://localhost:4000.'
  );
  return parts.join('\n');
}

export const pydanticSetupPlugin: SetupPlugin = {
  id: 'pydantic',
  displayName: 'Pydantic AI (BYO)',
  detect,
  collect,
};
