/**
 * Tests for `archon doctor`. Inject stubbed `whichFn` + `fetchFn` + `env`
 * so the probes don't depend on the host's actual Claude/opencode/litellm
 * state.
 */
import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctorProbes } from './doctor';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'archon-doctor-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function stubWhich(available: Record<string, string>): (cmd: string) => string | null {
  return cmd => (available[cmd] !== undefined ? available[cmd] : null);
}

function stubFetchUnreachable(): typeof fetch {
  return (async () => {
    throw new Error('connection refused');
  }) as unknown as typeof fetch;
}

function stubFetchOk(): typeof fetch {
  return (async () =>
    ({ ok: true, status: 200 }) as unknown as Response) as unknown as typeof fetch;
}

describe('runDoctorProbes', () => {
  test('all binaries + proxy reachable + master key set → all OK', async () => {
    const report = await runDoctorProbes({
      cwd,
      whichFn: stubWhich({
        claude: '/usr/local/bin/claude',
        opencode: '/usr/local/bin/opencode',
        uv: '/usr/local/bin/uv',
      }),
      fetchFn: stubFetchOk(),
      env: { LITELLM_MASTER_KEY: 'sk-test-1234' } as NodeJS.ProcessEnv,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(0);
    expect(report.summary.ok).toBe(6);
  });

  test('claude missing → warn with fix hint', async () => {
    const report = await runDoctorProbes({
      cwd,
      whichFn: stubWhich({
        opencode: '/usr/local/bin/opencode',
        uv: '/usr/local/bin/uv',
      }),
      fetchFn: stubFetchOk(),
      env: { LITELLM_MASTER_KEY: 'sk-x' } as NodeJS.ProcessEnv,
    });
    const claude = report.probes.find(p => p.name === 'claude binary');
    expect(claude?.status).toBe('warn');
    expect(claude?.fix).toContain('make claude');
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(report.summary.fail).toBe(0);
  });

  test('LiteLLM proxy unreachable + master key unset → two warns, no fails', async () => {
    const report = await runDoctorProbes({
      cwd,
      whichFn: stubWhich({ claude: '/c', opencode: '/o', uv: '/u' }),
      fetchFn: stubFetchUnreachable(),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBe(2);
    const proxy = report.probes.find(p => p.name === 'litellm proxy');
    expect(proxy?.status).toBe('warn');
    expect(proxy?.fix).toContain('externalBaseUrl');
    const key = report.probes.find(p => p.name === 'LITELLM_MASTER_KEY');
    expect(key?.status).toBe('warn');
  });

  test('master key is masked in OK detail', async () => {
    const report = await runDoctorProbes({
      cwd,
      whichFn: stubWhich({ claude: '/c', opencode: '/o', uv: '/u' }),
      fetchFn: stubFetchOk(),
      env: { LITELLM_MASTER_KEY: 'sk-supersecret123' } as NodeJS.ProcessEnv,
    });
    const key = report.probes.find(p => p.name === 'LITELLM_MASTER_KEY');
    expect(key?.status).toBe('ok');
    expect(key?.detail).toContain('sk-s');
    expect(key?.detail).not.toContain('supersecret');
  });
});
