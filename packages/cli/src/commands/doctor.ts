/**
 * `archon doctor` — health-check command.
 *
 * Runs a fixed set of probes and reports OK / WARN / FAIL with an
 * actionable fix hint per failure. Addresses the cheatsheet improvement
 * suggestion #8: "one command to check everything Archon needs." All
 * probes are strictly read-only — no writes, no network calls except the
 * LiteLLM liveliness probe.
 *
 * Exit codes:
 *   0 = all probes OK (warns are fine)
 *   1 = at least one probe FAILED
 *
 * Each probe is isolated so one failure doesn't abort the others — the
 * idea is that a user can see the full landscape in one pass.
 */
import { parseLiteLLMConfig } from '@archon/providers/litellm/config';

export type ProbeStatus = 'ok' | 'warn' | 'fail';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  detail: string;
  /** Hint on how to fix a warn/fail — omitted for OK. */
  fix?: string;
}

export interface DoctorOptions {
  cwd: string;
  json?: boolean;
  /** Injected for tests. Defaults to real implementations. */
  whichFn?: (cmd: string) => string | null;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

async function whichViaShell(cmd: string): Promise<string | null> {
  // Bun.which is the idiomatic lookup; fall back to null if not found.
  // Bun is guaranteed at runtime (the CLI binary is a Bun binary).
  const found = Bun.which(cmd);
  return found ?? null;
}

/** Probe: Claude Code CLI on PATH. */
async function probeClaude(
  whichFn: (cmd: string) => Promise<string | null> | string | null
): Promise<ProbeResult> {
  const path = await whichFn('claude');
  if (path !== null) {
    return { name: 'claude binary', status: 'ok', detail: path };
  }
  return {
    name: 'claude binary',
    status: 'warn',
    detail: 'not on PATH',
    fix: 'Install with `make claude` or `curl -fsSL https://claude.ai/install.sh | bash`.',
  };
}

async function probeOpenCode(
  whichFn: (cmd: string) => Promise<string | null> | string | null
): Promise<ProbeResult> {
  const path = await whichFn('opencode');
  if (path !== null) {
    return { name: 'opencode binary', status: 'ok', detail: path };
  }
  return {
    name: 'opencode binary',
    status: 'warn',
    detail: 'not on PATH',
    fix: 'Install with `make opencode`. Skip this probe if you do not use OpenCode.',
  };
}

async function probeUv(
  whichFn: (cmd: string) => Promise<string | null> | string | null
): Promise<ProbeResult> {
  const path = await whichFn('uv');
  if (path !== null) {
    return { name: 'uv (Pydantic AI runtime)', status: 'ok', detail: path };
  }
  return {
    name: 'uv (Pydantic AI runtime)',
    status: 'warn',
    detail: 'not on PATH',
    fix: 'Install with `make pydantic`. Skip this probe if you do not use Pydantic AI.',
  };
}

async function probeLiteLLMProxy(fetchImpl: typeof fetch): Promise<ProbeResult> {
  // v1 probes the default local URL (http://localhost:4000) since that's
  // what the spawn path uses and what the external-proxy escape hatch
  // documents. When `assistants.litellm.baseUrl` lives in config.yaml, a
  // follow-up plumbs that through.
  const cfg = parseLiteLLMConfig({});
  const baseUrl = `http://localhost:${cfg.port}`;

  try {
    const res = await fetchImpl(`${baseUrl}/health/liveliness`, {
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) {
      return { name: 'litellm proxy', status: 'ok', detail: `reachable at ${baseUrl}` };
    }
    return {
      name: 'litellm proxy',
      status: 'warn',
      detail: `${baseUrl} returned HTTP ${res.status}`,
      fix: 'Check the proxy logs — start it with `uvx litellm --config ~/.archon/litellm_config.yaml`.',
    };
  } catch {
    return {
      name: 'litellm proxy',
      status: 'warn',
      detail: `not reachable at ${baseUrl}`,
      fix:
        'Start the proxy (Archon auto-spawns on first query) or set ' +
        '`assistants.litellm.externalBaseUrl` if you run one elsewhere. ' +
        'Skip if you do not use LiteLLM.',
    };
  }
}

function probeMasterKey(env: NodeJS.ProcessEnv): ProbeResult {
  if (env.LITELLM_MASTER_KEY !== undefined && env.LITELLM_MASTER_KEY.length > 0) {
    return {
      name: 'LITELLM_MASTER_KEY',
      status: 'ok',
      detail: `set (${env.LITELLM_MASTER_KEY.slice(0, 4)}…)`,
    };
  }
  return {
    name: 'LITELLM_MASTER_KEY',
    status: 'warn',
    detail: 'unset',
    fix:
      "Set in ~/.archon/.env or ~/.archon/litellm_config.yaml's master_key. " +
      'Required only if you use the LiteLLM proxy.',
  };
}

/**
 * Audit `assistants.litellm.providers[*].authTokenEnv` across every tier.
 * Failing this probe means your models.yaml / config.yaml references an
 * env var that doesn't actually exist at runtime — LiteLLM will 401.
 *
 * For v1 the probe only reads from the current process env (no shell rc
 * sourcing). Matches what Archon actually sees when it spawns the proxy.
 */
function probeAuthTokenEnvs(
  // Future wiring: plumb through the parsed litellm config from
  // config.yaml. For v1 we accept an explicit list so tests + the CLI
  // entry can pass a concrete set.
  tokenEnvNames: string[],
  env: NodeJS.ProcessEnv
): ProbeResult {
  if (tokenEnvNames.length === 0) {
    return {
      name: 'authTokenEnv audit',
      status: 'ok',
      detail: 'no upstream provider env vars declared',
    };
  }
  const unset = tokenEnvNames.filter(n => {
    const v = env[n];
    return v === undefined || v.length === 0;
  });
  if (unset.length === 0) {
    return {
      name: 'authTokenEnv audit',
      status: 'ok',
      detail: `${tokenEnvNames.length} env var(s) set`,
    };
  }
  return {
    name: 'authTokenEnv audit',
    status: 'fail',
    detail: `unset: ${unset.join(', ')}`,
    fix: 'Export the missing env var(s) in your shell or ~/.archon/.env so LiteLLM can reach upstream.',
  };
}

export interface DoctorReport {
  probes: ProbeResult[];
  summary: { ok: number; warn: number; fail: number };
}

export async function runDoctorProbes(opts: DoctorOptions): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const injected = opts.whichFn;
  const whichFn: (cmd: string) => Promise<string | null> | string | null =
    injected !== undefined ? (cmd: string): string | null => injected(cmd) : whichViaShell;
  const fetchImpl = opts.fetchFn ?? fetch;

  // Discover authTokenEnv names by parsing whatever `assistants.litellm`
  // lives in ~/.archon/config.yaml. For v1 we pass an empty list — the
  // auth-env audit reads from real config.yaml in a follow-up. Keeping
  // the probe in place (with "no providers declared" as an OK state)
  // means the doctor report is stable and the wiring is trivial later.
  const tokenEnvNames: string[] = [];

  const probes: ProbeResult[] = [];
  probes.push(await probeClaude(whichFn));
  probes.push(await probeOpenCode(whichFn));
  probes.push(await probeUv(whichFn));
  probes.push(await probeLiteLLMProxy(fetchImpl));
  probes.push(probeMasterKey(env));
  probes.push(probeAuthTokenEnvs(tokenEnvNames, env));

  const summary = {
    ok: probes.filter(p => p.status === 'ok').length,
    warn: probes.filter(p => p.status === 'warn').length,
    fail: probes.filter(p => p.status === 'fail').length,
  };

  return { probes, summary };
}

/** CLI entry point. Returns an exit code. */
export async function doctorCommand(opts: DoctorOptions): Promise<number> {
  const report = await runDoctorProbes(opts);

  if (opts.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return report.summary.fail > 0 ? 1 : 0;
  }

  console.log('archon doctor');
  console.log('');
  // Simple glyph rendering — ASCII only, matches the rest of the CLI.
  for (const p of report.probes) {
    const marker = p.status === 'ok' ? '[OK]  ' : p.status === 'warn' ? '[WARN]' : '[FAIL]';
    console.log(`${marker}  ${p.name}: ${p.detail}`);
    if (p.fix !== undefined) console.log(`        fix: ${p.fix}`);
  }
  console.log('');
  console.log(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail`
  );

  return report.summary.fail > 0 ? 1 : 0;
}
