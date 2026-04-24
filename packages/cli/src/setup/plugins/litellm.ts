/**
 * LiteLLM setup plugin.
 *
 * Detects `uv` (LiteLLM proxy is a Python package — `uv tool install` is the
 * lightweight path) and offers to scaffold `~/.archon/litellm_config.yaml`
 * with a `model_list` covering Anthropic, OpenAI, Azure AI Foundry, and
 * Novita. Every upstream key lives in environment variables via the
 * `os.environ/<VAR_NAME>` placeholder — no secrets in YAML.
 *
 * The plugin does NOT install litellm automatically. Installation command is
 * included in the post-setup note so the user can audit before running. This
 * matches the March 2026 supply-chain incident response: pinned version,
 * user-initiated install.
 *
 * See docs/litellm.md for the full provider matrix + pinning rationale.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { confirm, isCancel, cancel, multiselect, note } from '@clack/prompts';
import type { SetupDetection, SetupPlugin, SetupPluginResult } from '../plugins';

/**
 * Pinned LiteLLM proxy version. Post-March-2026-incident safe release.
 * Bump intentionally — audit the release notes + GitHub security advisories
 * before raising the pin. See docs/litellm.md §Security.
 */
const LITELLM_PINNED_VERSION = '1.83.0';

const UV_INSTALL_HINT =
  'Install `uv` with:\n' +
  '  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
  '  # or\n' +
  '  brew install uv\n' +
  'then re-run `archon setup`.';

type UpstreamId = 'anthropic' | 'openai' | 'azure_ai' | 'novita';

interface UpstreamSpec {
  id: UpstreamId;
  label: string;
  /** Default env var name for the API key. */
  keyEnv: string;
  /** Optional env var name for the API base — only Azure AI Foundry uses it. */
  baseEnv?: string;
  /** Sample `model_list` entries for this upstream. Users edit the file
   *  afterwards to add/remove deployments. */
  sampleModels: { modelName: string; litellmModel: string }[];
}

const UPSTREAMS: UpstreamSpec[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude via LiteLLM)',
    keyEnv: 'ANTHROPIC_API_KEY',
    sampleModels: [
      { modelName: 'claude-sonnet', litellmModel: 'anthropic/claude-sonnet-4-5' },
      { modelName: 'claude-haiku', litellmModel: 'anthropic/claude-haiku-4-5' },
      { modelName: 'claude-opus', litellmModel: 'anthropic/claude-opus-4-5' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT-4o / o-series)',
    keyEnv: 'OPENAI_API_KEY',
    sampleModels: [
      { modelName: 'gpt-4o', litellmModel: 'openai/gpt-4o' },
      { modelName: 'gpt-4o-mini', litellmModel: 'openai/gpt-4o-mini' },
    ],
  },
  {
    id: 'azure_ai',
    label: 'Azure AI Foundry (Claude / Mistral / etc.)',
    keyEnv: 'AZURE_AI_API_KEY',
    baseEnv: 'AZURE_AI_API_BASE',
    sampleModels: [
      { modelName: 'azure-claude-sonnet', litellmModel: 'azure_ai/claude-sonnet-4-5' },
    ],
  },
  {
    id: 'novita',
    label: 'Novita (DeepSeek / Llama / open weights)',
    keyEnv: 'NOVITA_API_KEY',
    sampleModels: [
      { modelName: 'novita-deepseek-r1', litellmModel: 'novita/deepseek/deepseek-r1-turbo' },
    ],
  },
];

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
  if (fromPath !== null && existsSync(fromPath)) return { found: true, binaryPath: fromPath };
  return { found: false, installHint: UV_INSTALL_HINT };
}

async function collect(detection: SetupDetection): Promise<SetupPluginResult | null> {
  const wants = await confirm({
    message: detection.found
      ? 'Configure LiteLLM (proxy for Anthropic / OpenAI / Azure / Novita)?'
      : 'uv is not installed. Configure LiteLLM anyway (install uv later)?',
    initialValue: detection.found,
  });
  if (isCancel(wants)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }
  if (!wants) return null;

  if (!detection.found && detection.installHint !== undefined) {
    note(detection.installHint, 'uv not found');
  }

  const selected = await multiselect({
    message: 'Which upstream providers do you want to enable?',
    options: UPSTREAMS.map(u => ({ value: u.id, label: u.label })),
    required: false,
    initialValues: ['anthropic', 'openai'],
  });
  if (isCancel(selected)) {
    cancel('Setup cancelled.');
    process.exit(0);
  }

  const enabledIds = selected as UpstreamId[];
  const enabledUpstreams = UPSTREAMS.filter(u => enabledIds.includes(u.id));

  const configPath = join(homedir(), '.archon', 'litellm_config.yaml');
  const wroteConfig = writeLitellmConfigFile(configPath, enabledUpstreams);

  const envLines: string[] = [];
  // Master key — generated client-side would be ideal; for now we emit a
  // placeholder and the user is expected to fill a real value into their
  // ~/.archon/.env (or rotate via `archon setup --rotate-master-key`,
  // which doesn't exist yet; tracked as a follow-up).
  envLines.push('LITELLM_MASTER_KEY=change-me-before-first-run');
  for (const u of enabledUpstreams) {
    envLines.push(`${u.keyEnv}=`);
    if (u.baseEnv !== undefined) envLines.push(`${u.baseEnv}=`);
  }

  const configSnippet = buildArchonConfigSnippet(configPath, enabledUpstreams);

  const postNote = {
    title: 'LiteLLM configured',
    body: buildPostNote({
      uvBinary: detection.found ? detection.binaryPath : undefined,
      configPath,
      wroteConfig,
      upstreams: enabledUpstreams,
    }),
  };

  return { envLines, configSnippet, postNote };
}

