/**
 * Resolve the `uv` binary (https://docs.astral.sh/uv) that Archon uses to
 * spawn the Pydantic AI stdio bridge. uv's `--script` mode reads PEP 723
 * inline metadata from the bridge and user-agent files and resolves their
 * Python deps on the fly, so a separate virtualenv is not required.
 *
 * Resolution order:
 *   1. `UV_BIN_PATH` env var
 *   2. `assistants.pydantic.uvBinaryPath` in config
 *   3. Autodetect canonical install paths (`~/.local/bin/uv`, `~/.cargo/bin/uv`,
 *      `/opt/homebrew/bin/uv`, `/usr/local/bin/uv`)
 *   4. `which uv` (best-effort; if PATH is clean and uv is installed
 *      system-wide, it will be found)
 *   5. Throw ProviderError('pydantic','binary_not_found', …)
 */
import { existsSync as _existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLogger } from '@archon/paths';
import { ProviderError } from '../errors';

export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('pydantic-python');
  return cachedLog;
}

const INSTALL_INSTRUCTIONS =
  'uv not found. Archon needs uv to run Pydantic AI agent scripts.\n\n' +
  'Install:\n' +
  '  macOS / Linux:  curl -LsSf https://astral.sh/uv/install.sh | sh\n' +
  '  Homebrew:       brew install uv\n' +
  '  pip:            pip install uv\n\n' +
  'Then add the install directory to PATH, set UV_BIN_PATH, or record the\n' +
  'path in .archon/config.yaml:\n\n' +
  '  assistants:\n' +
  '    pydantic:\n' +
  '      uvBinaryPath: /absolute/path/to/uv\n\n' +
  'See https://docs.astral.sh/uv/getting-started/installation/';

export function resolveUvBinaryPath(configUvPath?: string): string {
  const envPath = process.env.UV_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new ProviderError(
        'pydantic',
        'binary_not_found',
        `UV_BIN_PATH is set to "${envPath}" but the file does not exist.`
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'pydantic.uv_resolved');
    return envPath;
  }

  if (configUvPath) {
    if (!fileExists(configUvPath)) {
      throw new ProviderError(
        'pydantic',
        'binary_not_found',
        `assistants.pydantic.uvBinaryPath is set to "${configUvPath}" but the file does not exist.`
      );
    }
    getLog().info({ binaryPath: configUvPath, source: 'config' }, 'pydantic.uv_resolved');
    return configUvPath;
  }

  const candidates = [
    join(homedir(), '.local', 'bin', 'uv'),
    join(homedir(), '.cargo', 'bin', 'uv'),
    '/opt/homebrew/bin/uv',
    '/usr/local/bin/uv',
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      getLog().info({ binaryPath: candidate, source: 'autodetect' }, 'pydantic.uv_resolved');
      return candidate;
    }
  }

  // Last resort: fall back to PATH lookup.
  try {
    const out = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    if (out && fileExists(out)) {
      getLog().info({ binaryPath: out, source: 'which' }, 'pydantic.uv_resolved');
      return out;
    }
  } catch {
    // `which` failed — fall through to the install-instructions throw.
  }

  throw new ProviderError('pydantic', 'binary_not_found', INSTALL_INSTRUCTIONS);
}
