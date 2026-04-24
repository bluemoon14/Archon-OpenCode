import { describe, it, expect } from 'bun:test';
import { getSetupPlugins } from './registry';

describe('getSetupPlugins', () => {
  it('returns opencode and pydantic plugins', () => {
    const plugins = getSetupPlugins();
    const ids = plugins.map(p => p.id);
    expect(ids).toContain('opencode');
    expect(ids).toContain('pydantic');
    expect(plugins).toHaveLength(2);
  });

  it('each plugin exposes detect() and collect()', () => {
    for (const plugin of getSetupPlugins()) {
      expect(typeof plugin.detect).toBe('function');
      expect(typeof plugin.collect).toBe('function');
    }
  });
});
