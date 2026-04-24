/**
 * Unit tests for the OpenCode setup plugin's pure helpers. Interactive
 * `collect()` is covered only indirectly — its prompts go through @clack
 * which can't run non-interactively; those paths are exercised via the
 * end-to-end setup test (out-of-scope here).
 */
import { describe, it, expect } from 'bun:test';
import { opencodeSetupPlugin } from './opencode';

describe('opencodeSetupPlugin', () => {
  it('exposes id and displayName', () => {
    expect(opencodeSetupPlugin.id).toBe('opencode');
    expect(opencodeSetupPlugin.displayName).toBe('OpenCode');
  });

  it('detect() returns a SetupDetection with deterministic shape', () => {
    const result = opencodeSetupPlugin.detect();
    expect(typeof result.found).toBe('boolean');
    if (result.found) {
      expect(typeof result.binaryPath).toBe('string');
      expect(result.binaryPath).toBeTruthy();
    } else {
      expect(result.installHint).toBeTruthy();
    }
  });
});
