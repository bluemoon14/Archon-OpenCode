/**
 * Pure-function tests for the OpenCode SSE -> MessageChunk mapper.
 *
 * No mocks — the mapper is a total pure function over Event input, so every
 * case is just input/output equality. This covers the contract most likely
 * to break if the upstream SDK changes event shape under us.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import type { Event, Part, ToolState, AssistantMessage } from '@opencode-ai/sdk';
import { mapEvent, createMapperState, type MapperState } from './event-mapper';

const SESSION = 'session-under-test';

function textPart(
  partial: Partial<Extract<Part, { type: 'text' }>>
): Extract<Part, { type: 'text' }> {
  return {
    id: 'part-1',
    sessionID: SESSION,
    messageID: 'msg-1',
    type: 'text',
    text: '',
    ...partial,
  };
}

function reasoningPart(
  partial: Partial<Extract<Part, { type: 'reasoning' }>>
): Extract<Part, { type: 'reasoning' }> {
  return {
    id: 'part-r1',
    sessionID: SESSION,
    messageID: 'msg-1',
    type: 'reasoning',
    text: '',
    time: { start: 0 },
    ...partial,
  };
}

function toolPart(
  callID: string,
  state: ToolState,
  tool = 'bash'
): Extract<Part, { type: 'tool' }> {
  return {
    id: `tool-${callID}`,
    sessionID: SESSION,
    messageID: 'msg-1',
    type: 'tool',
    callID,
    tool,
    state,
  };
}

function partUpdated(part: Part, delta?: string): Extract<Event, { type: 'message.part.updated' }> {
  return {
    type: 'message.part.updated',
    properties: { part, ...(delta !== undefined ? { delta } : {}) },
  };
}

describe('opencode event-mapper', () => {
  let state: MapperState;

  beforeEach(() => {
    state = createMapperState(SESSION);
  });

  describe('text parts', () => {
    test('delta yields assistant chunk', () => {
      const chunks = mapEvent(partUpdated(textPart({ text: 'Hello' }), 'Hel'), state);
      expect(chunks).toEqual([{ type: 'assistant', content: 'Hel' }]);
    });

    test('empty delta is skipped', () => {
      const chunks = mapEvent(partUpdated(textPart({ text: 'Hello' }), ''), state);
      expect(chunks).toEqual([]);
    });

    test('ignored parts are skipped', () => {
      const chunks = mapEvent(
        partUpdated(textPart({ text: 'Synthetic', ignored: true }), 'Syn'),
        state
      );
      expect(chunks).toEqual([]);
    });

    test('full text without delta falls through', () => {
      const chunks = mapEvent(partUpdated(textPart({ text: 'Full body' })), state);
      expect(chunks).toEqual([{ type: 'assistant', content: 'Full body' }]);
    });

    test('parts from other sessions are filtered', () => {
      const otherSession = textPart({ text: 'Nope', sessionID: 'other-session' });
      const chunks = mapEvent(partUpdated(otherSession, 'Nope'), state);
      expect(chunks).toEqual([]);
    });
  });

  describe('reasoning parts', () => {
    test('delta yields thinking chunk', () => {
      const chunks = mapEvent(
        partUpdated(reasoningPart({ text: 'Thinking...' }), 'Thinking'),
        state
      );
      expect(chunks).toEqual([{ type: 'thinking', content: 'Thinking' }]);
    });

    test('full text without delta yields thinking chunk', () => {
      const chunks = mapEvent(partUpdated(reasoningPart({ text: 'Considered it.' })), state);
      expect(chunks).toEqual([{ type: 'thinking', content: 'Considered it.' }]);
    });
  });

  describe('tool parts', () => {
    test('running emits tool chunk once', () => {
      const running: ToolState = {
        status: 'running',
        input: { cmd: 'ls' },
        time: { start: 0 },
      };
      const chunks = mapEvent(partUpdated(toolPart('call-1', running)), state);
      expect(chunks).toEqual([
        { type: 'tool', toolName: 'bash', toolInput: { cmd: 'ls' }, toolCallId: 'call-1' },
      ]);
    });

    test('duplicate running events are deduped by callID', () => {
      const running: ToolState = { status: 'running', input: { cmd: 'ls' }, time: { start: 0 } };
      mapEvent(partUpdated(toolPart('call-1', running)), state);
      const chunks = mapEvent(partUpdated(toolPart('call-1', running)), state);
      expect(chunks).toEqual([]);
    });

    test('completed after running emits only tool_result', () => {
      const running: ToolState = { status: 'running', input: { cmd: 'ls' }, time: { start: 0 } };
      mapEvent(partUpdated(toolPart('call-1', running)), state);
      const completed: ToolState = {
        status: 'completed',
        input: { cmd: 'ls' },
        output: 'a.ts b.ts',
        title: 'ls',
        metadata: {},
        time: { start: 0, end: 1 },
      };
      const chunks = mapEvent(partUpdated(toolPart('call-1', completed)), state);
      expect(chunks).toEqual([
        {
          type: 'tool_result',
          toolName: 'bash',
          toolOutput: 'a.ts b.ts',
          toolCallId: 'call-1',
        },
      ]);
    });

    test('completed without prior running emits both chunks (fast tool)', () => {
      const completed: ToolState = {
        status: 'completed',
        input: { cmd: 'pwd' },
        output: '/home',
        title: 'pwd',
        metadata: {},
        time: { start: 0, end: 0 },
      };
      const chunks = mapEvent(partUpdated(toolPart('call-x', completed, 'shell')), state);
      expect(chunks).toEqual([
        { type: 'tool', toolName: 'shell', toolInput: { cmd: 'pwd' }, toolCallId: 'call-x' },
        { type: 'tool_result', toolName: 'shell', toolOutput: '/home', toolCallId: 'call-x' },
      ]);
    });

    test('error status produces ERROR-prefixed tool_result', () => {
      const error: ToolState = {
        status: 'error',
        input: { cmd: 'bogus' },
        error: 'command not found',
        time: { start: 0, end: 0 },
      };
      const chunks = mapEvent(partUpdated(toolPart('call-e', error)), state);
      expect(chunks).toContainEqual({
        type: 'tool_result',
        toolName: 'bash',
        toolOutput: 'ERROR: command not found',
        toolCallId: 'call-e',
      });
    });
  });

  describe('terminal messages', () => {
    const assistantMsg = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
      id: 'assistant-msg-1',
      sessionID: SESSION,
      role: 'assistant',
      time: { created: 0, completed: 100 },
      parentID: 'req-1',
      modelID: 'gpt-4o-mini',
      providerID: 'openai',
      mode: 'chat',
      path: { cwd: '/tmp', root: '/tmp' },
      cost: 0.002,
      tokens: { input: 42, output: 17, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: 'end_turn',
      ...overrides,
    });

    test('terminal message.updated emits result chunk with tokens + cost', () => {
      const chunks = mapEvent(
        { type: 'message.updated', properties: { info: assistantMsg() } },
        state
      );
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({
        type: 'result',
        sessionId: SESSION,
        tokens: { input: 42, output: 17, total: 59, cost: 0.002 },
        cost: 0.002,
        stopReason: 'end_turn',
      });
    });

    test('non-terminal message.updated (no completed time) yields nothing', () => {
      const incomplete = assistantMsg({ time: { created: 0 }, finish: undefined });
      const chunks = mapEvent({ type: 'message.updated', properties: { info: incomplete } }, state);
      expect(chunks).toEqual([]);
    });

    test('session.error yields result chunk flagged isError', () => {
      const chunks = mapEvent(
        { type: 'session.error', properties: { reason: 'oops' } } as Extract<
          Event,
          { type: 'session.error' }
        >,
        state
      );
      expect(chunks).toHaveLength(1);
      const [chunk] = chunks;
      expect(chunk?.type).toBe('result');
      if (chunk?.type === 'result') {
        expect(chunk.isError).toBe(true);
      }
    });
  });

  describe('unhandled events', () => {
    test('file.edited yields nothing', () => {
      const chunks = mapEvent({ type: 'file.edited', properties: { file: 'x.ts' } }, state);
      expect(chunks).toEqual([]);
    });

    test('session.idle yields nothing', () => {
      const chunks = mapEvent({ type: 'session.idle', properties: { sessionID: SESSION } }, state);
      expect(chunks).toEqual([]);
    });
  });
});
