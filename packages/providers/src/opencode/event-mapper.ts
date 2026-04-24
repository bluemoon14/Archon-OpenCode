/**
 * Pure transform: OpenCode SSE event → zero or more Archon MessageChunks.
 *
 * Separated from the provider so it's trivially testable without mocking
 * spawn, HTTP, or SSE streams. The provider feeds raw events from
 * `client.event.subscribe()` through this function and yields the results.
 */
import type { MessageChunk } from '../types';
import type { Event, AssistantMessage, ToolPart } from '@opencode-ai/sdk';

/**
 * Track which tool callIDs we've already emitted a `tool` chunk for so a
 * later `state.status === 'completed'` yields only the `tool_result` and
 * doesn't double-emit the call.
 */
export interface MapperState {
  toolCallStarted: Set<string>;
  /**
   * Session ID the provider assigned to this sendQuery. `message.updated`
   * events for OTHER sessions (e.g. sub-sessions OpenCode spawns internally)
   * are filtered — we only surface chunks scoped to the caller's session.
   */
  sessionID: string;
}

export function createMapperState(sessionID: string): MapperState {
  return { toolCallStarted: new Set(), sessionID };
}

/**
 * Convert an OpenCode event to chunks. Returns an empty array for events
 * that don't produce user-visible chunks (session.status, file.edited,
 * internal-only bookkeeping).
 *
 * Does NOT throw on `session.error` — the provider layer decides whether to
 * throw or to yield a `result` chunk with `isError: true`. Keeping errors as
 * data here lets the mapper stay pure.
 */
export function mapEvent(event: Event, state: MapperState): MessageChunk[] {
  switch (event.type) {
    case 'message.part.updated':
      return mapPartUpdated(event, state);
    case 'message.updated':
      return mapMessageUpdated(event, state);
    case 'session.error':
      return [
        {
          type: 'result',
          sessionId: state.sessionID,
          isError: true,
          errors: [
            event.properties && typeof event.properties === 'object'
              ? JSON.stringify(event.properties)
              : 'unknown opencode session error',
          ],
        },
      ];
    default:
      return [];
  }
}

function mapPartUpdated(
  event: Extract<Event, { type: 'message.part.updated' }>,
  state: MapperState
): MessageChunk[] {
  const { part, delta } = event.properties;
  if (part.sessionID !== state.sessionID) return [];

  switch (part.type) {
    case 'text': {
      // Prefer incremental deltas when available; otherwise the full text is
      // the event payload (e.g. a synthetic/tool-injected assistant message).
      const content = delta ?? part.text;
      if (!content) return [];
      if (part.ignored) return [];
      return [{ type: 'assistant', content }];
    }
    case 'reasoning': {
      const content = delta ?? part.text;
      if (!content) return [];
      return [{ type: 'thinking', content }];
    }
    case 'tool':
      return mapToolPart(part, state);
    default:
      // file, step-start, step-finish, snapshot, patch, agent, retry,
      // compaction, subtask — not surfaced as chunks today. Cost/tokens
      // arrive on the terminal AssistantMessage via message.updated.
      return [];
  }
}

function mapMessageUpdated(
  event: Extract<Event, { type: 'message.updated' }>,
  state: MapperState
): MessageChunk[] {
  const msg = event.properties.info;
  if (msg.role !== 'assistant') return [];
  if (msg.sessionID !== state.sessionID) return [];
  // Only the terminal update carries `time.completed` + `finish`.
  if (!msg.time.completed || !msg.finish) return [];
  return [assistantMessageToResult(msg)];
}

function mapToolPart(part: ToolPart, state: MapperState): MessageChunk[] {
  const status = part.state.status;
  const toolCallChunk = (): MessageChunk => ({
    type: 'tool',
    toolName: part.tool,
    toolInput: part.state.input,
    toolCallId: part.callID,
  });

  if (status === 'pending' || status === 'running') {
    if (state.toolCallStarted.has(part.callID)) return [];
    state.toolCallStarted.add(part.callID);
    return [toolCallChunk()];
  }

  // `completed` and `error` — always emit a tool_result, and prepend the
  // tool-call chunk if we didn't already see the running state.
  const out: MessageChunk[] = [];
  if (!state.toolCallStarted.has(part.callID)) {
    state.toolCallStarted.add(part.callID);
    out.push(toolCallChunk());
  }
  const toolOutput = status === 'completed' ? part.state.output : `ERROR: ${part.state.error}`;
  out.push({
    type: 'tool_result',
    toolName: part.tool,
    toolOutput,
    toolCallId: part.callID,
  });
  return out;
}

function assistantMessageToResult(msg: AssistantMessage): MessageChunk {
  return {
    type: 'result',
    sessionId: msg.sessionID,
    tokens: {
      input: msg.tokens.input,
      output: msg.tokens.output,
      total: msg.tokens.input + msg.tokens.output,
      cost: msg.cost,
    },
    cost: msg.cost,
    stopReason: msg.finish,
    isError: msg.error !== undefined,
    ...(msg.error !== undefined
      ? { errors: [typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)] }
      : {}),
  };
}
