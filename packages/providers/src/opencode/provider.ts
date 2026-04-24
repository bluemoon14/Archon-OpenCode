/**
 * OpenCode agent provider.
 *
 * Spawns one `opencode serve` subprocess per sendQuery via the SDK's
 * `createOpencodeServer` helper (handles cross-spawn + readiness + teardown).
 * Honours `assistants.opencode.baseUrl` as an escape hatch for users running
 * their own server — in that mode we skip spawn and use
 * `createOpencodeClient({ baseUrl })` directly.
 */
import type {
  IAgentProvider,
  MessageChunk,
  SendQueryOptions,
  ProviderCapabilities,
} from '../types';
import { ProviderError } from '../errors';
import { createLogger } from '@archon/paths';
import {
  createOpencodeClient,
  createOpencodeServer,
  type OpencodeClient,
  type Event,
} from '@opencode-ai/sdk';
import { parseOpenCodeConfig, parseOpenCodeModel, resolveOpencodeAuthEnv } from './config';
import { resolveOpencodeBinaryPath, prependBinaryDirToPath } from './binary-resolver';
import { OPENCODE_CAPABILITIES } from './capabilities';
import { createMapperState, mapEvent } from './event-mapper';
import { buildResolvedSystemPrompt } from '../resolved-content-prompt';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('provider.opencode');
  return cachedLog;
}

export class OpenCodeProvider implements IAgentProvider {
  getType(): string {
    return 'opencode';
  }

