/**
 * Pure-function tests for envelope -> MessageChunk conversion. The full
 * subprocess-spawn path requires `uv` and a live Python process — covered by
 * opt-in integration scripts, not this unit test file.
 */
import { describe, expect, test } from 'bun:test';
import { envelopeToMessageChunk, type BridgeEnvelope } from './bridge-client';

describe('envelopeToMessageChunk', () => {
  test('assistant kind maps to assistant chunk', () => {
    const chunk = envelopeToMessageChunk({ kind: 'assistant', id: 'q1', content: 'Hello' });
    expect(chunk).toEqual({ type: 'assistant', content: 'Hello' });
  });

  test('thinking kind maps to thinking chunk', () => {
    const chunk = envelopeToMessageChunk({ kind: 'thinking', id: 'q1', content: 'Reasoning...' });
    expect(chunk).toEqual({ type: 'thinking', content: 'Reasoning...' });
  });

  test('tool kind preserves toolInput object', () => {
    const chunk = envelopeToMessageChunk({
      kind: 'tool',
      id: 'q1',
      toolName: 'bash',
      toolInput: { cmd: 'ls' },
      toolCallId: 'call-abc',
    });
    expect(chunk).toEqual({
      type: 'tool',
      toolName: 'bash',
      toolInput: { cmd: 'ls' },
      toolCallId: 'call-abc',
    });
  });

  test('tool without toolInput drops it', () => {
    const chunk = envelopeToMessageChunk({
      kind: 'tool',
      id: 'q1',
      toolName: 'bash',
      toolCallId: 'call-1',
    });
    expect(chunk).toEqual({
      type: 'tool',
      toolName: 'bash',
      toolInput: undefined,
      toolCallId: 'call-1',
    });
  });

  test('tool_result maps to tool_result chunk', () => {
    const chunk = envelopeToMessageChunk({
      kind: 'tool_result',
      id: 'q1',
      toolName: 'shell',
      toolOutput: 'ok',
      toolCallId: 'call-2',
    });
    expect(chunk).toEqual({
      type: 'tool_result',
      toolName: 'shell',
      toolOutput: 'ok',
      toolCallId: 'call-2',
    });
  });

  test('result maps to result chunk with normalized tokens', () => {
    const chunk = envelopeToMessageChunk({
      kind: 'result',
      id: 'q1',
      tokens: { input: 10, output: 5, total: 15 },
      structuredOutput: { foo: 'bar' },
      stopReason: 'end',
      numTurns: 2,
    });
    expect(chunk).toEqual({
      type: 'result',
      tokens: { input: 10, output: 5, total: 15 },
      structuredOutput: { foo: 'bar' },
      stopReason: 'end',
      numTurns: 2,
    });
  });

  test('result missing total field computes it from input + output', () => {
    const chunk = envelopeToMessageChunk({
      kind: 'result',
      id: 'q1',
      tokens: { input: 3, output: 7 },
    });
    if (chunk?.type !== 'result') throw new Error('expected result chunk');
    expect(chunk.tokens).toEqual({ input: 3, output: 7, total: 10 });
  });

  test('unknown kind returns null', () => {
    expect(envelopeToMessageChunk({ kind: 'something-new' } as BridgeEnvelope)).toBeNull();
  });

  test('defensively coerces non-string fields to empty string', () => {
    // Simulates a malformed bridge that sends a number where string expected.
    const chunk = envelopeToMessageChunk({
      kind: 'assistant',
      id: 'q1',
      content: 42 as unknown as string,
    });
    expect(chunk).toEqual({ type: 'assistant', content: '' });
  });
});
