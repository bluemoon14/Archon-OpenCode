/**
 * Covers the setErrorReporter / fatal-hook path in ./logger.
 *
 * Filename starts with 'logger-' so it sorts BEFORE logger.test.ts in
 * Bun's single-process test runner. logger.test.ts calls mock.module('./logger')
 * to install a stub (which does NOT include the pino fatal hook); since
 * mock.module is process-global and irreversible, running it first would
 * prevent us from exercising the real logger here.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createLogger, setErrorReporter } from './logger';

describe('logger fatal reporter', () => {
  beforeEach(() => {
    setErrorReporter(null);
  });

  it('invokes the reporter on .fatal with the Error from { err }', () => {
    const reporter = mock((_err: unknown, _ctx: Record<string, unknown>): void => undefined);
    setErrorReporter(reporter);

    const log = createLogger('fatal-test');
    const err = new Error('boom');
    log.fatal({ err, extra: 'x' }, 'something fatal');

    expect(reporter).toHaveBeenCalledTimes(1);
    const [capturedErr, capturedCtx] = reporter.mock.calls[0] ?? [];
    expect(capturedErr).toBe(err);
    expect(capturedCtx).toMatchObject({ err, extra: 'x' });
  });

  it('does NOT invoke the reporter on .error', () => {
    const reporter = mock((_err: unknown, _ctx: Record<string, unknown>): void => undefined);
    setErrorReporter(reporter);

    const log = createLogger('error-test');
    log.error({ err: new Error('not fatal') }, 'routine failure');

    expect(reporter).toHaveBeenCalledTimes(0);
  });

  it('synthesizes an Error when .fatal is called with only a string message', () => {
    const reporter = mock((_err: unknown, _ctx: Record<string, unknown>): void => undefined);
    setErrorReporter(reporter);

    const log = createLogger('fatal-string');
    log.fatal('pure string fatal');

    expect(reporter).toHaveBeenCalledTimes(1);
    const [capturedErr] = reporter.mock.calls[0] ?? [];
    expect(capturedErr).toBeInstanceOf(Error);
    expect((capturedErr as Error).message).toBe('pure string fatal');
  });

  it('setErrorReporter(null) detaches the reporter', () => {
    const reporter = mock((_err: unknown, _ctx: Record<string, unknown>): void => undefined);
    setErrorReporter(reporter);
    setErrorReporter(null);

    const log = createLogger('detach-test');
    log.fatal({ err: new Error('after detach') }, 'event');

    expect(reporter).toHaveBeenCalledTimes(0);
  });

  it('a throwing reporter does not crash the logger', () => {
    const reporter = mock((_err: unknown, _ctx: Record<string, unknown>): void => {
      throw new Error('reporter is broken');
    });
    setErrorReporter(reporter);

    const log = createLogger('throwing-reporter');
    expect(() => log.fatal({ err: new Error('real err') }, 'event')).not.toThrow();
  });
});
