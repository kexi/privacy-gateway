/**
 * What structured logging guarantees: one Cloud Logging JSON object per line,
 * correlation fields intact, and no raw PII in any value.
 */

import { describe, expect, it } from 'vitest';
import { createLogger, errorFields, type Logger } from '../src/logging.ts';

/** Captures emitted lines instead of writing to stdout. */
function capturing(level?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR'): {
  logger: Logger;
  lines: Record<string, unknown>[];
} {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    agent: 'gateway',
    ...(level !== undefined ? { level } : {}),
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('log shape', () => {
  it('emits the Cloud Logging reserved fields', () => {
    const { logger, lines } = capturing();
    logger.info('hello');

    expect(lines[0]).toMatchObject({ severity: 'INFO', message: 'hello', agent: 'gateway' });
    expect(typeof lines[0]?.['time']).toBe('string');
  });

  it('records the event name as a searchable field', () => {
    const { logger, lines } = capturing();
    logger.event('mask.done', { placeholder_count: 5 });

    expect(lines[0]).toMatchObject({ event: 'mask.done', placeholder_count: 5 });
  });

  it('honours the level threshold', () => {
    const { logger, lines } = capturing('WARNING');
    logger.info('ignored');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['message']).toBe('kept');
  });
});

describe('PII masking', () => {
  it('masks a raw value that reaches the message', () => {
    const { logger, lines } = capturing();
    logger.info('mailing taro@example.co.jp now');

    expect(lines[0]?.['message']).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['message']).toContain('⟦EMAIL_1⟧');
  });

  it('masks raw values nested inside fields', () => {
    const { logger, lines } = capturing();
    logger.info('done', { detail: { contact: 'call 090-1234-5678' } });

    const detail = lines[0]?.['detail'] as { contact: string };
    expect(detail.contact).not.toContain('090-1234-5678');
  });

  it('leaves identifier fields readable', () => {
    // Masking these would make log entries impossible to correlate.
    const { logger, lines } = capturing();
    logger.event('request.start', {
      session_id: 's1',
      request_id: '01920000-0000-7000-8000-000000000001',
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });

    expect(lines[0]).toMatchObject({
      session_id: 's1',
      request_id: '01920000-0000-7000-8000-000000000001',
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });
  });

  it('masks an error message that carries PII', () => {
    const { logger, lines } = capturing();
    logger.error('failed', errorFields(new Error('could not reach taro@example.co.jp')));

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_code']).toBe('Error');
  });
});

describe('bound context', () => {
  it('carries child fields onto every later line', () => {
    const { logger, lines } = capturing();
    const scoped = logger.child({ request_id: 'req-1', session_id: 's1' });

    scoped.event('a2a.core.send');
    scoped.event('a2a.core.recv', { duration_ms: 12 });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ request_id: 'req-1', session_id: 's1' });
    }
    expect(lines[1]).toMatchObject({ duration_ms: 12 });
  });
});
