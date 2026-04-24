/**
 * Sentry integration for the Archon CLI — error/crash reporting only.
 *
 * Off by default. Opt-in via DSN from (in order):
 *   1. ARCHON_DISABLE_SENTRY=1 → always off, even if a DSN is present.
 *   2. ARCHON_SENTRY_DSN / SENTRY_DSN env var.
 *   3. sentry.dsn in ~/.archon/config.yaml (GlobalConfig).
 *
 * Scope: uncaught exceptions, unhandled promise rejections, the top-level
 * main().catch(...) in cli.ts, and logger.fatal(...) calls (wired via
 * setErrorReporter in @archon/paths). Ordinary logger.error(...) is NOT
 * forwarded — keeps Sentry volume low by design.
 *
 * @sentry/node is lazy-imported so the disabled path pays zero runtime cost.
 */

import { homedir } from 'node:os';
import type { ErrorEvent } from '@sentry/node';
import { BUNDLED_VERSION } from '@archon/paths';

export interface SentryInitOptions {
  /** Optional DSN from config.yaml (`sentry.dsn`). Env vars take precedence. */
  dsn?: string;
  /** Optional environment override from config. Defaults to 'production'. */
  environment?: string;
}

type SentryModule = typeof import('@sentry/node');

let sentry: SentryModule | null = null;
let initialized = false;

function resolveDsn(opts: SentryInitOptions): string | null {
  if (process.env.ARCHON_DISABLE_SENTRY === '1' || process.env.ARCHON_DISABLE_SENTRY === 'true') {
    return null;
  }
  const envDsn = process.env.ARCHON_SENTRY_DSN ?? process.env.SENTRY_DSN;
  if (envDsn && envDsn.trim().length > 0) return envDsn.trim();
  if (opts.dsn && opts.dsn.trim().length > 0) return opts.dsn.trim();
  return null;
}

/**
 * Replace the user's home-directory prefix in stack-frame filenames with '~'.
 * Reduces incidental PII (usernames, local paths) leaking into Sentry events.
 * Covers the common case; symlinked / relative paths are left unchanged.
 */
function scrubStackPaths<T>(event: T): T {
  const home = homedir();
  if (!home) return event;
  const replace = (s: string): string => (s.includes(home) ? s.split(home).join('~') : s);

  const exception = (event as { exception?: { values?: Record<string, unknown>[] } }).exception;
  if (!exception?.values) return event;

  for (const value of exception.values) {
    const stacktrace = value.stacktrace as { frames?: Record<string, unknown>[] } | undefined;
    if (!stacktrace?.frames) continue;
    for (const frame of stacktrace.frames) {
      if (typeof frame.filename === 'string') frame.filename = replace(frame.filename);
      if (typeof frame.abs_path === 'string') frame.abs_path = replace(frame.abs_path);
    }
  }
  return event;
}

/**
 * Initialize Sentry if a DSN is resolvable. Idempotent; subsequent calls are
 * no-ops. Returns true when Sentry is active, false otherwise.
 */
export async function initSentry(opts: SentryInitOptions = {}): Promise<boolean> {
  if (initialized) return sentry !== null;
  initialized = true;

  const dsn = resolveDsn(opts);
  if (!dsn) return false;

  try {
    sentry = await import('@sentry/node');
    sentry.init({
      dsn,
      release: BUNDLED_VERSION,
      environment: opts.environment ?? process.env.ARCHON_SENTRY_ENVIRONMENT ?? 'production',
      // Errors only — no performance / tracing data.
      tracesSampleRate: 0,
      // Never attach request bodies, headers, cookies, or IP addresses.
      sendDefaultPii: false,
      // Drop default integrations (HTTP, Express, etc.); we only care about
      // `onUncaughtException` / `onUnhandledRejection`, which Archon registers
      // explicitly in cli.ts so they can flush + exit deterministically.
      defaultIntegrations: false,
      beforeSend: (event: ErrorEvent) => scrubStackPaths(event),
    });
    return true;
  } catch {
    // Any init failure (network-proxy misconfig, invalid DSN, missing module
    // in a compiled binary) must not crash the CLI. Disable silently.
    sentry = null;
    return false;
  }
}

/**
 * Capture an exception. No-op when Sentry is not initialized.
 * Safe to call at any time after (or before) initSentry().
 */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(err, context ? { extra: context } : undefined);
  } catch {
    // Never let reporting crash the process.
  }
}

/**
 * Flush pending events to Sentry. Always safe to await during shutdown,
 * whether or not Sentry was initialized.
 */
export async function flushSentry(timeoutMs = 2000): Promise<void> {
  if (!sentry) return;
  try {
    await sentry.close(timeoutMs);
  } catch {
    // Shutdown must not itself throw.
  }
}

/** Test-only: reset module state between test cases. */
export function resetSentryForTests(): void {
  sentry = null;
  initialized = false;
}

export function isSentryEnabled(): boolean {
  return sentry !== null;
}
