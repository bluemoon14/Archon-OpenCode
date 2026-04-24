/**
 * LiteLLM proxy subprocess management.
 *
 * The LiteLLM proxy is a Python process. Starting it has non-trivial cost
 * (Python interpreter boot + model_list parsing + HTTP server bind), so we
 * run a singleton per Archon process and reuse it across sendQuery calls.
 * Teardown happens at process exit — users explicitly managing a proxy
 * elsewhere can bypass spawning by setting `assistants.litellm.baseUrl`.
 *
 * Spawn command: `litellm --config <path> --port <port>`. The binary is
 * resolved from `litellmBinaryPath` (explicit) or the PATH lookup. We do NOT
 * run through `uv` here — installation is the setup plugin's job; at runtime
 * we assume the `litellm` CLI is on PATH.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '@archon/paths';
import { ProviderError } from '../errors';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.litellm.proxy');
  return cachedLog;
}

export interface ProxyHandle {
  /** `http://127.0.0.1:<port>` — base URL for the OpenAI SDK client. */
  baseUrl: string;
  /** Terminates the proxy. Only used at shutdown or in tests. */
  close(): void;
  /** True when the proxy is an external (user-managed) instance. */
  external: boolean;
}

export interface StartProxyOptions {
  /** Absolute path to `litellm_config.yaml`. Required unless `baseUrl` is set. */
  configPath: string;
  /** TCP port. Default 4000. */
  port: number;
  /** Absolute path to the `litellm` binary. When undefined we rely on PATH. */
  binaryPath?: string;
  /** Env vars passed to the spawned process (API keys etc.). */
  env?: Record<string, string>;
  /** Ready-probe timeout in milliseconds. Default 30s (model_list parse can be slow). */
  readyTimeoutMs?: number;
}

// Module-level singleton — reused across sendQuery calls within one Archon process.
let cachedHandle: ProxyHandle | undefined;
let cachedSpec: { configPath: string; port: number } | undefined;
let teardownRegistered = false;

/**
 * Return a cached running proxy when its config matches, otherwise spawn a new
 * one. When an external `baseUrl` is provided, skip spawning entirely.
 */
export async function getOrStartProxy(
  opts: StartProxyOptions & { baseUrl?: string }
): Promise<ProxyHandle> {
  if (opts.baseUrl !== undefined && opts.baseUrl.length > 0) {
    getLog().info({ baseUrl: opts.baseUrl }, 'litellm.proxy_external');
    return { baseUrl: opts.baseUrl, close: () => undefined, external: true };
  }

  if (
    cachedHandle !== undefined &&
    cachedSpec?.configPath === opts.configPath &&
    cachedSpec.port === opts.port
  ) {
    return cachedHandle;
  }

  // Config changed — tear down previous proxy if any, then spawn a fresh one.
  if (cachedHandle !== undefined && !cachedHandle.external) {
    cachedHandle.close();
    cachedHandle = undefined;
    cachedSpec = undefined;
  }

  const handle = await spawnProxy(opts);
  cachedHandle = handle;
  cachedSpec = { configPath: opts.configPath, port: opts.port };
  registerTeardownOnce();
  return handle;
}

async function spawnProxy(opts: StartProxyOptions): Promise<ProxyHandle> {
  const port = opts.port;
  const binary = opts.binaryPath ?? 'litellm';
  const args = ['--config', opts.configPath, '--port', String(port)];
  const env = { ...process.env, ...(opts.env ?? {}) };

  getLog().info({ binary, port, configPath: opts.configPath }, 'litellm.proxy_starting');

  let child: ChildProcess;
  try {
    child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: false,
    });
  } catch (err) {
    throw new ProviderError(
      'litellm',
      'subprocess_crash',
      `Failed to spawn litellm proxy (${binary}): ${(err as Error).message}`,
      err as Error
    );
  }

  // Pipe stderr for diagnostics. Keep the last ~40KB in memory so startup
  // failures surface with context rather than "unknown error".
  const stderrBuf: string[] = [];
  let stderrBytes = 0;
  child.stderr?.on('data', (d: Buffer) => {
    const s = d.toString();
    stderrBuf.push(s);
    stderrBytes += s.length;
    while (stderrBytes > 40_000 && stderrBuf.length > 1) {
      stderrBytes -= stderrBuf[0].length;
      stderrBuf.shift();
    }
  });
  child.stdout?.on('data', () => undefined); // drain so the pipe doesn't fill

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;

  try {
    await waitForReady(baseUrl, readyTimeoutMs, child);
  } catch (err) {
    const tail = stderrBuf.join('').slice(-4000);
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore — process may have already exited
    }
    throw new ProviderError(
      'litellm',
      'subprocess_crash',
      `litellm proxy did not become ready within ${String(readyTimeoutMs)}ms: ${(err as Error).message}${tail ? `\n--- last stderr ---\n${tail}` : ''}`,
      err as Error
    );
  }

  getLog().info({ baseUrl, pid: child.pid }, 'litellm.proxy_ready');

  const handle: ProxyHandle = {
    baseUrl,
    external: false,
    close: () => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already dead
      }
      if (cachedHandle === handle) {
        cachedHandle = undefined;
        cachedSpec = undefined;
      }
    },
  };
  return handle;
}

async function waitForReady(
  baseUrl: string,
  timeoutMs: number,
  child: ChildProcess
): Promise<void> {
  const started = Date.now();
  // Check /health every 200ms. LiteLLM exposes a /health/liveliness endpoint
  // that returns 200 once the HTTP server is bound. Fall back to `/health`
  // for older proxy versions.
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`proxy exited early with code ${String(child.exitCode)}`);
    }
    for (const path of ['/health/liveliness', '/health']) {
      try {
        const res = await fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(500) });
        if (res.ok) return;
      } catch {
        // connection refused while booting — keep polling
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('readiness-probe timeout');
}

function registerTeardownOnce(): void {
  if (teardownRegistered) return;
  teardownRegistered = true;
  const teardown = (): void => {
    if (cachedHandle !== undefined && !cachedHandle.external) {
      cachedHandle.close();
    }
  };
  process.once('exit', teardown);
  process.once('SIGINT', teardown);
  process.once('SIGTERM', teardown);
  process.once('beforeExit', teardown);
}

/** @internal Test hook — force teardown so the next test starts clean. */
export function resetProxySingleton(): void {
  if (cachedHandle !== undefined && !cachedHandle.external) cachedHandle.close();
  cachedHandle = undefined;
  cachedSpec = undefined;
}
