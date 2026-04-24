import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';

// Stub @sentry/node so tests never hit the network. The init module
// lazy-imports '@sentry/node', so mock.module must be set up before the
// first initSentry() call — doing it at module top-level here is sufficient.
const sentryInitMock = mock((_opts: Record<string, unknown>): void => undefined);
const sentryCaptureMock = mock(
  (_err: unknown, _ctx?: Record<string, unknown>): string => 'event-id'
);
const sentryCloseMock = mock(async (_timeoutMs?: number): Promise<boolean> => true);

mock.module('@sentry/node', () => ({
  init: sentryInitMock,
  captureException: sentryCaptureMock,
  close: sentryCloseMock,
}));

// Imported AFTER the mock is registered.
const { initSentry, captureException, flushSentry, isSentryEnabled, resetSentryForTests } =
  await import('./init');

const ENV_KEYS = [
  'ARCHON_SENTRY_DSN',
  'SENTRY_DSN',
  'ARCHON_DISABLE_SENTRY',
  'ARCHON_SENTRY_ENVIRONMENT',
] as const;

describe('initSentry', () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    sentryInitMock.mockClear();
    sentryCaptureMock.mockClear();
    sentryCloseMock.mockClear();
    resetSentryForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it('is disabled and does not load @sentry/node when no DSN is configured', async () => {
    const enabled = await initSentry();
    expect(enabled).toBe(false);
    expect(isSentryEnabled()).toBe(false);
    expect(sentryInitMock).toHaveBeenCalledTimes(0);
  });

  it('initializes when a DSN is provided via config', async () => {
    const enabled = await initSentry({ dsn: 'https://example@o0.ingest.sentry.io/0' });
    expect(enabled).toBe(true);
    expect(isSentryEnabled()).toBe(true);
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
    const call = sentryInitMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.dsn).toBe('https://example@o0.ingest.sentry.io/0');
    expect(call.tracesSampleRate).toBe(0);
    expect(call.sendDefaultPii).toBe(false);
  });

  it('prefers ARCHON_SENTRY_DSN over config.dsn', async () => {
    process.env.ARCHON_SENTRY_DSN = 'https://env@o0.ingest.sentry.io/0';
    await initSentry({ dsn: 'https://cfg@o0.ingest.sentry.io/0' });
    const call = sentryInitMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.dsn).toBe('https://env@o0.ingest.sentry.io/0');
  });

  it('falls back to SENTRY_DSN when ARCHON_SENTRY_DSN is unset', async () => {
    process.env.SENTRY_DSN = 'https://sentry-env@o0.ingest.sentry.io/0';
    await initSentry();
    const call = sentryInitMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.dsn).toBe('https://sentry-env@o0.ingest.sentry.io/0');
  });

  it('ARCHON_DISABLE_SENTRY=true forces Sentry off even with a DSN', async () => {
    process.env.ARCHON_DISABLE_SENTRY = 'true';
    process.env.ARCHON_SENTRY_DSN = 'https://example@o0.ingest.sentry.io/0';
    const enabled = await initSentry({ dsn: 'https://cfg@o0.ingest.sentry.io/0' });
    expect(enabled).toBe(false);
    expect(sentryInitMock).toHaveBeenCalledTimes(0);
  });

  it('captureException is a no-op before init / when disabled', () => {
    captureException(new Error('before init'));
    expect(sentryCaptureMock).toHaveBeenCalledTimes(0);
  });

  it('flushSentry is safe to await when disabled', async () => {
    await flushSentry();
    expect(sentryCloseMock).toHaveBeenCalledTimes(0);
  });

  it('captureException forwards to @sentry/node after init', async () => {
    await initSentry({ dsn: 'https://example@o0.ingest.sentry.io/0' });
    const err = new Error('boom');
    captureException(err, { workflowRunId: 'abc' });
    expect(sentryCaptureMock).toHaveBeenCalledTimes(1);
    const args = sentryCaptureMock.mock.calls[0];
    expect(args[0]).toBe(err);
    expect(args[1]).toEqual({ extra: { workflowRunId: 'abc' } });
  });

  it('is idempotent — a second initSentry call does not re-init', async () => {
    await initSentry({ dsn: 'https://example@o0.ingest.sentry.io/0' });
    await initSentry({ dsn: 'https://other@o0.ingest.sentry.io/0' });
    expect(sentryInitMock).toHaveBeenCalledTimes(1);
  });
});
