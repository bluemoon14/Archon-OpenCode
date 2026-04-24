/**
 * Tests for `getOrStartProxy` — exercises caching, concurrent-spawn
 * serialization, and external-baseUrl passthrough. Uses the
 * `__setSpawnProxyForTesting` injection hook so no real subprocess is
 * spawned; all tests run synchronously in-process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  __restoreSpawnProxy,
  __setSpawnProxyForTesting,
  getOrStartProxy,
  resetProxySingleton,
  type ProxyHandle,
  type StartProxyOptions,
} from './proxy';

interface SpawnCall {
  opts: StartProxyOptions;
  at: number;
}

let spawnCalls: SpawnCall[];
let spawnDelayMs: number;

function stubSpawnProxy(): (opts: StartProxyOptions) => Promise<ProxyHandle> {
  return opts =>
    new Promise(resolve => {
      spawnCalls.push({ opts, at: Date.now() });
      setTimeout(() => {
        resolve({
          baseUrl: `http://127.0.0.1:${String(opts.port)}`,
          external: false,
          close: () => undefined,
        });
      }, spawnDelayMs);
    });
}

beforeEach(() => {
  spawnCalls = [];
  spawnDelayMs = 20; // tiny delay so concurrent callers actually interleave
  __setSpawnProxyForTesting(stubSpawnProxy());
  resetProxySingleton();
});

afterEach(() => {
  __restoreSpawnProxy();
  resetProxySingleton();
});

describe('getOrStartProxy — external baseUrl', () => {
  test('returns an external handle without spawning', async () => {
    const handle = await getOrStartProxy({
      baseUrl: 'http://my-proxy:9000',
      configPath: '/unused',
      port: 9000,
    });
    expect(handle.external).toBe(true);
    expect(handle.baseUrl).toBe('http://my-proxy:9000');
    expect(spawnCalls).toHaveLength(0);
  });

  test('external mode skips the pending-spawn lock', async () => {
    // Kick off an in-flight spawn first, then an external call should bypass
    // the serialization and return immediately without waiting.
    spawnDelayMs = 1000;
    const spawnPromise = getOrStartProxy({ configPath: '/a', port: 4000 });
    const start = Date.now();
    const externalHandle = await getOrStartProxy({
      baseUrl: 'http://external:9999',
      configPath: '/b',
      port: 9999,
    });
    expect(Date.now() - start).toBeLessThan(100);
    expect(externalHandle.external).toBe(true);
    // Let the first spawn settle so the test doesn't leak it
    await spawnPromise;
  });
});

describe('getOrStartProxy — caching', () => {
  test('second call with matching config returns the cached handle', async () => {
    const h1 = await getOrStartProxy({ configPath: '/cfg', port: 4000 });
    const h2 = await getOrStartProxy({ configPath: '/cfg', port: 4000 });
    expect(spawnCalls).toHaveLength(1);
    expect(h2).toBe(h1);
  });

  test('different config triggers a fresh spawn + closes the previous handle', async () => {
    const h1 = await getOrStartProxy({ configPath: '/cfg1', port: 4000 });
    const h2 = await getOrStartProxy({ configPath: '/cfg2', port: 4100 });
    expect(spawnCalls).toHaveLength(2);
    expect(h2).not.toBe(h1);
    expect(h2.baseUrl).toContain('4100');
  });
});

describe('getOrStartProxy — concurrent spawn serialization', () => {
  test('two parallel calls with matching config share one spawn', async () => {
    const [h1, h2] = await Promise.all([
      getOrStartProxy({ configPath: '/cfg', port: 4000 }),
      getOrStartProxy({ configPath: '/cfg', port: 4000 }),
    ]);
    expect(spawnCalls).toHaveLength(1);
    expect(h1).toBe(h2);
  });

  test('three parallel calls also share one spawn', async () => {
    const [h1, h2, h3] = await Promise.all([
      getOrStartProxy({ configPath: '/cfg', port: 4000 }),
      getOrStartProxy({ configPath: '/cfg', port: 4000 }),
      getOrStartProxy({ configPath: '/cfg', port: 4000 }),
    ]);
    expect(spawnCalls).toHaveLength(1);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  test('failed spawn clears pendingSpawn so subsequent calls retry cleanly', async () => {
    __setSpawnProxyForTesting(async () => {
      spawnCalls.push({ opts: { configPath: '', port: 0 }, at: Date.now() });
      throw new Error('boot failed');
    });
    await expect(getOrStartProxy({ configPath: '/cfg', port: 4000 })).rejects.toThrow(
      'boot failed'
    );
    // Swap back to a succeeding stub
    __setSpawnProxyForTesting(stubSpawnProxy());
    const handle = await getOrStartProxy({ configPath: '/cfg', port: 4000 });
    expect(handle.baseUrl).toContain('4000');
    // 2 calls: the failed one, then the successful one
    expect(spawnCalls).toHaveLength(2);
  });

  test('parallel calls with mismatched configs serialize (second waits for first)', async () => {
    spawnDelayMs = 30;
    const [h1, h2] = await Promise.all([
      getOrStartProxy({ configPath: '/cfg1', port: 4000 }),
      getOrStartProxy({ configPath: '/cfg2', port: 4100 }),
    ]);
    // The second call observed the in-flight spawn, waited, saw config
    // mismatch, then kicked its own spawn — 2 spawns total, both succeed.
    expect(spawnCalls).toHaveLength(2);
    expect(h1.baseUrl).toContain('4000');
    expect(h2.baseUrl).toContain('4100');
  });
});
