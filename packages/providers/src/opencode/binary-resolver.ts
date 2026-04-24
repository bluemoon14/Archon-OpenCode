/**
 * OpenCode binary resolver.
 *
 * `@opencode-ai/sdk`'s `createOpencodeServer` spawns `opencode` via PATH
 * lookup (cross-spawn). To support custom binary paths without reimplementing
 * spawn+readiness, we prepend the configured binary's directory to PATH
 * before calling into the SDK.
 *
 * Resolution order (binary mode only):
 * 1. `OPENCODE_BIN_PATH` environment variable
 * 2. `assistants.opencode.opencodeBinaryPath` in config
 * 3. Autodetect canonical install paths
 * 4. Throw ProviderError('opencode','binary_not_found', …)
 *
 * In dev mode (BUNDLED_IS_BINARY=false), returns undefined so the SDK's
 * default PATH lookup applies.
 */
import { existsSync as _existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BUNDLED_IS_BINARY, createLogger } from '@archon/paths';
import { ProviderError } from '../errors';

/** Wrapper for existsSync — enables spyOn in tests (direct imports can't be spied on). */
export function fileExists(path: string): boolean {
  return _existsSync(path);
}

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('opencode-binary');
  return cachedLog;
}

const INSTALL_INSTRUCTIONS =
  'OpenCode binary not found. Archon spawns `opencode serve` per session and\n' +
  'needs it reachable at a known path.\n\n' +
  'Install:\n' +
  '  macOS / Linux:  curl -fsSL https://opencode.ai/install | bash\n' +
  '  npm:            npm install -g opencode-ai\n\n' +
  'Then either add the install directory to PATH, set OPENCODE_BIN_PATH, or\n' +
  'record the path in ~/.archon/config.yaml:\n\n' +
  '  assistants:\n' +
  '    opencode:\n' +
  '      opencodeBinaryPath: /absolute/path/to/opencode';

/**
 * Resolve the absolute path to the `opencode` executable. Returns undefined
 * in dev mode (lets the SDK's PATH lookup resolve naturally).
 */
export async function resolveOpencodeBinaryPath(
  configBinaryPath?: string
): Promise<string | undefined> {
  if (!BUNDLED_IS_BINARY) return undefined;

  const envPath = process.env.OPENCODE_BIN_PATH;
  if (envPath) {
    if (!fileExists(envPath)) {
      throw new ProviderError(
        'opencode',
        'binary_not_found',
        `OPENCODE_BIN_PATH is set to "${envPath}" but the file does not exist.`
      );
    }
    getLog().info({ binaryPath: envPath, source: 'env' }, 'opencode.binary_resolved');
    return envPath;
  }

  if (configBinaryPath) {
    if (!fileExists(configBinaryPath)) {
      throw new ProviderError(
        'opencode',
        'binary_not_found',
        `assistants.opencode.opencodeBinaryPath is set to "${configBinaryPath}" but the file does not exist.`
      );
    }
    getLog().info({ binaryPath: configBinaryPath, source: 'config' }, 'opencode.binary_resolved');
    return configBinaryPath;
  }

  // Canonical install locations
  const candidates = [
    join(homedir(), '.opencode', 'bin', 'opencode'),
    join(homedir(), '.local', 'bin', 'opencode'),
  ];
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      getLog().info({ binaryPath: candidate, source: 'autodetect' }, 'opencode.binary_resolved');
      return candidate;
    }
  }

  throw new ProviderError('opencode', 'binary_not_found', INSTALL_INSTRUCTIONS);
}

/**
 * Return a PATH string with the binary's directory prepended. Lets the
 * OpenCode SDK's `cross-spawn('opencode', …)` resolve to the configured
 * binary without re-implementing readiness detection.
 *
 * Returns undefined when no custom binary is resolved — caller leaves PATH
 * untouched.
 */
export function prependBinaryDirToPath(binaryPath: string | undefined): string | undefined {
  if (!binaryPath) return undefined;
  const dir = dirname(binaryPath);
  const current = process.env.PATH ?? '';
  return current.length > 0 ? `${dir}:${current}` : dir;
}
