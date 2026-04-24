/**
 * Bridge client: spawns `uv run --script archon_pydantic_bridge.py -- <agent>`,
 * frames stdout with readline, and exposes an async-generator query interface
 * on top of the JSONL wire protocol (see bridge-protocol.md).
 *
 * One bridge per sendQuery; host enforces one in-flight query at a time.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createLogger } from '@archon/paths';
import type { MessageChunk } from '../types';
import { ProviderError } from '../errors';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('pydantic.bridge');
  return cachedLog;
}

/** Path to the bundled Python bridge script. Resolved relative to this TS
 *  module so dev mode works out of the box; compiled binaries will need to
 *  materialise the script to an on-disk path first (handled by the provider). */
export function defaultBridgeScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // here === packages/providers/src/pydantic in dev
  return resolve(here, 'bridge', 'archon_pydantic_bridge.py');
}

export interface SpawnOptions {
  uvBinaryPath: string;
  bridgeScriptPath: string;
  agentEntryPath: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  /** How long to wait (ms) for the `ready` envelope before giving up. */
  readyTimeoutMs?: number;
}

export interface BridgeEnvelope {
  v?: number;
  kind: string;
  id?: string;
  [key: string]: unknown;
}

/** Safe coercion: returns `value` if string, `fallback` otherwise. Avoids
 *  `no-base-to-string` lint errors on `unknown` envelope fields. */
function toStr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Long-lived bridge wrapper. Construct once, `start()` once, `sendQuery()`
 * as many times as needed, then `shutdown()`.
 */
export class PydanticBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private pendingLines: BridgeEnvelope[] = [];
  private lineResolvers: ((envelope: BridgeEnvelope | null) => void)[] = [];
  private readyEnvelope: BridgeEnvelope | null = null;
  private procExited = false;
  private procExitCode: number | null = null;
  private stderr = '';

  constructor(private readonly opts: SpawnOptions) {}

  async start(): Promise<BridgeEnvelope> {
    if (this.proc) throw new Error('bridge already started');

    const args = ['run', '--script', this.opts.bridgeScriptPath, '--', this.opts.agentEntryPath];

    // Filter out undefined env values — node/bun don't allow them in spawn env.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...(this.opts.env ?? {}) })) {
      if (typeof v === 'string') env[k] = v;
    }

    this.proc = spawn(this.opts.uvBinaryPath, args, {
      cwd: this.opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.rl = readline.createInterface({ input: this.proc.stdout, crlfDelay: Infinity });
    this.rl.on('line', line => {
      this.onLine(line);
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      this.stderr += text;
      getLog().debug({ stderr: text }, 'pydantic.bridge.stderr');
    });

    this.proc.once('exit', code => {
      this.procExited = true;
      this.procExitCode = code;
      // Wake any pending readers with null (EOF).
      while (this.lineResolvers.length > 0) {
        const resolver = this.lineResolvers.shift();
        resolver?.(null);
      }
    });

    // Wait for `ready` or exit.
    const timeoutMs = this.opts.readyTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    while (!this.readyEnvelope && !this.procExited && Date.now() < deadline) {
      const envelope = await this.nextLine(deadline - Date.now());
      if (envelope === null) break;
      if (envelope.kind === 'ready') {
        this.readyEnvelope = envelope;
      } else if (envelope.kind === 'error' && envelope.code === 'agent_import_error') {
        await this.shutdown();
        throw new ProviderError(
          'pydantic',
          'agent_import_error',
          toStr(envelope.message, 'agent import failed')
        );
      } else {
        // Stash non-ready envelopes emitted before ready (rare).
        this.pendingLines.push(envelope);
      }
    }

    if (!this.readyEnvelope) {
      await this.shutdown();
      if (this.procExitCode !== null && this.procExitCode !== 0) {
        throw new ProviderError(
          'pydantic',
          'subprocess_crash',
          `uv run exited with code ${this.procExitCode} before emitting ready${this.stderr ? `\n--- stderr ---\n${this.stderr.trim()}` : ''}`
        );
      }
      throw new ProviderError(
        'pydantic',
        'timeout',
        `bridge did not emit ready within ${timeoutMs}ms${this.stderr ? `\n--- stderr ---\n${this.stderr.trim()}` : ''}`
      );
    }

    return this.readyEnvelope;
  }

  /**
   * Send a query and yield envelopes until the matching terminal (`result`
   * or `error` for this id). Caller translates envelopes to MessageChunks.
   */
  async *sendQuery(
    id: string,
    prompt: string,
    cwd: string,
    env?: Record<string, string>,
    /**
     * Optional system-level context (systemPrompt + resolvedSkills +
     * resolvedAgents, already folded into one string). The bridge prepends
     * this to the user prompt before calling `agent.run()` so Pydantic nodes
     * receive the same skill/agent context as Claude / OpenCode / LiteLLM.
     * See bridge-protocol.md §query envelope.
     */
    systemContext?: string
  ): AsyncGenerator<BridgeEnvelope> {
    const envelope: BridgeEnvelope = {
      v: 1,
      kind: 'query',
      id,
      prompt,
      cwd,
      env: env ?? {},
    };
    if (systemContext !== undefined && systemContext.length > 0) {
      envelope.systemContext = systemContext;
    }
    this.write(envelope);

    while (true) {
      const envelope = await this.nextLine();
      if (envelope === null) {
        // Process died mid-query.
        throw new ProviderError(
          'pydantic',
          'subprocess_crash',
          `bridge exited with code ${this.procExitCode ?? 'null'} mid-query${this.stderr ? `\n--- stderr ---\n${this.stderr.trim()}` : ''}`
        );
      }
      if (envelope.id !== undefined && envelope.id !== id) {
        // Not ours — skip.
        continue;
      }
      yield envelope;
      if (envelope.kind === 'result' || envelope.kind === 'error') return;
    }
  }

  /** In-band abort: asks the bridge to cancel the currently running query. */
  abort(id: string): void {
    this.write({ v: 1, kind: 'abort', id });
  }

  /** Graceful shutdown — sends `shutdown` and waits for exit (max 2s). */
  async shutdown(): Promise<void> {
    if (!this.proc) return;
    if (!this.procExited) {
      try {
        this.write({ v: 1, kind: 'shutdown' });
      } catch {
        // stdin may be closed; ignore.
      }
      const race = Promise.race([
        once(this.proc, 'exit'),
        new Promise<void>(r => setTimeout(r, 2000)),
      ]);
      await race;
      if (!this.procExited) {
        this.proc.kill('SIGTERM');
        await Promise.race([once(this.proc, 'exit'), new Promise<void>(r => setTimeout(r, 2000))]);
        if (!this.procExited) this.proc.kill('SIGKILL');
      }
    }
    this.rl?.close();
    this.rl = null;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let envelope: BridgeEnvelope;
    try {
      envelope = JSON.parse(line) as BridgeEnvelope;
    } catch {
      getLog().debug({ line }, 'pydantic.bridge.malformed_line');
      return;
    }
    const resolver = this.lineResolvers.shift();
    if (resolver) resolver(envelope);
    else this.pendingLines.push(envelope);
  }

  private nextLine(timeoutMs?: number): Promise<BridgeEnvelope | null> {
    const pending = this.pendingLines.shift();
    if (pending) return Promise.resolve(pending);
    if (this.procExited) return Promise.resolve(null);
    return new Promise(resolve_ => {
      this.lineResolvers.push(resolve_);
      if (timeoutMs !== undefined && timeoutMs > 0) {
        setTimeout(() => {
          const idx = this.lineResolvers.indexOf(resolve_);
          if (idx >= 0) {
            this.lineResolvers.splice(idx, 1);
            resolve_(null);
          }
        }, timeoutMs);
      }
    });
  }

  private write(envelope: BridgeEnvelope): void {
    if (!this.proc || this.procExited) {
      throw new ProviderError('pydantic', 'subprocess_crash', 'bridge process is not running');
    }
    this.proc.stdin.write(JSON.stringify(envelope) + '\n');
  }
}

