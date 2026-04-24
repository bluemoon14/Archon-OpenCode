import { describe, it, expect } from 'bun:test';
import { pydanticSetupPlugin } from './pydantic';

describe('pydanticSetupPlugin', () => {
  it('exposes id and displayName', () => {
    expect(pydanticSetupPlugin.id).toBe('pydantic');
    expect(pydanticSetupPlugin.displayName).toBe('Pydantic AI (BYO)');
  });

  it('detect() returns a SetupDetection with deterministic shape', () => {
    const result = pydanticSetupPlugin.detect();
    expect(typeof result.found).toBe('boolean');
    if (result.found) {
      expect(typeof result.binaryPath).toBe('string');
      expect(result.binaryPath).toBeTruthy();
    } else {
      expect(result.installHint).toBeTruthy();
    }
  });
});
