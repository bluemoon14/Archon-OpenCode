import { describe, it, expect, beforeAll } from 'bun:test';
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
import { isModelCompatible, inferProviderFromModel } from './model-validation';

// Bootstrap registry once for all tests (idempotent)
beforeAll(() => {
  clearRegistry();
  registerBuiltinProviders();
});

describe('model-validation (registry-driven)', () => {
  describe('isModelCompatible', () => {
    it('should accept any model when model is undefined', () => {
      expect(isModelCompatible('claude')).toBe(true);
    });

    it('should accept Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'sonnet')).toBe(true);
      expect(isModelCompatible('claude', 'opus')).toBe(true);
      expect(isModelCompatible('claude', 'haiku')).toBe(true);
      expect(isModelCompatible('claude', 'inherit')).toBe(true);
      expect(isModelCompatible('claude', 'claude-opus-4-6')).toBe(true);
    });

    it('should reject non-Claude models with claude provider', () => {
      expect(isModelCompatible('claude', 'gpt-4')).toBe(false);
      expect(isModelCompatible('claude', 'o1-mini')).toBe(false);
    });

    it('should handle empty string model', () => {
      // Empty string is falsy, so treated as "no model specified"
      expect(isModelCompatible('claude', '')).toBe(true);
    });

    it('should throw on unknown providers (fail-fast)', () => {
      expect(() => isModelCompatible('my-llm', 'any-model')).toThrow(/Unknown provider 'my-llm'/);
    });
  });

  describe('inferProviderFromModel', () => {
    it('should return default when model is undefined', () => {
      expect(inferProviderFromModel(undefined, 'claude')).toBe('claude');
    });

    it('should return default when model is empty string', () => {
      expect(inferProviderFromModel('', 'claude')).toBe('claude');
    });

    it('should infer claude from Claude model names', () => {
      expect(inferProviderFromModel('sonnet', 'claude')).toBe('claude');
      expect(inferProviderFromModel('opus', 'claude')).toBe('claude');
      expect(inferProviderFromModel('haiku', 'claude')).toBe('claude');
      expect(inferProviderFromModel('inherit', 'claude')).toBe('claude');
      expect(inferProviderFromModel('claude-opus-4-6', 'claude')).toBe('claude');
    });

    it('falls back to default when no built-in provider matches the model', () => {
      // No built-in matches a non-Claude model name; caller's default provider is returned.
      expect(inferProviderFromModel('gpt-4', 'claude')).toBe('claude');
      expect(inferProviderFromModel('o1-mini', 'claude')).toBe('claude');
    });
  });
});
