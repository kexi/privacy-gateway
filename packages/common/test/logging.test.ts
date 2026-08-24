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

const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

describe('log shape', () => {
  it('emits the Cloud Logging reserved fields', () => {
    const { logger, lines } = capturing();
    logger.event('request.start');

    expect(lines[0]).toMatchObject({
      severity: 'INFO',
      message: 'request.start',
      agent: 'gateway',
    });
    expect(typeof lines[0]?.['time']).toBe('string');
  });

  it('records the event name as a searchable field', () => {
    const { logger, lines } = capturing();
    logger.event('mask.done', { placeholder_count: 5 });

    expect(lines[0]).toMatchObject({ event: 'mask.done', placeholder_count: 5 });
  });

  it('derives the message from the event name, with no free-text channel', () => {
    // There is deliberately no `info(message)` overload: a free-text message
    // bypassed the field allowlist entirely, so any interpolated value went
    // straight into the line.
    const { logger, lines } = capturing();
    logger.event('release.ok');

    expect(lines[0]?.['message']).toBe('release.ok');
    expect(lines[0]?.['message']).toBe(lines[0]?.['event']);
  });

  it('refuses an event name that is not enum-shaped', () => {
    const { logger, lines } = capturing();
    logger.event('leaked taro@example.co.jp');

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['message']).toBe('event');
  });

  it('honours the level threshold', () => {
    const { logger, lines } = capturing('WARNING');
    logger.event('request.start', {}, 'INFO');
    logger.event('request.refused', {}, 'WARNING');

    expect(lines).toHaveLength(1);
    expect(lines[0]?.['message']).toBe('request.refused');
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
    logger.event('request.end', { detail: { contact: 'call 090-1234-5678' } });

    expect(JSON.stringify(lines[0])).not.toContain('090-1234-5678');
  });

  it('leaves identifier fields readable', () => {
    // Masking these would make log entries impossible to correlate.
    const { logger, lines } = capturing();
    logger.event('request.start', {
      request_id: REQUEST_ID,
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });

    expect(lines[0]).toMatchObject({
      request_id: REQUEST_ID,
      trust_tier: 'machine-confirmed',
      verdict: 'pass',
    });
  });

  it('drops an id that is not a UUID or a W3C trace id', () => {
    // Ids are minted server-side, so anything else arrived from somewhere it
    // should not have; truncating it would still emit a prefix of it.
    const { logger, lines } = capturing();
    logger.event('request.start', { request_id: 'taro@example.co.jp' });

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['request_id']).toBeUndefined();
  });

  it('accepts a W3C trace id and a span id', () => {
    const { logger, lines } = capturing();
    logger.event('request.start', { trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) });

    expect(lines[0]).toMatchObject({ trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) });
  });

  it('drops a hash field that is not a sha256 digest', () => {
    const { logger, lines } = capturing();
    logger.event('attest.verdict', {
      attester_sha256: 'unavailable',
      response_hash: 'e'.repeat(64),
    });

    expect(lines[0]?.['attester_sha256']).toBeUndefined();
    expect(lines[0]?.['response_hash']).toBe('e'.repeat(64));
  });

  it('drops a category outside the closed enum', () => {
    // A Gemma judge answering `categories: ["Taro Yamada"]` was a log
    // disclosure channel; an unrecognised name is discarded, not truncated.
    const { logger, lines } = capturing();
    logger.event('release.refused', { categories: ['PERSON', 'Taro Yamada'] });

    expect(lines[0]?.['categories']).toEqual(['PERSON']);
    expect(JSON.stringify(lines[0])).not.toContain('Taro Yamada');
  });

  it('drops a token-list entry that is not a placeholder', () => {
    const { logger, lines } = capturing();
    logger.event('release.refused', {
      unresolved_tokens: ['⟦EMAIL_1⟧', 'taro@example.co.jp'],
    });

    expect(lines[0]?.['unresolved_tokens']).toEqual(['⟦EMAIL_1⟧']);
    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
  });

  it('drops an enum value that carries free text', () => {
    const { logger, lines } = capturing();
    logger.event('request.failed', { error_class: 'could not reach taro@example.co.jp' });

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_class']).toBeUndefined();
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

  it('drops an oversized value rather than emitting a prefix of it', () => {
    const { logger, lines } = capturing();
    logger.event('request.start', { request_id: 'x'.repeat(500) });

    expect(lines[0]?.['request_id']).toBeUndefined();
  });
});

describe('errors', () => {
  it('records the error class and never the exception message', () => {
    // An exception message routinely embeds the value that caused it.
    const { logger, lines } = capturing();
    logger.event(
      'request.failed',
      errorFields(new Error('could not reach taro@example.co.jp')),
      'ERROR',
    );

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_class']).toBe('Error');
    expect(lines[0]?.['error_code']).toBe('Error');
    expect(lines[0]?.['error_message']).toBeUndefined();
  });

  it('handles a thrown non-Error', () => {
    const { logger, lines } = capturing();
    logger.event('request.failed', errorFields('taro@example.co.jp'), 'ERROR');

    expect(JSON.stringify(lines[0])).not.toContain('taro@example.co.jp');
    expect(lines[0]?.['error_class']).toBe('unknown_error');
  });
});

describe('bound context', () => {
  it('carries child fields onto every later line', () => {
    const { logger, lines } = capturing();
    const scoped = logger.child({ request_id: REQUEST_ID });

    scoped.event('a2a.core.send');
    scoped.event('a2a.core.recv', { duration_ms: 12 });

    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ request_id: REQUEST_ID });
    }
    expect(lines[1]).toMatchObject({ duration_ms: 12 });
  });
});
