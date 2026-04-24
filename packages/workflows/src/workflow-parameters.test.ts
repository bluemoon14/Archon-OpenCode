import { describe, expect, test } from 'bun:test';
import type { WorkflowDefinition } from './schemas/workflow';
import {
  WorkflowParameterError,
  parseCliParamFlags,
  resolveWorkflowParameters,
} from './workflow-parameters';

function wf(parameters?: WorkflowDefinition['parameters']): Pick<WorkflowDefinition, 'parameters'> {
  return { parameters };
}

describe('resolveWorkflowParameters', () => {
  test('returns empty when workflow has no parameters and no CLI values', () => {
    expect(resolveWorkflowParameters(wf(), {})).toEqual({});
  });

  test('applies defaults when CLI value absent', () => {
    const out = resolveWorkflowParameters(wf({ tone: { default: 'terse' } }), {});
    expect(out).toEqual({ tone: 'terse' });
  });

  test('CLI value overrides default', () => {
    const out = resolveWorkflowParameters(wf({ tone: { default: 'terse' } }), {
      tone: 'chatty',
    });
    expect(out).toEqual({ tone: 'chatty' });
  });

  test('optional param with no default resolves to empty string', () => {
    const out = resolveWorkflowParameters(wf({ note: {} }), {});
    expect(out).toEqual({ note: '' });
  });

  test('missing required param throws with name in error', () => {
    try {
      resolveWorkflowParameters(wf({ target_branch: { required: true } }), {});
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorkflowParameterError);
      expect((e as WorkflowParameterError).missingRequired).toEqual(['target_branch']);
      expect((e as Error).message).toContain('target_branch');
    }
  });

  test('required param satisfied by CLI', () => {
    const out = resolveWorkflowParameters(wf({ target_branch: { required: true } }), {
      target_branch: 'dev',
    });
    expect(out).toEqual({ target_branch: 'dev' });
  });

  test('undeclared CLI params pass through unchanged', () => {
    const out = resolveWorkflowParameters(wf(), { undeclared: 'value' });
    expect(out).toEqual({ undeclared: 'value' });
  });

  test('lists every missing required param in one error', () => {
    try {
      resolveWorkflowParameters(
        wf({
          a: { required: true },
          b: { required: true },
          c: { default: 'c-val' },
        }),
        {}
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as WorkflowParameterError).missingRequired).toEqual(['a', 'b']);
    }
  });
});

describe('parseCliParamFlags', () => {
  test('parses a single key=value flag', () => {
    expect(parseCliParamFlags(['target_branch=dev'])).toEqual({ target_branch: 'dev' });
  });

  test('parses multiple flags, later wins', () => {
    expect(parseCliParamFlags(['a=1', 'b=2', 'a=3'])).toEqual({ a: '3', b: '2' });
  });

  test('values can contain = signs', () => {
    expect(parseCliParamFlags(['url=https://example.com?foo=bar'])).toEqual({
      url: 'https://example.com?foo=bar',
    });
  });

  test('empty value is allowed', () => {
    expect(parseCliParamFlags(['note='])).toEqual({ note: '' });
  });

  test('rejects missing =', () => {
    expect(() => parseCliParamFlags(['bogus'])).toThrow(/Expected 'key=value'/);
  });

  test('rejects invalid identifier keys', () => {
    expect(() => parseCliParamFlags(['1bad=x'])).toThrow(/valid identifiers/);
  });
});