  getCapabilities(): ProviderCapabilities {
    return OPENCODE_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions
  ): AsyncGenerator<MessageChunk> {
    const cfg = parseOpenCodeConfig(options?.assistantConfig);

    // Decide: spawn our own server or connect to a user-managed one?
    let client: OpencodeClient;
    let close: (() => void) | undefined;

    if (cfg.baseUrl) {
      getLog().info({ baseUrl: cfg.baseUrl }, 'opencode.client_mode');
      client = createOpencodeClient({ baseUrl: cfg.baseUrl });
    } else {
      const binaryPath = await resolveOpencodeBinaryPath(cfg.opencodeBinaryPath);
      // Prepend the binary's dir to PATH for this process so the SDK's
      // internal cross-spawn('opencode', …) resolves to our chosen binary.
      // The override lasts only for the spawn call below — we restore PATH
      // immediately after.
      const originalPath = process.env.PATH;
      const newPath = prependBinaryDirToPath(binaryPath);
      if (newPath) process.env.PATH = newPath;

      const authEnv = resolveOpencodeAuthEnv(cfg);
      const mergedEnv = { ...authEnv, ...options?.env };
      const savedEnvValues: [string, string | undefined][] = [];
      for (const [k, v] of Object.entries(mergedEnv)) {
        savedEnvValues.push([k, process.env[k]]);
        process.env[k] = v;
      }

      let server: { url: string; close(): void };
      try {
        server = await createOpencodeServer({
          hostname: '127.0.0.1',
          port: 0, // ask the OS for a free port
          signal: options?.abortSignal,
          timeout: 15000,
        });
      } catch (err) {
        throw new ProviderError(
          'opencode',
          'subprocess_crash',
          `Failed to start opencode serve: ${(err as Error).message}`,
          err as Error
        );
      } finally {
        // Restore PATH + env immediately — the server has already spawned
        // its own child with the snapshot it needed.
        restoreEnvVar('PATH', originalPath);
        for (const [k, v] of savedEnvValues) restoreEnvVar(k, v);
      }

      client = createOpencodeClient({ baseUrl: server.url });
      close = (): void => {
        server.close();
      };
      getLog().info({ url: server.url }, 'opencode.server_ready');
    }

    let sessionID: string;
    try {
      if (resumeSessionId) {
        const resp = await client.session.get({ path: { id: resumeSessionId } });
        if ('data' in resp && resp.data) {
          sessionID = resp.data.id;
        } else {
          throw new ProviderError(
            'opencode',
            'unknown',
            `Session ${resumeSessionId} not found on opencode server`
          );
        }
      } else {
        const resp = await client.session.create({
          body: {},
          query: { directory: cwd },
        });
        if ('data' in resp && resp.data) {
          sessionID = resp.data.id;
        } else {
          throw new ProviderError(
            'opencode',
            'unknown',
            'opencode session.create returned no data'
          );
        }
      }
    } catch (err) {
      close?.();
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(
        'opencode',
        'unknown',
        `session establish failed: ${(err as Error).message}`,
        err as Error
      );
    }

    const model = parseOpenCodeModel(options?.model);

    // Subscribe to the event stream BEFORE sending the prompt so we don't
    // miss the first part update. The prompt call itself resolves when the
    // server accepts the request — events arrive asynchronously.
    const eventsResp = await client.event.subscribe();
    if (!('stream' in eventsResp) || !eventsResp.stream) {
      close?.();
      throw new ProviderError('opencode', 'unknown', 'failed to subscribe to opencode events');
    }
    const stream = eventsResp.stream as AsyncIterable<Event>;

    // Merge the node-level systemPrompt with Archon-resolved skill/agent
    // content so OpenCode's session sees the same context as Claude/LiteLLM.
    // When nothing to inject, OpenCode defaults apply.
    const systemContent = buildResolvedSystemPrompt({
      systemPrompt: options?.systemPrompt,
      resolvedSkills: options?.resolvedSkills,
      resolvedAgents: options?.resolvedAgents,
    });

    // Fire the prompt; don't await its final result here. The stream yields
    // terminal `message.updated` with `finish` set — that's our signal.
    const promptPromise = client.session.prompt({
      path: { id: sessionID },
      body: {
        parts: [{ type: 'text', text: prompt }],
        ...(model ? { model } : {}),
        ...(options?.nodeConfig?.allowed_tools || options?.nodeConfig?.denied_tools
          ? { tools: buildToolFilter(options.nodeConfig) }
          : {}),
        ...(systemContent !== undefined ? { system: systemContent } : {}),
      },
    });

    const mapperState = createMapperState(sessionID);
    let done = false;
    try {
      for await (const event of stream) {
        if (options?.abortSignal?.aborted) break;
        const chunks = mapEvent(event, mapperState);
        for (const chunk of chunks) {
          yield chunk;
          if (chunk.type === 'result') {
            done = true;
          }
        }
        if (done) break;
      }
    } finally {
      // Always stop in-flight work and close the server/process.
      try {
        if (options?.abortSignal?.aborted) {
          await client.session.abort({ path: { id: sessionID } });
        }
      } catch (err) {
        getLog().debug({ err, sessionID }, 'opencode.abort_ignored');
      }
      // Drain the prompt promise so we don't leak unhandled rejections.
      promptPromise.catch((err: Error): void => {
        getLog().debug({ err: err.message }, 'opencode.prompt_promise_ignored');
      });
      close?.();
    }
  }
}

/**
 * Restore a process.env var to a prior value. When the prior value was
 * undefined we need an actual deletion — `env[k] = undefined` stringifies
 * to the literal "undefined" inside cross-spawn's snapshot. Reflect.deleteProperty
 * sidesteps the eslint no-dynamic-delete rule while doing the right thing.
 */
function restoreEnvVar(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

/** Build OpenCode's `tools` filter map from nodeConfig allowed/denied lists. */
function buildToolFilter(
  nodeConfig: { allowed_tools?: string[]; denied_tools?: string[] } | undefined
): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  if (nodeConfig?.allowed_tools) {
    for (const t of nodeConfig.allowed_tools) map[t] = true;
  }
  if (nodeConfig?.denied_tools) {
    for (const t of nodeConfig.denied_tools) map[t] = false;
  }
  return map;
}
