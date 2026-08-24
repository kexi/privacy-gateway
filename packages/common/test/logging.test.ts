/**
 * What structured logging guarantees: one Cloud Logging JSON object per line,
 * correlation fields intact, and only allowlisted fields emitted at all.
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

describe('the field allowlist', () => {
  it('drops a field that is not on the allowlist', () => {
    // The scrubber this replaced ran the tokenizer's regexes, which never saw a
    // personal name or an address. An unlisted field is not masked, it is gone.
    const { logger, lines } = capturing();
    logger.event('request.end', { customer_note: 'Taro Yamada lives in Shibuya' });

    expect(JSON.stringify(lines[0])).not.toContain('Taro Yamada');
    expect(JSON.stringify(lines[0])).not.toContain('Shibuya');
    expect(lines[0]?.['customer_note']).toBeUndefined();
  });

  it('names the dropped keys so a missing field is visible', () => {
    const { logger, lines } = capturing();
    logger.event('request.end', { customer_note: 'x', another: 1 });

    expect(lines[0]?.['dropped_fields']).toEqual(['another', 'customer_note']);
  });

  it('drops a nested object outright rather than walking into it', () => {
    const { logger, lines } = capturing();
    logger.info('done', { detail: { contact: 'call 090-1234-5678' } });

    expect(JSON.stringify(lines[0])).not.toContain('090-1234-5678');
  });

  it('leaves identifier fields readable', () => {
    // Masking these would make log entries impossible to correlate.
    const { logger, lines } = capturing();
    logger.event('request.start', {
      request_id: '01920000-0000-7000-8000-000000000001',
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });

    expect(lines[0]).toMatchObject({
      request_id: '01920000-0000-7000-8000-000000000001',
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });
  });

  it('coerces a field of the wrong type away rather than emitting it', () => {
    const { logger, lines } = capturing();
    logger.event('mask.done', { placeholder_count: 'not a number' });

    expect(lines[0]?.['placeholder_count']).toBeUndefined();
  });

  it('keeps category and count fields, which carry no values', () => {
    const { logger, lines } = capturing();
    logger.event('mask.done', {
      categories: ['EMAIL', 'PHONE'],
      counts_by_category: { EMAIL: 2 },
      findings: ['EMAIL'],
    });

    expect(lines[0]).toMatchObject({
      categories: ['EMAIL', 'PHONE'],
      counts_by_category: { EMAIL: 2 },
      findings: ['EMAIL'],
    });
  });

  it('bounds a string field so an inbound value cannot blow up a line', () => {
    const { logger, lines } = capturing();
    logger.event('request.start', { request_id: 'x'.repeat(500) });

    expect(String(lines[0]?.['request_id'])).toHaveLength(128);
  });
});

describe('errors', () => {
  it('records the error class and never the exception message', () => {
    // An exception message routinely embeds the value that caused it.
    const { logger, lines } = capturing();
    logger.error('failed', errorFields(new Error('could not reach taro@example.co.jp')));

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_class']).toBe('Error');
    expect(lines[0]?.['error_code']).toBe('Error');
    expect(lines[0]?.['error_message']).toBeUndefined();
  });

  it('handles a thrown non-Error', () => {
    const { logger, lines } = capturing();
    logger.error('failed', errorFields('taro@example.co.jp'));

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_class']).toBe('unknown_error');
  });
});

describe('bound context', () => {
  it('carries child fields onto every later line', () => {
    const { logger, lines } = capturing();
    const scoped = logger.child({ request_id: 'req-1' });

    scoped.event('a2a.core.send');
    scoped.event('a2a.core.recv', { duration_ms: 12 });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ request_id: 'req-1' });
    }
    expect(lines[1]).toMatchObject({ duration_ms: 12 });
  });
});