/** Convert a bridge envelope to an Archon MessageChunk. Unknown kinds return
 *  null so callers can filter cleanly. */
export function envelopeToMessageChunk(envelope: BridgeEnvelope): MessageChunk | null {
  switch (envelope.kind) {
    case 'assistant':
      return { type: 'assistant', content: toStr(envelope.content) };
    case 'thinking':
      return { type: 'thinking', content: toStr(envelope.content) };
    case 'tool':
      return {
        type: 'tool',
        toolName: toStr(envelope.toolName, 'unknown'),
        toolInput:
          envelope.toolInput && typeof envelope.toolInput === 'object'
            ? (envelope.toolInput as Record<string, unknown>)
            : undefined,
        toolCallId: toStr(envelope.toolCallId) || undefined,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolName: toStr(envelope.toolName, 'unknown'),
        toolOutput: toStr(envelope.toolOutput),
        toolCallId: toStr(envelope.toolCallId) || undefined,
      };
    case 'result': {
      const tokens =
        envelope.tokens && typeof envelope.tokens === 'object'
          ? (envelope.tokens as Record<string, number>)
          : undefined;
      return {
        type: 'result',
        tokens: tokens
          ? {
              input: tokens.input ?? 0,
              output: tokens.output ?? 0,
              total: tokens.total ?? (tokens.input ?? 0) + (tokens.output ?? 0),
            }
          : undefined,
        structuredOutput: envelope.structuredOutput,
        stopReason: toStr(envelope.stopReason) || undefined,
        numTurns: typeof envelope.numTurns === 'number' ? envelope.numTurns : undefined,
      };
    }
    default:
      return null;
  }
}

/** Best-effort resolver for __dirname-style paths inside esm. Exported for
 *  the provider's fallback when import.meta.url isn't usable. */
export function bridgeScriptFallback(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'bridge', 'archon_pydantic_bridge.py');
}