function writeLitellmConfigFile(path: string, upstreams: UpstreamSpec[]): boolean {
  // Don't overwrite an existing config — the user may have hand-tuned it.
  if (existsSync(path)) return false;

  mkdirSync(dirname(path), { recursive: true });

  const lines: string[] = [
    '# LiteLLM proxy configuration.',
    '# Scaffolded by `archon setup`. Edit freely — Archon does not regenerate.',
    '#',
    '# All API keys are read from environment variables via the os.environ/<VAR>',
    '# placeholder syntax. Put secrets in ~/.archon/.env (or export them in your',
    '# shell), not in this file.',
    '#',
    '# Model entries here expose user-friendly names (the `model_name`). Archon',
    '# still uses LiteLLM canonical form (provider/model) on the wire — the proxy',
    '# routes the canonical name to the upstream you configured under',
    '# litellm_params.model.',
    '',
    'model_list:',
  ];

  for (const u of upstreams) {
    for (const m of u.sampleModels) {
      lines.push(`  - model_name: ${m.modelName}`);
      lines.push('    litellm_params:');
      lines.push(`      model: ${m.litellmModel}`);
      lines.push(`      api_key: os.environ/${u.keyEnv}`);
      if (u.baseEnv !== undefined) {
        lines.push(`      api_base: os.environ/${u.baseEnv}`);
      }
    }
  }

  lines.push('');
  lines.push('general_settings:');
  lines.push('  master_key: os.environ/LITELLM_MASTER_KEY');
  lines.push('');
  lines.push('# Optional: per-request fallback chain (Archon forwards fallbackModel');
  lines.push('# on its own, so this only matters when the proxy is shared).');
  lines.push('# litellm_settings:');
  lines.push('#   default_fallbacks: ["claude-sonnet"]');
  lines.push('');

  writeFileSync(path, lines.join('\n'), 'utf-8');
  return true;
}

function buildArchonConfigSnippet(configPath: string, upstreams: UpstreamSpec[]): string {
  const providersBlock: string[] = [];
  for (const u of upstreams) {
    providersBlock.push(`      ${u.id}:`);
    providersBlock.push(`        authTokenEnv: ${u.keyEnv}`);
    if (u.baseEnv !== undefined) {
      providersBlock.push(`        apiBaseEnv: ${u.baseEnv}`);
    }
  }

  const lines = [
    'assistants:',
    '  litellm:',
    `    configPath: ${configPath}`,
    '    port: 4000',
    '    masterKeyEnv: LITELLM_MASTER_KEY',
  ];
  if (providersBlock.length > 0) {
    lines.push('    providers:');
    lines.push(...providersBlock);
  }
  return lines.join('\n') + '\n';
}

interface PostNoteInput {
  uvBinary: string | undefined;
  configPath: string;
  wroteConfig: boolean;
  upstreams: UpstreamSpec[];
}

function buildPostNote(input: PostNoteInput): string {
  const parts: string[] = [];

  const installCmd =
    input.uvBinary !== undefined
      ? `uv tool install 'litellm[proxy]==${LITELLM_PINNED_VERSION}'`
      : `pip install 'litellm[proxy]==${LITELLM_PINNED_VERSION}'  # once uv is installed, prefer: uv tool install`;
  parts.push(`Install the pinned proxy:\n  ${installCmd}`);

  if (input.wroteConfig) {
    parts.push(
      `Scaffolded ${input.configPath} with ${String(input.upstreams.length)} upstream(s).`
    );
  } else {
    parts.push(
      `${input.configPath} already exists — left it untouched. Review it to confirm the upstreams match what you selected.`
    );
  }

  parts.push(
    'Before first run: fill in the API keys listed in ~/.archon/.env. Archon refuses to spawn the proxy without LITELLM_MASTER_KEY set.'
  );

  parts.push(
    'Paste the YAML snippet below into .archon/config.yaml under assistants: — this wires Archon to your scaffolded config.'
  );

  if (input.upstreams.some(u => u.id === 'azure_ai')) {
    parts.push(
      'Azure AI Foundry gotcha: AZURE_AI_API_BASE should end at the resource endpoint (e.g. https://<resource>.services.ai.azure.com/anthropic) — LiteLLM appends /v1/messages automatically.'
    );
  }

  return parts.join('\n\n');
}

/** @internal Test hook — lets tests resolve the config file path without running collect(). */
export function defaultLitellmConfigPath(): string {
  return join(homedir(), '.archon', 'litellm_config.yaml');
}

/** @internal Test hook — exported so tests can verify scaffolded file content. */
export function scaffoldLitellmConfigForTests(path: string, upstreamIds: UpstreamId[]): boolean {
  const upstreams = UPSTREAMS.filter(u => upstreamIds.includes(u.id));
  return writeLitellmConfigFile(path, upstreams);
}

/** @internal Test hook — exported so tests can assert the archon-config snippet. */
export function buildArchonConfigSnippetForTests(
  configPath: string,
  upstreamIds: UpstreamId[]
): string {
  const upstreams = UPSTREAMS.filter(u => upstreamIds.includes(u.id));
  return buildArchonConfigSnippet(configPath, upstreams);
}

/** @internal Test hook — reads a scaffolded config back from disk. */
export function readScaffoldedConfigForTests(path: string): string {
  return readFileSync(path, 'utf-8');
}

export const litellmSetupPlugin: SetupPlugin = {
  id: 'litellm',
  displayName: 'LiteLLM',
  detect,
  collect,
};
